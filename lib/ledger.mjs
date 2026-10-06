// The ai-review ledger (.github/workflows/ai-review.yml): every review round's
// summary comment ends with one hidden HTML comment holding the sha it
// reviewed and the findings list every round carries forward — a finding's
// status now, whatever an earlier round said. One parser, so everything that
// reads a ledger reads the same one: a body without a ledger, and one whose
// list does not parse, read as none (#159).
export const LEDGER_MARK = "<!-- ai-review-ledger ";

/** The ledger a comment body carries, or null: `{ sha, findings }`. The last
 * marker wins — a quote of an earlier summary sits above the writer's own,
 * the way ai-review itself reads the thread back. */
export function ledgerOf(body) {
  const text = String(body ?? "");
  const at = text.lastIndexOf(LEDGER_MARK);
  if (at === -1) return null;
  const end = text.indexOf("-->", at + LEDGER_MARK.length);
  if (end === -1) return null;
  try {
    const ledger = JSON.parse(text.slice(at + LEDGER_MARK.length, end).trim());
    if (typeof ledger?.sha !== "string" || !Array.isArray(ledger.findings)) return null;
    return ledger;
  } catch {
    return null;
  }
}

/** The findings of a ledger that hold work open: Important, and still open.
 * A Nit, and a finding fixed, withdrawn or accepted, asks nobody for a round. */
export const openImportants = ledger =>
  (ledger?.findings ?? []).filter(f => f?.severity === "Important" && f?.status === "open");
