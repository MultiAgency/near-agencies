// What a reviewer's comment means, read by Jev (TypeSafe's System One model)
// instead of a prefix match. Shadow mode: the coordinator still routes change
// requests by isChangeRequest; each reviewer comment is also judged once (again
// after an edit), and every verdict is logged beside the regex's, with the
// disagreements kept for /api/health. Off without TYPESAFE_API_KEY.
const KEY = process.env.TYPESAFE_API_KEY;
// Pinned, so answers cannot shift under the trial when the jev-latest alias moves.
const MODEL = process.env.TYPESAFE_MODEL ?? "jev-1.13.0";
const TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS ?? "10000");
const KEEP = 50;

// Tested against the board's own review comments and 16 other phrasings: every
// change request found, no sign-off or handoff fix mistaken for one.
const INTENTS = {
  change_request: "Asks the contributor to revise the deliverable before it can be accepted (another round).",
  sign_off: "Accepts the deliverable as it stands; no further revision is required, even if it mentions earlier rounds or optional nits.",
  question: "Asks for information or clarification without yet accepting or requesting changes.",
  handoff_fix: "Asks only for a fix to the handoff comment or its formatting (for example a missing fence or field); the deliverable itself needs no revision.",
  other: "Anything else: claiming the task, scheduling, test notes, or status.",
};

/** { intent, confidence } for a comment the task's reviewer posted. */
export async function reviewIntent(body) {
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      state: { comment: body },
      questions: {
        intent: {
          type: "choice",
          instructions: "The reviewer of a task posted `comment` on it. What does the comment do to the task's deliverable?",
          criteria: INTENTS,
        },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`TypeSafe ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const { intent } = (await response.json()).answers;
  return { intent: intent.choice, confidence: intent.confidence };
}

const judged = new Map(); // comment id -> the updated_at it was judged at
const stats = { model: MODEL, judged: 0, disagreements: 0, errors: 0, recent: [] };

/**
 * Judge a reviewer's comment beside the regex's verdict, once per version of
 * the comment. Never throws: a failed call is counted and not retried, so an
 * outage cannot slow every cycle.
 */
export async function shadowJudge(comment, regexSaysChanges) {
  if (!KEY || judged.get(comment.id) === comment.updated_at) return;
  judged.set(comment.id, comment.updated_at);
  try {
    const { intent, confidence } = await reviewIntent(comment.body);
    stats.judged += 1;
    const agrees = (intent === "change_request") === regexSaysChanges;
    console.log(`judge: ${comment.html_url} jev=${intent} ${confidence.toFixed(2)} regex=${regexSaysChanges ? "change_request" : "no"}${agrees ? "" : " DISAGREE"}`);
    if (agrees) return;
    stats.disagreements += 1;
    stats.recent = [{ url: comment.html_url, jev: intent, confidence, regex: regexSaysChanges, at: new Date().toISOString() }, ...stats.recent].slice(0, KEEP);
  } catch (error) {
    stats.errors += 1;
    console.error(`judge: ${comment.html_url}: ${error.message}`);
  }
}

export const judgeHealth = () => (KEY ? { ...stats } : null);
