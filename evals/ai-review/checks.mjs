// What an eval run is judged on. Contract checks hold for every case, and
// any failure fails the run: the review must be able to do its job at all
// (no tool call refused, a verdict and a findings list that parse). Behavior
// checks come from each case's `expect` and are scored, since a model's
// answers vary from run to run. Pure, so the tests can run them on samples.

const LEDGER = /<!-- ai-review-ledger (\{.*?\}) -->/gs;

/** The last findings list in a summary, or null. */
export function ledgerOf(summary) {
  const lists = [...(summary ?? "").matchAll(LEDGER)];
  try {
    return lists.length ? JSON.parse(lists.at(-1)[1]) : null;
  } catch {
    return null;
  }
}

const important = text => /^\s*\**\s*\w+,\s*Important\b/i.test(text ?? "");
const near = (f, path, from, to) => f.path === path && Number(f.line) >= from && Number(f.line) <= to;

/** Every check for one case: [{name, contract, ok, detail}], plus notes
 * ({note: true}) that count for nothing. `run` is
 * {result, verdict, summary, inline, head}: the claude JSON result, the
 * parsed verdict.json (or null), the posted summary text, the inline
 * comments the review would have posted, and the head SHA under review. */
export function checks(expect = {}, run) {
  const out = [];
  const add = (name, contract, ok, detail = "") => out.push({ name, contract, ok: Boolean(ok), detail });
  // The review's own outputs (a file it writes, the summary it posts) must
  // never be refused: that is how #128's verdict went missing. Refused
  // exploration (reading the head's files, which the workflow withholds) is
  // reported, not failed.
  const denials = run.result?.permission_denials ?? [];
  const own = d => ["Write", "Edit"].includes(d.tool_name) || /^\s*gh pr comment\b/.test(d.tool_input?.command ?? "");
  const describe = list => list.map(d => `${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 80)}`).join("; ");
  add("the review ran and none of its own writes was refused", true, run.result && !denials.some(own), describe(denials.filter(own)));
  if (denials.some(d => !own(d))) out.push({ name: `refused, not counted: ${describe(denials.filter(d => !own(d)))}`, note: true, ok: true });
  add("verdict.json counts Important findings", true, Number.isInteger(run.verdict?.important) && run.verdict.important >= 0,
    JSON.stringify(run.verdict));
  add("a summary was posted", true, (run.summary ?? "").trim() !== "");
  const ledger = ledgerOf(run.summary);
  add("the summary ends with a findings list for this head", true,
    ledger && Array.isArray(ledger.findings) && String(run.head).startsWith(String(ledger.sha).slice(0, 7)),
    ledger ? `sha ${ledger.sha}` : "none");

  const findings = [
    ...(ledger?.findings ?? []).filter(f => f.severity === "Important" && f.status === "open"),
    ...(run.inline ?? []).filter(c => important(c.body)),
  ];
  if (expect.importantMax !== undefined)
    add(`at most ${expect.importantMax} Important`, false, run.verdict?.important <= expect.importantMax, `verdict ${run.verdict?.important}`);
  if (expect.importantMin !== undefined)
    add(`at least ${expect.importantMin} Important`, false, run.verdict?.important >= expect.importantMin, `verdict ${run.verdict?.important}`);
  for (const f of expect.mustFlag ?? [])
    add(`flags ${f.path}:${f.from}-${f.to} as Important (${f.what})`, false, findings.some(x => near(x, f.path, f.from, f.to)));
  for (const f of expect.mustNotRaise ?? [])
    add(`no new comment on ${f.path} raising "${f.word}"`, false,
      !(run.inline ?? []).some(c => c.path === f.path && c.body.toLowerCase().includes(f.word.toLowerCase())));
  for (const [id, statuses] of Object.entries(expect.ledgerStatus ?? {})) {
    const status = ledger?.findings?.find(f => f.id === id)?.status;
    add(`${id} is ${statuses.join(" or ")}`, false, statuses.includes(status), `found ${status ?? "nothing"}`);
  }
  return out;
}
