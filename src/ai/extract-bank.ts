// Bank-statement extractor (CONTRACT §12(a)).
// The AI ONLY transcribes what's printed — it never computes or invents a figure.
// The deterministic engine (footing/continuity) owns every calculation downstream.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ExtractContent } from './claude';

// ---------------------------------------------------------------------------
// Output shape (zod-validated) — exactly the §12(a) bank-statement contract.
// ---------------------------------------------------------------------------

// Numbers are coerced and tolerant: a missing/blank balance on a real statement
// must NOT reject the whole document. The deterministic footing check downstream
// catches anything that genuinely doesn't add up.
const num = z.coerce.number().catch(0);

const bankTransactionSchema = z.object({
  date: z.string().default(''),
  description: z.string().default(''),
  amount: num, // signed: + money IN, − money OUT
  balance: z.coerce.number().nullable().catch(null).optional(),
});

const bankStatementSchema = z.object({
  bankName: z.string().default(''),
  accountRef: z.string().default(''),
  currency: z.string().default('EUR'),
  periodStart: z.string().default(''),
  periodEnd: z.string().default(''),
  openingBalance: num,
  closingBalance: num,
  transactions: z.array(bankTransactionSchema).default([]),
});

export type BankStatementExtract = z.infer<typeof bankStatementSchema>;

// A single statement file can hold MORE THAN ONE account (e.g. a EUR and a PLN
// account printed together). The model returns every account it finds.
const bankStatementsSchema = z.object({
  statements: z.array(bankStatementSchema),
});

export interface ExtractBankInput {
  fileName: string;
  content: ExtractContent;
}

export interface ExtractBankResult {
  ok: boolean;
  statements?: BankStatementExtract[];
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

export interface ExtractBankDeps {
  call?: StructuredCaller;
}

/** Build the system+user prompt for bank-statement transcription. */
export function buildBankPrompt(input: ExtractBankInput): { system: string; user: string } {
  const system = [
    'You are a meticulous bookkeeping assistant that reads bank statements.',
    'Transcribe ONLY what is printed on the document. Never compute, derive, or invent any figure.',
    'Do not recalculate balances or totals — copy exactly what the statement shows.',
    'Amounts are SIGNED: money IN (credits/deposits) is POSITIVE, money OUT (debits/withdrawals) is NEGATIVE.',
    'Dates use ISO format YYYY-MM-DD. Use the currency exactly as printed (e.g. EUR, USD, GBP).',
    'Respond with JSON ONLY — no prose, no markdown fences, no explanation.',
  ].join(' ');

  const user = [
    `Read this bank statement file (file: ${input.fileName}). It may contain MORE THAN ONE account`,
    '(for example a EUR account and a PLN account printed in the same document, or several pages each',
    'for a different account/IBAN). Return EVERY distinct account as a SEPARATE entry in the "statements"',
    'array. For EACH account extract:',
    '- bankName: the issuing bank',
    '- accountRef: the account number or IBAN (this distinguishes the accounts)',
    '- currency: that account\'s currency',
    '- periodStart, periodEnd: the statement period (YYYY-MM-DD)',
    '- openingBalance, closingBalance: as printed for THAT account',
    '- transactions: EVERY transaction line for THAT account, each with { date (YYYY-MM-DD), description, amount (signed: + in / − out), balance (running balance if shown, else null) }',
    'Group each transaction under the account it belongs to. Never mix accounts.',
    '',
    'Return EXACTLY this JSON shape and nothing else:',
    '{"statements":[{"bankName":"","accountRef":"","currency":"","periodStart":"","periodEnd":"","openingBalance":0,"closingBalance":0,"transactions":[{"date":"","description":"","amount":0,"balance":null}]}]}',
    input.content.kind === 'text' && input.content.text
      ? `\nStatement text:\n${input.content.text}`
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

  // A full bank statement can carry hundreds of transaction lines, and adaptive
  // thinking also draws from the output budget — so we give it generous room and
  // STREAM (the SDK helper assembles the final message) to avoid request
  // timeouts on long transcriptions. A small budget here silently truncates to
  // an empty/!invalid response (stop_reason: max_tokens).
  const stream = client.messages.stream({
    model,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  const resp = await stream.finalMessage();

  // Skip non-text blocks (e.g. thinking blocks) and read the first text block.
  const textBlock = resp.content.find((b) => b.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  return { text, modelUsed: resp.model };
};

/**
 * Read one bank statement with Claude and return a typed, zod-validated statement.
 * Never throws — every failure (incl. missing key) comes back as { ok:false, error }.
 */
export async function extractBankStatement(
  input: ExtractBankInput,
  deps?: ExtractBankDeps,
): Promise<ExtractBankResult> {
  try {
    const call = deps?.call ?? defaultCaller;
    if (!deps?.call && !process.env.ANTHROPIC_API_KEY) {
      return { ok: false, error: 'No ANTHROPIC_API_KEY set — add it to your .env file.' };
    }

    const { system, user } = buildBankPrompt(input);
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

    // A statement is only usable if it has at least one transaction or a real
    // balance — this rejects empty/garbage objects while staying tolerant of a
    // single missing number on a genuine statement.
    const hasContent = (s: BankStatementExtract): boolean =>
      (Array.isArray(s.transactions) && s.transactions.length > 0) ||
      Number(s.openingBalance) !== 0 ||
      Number(s.closingBalance) !== 0;

    // Preferred shape: { statements: [...] }. Fall back to a single statement
    // object (older prompt / model that returned just one account).
    const multi = bankStatementsSchema.safeParse(raw);
    if (multi.success) {
      const usable = multi.data.statements.filter(hasContent);
      if (usable.length) return { ok: true, statements: usable, modelUsed };
    }
    const single = bankStatementSchema.safeParse(raw);
    if (single.success && hasContent(single.data)) {
      return { ok: true, statements: [single.data], modelUsed };
    }
    return { ok: false, error: 'No usable statement content found.', modelUsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
