export interface IntakeContext {
  /** Original file name (a classification signal). */
  fileName: string;
  /** Relative folder path, e.g. "SHARES/DISPOSAL/GAMIVO S.A" (a strong signal). */
  folderPath: string;
  /** Known investees for matching: canonical name + aliases. */
  investees: Array<{ name: string; aliases: string[] }>;
  /** Extracted document text. If absent, a PDF is attached to the message instead. */
  documentText?: string;
}

const SYSTEM = `You are AG-A11, an intake agent for VC fund investment accounting.
Your ONLY job is to READ a source document and EXTRACT structured facts about it.
You must NEVER compute, derive, or infer any figure. Journals, valuations, FX conversions,
gains/losses, and totals are produced by a separate deterministic engine, not by you.
Report monetary amounts and quantities EXACTLY as they appear in the document, in the
document's own currency.

Classify the document with "kind":
- "EVENT": it records a bookable investment event (share purchase/sale, loan advance/repayment,
  capital call, distribution/dividend, interest, FX revaluation, or write-off).
- "EVIDENCE": supporting material that is not itself a bookable event (registry/company-house
  extract, memorandum & articles, beneficial-owner or risk assessment, KYC).
- "UNKNOWN": you cannot tell — set needsReview=true.

Use the folder path and file name as strong signals (e.g. ".../SHARES/DISPOSAL/<investee>/..."
indicates a DISPOSAL of shares in <investee>). Match the investee to the provided roster by name
or alias; if none matches, use the name exactly as written in the document.

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

  const user = `File name: ${ctx.fileName}
Folder path: ${ctx.folderPath}

Known investees (roster):
${roster}

${docSection}

Return the JSON intent now.`;

  return { system: SYSTEM, user };
}
