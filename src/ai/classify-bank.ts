// Bank-description classifier (chart-of-accounts suggestion).
// The AI proposes which chart account a DISTINCT bank-transaction description
// belongs to (or proposes a sensible new account) — it NEVER invents amounts.
// Mirrors extract-bank.ts conventions: injectable StructuredCaller, a real
// streaming defaultCaller (claude-opus-4-8, adaptive thinking), a ```json-fence
// tolerant JSON extractor, zod validation, and never-throw error handling.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Public interface (match precisely so it can be wired in later).
// ---------------------------------------------------------------------------

export interface ClassifyChartAccount {
  code: string;
  name: string;
}

export interface ClassifySuggestion {
  pattern: string; // the distinct description (or a normalized recurring pattern) this applies to
  accountCode: string; // chosen existing code OR a new code if isNewAccount
  accountName: string; // friendly name (for a new account, a sensible name)
  isNewAccount: boolean; // true if accountCode is NOT in the supplied chart
  confidence: number; // 0..1
  rationale: string; // short, plain-language why (default '')
}

export interface ClassifyInput {
  descriptions: string[];
  chart: ClassifyChartAccount[];
}

export interface ClassifyResult {
  ok: boolean;
  suggestions?: ClassifySuggestion[];
  error?: string;
  modelUsed?: string;
}

// ---------------------------------------------------------------------------
// Output shape (zod-validated) — lenient on rationale, strict on pattern/code.
// ---------------------------------------------------------------------------

const suggestionSchema = z.object({
  pattern: z.string(),
  accountCode: z.string(),
  accountName: z.string().default(''),
  isNewAccount: z.boolean().default(false),
  confidence: z.number().default(0),
  rationale: z.string().default(''),
});

const classifyOutputSchema = z.object({
  suggestions: z.array(suggestionSchema),
});

// ---------------------------------------------------------------------------
// Injectable Claude caller (mirrors extract-bank.ts) so tests stub the model.
// ---------------------------------------------------------------------------

/** A structured caller takes a system+user prompt and returns raw model text. */
export type StructuredCaller = (args: {
  system: string;
  user: string;
}) => Promise<{ text: string; modelUsed?: string }>;

export interface ClassifyBankDeps {
  call?: StructuredCaller;
}

/** Build the system+user prompt for chart-of-accounts classification. */
export function buildClassifyPrompt(input: ClassifyInput): { system: string; user: string } {
  const system = [
    'You are a meticulous bookkeeping assistant.',
    'You are given DISTINCT bank-transaction descriptions (which may be in Polish or other languages) and the available chart of accounts.',
    'For EACH distinct description, choose the best-fitting account from the chart.',
    'If nothing fits well, propose a NEW account with a sensible numeric code',
    "(follow the chart's numbering: 6xxx = expenses, 4xxx = income, 1xxx assets, 2xxx liabilities)",
    'and a clear English name, and set isNewAccount true.',
    'Never invent transaction amounts.',
    'Respond with JSON ONLY — no prose, no markdown fences, no explanation.',
  ].join(' ');

  const chartLines = input.chart.map((a) => `- ${a.code}: ${a.name}`).join('\n');
  const descLines = input.descriptions.map((d) => `- ${d}`).join('\n');

  const user = [
    'Chart of accounts (existing codes):',
    chartLines || '(none provided)',
    '',
    'Distinct bank-transaction descriptions to classify:',
    descLines || '(none provided)',
    '',
    'For EACH description, return one suggestion with:',
    '- pattern: the distinct description (or a normalized recurring pattern) this applies to',
    '- accountCode: a chosen existing code, OR a new numeric code if nothing fits',
    '- accountName: a friendly name (for a new account, a sensible English name)',
    '- isNewAccount: true if accountCode is NOT in the supplied chart, else false',
    '- confidence: 0..1',
    '- rationale: short, plain-language why',
    '',
    'Return EXACTLY this JSON shape and nothing else:',
    '{"suggestions":[{"pattern":"","accountCode":"","accountName":"","isNewAccount":false,"confidence":0,"rationale":""}]}',
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

/** The real Claude caller — mirrors extract-bank.ts (claude-opus-4-8, adaptive thinking, streaming). */
const defaultCaller: StructuredCaller = async ({ system, user }) => {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

  // STREAM (the SDK helper assembles the final message) to avoid request
  // timeouts on long classification batches; adaptive thinking draws from the
  // output budget so we give it generous room.
  const stream = client.messages.stream({
    model,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  });
  const resp = await stream.finalMessage();

  // Skip non-text blocks (e.g. thinking blocks) and read the first text block.
  const textBlock = resp.content.find((b) => b.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  return { text, modelUsed: resp.model };
};

/**
 * Ask Claude to suggest chart-of-accounts classifications for the given
 * distinct bank-transaction descriptions, returning typed, zod-validated
 * suggestions. Never throws — every failure (incl. missing key) comes back
 * as { ok:false, error }.
 */
export async function classifyBankDescriptions(
  input: ClassifyInput,
  deps?: ClassifyBankDeps,
): Promise<ClassifyResult> {
  try {
    const call = deps?.call ?? defaultCaller;
    if (!deps?.call && !process.env.ANTHROPIC_API_KEY) {
      return { ok: false, error: 'No ANTHROPIC_API_KEY set — add it to your .env file.' };
    }

    const { system, user } = buildClassifyPrompt(input);
    const { text, modelUsed } = await call({ system, user });
    if (!text) {
      return { ok: false, error: 'Claude returned no text content.' };
    }

    let raw: unknown;
    try {
      raw = extractJsonObject(text);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'parse error', modelUsed };
    }

    const parsed = classifyOutputSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message, modelUsed };
    }

    return { ok: true, suggestions: parsed.data.suggestions, modelUsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
