/**
 * Copy the audited MATERIA (web-refinement) modules into src/materia/ from a
 * pinned commit, rewriting only the `@/core/` import alias to `@materia/core/`.
 *
 *   node scripts/materia-sync.ts          verify copies are unmodified (CI)
 *   node scripts/materia-sync.ts --update re-copy from UPSTREAM.json's commit
 *
 * The check compares each copy with its recorded sha256 and, when the pinned
 * commit is available (scripts/materia.ts), with MATERIA's file at that commit.
 *
 * Copies are never edited here. Fixes go to MATERIA first; then bump the commit
 * in src/materia/UPSTREAM.json and run --update.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT, sha256 } from "./data/sources.ts";
import { materiaAvailable, materiaShow, UPSTREAM_PATH, upstream } from "./materia.ts";

const HEADER = (path: string) =>
  `// Copied from MATERIA (${upstream.repo}) src/${path} @ ${upstream.commit.slice(0, 7)}. Do not edit; see scripts/materia-sync.ts.\n`;

function rewrite(path: string, text: string): string {
  return HEADER(path) + text.replaceAll('"@/core/', '"@materia/core/');
}

if (process.argv.includes("--update")) {
  if (!materiaAvailable()) process.exit(1);
  for (const f of upstream.files) {
    const out = rewrite(f.path, materiaShow(`src/${f.path}`));
    const dest = join(REPO_ROOT, "src/materia", f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, out);
    f.sha256 = sha256(out);
    console.log(`copied ${f.path}`);
  }
  writeFileSync(UPSTREAM_PATH, JSON.stringify(upstream, null, 2) + "\n");
} else {
  const againstUpstream = materiaAvailable();
  let bad = 0;
  for (const f of upstream.files) {
    const dest = join(REPO_ROOT, "src/materia", f.path);
    const copy = existsSync(dest) ? readFileSync(dest, "utf8") : undefined;
    if (copy === undefined || sha256(copy) !== f.sha256) {
      console.error(`modified or missing: src/materia/${f.path}`);
      bad++;
    } else if (againstUpstream && copy !== rewrite(f.path, materiaShow(`src/${f.path}`))) {
      console.error(`differs from MATERIA @ ${upstream.commit.slice(0, 7)}: src/materia/${f.path}`);
      bad++;
    }
  }
  if (bad) process.exit(1);
  const how = againstUpstream ? "MATERIA's files" : "their recorded sha256";
  console.log(`${upstream.files.length} MATERIA files match ${upstream.commit.slice(0, 7)} (checked against ${how})`);
}
