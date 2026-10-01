// Jobs whose ready seats nobody claims. The coordinator self-reports on
// /api/health, so its silence is visible; a worker that died, was redeployed or
// is paused is not — every seat just sits ready while health reads green, and
// the failure presents identically to "contributors are not claiming". The
// board itself carries the evidence, no worker coupling or credentials needed:
// seats labelled `ready`, unassigned, whose `ready` label event is older than
// the horizon after which a claim would have been released anyway.

import { cached } from "./cache.mjs";
import { github } from "./github.mjs";
import { openSeats } from "./seats.mjs";

// In the region of CLAIM_TTL_HOURS, the release horizon for a claim that did
// happen; its own setting, so the two can move apart.
export const IDLE_AFTER_MS = Number(process.env.IDLE_AFTER_HOURS ?? "24") * 3600_000;

// The board read behind /api/health: cached like every other repeated read
// (lib/cache.mjs), so the endpoint adds no GitHub requests per call.
const IDLE_TTL_MS = 60_000;

/**
 * When a seat last became claimable: its latest `ready` label event, or its
 * creation — the same rule the workers use to wait their turn
 * (agents/claude-worker/worker.mjs). `issue` is a seat as openSeats() returns
 * them; `events` its GitHub issue events.
 */
export function readySince(issue, events) {
  const ready = events.filter(e => e.event === "labeled" && e.label?.name === "ready").at(-1);
  return Date.parse(ready?.created_at ?? issue.createdAt);
}

/**
 * Open jobs holding unclaimed `ready` seats, from seats as openSeats() lists
 * them and `eventsOf` fetching a seat's issue events: one entry per job whose
 * oldest such seat has been ready longer than `after`, most stale first —
 * [{ job, oldest_ready_seconds, ready_seats }], empty when none is idle.
 */
export async function idleJobs(seats, eventsOf, { now = Date.now(), after = IDLE_AFTER_MS } = {}) {
  const waiting = seats.filter(seat =>
    seat.state === "open" &&
    seat.labels.includes("ready") &&
    seat.assignees.length === 0 &&
    typeof seat.terms?.engagement === "number");
  const ages = await Promise.all(waiting.map(async seat => [seat, now - readySince(seat, await eventsOf(seat))]));
  const jobs = new Map();
  for (const [seat, age] of ages) {
    const entry = jobs.get(seat.terms.engagement) ?? { job: seat.terms.engagement, oldest: 0, ready_seats: 0 };
    entry.oldest = Math.max(entry.oldest, age);
    entry.ready_seats += 1;
    jobs.set(seat.terms.engagement, entry);
  }
  return [...jobs.values()]
    .filter(entry => entry.oldest > after)
    .map(({ job, oldest, ready_seats }) => ({ job, oldest_ready_seconds: Math.round(oldest / 1000), ready_seats }))
    .sort((a, b) => b.oldest_ready_seconds - a.oldest_ready_seconds);
}

export const idleReport = cached(IDLE_TTL_MS, async () =>
  idleJobs(await openSeats(), seat => github("GET", `/issues/${seat.number}/events?per_page=100`)));
