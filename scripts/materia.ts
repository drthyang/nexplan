/**
 * MATERIA (web-refinement) at the commit pinned in src/materia/UPSTREAM.json, read from a clone's git objects and
 * never from its working tree. MATERIA_DIR names the clone (default ../web-refinement). When MATERIA_DIR is set
 * explicitly, as in CI, a missing commit is an error; otherwise the MATERIA checks are skipped with a warning.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./data/sources.ts";

export interface Upstream {
  repo: string;
  commit: string;
  files: { path: string; sha256: string }[];
}

export const UPSTREAM_PATH = join(REPO_ROOT, "src/materia/UPSTREAM.json");
export const upstream = JSON.parse(readFileSync(UPSTREAM_PATH, "utf8")) as Upstream;
export const MATERIA_DIR = process.env.MATERIA_DIR ?? join(REPO_ROOT, "../web-refinement");

/** A file of the MATERIA repository at the pinned commit. */
export function materiaShow(path: string): string {
  return execFileSync("git", ["-C", MATERIA_DIR, "show", `${upstream.commit}:${path}`], { encoding: "utf8", maxBuffer: 64 << 20 });
}

/** Whether the pinned commit is in MATERIA_DIR. Exits with an error if MATERIA_DIR was set and it is not. */
export function materiaAvailable(): boolean {
  try {
    execFileSync("git", ["-C", MATERIA_DIR, "cat-file", "-e", `${upstream.commit}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    const missing = `MATERIA commit ${upstream.commit.slice(0, 7)} not found in ${MATERIA_DIR}`;
    if (process.env.MATERIA_DIR) {
      console.error(`${missing}.`);
      process.exit(1);
    }
    console.warn(`${missing}; skipping the MATERIA checks (set MATERIA_DIR to a web-refinement clone).`);
    return false;
  }
}
