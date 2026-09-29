// A short-lived cache for board reads the pages repeat: every visitor's page
// load would otherwise cost several GitHub requests.
export function cached(ms, load) {
  const entries = new Map();
  return async (...args) => {
    const key = JSON.stringify(args);
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.value;
    const value = await load(...args);
    entries.set(key, { at: Date.now(), value });
    return value;
  };
}
