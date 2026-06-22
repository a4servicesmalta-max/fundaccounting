// Claude client (CONTRACT §6). The ONLY place that talks to the Anthropic API.
// The AI reads/classifies/transcribes; it never authors an accounting figure.

import Anthropic from '@anthropic-ai/sdk';
import { buildIntakePrompt } from '../core/intake-prompt';
import { parseIntakeResponse } from '../core/intake-parse';
import type { IntakeIntent } from '../core/intake-schema';

export interface ExtractContent {
  kind: 'text' | 'pdf' | 'image';
  text?: string; // kind==='text'
  base64?: string; // kind==='pdf' | 'image'
  mediaType?: string; // images: 'image/png' | 'image/jpeg' | ...
}

export interface ExtractInput {
  fileName: string;
  folderPath: string;
  content: ExtractContent;
  investees: string[];
}

/** Why an extraction failed — lets the UI tell the user a document couldn't be
 *  READ (AI reader down / out of credits / no key) versus the model declining it. */
export type ExtractErrorKind = 'credit' | 'auth' | 'unavailable' | 'no_text' | 'parse' | 'other';

export interface ExtractResult {
  ok: boolean;
  intent?: IntakeIntent;
  error?: string;
  errorKind?: ExtractErrorKind;
  modelUsed?: string;
}

/** Classify an API error so the UI can explain it. */
export function classifyApiError(err: unknown): ExtractErrorKind {
  const e = err as { status?: number; statusCode?: number; message?: string };
  const s = e?.status ?? e?.statusCode;
  const msg = (e?.message || '').toLowerCase();
  if (/credit balance is too low|insufficient.*credit|billing/.test(msg)) return 'credit';
  if (s === 401 || s === 403 || /invalid x-api-key|authentication|unauthorized|permission/.test(msg)) return 'auth';
  if (s === 429 || s === 500 || s === 502 || s === 503 || s === 529 ||
      /overloaded|rate.?limit|too many requests|timeout|timed out|econnreset|etimedout|socket hang|network|fetch failed/.test(msg)) {
    return 'unavailable';
  }
  return 'other';
}

/** A human-friendly one-liner for an extraction failure (shown on the document). */
export function extractErrorMessage(kind: ExtractErrorKind | undefined): string | null {
  switch (kind) {
    case 'credit': return 'The AI reader is out of API credits, so this document couldn’t be read. Top up your Anthropic credits and upload it again.';
    case 'auth': return 'The AI reader couldn’t sign in (check your API key in Settings), so this document couldn’t be read. Fix the key and upload it again.';
    case 'unavailable': return 'The AI reader is temporarily unavailable (it may be busy). This document couldn’t be read — please upload it again in a moment.';
    case 'no_text':
    case 'parse': return 'The AI reader couldn’t make sense of this document. Please check it’s a clear copy and upload it again.';
    default: return null;
  }
}

/** True when an API key is present in the environment. */
export function isConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const MAX_ATTEMPTS = 4;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A transient API condition worth retrying: rate limit (429), overload (529),
 *  5xx, or a network/timeout blip. A bulk upload of 100 docs must not silently
 *  drop documents to UNKNOWN because the API throttled for a moment. */
function isTransient(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; name?: string; message?: string };
  const s = e?.status ?? e?.statusCode;
  if (s === 429 || s === 500 || s === 502 || s === 503 || s === 529) return true;
  const name = e?.name || '';
  const msg = (e?.message || '').toLowerCase();
  if (/overloaded|rate.?limit|too many requests|timeout|timed out|econnreset|etimedout|socket hang|network|fetch failed/.test(msg)) return true;
  return name === 'APIConnectionError' || name === 'APIConnectionTimeoutError';
}

/** Exponential backoff (ms) by 0-indexed attempt. Deterministic — no randomness. */
function backoffMs(attempt: number): number {
  return [1500, 4000, 9000, 18000][Math.min(attempt, 3)];
}

/**
 * Read one document with Claude and return a typed intake intent.
 * Never throws — every failure (incl. missing key) comes back as { ok:false, error }.
 */
export async function extractIntent(input: ExtractInput): Promise<ExtractResult> {
  try {
    if (!isConfigured()) {
      return { ok: false, error: 'No ANTHROPIC_API_KEY set — add it to your .env file.', errorKind: 'auth' };
    }

    const { fileName, folderPath, content, investees } = input;

    const { system, user } = buildIntakePrompt({
      fileName,
      folderPath,
      investees: investees.map((name) => ({ name, aliases: [] })),
      documentText: content.kind === 'text' ? content.text : undefined,
      // Deployment config: the fund whose books these are, so the agent can decide
      // ACQUISITION vs DISPOSAL by which side of an SPA the entity is on.
      reportingEntity: process.env.REPORTING_ENTITY || undefined,
    });

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
        source: {
          type: 'base64',
          media_type: content.mediaType || 'image/png',
          data: content.base64,
        },
      });
    }

    // Retry transient API failures (rate limit / overload / network) with backoff
    // so a momentary throttle during a large batch doesn't silently drop the doc.
    let lastError = 'extraction failed';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        // Adaptive thinking draws from the output budget, so max_tokens must be
        // generous or a large/complex document spends it all on thinking and emits
        // no text (stop_reason: max_tokens). Stream to avoid timeouts on long reads.
        const stream = client.messages.stream({
          model,
          max_tokens: 32000, // bilingual / multi-page agreements can exhaust a smaller budget on thinking and emit no text
          thinking: { type: 'adaptive' },
          system,
          messages: [{ role: 'user', content: userContent }],
        });
        const resp = await stream.finalMessage();

        // Skip non-text blocks (e.g. thinking blocks) and read the first text block.
        const textBlock = resp.content.find((b) => b.type === 'text');
        const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
        if (!text) {
          // Empty text (e.g. budget consumed by thinking) — retry within budget.
          lastError = 'Claude returned no text content.';
          if (attempt < MAX_ATTEMPTS - 1) { await sleep(backoffMs(attempt)); continue; }
          return { ok: false, error: lastError, errorKind: 'no_text', modelUsed: resp.model };
        }

        const parsed = parseIntakeResponse(text);
        if (!parsed.ok) {
          // A malformed/short JSON can be a one-off model hiccup — retry once or twice.
          lastError = parsed.error;
          if (attempt < MAX_ATTEMPTS - 1) { await sleep(backoffMs(attempt)); continue; }
          return { ok: false, error: parsed.error, errorKind: 'parse', modelUsed: resp.model };
        }

        return { ok: true, intent: parsed.intent, modelUsed: resp.model };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (isTransient(err) && attempt < MAX_ATTEMPTS - 1) { await sleep(backoffMs(attempt)); continue; }
        return { ok: false, error: lastError, errorKind: classifyApiError(err) };
      }
    }
    return { ok: false, error: lastError, errorKind: 'unavailable' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), errorKind: classifyApiError(err) };
  }
}
