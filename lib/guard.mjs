// Board writes that only the bot or an owner may make, undone otherwise:
// the labels that gate who may claim a task (lib/seats.mjs), and the closes
// of tasks and job epics. Triage on the board lets anyone with it flip a gate
// label or close an issue, and GitHub records the actor of each change as an
// issue event, so the coordinator reads an issue's events, checks each
// relevant actor with isTrusted, and puts a stranger's change back.
import { comment, epicIssues, fenced, github, isTrusted, issue } from "./github.mjs";

// The labels that decide eligibility (`lib/seats.mjs`); a team sets exactly
// one of them on every task it creates (lib/team.mjs).
export const GATE_LABELS = ["agent-eligible", "human-only"];

// A label change or close past the first 100 events must still be seen, so
// this follows pagination the way comments() does (lib/github.mjs).
const EVENT_PAGES = 50;

/** An issue's events, oldest first, every page of them: the latest event for
 * a label, and the latest close, sit on the last page. */
export async function allEvents(number) {
  const found = [];
  for (let page = 1; page <= EVENT_PAGES; page++) {
    const batch = await github("GET", `/issues/${number}/events?per_page=100&page=${page}`);
    found.push(...batch);
    if (batch.length < 100) return found;
  }
  throw new Error(`more than ${EVENT_PAGES * 100} events on issue ${number}`);
}

/**
 * How a gate label's trail reads as far as the bot and owners are concerned:
 * `intended`, the state their latest event in the trail left it in — or the
 * state before a stranger's first change when the whole trail is theirs —
 * with `latest`, the trail's last event, and `stranger`, the untrusted actor
 * to name (their latest change, or their first when there is no baseline).
 * Null when the label has no trail: it was set at creation and has no actor
 * to check.
 */
async function gateState(trail, trusted) {
  if (!trail.length) return null;
  const latest = trail.at(-1);
  if (await trusted(latest.actor?.login)) {
    return { intended: latest.event === "labeled" ? "present" : "absent", latest, stranger: latest.actor?.login };
  }
  let baseline = null;
  for (const e of trail) if (await trusted(e.actor?.login)) baseline = e;
  if (baseline) {
    return { intended: baseline.event === "labeled" ? "present" : "absent", latest, stranger: latest.actor?.login };
  }
  return { intended: trail[0].event === "labeled" ? "absent" : "present", latest, stranger: trail[0].actor?.login };
}

/**
 * The gate-label changes nobody trusted made, oldest last, each with the
 * restore it needs: the label put back the state the bot and owners last
 * left it in, so however many changes a stranger made, even a flip they
 * flipped back, cannot turn into removing a label an owner set or adding
 * one nobody did. The latest event having been the bot's or an owner's own,
 * or a stranger's trail that nets to nothing, leaves the label as it stands.
 */
export async function gateChanges(events, trusted = isTrusted) {
  const changes = [];
  for (const label of GATE_LABELS) {
    const trail = events
      .filter(e => (e.event === "labeled" || e.event === "unlabeled") && e.label?.name === label);
    const state = await gateState(trail, trusted);
    if (state === null) continue;
    if ((state.latest.event === "labeled" ? "present" : "absent") === state.intended) continue;
    changes.push({ label, restore: state.intended === "present" ? "add" : "remove", actor: state.stranger });
  }
  return changes;
}

/**
 * Put the gate labels a stranger changed on this seat back the way they were,
 * and comment on the task naming who changed each. `seat` is one seat as
 * openSeats() returns it; a change an owner has already redone since the seat
 * was read — the label no longer missing, or no longer there — is left as it
 * stands. Returns the changes restored.
 */
export async function restoreGateLabels(seat) {
  const changes = (await gateChanges(await allEvents(seat.number)))
    // A restore applies only while the seat's state differs from the one it
    // brings back: a stranger's flip they have already flipped back, like a
    // change an owner has already redone since the seat was read, is left as
    // it stands.
    .filter(({ label, restore }) => seat.labels.includes(label) === (restore === "remove"));
  for (const { label, restore, actor } of changes) {
    if (restore === "add") {
      await github("POST", `/issues/${seat.number}/labels`, { labels: [label] });
    } else {
      await github("DELETE", `/issues/${seat.number}/labels/${encodeURIComponent(label)}`).catch(error => {
        if (!String(error.message).includes(": 404")) throw error;
      });
    }
    console.log(`coordinator: #${seat.number} \`${label}\` ${restore === "add" ? "restored" : "removed again"} (@${actor} changed it)`);
  }
  if (changes.length) {
    await comment(seat.number, changes.map(({ label, restore, actor }) =>
      restore === "add"
        ? `@${actor} removed \`${label}\` on this task; only the bot or an owner can change the labels that gate claims, so it is back.`
        : `@${actor} added \`${label}\` on this task; only the bot or an owner can set the labels that gate claims, so it is removed again.`)
      .join(" "));
  }
  return changes;
}

/**
 * Why a claim on this seat does not count while the gate label it relies on
 * does not stand as the bot and owners left it, or null. Restoring a gate
 * label races `/claim`, so this is checked when the claim settles, not only
 * when the label is restored: the state the claim rides on is the one the
 * trail's trusted events warrant. A stranger's removal being put back leaves
 * the bot's `labeled` event latest, and the claim carries; a stranger's
 * re-add of a label their own removal had taken off — or of one nobody set —
 * refuses the claim, naming who set it, until an owner's event is latest.
 */
export async function labelGateProblem(seat, trusted = isTrusted) {
  const label = seat.labels.includes("agent-eligible") ? "agent-eligible"
    : seat.labels.includes("human-only") ? "human-only"
    : null;
  if (!label) return null;
  const trail = (await allEvents(seat.number))
    .filter(e => (e.event === "labeled" || e.event === "unlabeled") && e.label?.name === label);
  const state = await gateState(trail, trusted);
  if (state === null || state.intended === "present") return null;
  const lastLabeled = trail.filter(e => e.event === "labeled").at(-1);
  if (!lastLabeled || (await trusted(lastLabeled.actor?.login))) return null;
  return `its \`${label}\` label was set by @${lastLabeled.actor.login}, not the bot or an owner`;
}

// Closes already verified trusted, by issue: the close they were verified for.
// A close's actor cannot change while the issue stays closed, so each close is
// read from the events once however often promote, the payout sweep or the
// epic settle looks at it; a process restart verifies each once more.
const verifiedCloses = new Map();

// An issue can be closed more than once — the bot closes a delivered task,
// a change request reopens it — so only an event of the close at hand may
// evidence it: an earlier round's `closed` event, however trusted, is seconds
// or more older than this close, and must not vouch for it. GitHub writes a
// close's event at the close's own instant; the allowance is clock skew.
const CLOSE_EVENT_SKEW_MS = 2000;

/**
 * Whether this close stands — made by the bot or an owner, GitHub's `closed`
 * event says who — reopening the issue with a comment when it does not. A
 * close whose event is not indexed yet is checked against the issue's own
 * `closed_by` in the meantime, so a stranger's close read during that lag is
 * reopened at once rather than counted; with neither readable there is no
 * actor to blame, and it counts until one is. Such an unproven close is never
 * memoized, so each pass re-checks it rather than trusting it for the life of
 * the process.
 */
export async function closeVerified(number, closedAt, what = "task") {
  if (!closedAt || verifiedCloses.get(number) === closedAt) return true;
  const closed = (await allEvents(number))
    .filter(e => e.event === "closed" && Date.parse(e.created_at) >= Date.parse(closedAt) - CLOSE_EVENT_SKEW_MS)
    .at(-1);
  if (closed && (await isTrusted(closed.actor?.login))) {
    verifiedCloses.set(number, closedAt);
    return true;
  }
  // The events were read a request ago: re-read the issue before its first
  // visible effect, so a close made since — a proper one — is not undone.
  const live = await issue(number);
  if (live.state !== "closed" || live.closed_at !== closedAt) return false;
  const actor = closed?.actor?.login ?? live.closed_by?.login ?? null;
  if (actor && !(await isTrusted(actor))) return reopenStrangersClose(number, live, actor, what);
  return true;
}

async function reopenStrangersClose(number, live, actor, what) {
  await github("PATCH", `/issues/${number}`, { state: "open" });
  // Tidy strips a closed seat's status label, so a reopened task resumes
  // with the one its state calls for: claimed work continues, and an
  // unclaimed task waits on its dependencies or is open to claim — the
  // label promote would have left it wearing — or the coordinator would
  // never act on it again.
  if (what === "task") {
    const resume = await resumeLabel(live);
    if (!(live.labels ?? []).some(l => l.name === resume)) {
      await github("POST", `/issues/${number}/labels`, { labels: [resume] });
    }
  }
  await comment(number, `@${actor} closed this ${what} by hand; only the bot or an owner can close a ${what}, so it is open again.${what === "task" ? " Deliver with a handoff to close it." : ""}`);
  console.log(`coordinator: #${number} reopened (${actor} closed it by hand)`);
  return false;
}

// The status label a reopened task resumes under, from the issue as re-read:
// an unclaimed task with an open dependency is still blocked, one whose
// dependencies are done is ready to claim, and a claimed one is in progress.
async function resumeLabel(live) {
  if ((live.assignees ?? []).length) return "in-progress";
  const dependsOn = [...(live.body ?? "").matchAll(/^- \[[ x]\] #(\d+)/gm)].map(m => Number(m[1]));
  if (dependsOn.length) {
    const parents = await Promise.all(dependsOn.map(n => issue(n)));
    if (parents.some(p => p.state !== "closed")) return "blocked";
  }
  return "ready";
}

/**
 * The job epics updated since `since`: each closed one is checked the same
 * way, however it was closed — with a team on it (settleClosedEpics sees only
 * those still wearing `blocked`) or before one was assembled, where a close by
 * hand hides the job from the approval and payout sweeps, which read open
 * jobs only. Pass `new Date(...).toISOString()`; callers keep the watermark.
 */
export async function auditClosedEpics(since, list = epicIssues) {
  for (const epic of await list(since)) {
    if (epic.pull_request || epic.state !== "closed" || !fenced(epic.body, "engagement")) continue;
    await closeVerified(epic.number, epic.closed_at, "job");
  }
}
