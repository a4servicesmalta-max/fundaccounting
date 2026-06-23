// Journal-entry suggester for NON-standard documents (CONTRACT companion to §12).
// For a source document that is NOT a bank statement or a plain invoice — e.g. a
// share-purchase agreement, a contract, a loan agreement, a receipt, or a misc.
// document — the AI TRANSCRIBES the key amount(s) and PROPOSES a balanced
// double-entry journal for a human to review/approve. It never invents or
// computes figures beyond simple balancing; the deterministic engine rebalances
// downstream. Mirrors extract-bank.ts / classify-bank.ts conventions exactly:
// injectable StructuredCaller, a real streaming defaultCaller (claude-opus-4-8,
// adaptive thinking, pdf/image content blocks), a ```json-fence tolerant JSON
// extractor, zod validation, and never-throw error handling.

import Anthropic from '@anthropic-ai/sdk';
import { withRetry } from './retry';
import { z } from 'zod';
import type { ExtractContent } from './claude';

// ---------------------------------------------------------------------------
// Public interface (match precisely so it can be wired into the pipeline).
// ---------------------------------------------------------------------------

export interface JournalChartAccount {
  code: string;
  name: string;
}

export interface SuggestedJournalLine {
  accountCode: string; // an existing chart code, or a new sensible code if needed
  accountName: string; // friendly name (for a new account, a clear name)
  amount: number; // SIGNED in the document's currency: positive = DEBIT, negative = CREDIT
}

export interface SuggestedJournal {
  description: string; // what this document is, plain language
  date: string; // YYYY-MM-DD transaction date (or '' if unknown)
  currency: string; // the document's currency (ISO, e.g. EUR/USD/GBP/CHF/PLN)
  lines: SuggestedJournalLine[]; // >= 2 lines, MUST sum to ~0 (balanced)
  confidence: number; // 0..1
  rationale: string; // short plain-language explanation (default '')
}

export interface SuggestJournalInput {
  fileName: string;
  content: ExtractContent;
  chart: JournalChartAccount[];
}

export interface SuggestJournalResult {
  ok: boolean;
  suggestion?: SuggestedJournal;
  error?: string;
  modelUsed?: string;
}

// ---------------------------------------------------------------------------
// Output shape (zod-validated) — strict on line shape, lenient on soft fields.
// ---------------------------------------------------------------------------

const lineSchema = z.object({
  accountCode: z.string(),
  accountName: z.string().default(''),
  amount: z.number(),
});

const journalSchema = z.object({
  description: z.string().default(''),
  date: z.string().default(''),
  currency: z.string().default('EUR'),
  lines: z.array(lineSchema).min(1),
  confidence: z.number().min(0).max(1).default(0.5),
  rationale: z.string().default(''),
});

// ---------------------------------------------------------------------------
// Injectable Claude caller (mirrors extract-bank.ts) so tests stub the model.
// ---------------------------------------------------------------------------

/** A structured caller takes a system+user prompt plus content and returns raw model text. */
export type StructuredCaller = (args: {
  system: string;
  user: string;
  content: ExtractContent;
}) => Promise<{ text: string; modelUsed?: string }>;

export interface SuggestJournalDeps {
  call?: StructuredCaller;
}

/** Build the system+user prompt for journal-entry suggestion. */
export function buildSuggestJournalPrompt(input: SuggestJournalInput): {
  system: string;
  user: string;
} {
  const system = [
    'You are a meticulous bookkeeping assistant for an investment FUND.',
    'You are shown a source document and the available chart of accounts.',
    'TRANSCRIBE the key amount(s) exactly as printed — never invent or compute figures beyond simple balancing.',
    'Propose a balanced double-entry journal (debits = credits) that books what this document represents,',
    'choosing accounts from the chart (or proposing a NEW account with a sensible numeric code following',
    "the chart's numbering: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 6xxx expenses,",
    'control 030 investments in shares / 032 loans granted).',
    'Amounts are SIGNED: positive = DEBIT, negative = CREDIT, and MUST sum to zero.',
    'Examples: a share purchase → Dr 030 (investment) / Cr 1010 (bank); a signed contract with a commitment',
    'but no cash movement yet → still describe it but you may return a single memo with confidence low.',
    'Respond with JSON ONLY.',
  ].join(' ');

  const chartLines = input.chart.map((a) => `- ${a.code}: ${a.name}`).join('\n');

  const user = [
    `Source document (file: ${input.fileName}).`,
    '',
    'Chart of accounts (existing codes):',
    chartLines || '(none provided)',
    '',
    'Propose a balanced journal for this document with:',
    '- description: what this document is, in plain language',
    '- date: the transaction date (YYYY-MM-DD), or "" if unknown',
    '- currency: the document\'s currency (ISO, e.g. EUR/USD/GBP/CHF/PLN)',
    '- lines: at least two lines, each { accountCode, accountName, amount } where amount is SIGNED',
    '  (positive = DEBIT, negative = CREDIT) and the line amounts MUST sum to zero',
    '- confidence: 0..1',
    '- rationale: a short plain-language explanation',
    '',
    'Return EXACTLY this JSON shape and nothing else:',
    '{"description":"","date":"","currency":"","lines":[{"accountCode":"","accountName":"","amount":0}],"confidence":0,"rationale":""}',
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

/** The real Claude caller — mirrors extract-bank.ts (claude-opus-4-8, adaptive thinking, streaming, content blocks). */
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

  // Adaptive thinking draws from the output budget, so we give it generous room
  // and STREAM (the SDK helper assembles the final message) to avoid request
  // timeouts on a careful read of an unusual document. A small budget here
  // silently truncates to an empty/invalid response (stop_reason: max_tokens).
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
 * Ask Claude to SUGGEST a balanced journal entry for a non-standard document
 * (share-purchase agreement, contract, loan agreement, receipt, misc.), for a
 * human to review/approve. Returns a typed, zod-validated suggestion. We only
 * validate the SHAPE — if the proposed lines don't sum to ~0 we still return
 * ok:true (the deterministic engine rebalances downstream). Never throws —
 * every failure (incl. missing key) comes back as { ok:false, error }.
 */
export async function suggestJournal(
  input: SuggestJournalInput,
  deps?: SuggestJournalDeps,
): Promise<SuggestJournalResult> {
  try {
    const call = deps?.call ?? defaultCaller;
    if (!deps?.call && !process.env.ANTHROPIC_API_KEY) {
      return { ok: false, error: 'No ANTHROPIC_API_KEY set — add it to your .env file.' };
    }

    const { system, user } = buildSuggestJournalPrompt(input);
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

    const parsed = journalSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message, modelUsed };
    }

    // Shape-only: if the lines don't sum to ~0 we DO NOT reject — the engine
    // rebalances downstream. Just hand back the validated suggestion.
    return { ok: true, suggestion: parsed.data, modelUsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
