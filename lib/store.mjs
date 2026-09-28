// Pending engagement intake, persisted as JSON. Records hold a brief only
// until its deposit arrives; from then on the epic issue is the source of
// truth and the record just points at it.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { network } from "./network.mjs";

const file = join(dirname(fileURLToPath(import.meta.url)), "..", ".data", `engagements.${network.networkId}.json`);
let queue = Promise.resolve();

async function load() {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

/** Serialized read-modify-write; `mutate` may return a value. */
export function update(mutate) {
  const run = queue.then(async () => {
    const records = await load();
    const result = await mutate(records);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(records, null, 2));
    await rename(`${file}.tmp`, file);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

export const all = () => queue.then(load);
export const get = async code => (await all())[code] ?? null;
