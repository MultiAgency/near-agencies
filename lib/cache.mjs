// A short-lived cache for board reads the pages repeat: every visitor's page
// load would otherwise cost several GitHub requests. Expired entries are
// dropped, the size is capped, and concurrent misses for one key share a load.
const MAX_ENTRIES = 500;

export function cached(ms, load, { max = MAX_ENTRIES } = {}) {
  const entries = new Map();
  const loading = new Map();

  function evict(now) {
    for (const [key, entry] of entries) if (now - entry.at >= ms) entries.delete(key);
    // Map iterates in insertion order, so the first keys are the oldest.
    for (const key of entries.keys()) {
      if (entries.size < max) break;
      entries.delete(key);
    }
  }

  return async (...args) => {
    const key = JSON.stringify(args);
    const now = Date.now();
    const hit = entries.get(key);
    if (hit && now - hit.at < ms) return hit.value;
    if (loading.has(key)) return loading.get(key);
    const pending = (async () => {
      try {
        const value = await load(...args);
        const at = Date.now();
        entries.delete(key);
        evict(at);
        entries.set(key, { at, value });
        return value;
      } finally {
        loading.delete(key);
      }
    })();
    loading.set(key, pending);
    return pending;
  };
}
