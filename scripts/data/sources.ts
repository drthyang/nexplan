/**
 * Upstream-source registry: reads data-sources/sources.json and returns the
 * cached bytes of a source, refusing any file whose SHA-256 differs from the
 * pinned value. Development-time only; the app never fetches these.
 *
 * A source with `normalize` is a mutable web page that cannot be pinned to a
 * revision. Its data table is extracted to text, the hash covers that text, and
 * the text is committed under data-sources/snapshots/ so builds never depend on
 * the page still being online or unchanged.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY = join(REPO_ROOT, "data-sources/sources.json");
const CACHE = join(REPO_ROOT, "data-sources/cache");
const SNAPSHOTS = join(REPO_ROOT, "data-sources/snapshots");

export interface SourceEntry {
  readonly id: string;
  readonly role: "primary" | "crosscheck";
  readonly dataset: string;
  readonly description: string;
  readonly urls: readonly string[];
  readonly file: string;
  readonly sha256: string;
  readonly license: string;
  readonly normalize?: "nist-n-lengths-table";
}

export function loadRegistry(): SourceEntry[] {
  const json = JSON.parse(readFileSync(REGISTRY, "utf8")) as { sources: SourceEntry[] };
  return json.sources;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function getSource(id: string): SourceEntry {
  const entry = loadRegistry().find((s) => s.id === id);
  if (!entry) throw new Error(`Unknown source id '${id}'`);
  return entry;
}

function storedPath(entry: SourceEntry): string {
  return entry.normalize ? join(SNAPSHOTS, entry.file) : join(CACHE, entry.id, entry.file);
}

/**
 * Extract the data table of https://www.ncnr.nist.gov/resources/n-lengths/list.html:
 * the `<table border=4>` element, one output line per `<tr>`, cells separated by tabs,
 * tags removed (so `5.74-1.483<i>i</i>` becomes `5.74-1.483i`), whitespace trimmed.
 */
export function normalizeNistTable(html: string): string {
  const start = html.indexOf("<table border=4>");
  const end = html.indexOf("</table>", start);
  if (start < 0 || end < 0) throw new Error("NIST page: data table not found");
  const body = html.slice(start, end);
  const lines: string[] = [];
  for (const row of body.split(/<tr>/i)) {
    if (!/<td/i.test(row)) continue;
    const cells = row
      .split(/<td>/i)
      .slice(1)
      .map((c) => c.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim());
    lines.push(cells.join("\t"));
  }
  return lines.join("\n") + "\n";
}

function materialize(entry: SourceEntry, bytes: Uint8Array): Uint8Array {
  if (entry.normalize === "nist-n-lengths-table") {
    return new TextEncoder().encode(normalizeNistTable(new TextDecoder().decode(bytes)));
  }
  return bytes;
}

/** Download one source (trying each URL in order) and store it, verifying its hash. */
export async function fetchSource(entry: SourceEntry, opts: { update?: boolean } = {}): Promise<string> {
  const path = storedPath(entry);
  if (existsSync(path) && sha256(readFileSync(path)) === entry.sha256) return path;
  const failures: string[] = [];
  for (const url of entry.urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        failures.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      const bytes = materialize(entry, new Uint8Array(await res.arrayBuffer()));
      const got = sha256(bytes);
      if (got !== entry.sha256 && !opts.update) {
        failures.push(`${url}: sha256 ${got} != pinned ${entry.sha256}`);
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      if (got !== entry.sha256) console.warn(`UPDATED ${entry.id}: new sha256 ${got} (pin it in sources.json after review)`);
      return path;
    } catch (err) {
      failures.push(`${url}: ${(err as Error).message}`);
    }
  }
  throw new Error(`Could not obtain source '${entry.id}':\n  ${failures.join("\n  ")}`);
}

/** Read a stored source as text after re-verifying its hash. Run `npm run data:fetch` first. */
export function readSource(id: string): { entry: SourceEntry; text: string } {
  const entry = getSource(id);
  const path = storedPath(entry);
  if (!existsSync(path)) {
    throw new Error(`Source '${id}' is not cached; run \`npm run data:fetch\``);
  }
  const bytes = readFileSync(path);
  const got = sha256(bytes);
  if (got !== entry.sha256) {
    throw new Error(`Stored source '${id}' has sha256 ${got}, expected ${entry.sha256}`);
  }
  return { entry, text: bytes.toString("utf8") };
}
