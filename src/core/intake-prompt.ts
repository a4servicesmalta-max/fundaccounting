export interface IntakeContext {
  /** Original file name (a classification signal). */
  fileName: string;
  /** Relative folder path, e.g. "SHARES/DISPOSAL/GAMIVO S.A" (a strong signal). */
  folderPath: string;
  /** Known investees for matching: canonical name + aliases. */
  investees: Array<{ name: string; aliases: string[] }>;
  /** Extracted document text. If absent, a PDF is attached to the message instead. */
  documentText?: string;
  /** The reporting entity whose books these are (the fund/holder). Used to decide
   *  event DIRECTION: a Sale & Purchase Agreement has a buyer and a seller, and the
   *  reporting entity may be either — which side it is on flips ACQUISITION vs
   *  DISPOSAL. When absent, the agent infers the holder from context. */
  reportingEntity?: string;
}

const SYSTEM = `You are AG-A11, an intake agent for VC fund investment accounting.
Your ONLY job is to READ a source document and EXTRACT structured facts about it.
You must NEVER compute, derive, or infer any figure. Journals, valuations, FX conversions,
gains/losses, and totals are produced by a separate deterministic engine, not by you.
Report monetary amounts and quantities EXACTLY as they appear in the document, in the
document's own currency.

Classify the document with "kind":
- "EVENT": it records a bookable investment event — a share purchase/sale, loan advance/
  repayment, capital call, distribution/dividend, interest, FX revaluation, write-off, OR
  a **purchase or sale/assignment of a receivable or claim (debt purchase / factoring)**.
  An agreement under which the reporting entity BUYS or SELLS a claim/receivable for a price
  is a bookable EVENT (not mere supporting evidence): give its purchase price as the amount.
- "EVIDENCE": supporting material that is not itself a bookable event (registry/company-house
  extract, memorandum & articles, beneficial-owner or risk assessment, KYC).
- "UNKNOWN": you cannot tell — set needsReview=true.

EVENT DIRECTION — classify from the REPORTING ENTITY'S perspective (the fund/holder
whose books these are; it is given to you as "Reporting entity" when known, and is
NEVER one of the roster investees — the investees are the companies it invests IN).
A Sale & Purchase Agreement (SPA), share transfer, or sale order ALWAYS has a buyer
and a seller, and the reporting entity may be EITHER. Do not infer direction from the
words "sale"/"SPA"/"transfer" alone — identify which side the reporting entity is on:
- Reporting entity BUYS / acquires / subscribes for shares  → eventType "ACQUISITION"
- Reporting entity SELLS / disposes / transfers OUT its shares → eventType "DISPOSAL"
- Reporting entity LENDS / advances funds → "LOAN_ADVANCE"; receives repayment → "LOAN_REPAYMENT"
The document usually states the roles explicitly (e.g. "the Fund, as Seller", or
"acquisition by the Buyer [the Fund]") — use that. When a document clearly records an
investment transaction, return a TYPED eventType (ACQUISITION/DISPOSAL/LOAN_ADVANCE/
LOAN_REPAYMENT/DISTRIBUTION/INTEREST/FX_REVAL/WRITE_OFF) rather than leaving it generic.

Use the folder path and file name as supporting signals (e.g. ".../SHARES/DISPOSAL/<investee>/..."
suggests a DISPOSAL of shares in <investee>), but the document's stated roles and the
reporting entity's side OVERRIDE a folder name when they conflict. Match the investee to
the provided roster by name or alias; if none matches, use the name exactly as written.

Return ONLY a single JSON object. No prose and no markdown code fences.`;

export function buildIntakePrompt(ctx: IntakeContext): { system: string; user: string } {
  const roster = ctx.investees.length
    ? ctx.investees
        .map((i) => `- ${i.name}${i.aliases.length ? ` (aliases: ${i.aliases.join(', ')})` : ''}`)
        .join('\n')
    : '(none provided)';

  const docSection = ctx.documentText
    ? `Document text:\n"""\n${ctx.documentText}\n"""`
    : 'The document is attached as a PDF to this message.';

  const entityLine = ctx.reportingEntity
    ? `Reporting entity (the fund whose books these are): ${ctx.reportingEntity}\n`
    : '';

  const user = `File name: ${ctx.fileName}
Folder path: ${ctx.folderPath}
${entityLine}
Known investees (roster):
${roster}

${docSection}

Return the JSON intent now.`;

  return { system: SYSTEM, user };
}
