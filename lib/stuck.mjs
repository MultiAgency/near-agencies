// Engagement records that paid but have no epic: a record claimed for opening
// whose process died mid-way (`opening`), or whose epic creation failed
// (`deposit_settled_epic_failed`). Either way the deposit is final, so a person
// has to finish the job.

// An open in progress takes seconds (GitHub requests time out at 30s), so a
// record older than this is not being worked on.
export const STUCK_AFTER_MS = Number(process.env.STUCK_AFTER_MINUTES ?? "5") * 60_000;

const PENDING = new Set(["opening", "deposit_settled_epic_failed"]);

/** When a pending record entered its state; records from before the timestamps fall back to creation. */
export const since = record => (record.status === "opening" ? record.opening_at : record.failed_at) ?? record.created_at;

/** Pending records that have waited longer than STUCK_AFTER_MS. */
export function stuckRecords(records, now = Date.now()) {
  return Object.values(records).filter(r => PENDING.has(r.status) && now - Date.parse(since(r)) > STUCK_AFTER_MS);
}

/** Counts for /api/health. Informational: a stuck record needs a look, not a restart. */
export function engagementHealth(records, now = Date.now()) {
  const all = Object.values(records);
  return {
    opening: all.filter(r => r.status === "opening").length,
    epic_failed: all.filter(r => r.status === "deposit_settled_epic_failed").length,
    stuck: stuckRecords(records, now).map(r => ({ code: r.code, status: r.status, since: since(r) })),
  };
}
