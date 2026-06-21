import { z } from 'zod';

/** Bookable investment event types (same closed set as the engine's InvestmentEventType). */
export const INVESTMENT_EVENT_TYPES = [
  'ACQUISITION',
  'DISPOSAL',
  'LOAN_ADVANCE',
  'LOAN_REPAYMENT',
  'DISTRIBUTION',
  'INTEREST_ACCRUAL',
  'FX_REVAL',
  'WRITE_OFF',
] as const;

/**
 * Figures transcribed from the document, in the document's own currency. NEVER computed.
 * Deliberately excludes carrying cost / cost basis: that is a ledger-derived figure the
 * deterministic engine owns (accumulated from prior acquisitions via the position
 * roll-forward) and must never be authored by the model. `fairValue` is kept because a
 * board/IPEV valuation is genuinely printed in the source document (read, not computed).
 */
export const sourceFiguresSchema = z.object({
  amount: z.number(),
  quantity: z.number().nullable().default(null),
  fairValue: z.number().nullable().default(null),
});

// Soft, descriptive metadata (prose explanations, citations, confidence) is made
// lenient on purpose: the model occasionally omits one, and a missing explanation
// must NEVER reject an otherwise-good read. The accounting signal that the engine
// actually needs (event type, instrument, currency, date, amount) stays strict.
const rationale = z.string().default('').catch('');
const citation = z.string().default('').catch('');

export const investmentEventIntentSchema = z.object({
  kind: z.literal('EVENT'),
  investeeName: z.string().min(1),
  instrument: z.enum(['SHARES', 'LOAN']),
  eventType: z.enum(INVESTMENT_EVENT_TYPES),
  currency: z.string().min(1).default('EUR').catch('EUR'), // ISO 4217 (lenient)
  txnDate: z.string().default('').catch(''), // ISO date string, as read
  sourceFigures: sourceFiguresSchema,
  // Missing confidence defaults; an out-of-range number is still rejected.
  confidence: z.number().min(0).max(1).default(0.6),
  citation,
  rationale,
  needsReview: z.boolean().default(false).catch(false),
});

export const evidenceIntentSchema = z.object({
  kind: z.literal('EVIDENCE'),
  documentType: z.string().default('document').catch('document'),
  investeeName: z.string().nullable().default(null).catch(null),
  rationale,
});

export const unknownIntentSchema = z.object({
  kind: z.literal('UNKNOWN'),
  rationale,
  needsReview: z.literal(true).default(true).catch(true),
});

export const intakeIntentSchema = z.discriminatedUnion('kind', [
  investmentEventIntentSchema,
  evidenceIntentSchema,
  unknownIntentSchema,
]);

export type InvestmentEventIntent = z.infer<typeof investmentEventIntentSchema>;
export type EvidenceIntent = z.infer<typeof evidenceIntentSchema>;
export type UnknownIntent = z.infer<typeof unknownIntentSchema>;
export type IntakeIntent = z.infer<typeof intakeIntentSchema>;
