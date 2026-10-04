import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// The worker image must carry every module the worker imports. This bit
// MultiAgency once: the Dockerfile copied worker.mjs and code-mode.mjs by
// name, a new module (next-task.mjs) joined the imports, and both Railway
// workers crashed on every cron run with ERR_MODULE_NOT_FOUND before doing
// any work. So the Dockerfile copies the folder's *.mjs glob, and this test
// keeps the two honest: every module worker.mjs reaches, followed
// transitively, must land in the image.

const workerDir = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "claude-worker");
const entry = "worker.mjs";

// Relative imports read straight out of the source text: `from "./x.mjs"`,
// `export ... from "./x.mjs"` and dynamic `import("./x.mjs")`. No parser and
// no dependency, so the test runs from the repository root where this
// folder's node_modules are not installed.
const relativeImports = source =>
  [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)["'](\.[^"']+)["']/g)].map(m => m[1]);

// The modules worker.mjs reaches, transitively, as file names in workerDir.
function importedModules(entryFile) {
  const seen = new Set([entryFile]);
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop();
    const source = readFileSync(join(workerDir, file), "utf8");
    for (const spec of relativeImports(source)) {
      const target = basename(resolve(dirname(join(workerDir, file)), spec));
      assert.equal(readdirSync(workerDir).includes(target), true, `${file} imports ${spec}, which does not exist`);
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

// The files a COPY puts into the image. Sources are names relative to the
// build context (this folder); a glob source covers everything it matches in
// the folder, so `*.mjs` covers every module that exists here — including the
// one a future edit adds.
function copiedIntoImage(dockerfilePath) {
  const folderFiles = readdirSync(workerDir);
  const image = new Set();
  for (const line of readFileSync(dockerfilePath, "utf8").split("\n")) {
    const copy = line.match(/^COPY\s+(.+)$/);
    if (!copy) continue;
    const args = copy[1].trim().split(/\s+/).filter(arg => !arg.startsWith("--"));
    const sources = args.slice(0, -1); // the last argument is the destination
    for (const source of sources) {
      if (source.includes("*")) {
        const pattern = new RegExp(`^${source.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
        for (const file of folderFiles) if (pattern.test(file)) image.add(file);
      } else {
        image.add(basename(source));
      }
    }
  }
  return image;
}

describe("the claude-worker image carries every module the worker imports", () => {
  test("every module worker.mjs reaches, followed transitively, is in the image", () => {
    const image = copiedIntoImage(join(workerDir, "Dockerfile"));
    for (const module of importedModules(entry)) {
      assert.equal(image.has(module), true, `${module} is imported but never copied into the image`);
    }
  });
});

// One Dockerfile builds every worker variant (issue #86): TOOLCHAIN=node, the
// default every worker gets, and TOOLCHAIN=rust, which adds the Rust toolchain
// with clippy for the repositories that need it. Either build sets
// WORKER_TOOLCHAIN to the toolchain it carries, so the worker can tell what it
// has; the default build must stay exactly what it was before the argument.
describe("the image takes its toolchain from one build argument", () => {
  const dockerfile = () => readFileSync(join(workerDir, "Dockerfile"), "utf8");

  test("TOOLCHAIN is a build argument defaulting to node", () => {
    assert.match(dockerfile(), /^ARG TOOLCHAIN=node$/m);
  });

  test("every build sets WORKER_TOOLCHAIN from the argument", () => {
    assert.match(dockerfile(), /^ENV WORKER_TOOLCHAIN=\$\{TOOLCHAIN\}/m);
  });

  test("the Rust toolchain installs only on the rust build", () => {
    const source = dockerfile();
    const guard = /^RUN if \[ "\$TOOLCHAIN" = "rust" \]; then/m;
    assert.match(source, guard, "the rust additions must sit behind a TOOLCHAIN=rust guard");
    const start = source.search(guard);
    const before = source.slice(0, start);
    const guarded = source.slice(start);
    for (const what of ["rustup-init", "build-essential", "cmake", "libssl-dev", "clippy"]) {
      assert.equal(guarded.includes(what), true, `${what} belongs to the guarded rust build`);
    }
    // Tokens that can only mean an install line: none of these may appear
    // before the guard, where the default build would run them.
    for (const what of ["rustup-init", "build-essential", "libssl-dev"]) {
      assert.equal(before.includes(what), false, `${what} must not be installed on the default build`);
    }
  });
});
