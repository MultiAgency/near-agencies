// An engagement as a relay between its participants: every event on the epic
// and its seats, placed in the lane of whoever acted — the client, the
// coordinator, the maintainer, each contributor, the DAO treasury — for the
// engagement page's swimlane. Events are recognised by the same markers the
// board's tools write, so nothing here is inferred.
import { isChangeRequest } from "./coordinator.mjs";
import { comments, fenced, issue, markdownHtml } from "./github.mjs";
import { cached } from "./cache.mjs";
import { byGithub } from "./roster.mjs";

const MAINTAINER = "<!-- multiagency-maintainer -->";

/** The lane and kind of one board comment, or null for chatter. Pure. */
export function classify(body, author) {
  const text = body.trim();
  if (text.includes(MAINTAINER)) {
    const kind = text.includes("```team-draft") ? "team-draft" : /retrospective/i.test(text) ? "retrospective" : "note";
    return { lane: "maintainer", kind };
  }
  if (text.startsWith("**Payout proposed:**")) return { lane: "treasury", kind: "payout-proposed" };
  if (text.startsWith("**Paid:**")) return { lane: "treasury", kind: "paid" };
  if (text.startsWith("**Engagement complete.**")) return { lane: "treasury", kind: "complete" };
  if (text.startsWith("Claimed by @")) return { lane: "coordinator", kind: "assigned" };
  if (text.startsWith("Dependencies ")) return { lane: "coordinator", kind: "seat-opened" };
  if (text.startsWith("**Changes requested** by")) return { lane: "coordinator", kind: "reopened" };
  if (/^\/claim\b/i.test(text)) return { lane: author, kind: "claim" };
  if (text.startsWith("**Deliverable**")) return { lane: author, kind: "deliverable" };
  if (fenced(text, "handoff")) return { lane: author, kind: "handoff" };
  if (isChangeRequest({ body: text })) return { lane: author, kind: "changes-requested" };
  return null;
}

export const timeline = cached(15_000, number => build(number));

async function build(number) {
  const epic = await issue(number);
  const engagement = fenced(epic.body, "engagement");
  if (!engagement) throw new Error(`#${number} is not an engagement`);
  const seats = await Promise.all((fenced(epic.body, "team")?.members ?? []).map(m => issue(m.issue)));
  const events = [{ t: epic.created_at, lane: "client", kind: "deposit", seat: null, url: epic.html_url }];
  if (seats.length) {
    const first = seats.reduce((a, b) => (a.created_at < b.created_at ? a : b));
    events.push({ t: first.created_at, lane: first.user.login, kind: "team-approved", seat: null, url: epic.html_url });
  }
  let latest = null;
  for (const [n, thread] of [[number, await comments(number)], ...await Promise.all(seats.map(async s => [s.number, await comments(s.number)]))]) {
    for (const c of thread) {
      const at = classify(c.body, c.user.login);
      if (at) events.push({ t: c.created_at, ...at, seat: n === number ? null : n, url: c.html_url });
      if (at?.kind === "deliverable" && (!latest || c.created_at > latest.created_at)) latest = { ...c, seat: n };
    }
  }
  events.sort((a, b) => a.t.localeCompare(b.t));
  const lanes = ["client", "coordinator", "maintainer"];
  for (const e of events) if (!lanes.includes(e.lane) && e.lane !== "treasury") lanes.push(e.lane);
  lanes.push("treasury");
  return {
    open: epic.state === "open",
    lanes: lanes
      .filter(key => key === "client" || key === "treasury" || events.some(e => e.lane === key))
      .map(key => ({ key, ...laneInfo(key, engagement) })),
    events,
    seats: seats.map(s => ({ number: s.number, title: s.title })),
    // The newest deliverable is the work as it stands: the final write-up, or
    // the revision of it.
    result: latest && {
      seat: latest.seat,
      url: latest.html_url,
      author: latest.user.login,
      html: await markdownHtml(latest.body.replace(/^\*\*Deliverable\*\*[^\n]*\n+/, "")),
    },
  };
}

function laneInfo(key, engagement) {
  if (key === "client") return { name: engagement.org, role: "Client, paid the deposit", kind: "client" };
  if (key === "coordinator") return { name: "Coordinator", role: "Applies the rules", kind: "system" };
  if (key === "maintainer") return { name: "Maintainer", role: "AI that proposes teams", kind: "system" };
  if (key === "treasury") return { name: "DAO treasury", role: "Pays on sign-off", kind: "money" };
  const builder = byGithub(key);
  if (!builder) return { name: `@${key}`, role: "Contributor", kind: "agent" };
  return builder.kind === "agent"
    ? { name: `@${key}`, role: "AI agent", kind: "agent" }
    : { name: `@${key}`, role: "Person", kind: "person" };
}
