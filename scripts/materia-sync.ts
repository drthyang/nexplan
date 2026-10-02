/**
 * Copy the audited MATERIA (web-refinement) modules into src/materia/ from a
 * pinned commit, rewriting only the `@/core/` import alias to `@materia/core/`.
 *
 *   node scripts/materia-sync.ts          verify copies are unmodified (CI)
 *   node scripts/materia-sync.ts --update re-copy from UPSTREAM.json's commit
 *
 * Copies are never edited here. Fixes go to MATERIA first; then bump the commit
 * in src/materia/UPSTREAM.json and run --update.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT, sha256 } from "./data/sources.ts";

interface Upstream {
  repo: string;
  commit: string;
  files: { path: string; sha256: string }[];
}

const MANIFEST = join(REPO_ROOT, "src/materia/UPSTREAM.json");
const MATERIA_DIR = process.env.MATERIA_DIR ?? join(REPO_ROOT, "../web-refinement");
const upstream = JSON.parse(readFileSync(MANIFEST, "utf8")) as Upstream;

const HEADER = (path: string) =>
  `// Copied from MATERIA (${upstream.repo}) src/${path} @ ${upstream.commit.slice(0, 7)}. Do not edit; see scripts/materia-sync.ts.\n`;

function rewrite(path: string, text: string): string {
  return HEADER(path) + text.replaceAll('"@/core/', '"@materia/core/');
}

if (process.argv.includes("--update")) {
  for (const f of upstream.files) {
    const text = execFileSync("git", ["-C", MATERIA_DIR, "show", `${upstream.commit}:src/${f.path}`], { encoding: "utf8" });
    const out = rewrite(f.path, text);
    const dest = join(REPO_ROOT, "src/materia", f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, out);
    f.sha256 = sha256(out);
    console.log(`copied ${f.path}`);
  }
  writeFileSync(MANIFEST, JSON.stringify(upstream, null, 2) + "\n");
} else {
  let bad = 0;
  for (const f of upstream.files) {
    const dest = join(REPO_ROOT, "src/materia", f.path);
    if (!existsSync(dest) || sha256(readFileSync(dest, "utf8")) !== f.sha256) {
      console.error(`modified or missing: src/materia/${f.path}`);
      bad++;
    }
  }
  if (bad) process.exit(1);
  console.log(`${upstream.files.length} MATERIA files match ${upstream.commit.slice(0, 7)}`);
}
