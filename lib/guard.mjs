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
 * The gate-label changes nobody trusted made, oldest last: the latest
 * `labeled`/`unlabeled` event for each gate label, with the restore it needs —
 * an untrusted add is removed again, an untrusted removal put back. A gate
 * label with no label event was set at creation and has no actor to check.
 */
export async function gateChanges(events, trusted = isTrusted) {
  const changes = [];
  for (const label of GATE_LABELS) {
    const latest = events
      .filter(e => (e.event === "labeled" || e.event === "unlabeled") && e.label?.name === label)
      .at(-1);
    if (latest && !(await trusted(latest.actor?.login))) {
      changes.push({ label, restore: latest.event === "labeled" ? "remove" : "add", actor: latest.actor.login });
    }
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
    // A stranger's add is undone while the label is on the seat, a stranger's
    // removal while it is off: the state each restore brings back.
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
 * stands as a stranger set it, or null. Restoring a gate label races `/claim`,
 * so this is checked when the claim settles, not only when the label is
 * restored: the latest `labeled` event for the gate label the claim relies on
 * (the one of the pair the seat carries) must come from the bot or an owner.
 */
export async function labelGateProblem(seat, trusted = isTrusted) {
  const label = seat.labels.includes("agent-eligible") ? "agent-eligible"
    : seat.labels.includes("human-only") ? "human-only"
    : null;
  if (!label) return null;
  const latest = (await allEvents(seat.number))
    .filter(e => e.event === "labeled" && e.label?.name === label)
    .at(-1);
  if (!latest || (await trusted(latest.actor?.login))) return null;
  return `its \`${label}\` label was set by @${latest.actor.login}, not the bot or an owner`;
}

// Closes already verified trusted, by issue: the close they were verified for.
// A close's actor cannot change while the issue stays closed, so each close is
// read from the events once however often promote, the payout sweep or the
// epic settle looks at it; a process restart verifies each once more.
const verifiedCloses = new Map();

/**
 * Whether this close stands — made by the bot or an owner, GitHub's `closed`
 * event says who — reopening the issue with a comment when it does not. A
 * close with no `closed` event has no actor to blame: nothing on the board
 * closes an issue without one, so it reads as the coordinator's own close
 * whose event has not become readable yet, and reopening it would flap.
 */
export async function closeVerified(number, closedAt, what = "task") {
  if (!closedAt || verifiedCloses.get(number) === closedAt) return true;
  const closed = (await allEvents(number)).filter(e => e.event === "closed").at(-1);
  if (closed && !(await isTrusted(closed.actor?.login))) {
    // The events were read a request ago: re-read the issue before its first
    // visible effect, so a close made since — a proper one — is not undone.
    const live = await issue(number);
    if (live.state !== "closed" || live.closed_at !== closedAt) return false;
    await github("PATCH", `/issues/${number}`, { state: "open" });
    await comment(number, `@${closed.actor?.login ?? "someone"} closed this ${what} by hand; only the bot or an owner can close a ${what}, so it is open again.${what === "task" ? " Deliver with a handoff to close it." : ""}`);
    console.log(`coordinator: #${number} reopened (${closed.actor?.login ?? "someone"} closed it by hand)`);
    return false;
  }
  verifiedCloses.set(number, closedAt);
  return true;
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
