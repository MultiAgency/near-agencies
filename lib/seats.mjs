// Seats are the kanban issues of an engagement: each carries a ```terms block
// (engagement, amount) and may depend on earlier seats via `- [ ] #N` lines.
import { comments, fenced, github } from "./github.mjs";
import { covers } from "./roster.mjs";

export async function openSeats() {
  const issues = await github("GET", "/issues?state=open&per_page=100");
  return issues.filter(i => !i.pull_request && fenced(i.body, "terms")).map(seat);
}

export function seat(issue) {
  const labels = issue.labels.map(label => label.name);
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.html_url,
    state: issue.state,
    updatedAt: issue.updated_at,
    labels,
    skills: labels.filter(name => name.startsWith("skill:")),
    assignees: issue.assignees.map(a => a.login),
    terms: fenced(issue.body, "terms"),
    dependsOn: [...issue.body.matchAll(/^- \[[ x]\] #(\d+)/gm)].map(m => Number(m[1])),
  };
}

/** Whether a roster builder may take this seat. Returns a reason when not. */
export function eligibility(seat, builder) {
  if (!builder) return "not on the MultiAgency roster";
  if (seat.labels.includes("human-only") && builder.kind !== "human") return "this seat is human-only";
  if (builder.kind === "agent" && !seat.labels.includes("agent-eligible")) return "this seat is not agent-eligible";
  if (!covers(builder, seat.skills)) return `roster skills do not cover ${seat.skills.join(", ")}`;
  return null;
}

export const isClaim = comment => /^\/claim\b/i.test(comment.body.trim());

export async function swapLabel(number, from, to) {
  await github("POST", `/issues/${number}/labels`, { labels: [to] });
  await github("DELETE", `/issues/${number}/labels/${encodeURIComponent(from)}`).catch(error => {
    if (!String(error.message).includes(": 404")) throw error;
  });
}

export { comments };
