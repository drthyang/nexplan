/**
 * Download every registered upstream source, verifying SHA-256.
 * `--update <id>` re-fetches one source and accepts a changed hash, printing it
 * for review; nothing is trusted until the new hash is pinned in sources.json.
 */
import { fetchSource, loadRegistry } from "./sources.ts";

const updateIdx = process.argv.indexOf("--update");
const updateId = updateIdx >= 0 ? process.argv[updateIdx + 1] : undefined;

let failed = 0;
for (const entry of loadRegistry()) {
  if (updateId && entry.id !== updateId) continue;
  try {
    const path = await fetchSource(entry, { update: entry.id === updateId });
    console.log(`ok    ${entry.id.padEnd(22)} ${path}`);
  } catch (err) {
    if (entry.optional) {
      console.warn(`skip  ${entry.id} (optional test data unavailable)\n${(err as Error).message}`);
      continue;
    }
    failed++;
    console.error(`FAIL  ${entry.id}\n${(err as Error).message}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
