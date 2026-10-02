// Finish engagements that paid but have no epic (see lib/stuck.mjs). For each
// stuck record, look for an epic that already carries its code before creating
// one: the first attempt may have created it just before the process died, and
// a second would be a duplicate. Only an epic the bot or an owner opened counts
// (an owner may have opened it by hand): the code is the deposit memo, public on
// chain, so anyone who can label an issue could copy it into one.
//
// A record is claimed at most MAX_RECOVERY_ATTEMPTS times (lib/stuck.mjs); after that
// it stays failed and /api/health keeps listing it for a person.
//
// The lookup uses the issue list, which is consistent; search is not, and a
// recovery running soon after a crash could miss an epic it should find.
import { epicIssues, fenced, isTrusted } from "./github.mjs";
import { createEpic } from "./epic.mjs";
import * as realStore from "./store.mjs";
import { gaveUp, stuckRecords } from "./stuck.mjs";

// GitHub's `since` is compared with an issue's update time; leave room for clock skew.
const SKEW_MS = 60_000;

export async function recoverStuck({ store = realStore, listEpics = epicIssues, create = createEpic, trusted = isTrusted, now = Date.now() } = {}) {
  const recovered = [];
  for (const candidate of stuckRecords(await store.all(), now).filter(r => !gaveUp(r))) {
    const { code } = candidate;
    // No epic can predate the quote. Not opening_at: each re-claim moves it, and a failed lookup would then miss an earlier attempt's epic.
    const from = new Date(Date.parse(candidate.created_at) - SKEW_MS).toISOString();
    // Claim it again, which also restarts its clock so a later tick leaves it alone while this runs.
    const record = await store.update(records => {
      const r = records[code];
      if (!r || gaveUp(r) || !stuckRecords({ [code]: r }, now).length) return null;
      return Object.assign(r, { status: "opening", attempts: (r.attempts ?? 0) + 1, opening_at: new Date(now).toISOString(), error: undefined });
    });
    if (!record) continue;
    try {
      let existing = null;
      for (const issue of await listEpics(from)) {
        if (!issue.pull_request && fenced(issue.body, "engagement")?.engagement_id === code && await trusted(issue.user.login)) {
          existing = issue;
          break;
        }
      }
      const epic = existing ?? (await create(record));
      await store.update(records => Object.assign(records[code], {
        status: "open",
        issue: epic.number,
        issue_url: epic.html_url,
        brief: undefined,
        error: undefined,
      }));
      recovered.push({ code, issue: epic.number, created: !existing });
      console.log(`${code}: ${existing ? "found" : "created"} ${epic.html_url} (recovered)`);
    } catch (error) {
      const failed = await store.update(records => Object.assign(records[code], {
        status: "deposit_settled_epic_failed",
        error: error.message,
        // The time of the failure, not of the tick: an attempt can take minutes.
        failed_at: new Date().toISOString(),
      }));
      console.error(`${code}: recovery failed (attempt ${failed.attempts}): ${error.message}${gaveUp(failed) ? "; giving up, it needs a person" : ""}`);
    }
  }
  return recovered;
}
