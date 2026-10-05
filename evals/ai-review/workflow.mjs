// What the evals run is read from .github/workflows/ai-review.yml itself, so
// they test the review as configured, never a copy that can drift: the
// prompt, the claude_args (tools, turns, model), and the run script of the
// "Earlier rounds" step that builds the reviewer's memory. Dependency-free:
// a literal block (`key: |`) is every following line indented deeper than
// its key, blank lines included. Pure, so the tests can hold it to the real
// file.

/** The literal block under the first `key: |` at or after line `from`. */
export function literalBlock(lines, key, from = 0) {
  for (let i = from; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^(\\s*)(?:- )?${key}: \\|\\s*$`));
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== "" && lines[j].search(/\S/) <= indent) break;
      body.push(lines[j]);
    }
    while (body.length && body.at(-1).trim() === "") body.pop();
    const cut = Math.min(...body.filter(l => l.trim()).map(l => l.search(/\S/)));
    return body.map(l => l.slice(cut)).join("\n");
  }
  throw new Error(`no "${key}: |" block in the workflow`);
}

/** The run script of the step named `name`. */
function stepScript(lines, name) {
  const step = lines.findIndex(l => new RegExp(`^\\s*- name: ${name}\\s*$`).test(l));
  if (step === -1) throw new Error(`no "${name}" step in the workflow`);
  return literalBlock(lines, "run", step);
}

/** The prompt, the claude_args, and the scripts of the steps around the
 * review: "Earlier rounds" (its memory) and "Verdict" (what the gate reads). */
export function reviewConfig(text) {
  const lines = text.split("\n");
  return {
    prompt: literalBlock(lines, "prompt"),
    claudeArgs: literalBlock(lines, "claude_args"),
    earlierRounds: stepScript(lines, "Earlier rounds"),
    verdict: stepScript(lines, "Verdict"),
  };
}

/** `${{ expr }}` replaced from `values`, keyed by the expression's text. An
 * expression the evals don't know is an error, not a blank. */
export function interpolate(text, values) {
  return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expr) => {
    if (!(expr in values)) throw new Error(`the evals have no value for \${{ ${expr} }}`);
    return values[expr];
  });
}

/** claude_args split the way a shell would: whitespace outside double quotes. */
export function splitArgs(text) {
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
}
