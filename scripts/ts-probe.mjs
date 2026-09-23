/**
 * ts-probe.mjs — run a repo TypeScript module from `node --test`.
 *
 * `npm test` is `node --test scripts/*.test.mjs`, and node cannot import a `.ts`
 * file. The portal has no test runner of its own, so the two modules whose
 * behaviour is worth pinning (the WebRTC fragment's ownership and the per-DID
 * Capstone bindings) are exercised by transpiling them with the project's own
 * `typescript` into a temp directory and importing the result — the same
 * compiler the app is built with, so a probe can only fail on behaviour, not on
 * a second parser's opinion.
 *
 * Not a `*.test.mjs` file itself: the glob must not pick the helper up as a
 * test. `import { probe } from "./ts-probe.mjs"`.
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = dirname(HERE);

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** Transpile one or more repo-relative modules into a temp dir; returns it. */
export function transpile(sources, outDir) {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), "zeus-ts-probe-"));
  // A bare specifier (`better-sqlite3`) resolves from the module's own URL, and
  // the module now lives in /tmp — so give the temp dir the repo's packages.
  // Without this the transpiled copy of a module that touches the database
  // cannot import it, and the failure reads as a missing dependency rather than
  // as a probe working from the wrong root.
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The temp dir is disposable either way.
    }
  });

  for (const source of sources) {
    const js = ts
      .transpileModule(readFileSync(join(REPO, source), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      })
      .outputText
      // TypeScript keeps extensionless relative specifiers; node's ESM loader
      // wants the file name, and every module here is transpiled into the same
      // flat directory.
      .replace(/(from\s+")\.\/([^".]+)"/g, "$1./$2.mjs\"");
    const name = source.split("/").pop().replace(/\.ts$/, ".mjs");
    writeFileSync(join(dir, name), js);
  }
  return dir;
}

/** Import a transpiled module by name. */
export function load(dir, moduleName) {
  return import(pathToFileURL(join(dir, `${moduleName}.mjs`)).href);
}

export { rmSync };
