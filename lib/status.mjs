// Where someone stands with MultiAgency, for the site's status page: their
// join request, their place on the roster, and the tasks they can claim now.
import { searchIssues } from "./github.mjs";
import { view } from "./near.mjs";
import { network } from "./network.mjs";
import { joinRequest } from "./onboarding.mjs";
import { byGithub, covers } from "./roster.mjs";
import { eligibility, openSeats } from "./seats.mjs";

export const isGithubLogin = login => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login ?? "");

const task = s => ({ number: s.number, title: s.title, url: s.url, amount: s.terms?.amount ?? null, review: s.skills.includes("skill:review") });

/**
 * One of: none (no join request), checking (posted, not yet verified),
 * verified (waiting for an owner's `/admit`), refused (with the reason), or
 * member (with the tasks they can claim and those they are working on).
 */
export async function memberStatus(login) {
  const member = byGithub(login);
  if (member) {
    const [registration, seats] = await Promise.all([
      view(network.usdc, "storage_balance_of", { account_id: member.nearAccount }),
      openSeats(),
    ]);
    const mine = s => s.assignees.some(a => a.toLowerCase() === member.github.toLowerCase());
    const open = seats.filter(s => s.labels.includes("ready") && s.assignees.length === 0 && !eligibility(s, member));
    return {
      login: member.github,
      stage: "member",
      member: { name: member.name, kind: member.kind, skills: member.skills, nearAccount: member.nearAccount, operator: member.operator ?? null },
      usdc_registered: Boolean(registration),
      working: seats.filter(mine).map(task),
      // Everything open to them, split by whether their declared skills cover it.
      tasks: open.filter(s => covers(member, s.skills)).map(task),
      also: open.filter(s => !covers(member, s.skills)).map(task),
    };
  }
  const latest = (await searchIssues(`author:${login} roster-request in:body`))
    .filter(i => joinRequest(i.body))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!latest) return { login, stage: "none" };
  const request = { number: latest.number, url: latest.html_url };
  if (latest.state === "open") {
    return { login, stage: latest.labels.some(l => l.name === "roster-verified") ? "verified" : "checking", request };
  }
  return latest.state_reason === "not_planned" ? { login, stage: "refused", request } : { login, stage: "none" };
}
