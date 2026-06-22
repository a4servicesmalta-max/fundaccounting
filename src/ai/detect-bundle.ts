// Bundle detector: decide whether ONE uploaded PDF actually contains SEVERAL
// distinct documents (a bank statement + an invoice + an agreement scanned into a
// single file) and, if so, where each one starts and ends. The AI ONLY reports
// page ranges + a coarse category — it never extracts figures (each sub-document
// is read in full afterwards by the normal intake). Conservative by design: when
// in doubt it returns a single document, so a long single agreement is never
// chopped up.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ExtractContent } from './claude';

const segmentSchema = z.object({
  category: z.string(),
  title: z.string().default(''),
  pageStart: z.number(),
  pageEnd: z.number(),
});

const bundleSchema = z.object({
  documents: z.array(segmentSchema),
});

export type DetectedSegment = z.infer<typeof segmentSchema>;

export interface DetectBundleInput {
  fileName: string;
  content: ExtractContent;
  pageCount: number;
}

export interface DetectBundleResult {
  ok: boolean;
  documents: DetectedSegment[];
  error?: string;
  modelUsed?: string;
}

export type StructuredCaller = (args: {
  system: string;
  user: string;
  content: ExtractContent;
}) => Promise<{ text: string; modelUsed?: string }>;

export interface DetectBundleDeps {
  call?: StructuredCaller;
}

export function buildBundlePrompt(input: DetectBundleInput): { system: string; user: string } {
  const system = [
    'You segment a scanned/merged PDF for an investment fund\'s bookkeeping.',
    'Decide whether this ONE file contains SEVERAL separate documents (e.g. a bank statement, an invoice, a share purchase agreement, a dividend resolution) or just ONE document.',
    'Be conservative: a single long agreement, a single multi-page bank statement, or a single financial-statement set is ONE document — do NOT split it. Only report multiple documents when the file clearly concatenates DIFFERENT documents (different headers/issuers/types).',
    'Report only page boundaries and a coarse category — never extract or invent any figure.',
    'Respond with JSON ONLY — no prose, no markdown fences.',
  ].join(' ');

  const user = [
    `This PDF (file: ${input.fileName}) has ${input.pageCount} page(s).`,
    'Return the distinct documents it contains, each with 1-based inclusive page ranges:',
    '- category: one of bank_statement, invoice, agreement, resolution, financial_statement, registry, other',
    '- title: a short label (issuer / document name) if visible, else ""',
    '- pageStart, pageEnd: 1-based inclusive page numbers within this file',
    'If the file is a SINGLE document, return exactly one entry spanning all pages.',
    '',
    'Return EXACTLY this JSON shape and nothing else:',
    '{"documents":[{"category":"","title":"","pageStart":1,"pageEnd":1}]}',
    input.content.kind === 'text' && input.content.text
      ? `\nDocument text:\n${input.content.text}`
      : '',
  ].join('\n');

  return { system, user };
}

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

const defaultCaller: StructuredCaller = async ({ system, user, content }) => {
  const client = new Anthropic();
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
  // Segmentation is a light task (page boundaries only) — a modest budget is enough.
  const stream = client.messages.stream({
    model,
    max_tokens: 6000,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  const resp = await stream.finalMessage();
  const textBlock = resp.content.find((b) => b.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  return { text, modelUsed: resp.model };
};

/** Detect the documents inside a PDF. Never throws — failures return ok:false with
 *  an empty list so the caller falls back to treating the file as one document. */
export async function detectBundle(
  input: DetectBundleInput,
  deps?: DetectBundleDeps,
): Promise<DetectBundleResult> {
  try {
    const call = deps?.call ?? defaultCaller;
    if (!deps?.call && !process.env.ANTHROPIC_API_KEY) {
      return { ok: false, documents: [], error: 'No ANTHROPIC_API_KEY set.' };
    }
    const { system, user } = buildBundlePrompt(input);
    const { text, modelUsed } = await call({ system, user, content: input.content });
    if (!text) return { ok: false, documents: [], error: 'Claude returned no text content.', modelUsed };

    let raw: unknown;
    try {
      raw = extractJsonObject(text);
    } catch (err) {
      return { ok: false, documents: [], error: err instanceof Error ? err.message : 'parse error', modelUsed };
    }
    const parsed = bundleSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, documents: [], error: parsed.error.message, modelUsed };
    return { ok: true, documents: parsed.data.documents, modelUsed };
  } catch (err) {
    return { ok: false, documents: [], error: err instanceof Error ? err.message : String(err) };
  }
}
