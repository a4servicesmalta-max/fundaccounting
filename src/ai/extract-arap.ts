// AR/AP extractor (CONTRACT §12(a)).
// The AI ONLY transcribes what's printed and classifies the document direction —
// it never computes or invents a figure. The engine owns all downstream math.
//
// RECEIVABLE = an invoice the FUND ISSUED (money owed TO the fund).
// PAYABLE    = a bill/supplier invoice the FUND RECEIVED (money the fund OWES).

import Anthropic from '@anthropic-ai/sdk';
import { withRetry } from './retry';
import { z } from 'zod';
import type { ExtractContent } from './claude';

// ---------------------------------------------------------------------------
// Output shape (zod-validated) — exactly the §12(a) AR/AP item contract.
// ---------------------------------------------------------------------------

const arApItemSchema = z.object({
  kind: z.enum(['RECEIVABLE', 'PAYABLE']),
  counterparty: z.string(),
  amount: z.number(),
  currency: z.string(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
});

export type ArApExtract = z.infer<typeof arApItemSchema>;

export interface ExtractArApInput {
  fileName: string;
  content: ExtractContent;
}

export interface ExtractArApResult {
  ok: boolean;
  item?: ArApExtract;
  error?: string;
  modelUsed?: string;
}

// ---------------------------------------------------------------------------
// Injectable Claude caller (mirrors claude.ts) so tests stub the model.
// ---------------------------------------------------------------------------

/** A structured caller takes a system+user prompt plus content and returns raw model text. */
export type StructuredCaller = (args: {
  system: string;
  user: string;
  content: ExtractContent;
}) => Promise<{ text: string; modelUsed?: string }>;

export interface ExtractArApDeps {
  call?: StructuredCaller;
}

/** Build the system+user prompt for AR/AP transcription + direction classification. */
export function buildArApPrompt(input: ExtractArApInput): { system: string; user: string } {
  const system = [
    'You are a meticulous bookkeeping assistant that reads invoices and bills for an investment FUND.',
    'Transcribe ONLY what is printed on the document. Never compute, derive, or invent any figure.',
    'Classify the document direction from the FUND\'s point of view:',
    'RECEIVABLE = an invoice the FUND ISSUED to a customer (money owed TO the fund).',
    'PAYABLE = a bill or supplier invoice the FUND RECEIVED (money the fund OWES).',
    'Dates use ISO format YYYY-MM-DD, or null if not printed. Use the currency exactly as printed.',
    'Respond with JSON ONLY — no prose, no markdown fences, no explanation.',
  ].join(' ');

  const user = [
    `Read this invoice/bill (file: ${input.fileName}) and extract:`,
    '- kind: "RECEIVABLE" if the fund issued it (owed TO the fund), "PAYABLE" if the fund received it (the fund OWES)',
    '- counterparty: the other party (customer for RECEIVABLE, supplier for PAYABLE)',
    '- amount: the total amount due, as printed',
    '- currency: the document currency',
    '- issueDate: the invoice/issue date (YYYY-MM-DD) or null',
    '- dueDate: the payment due date (YYYY-MM-DD) or null',
    '',
    'Return EXACTLY this JSON shape and nothing else:',
    '{"kind":"RECEIVABLE","counterparty":"","amount":0,"currency":"","issueDate":null,"dueDate":null}',
    input.content.kind === 'text' && input.content.text
      ? `\nDocument text:\n${input.content.text}`
      : '',
  ].join('\n');

  return { system, user };
}

/** Extract a JSON object from raw model text (handles ```json fences + surrounding prose). */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const s = candidate.indexOf('{');
    const e = candidate.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(candidate.slice(s, e + 1));
    throw new Error('No valid JSON in model output');
  }
}

/** The real Claude caller — mirrors claude.ts (claude-opus-4-8, adaptive thinking, content blocks). */
const defaultCaller: StructuredCaller = async ({ system, user, content }) => {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

  const userContent: any[] = [{ type: 'text', text: user }];
  if (content.kind === 'pdf' && content.base64) {
    userContent.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: content.base64 },
    });
  }
  if (content.kind === 'image' && content.base64) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: content.mediaType || 'image/png', data: content.base64 },
    });
  }

  // Generous budget + streaming: adaptive thinking draws from the output budget,
  // so a small max_tokens can be fully consumed by thinking, yielding no text.
  const resp = await withRetry(() => client.messages.stream({
    model,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: userContent }],
  }).finalMessage());

  // Skip non-text blocks (e.g. thinking blocks) and read the first text block.
  const textBlock = resp.content.find((b) => b.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  return { text, modelUsed: resp.model };
};

/**
 * Read one invoice/bill with Claude and return a typed, zod-validated AR/AP item.
 * Never throws — every failure (incl. missing key) comes back as { ok:false, error }.
 */
export async function extractArAp(
  input: ExtractArApInput,
  deps?: ExtractArApDeps,
): Promise<ExtractArApResult> {
  try {
    const call = deps?.call ?? defaultCaller;
    if (!deps?.call && !process.env.ANTHROPIC_API_KEY) {
      return { ok: false, error: 'No ANTHROPIC_API_KEY set — add it to your .env file.' };
    }

    const { system, user } = buildArApPrompt(input);
    const { text, modelUsed } = await call({ system, user, content: input.content });
    if (!text) {
      return { ok: false, error: 'Claude returned no text content.' };
    }

    let raw: unknown;
    try {
      raw = extractJsonObject(text);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'parse error', modelUsed };
    }

    const parsed = arApItemSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message, modelUsed };
    }

    return { ok: true, item: parsed.data, modelUsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
