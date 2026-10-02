/**
 * Build the production scattering tables from pinned upstream sources and
 * cross-check every row against independent transcriptions and physical
 * identities. Writes:
 *
 *   src/data/xray-f0-wk1995.json        Waasmaier & Kirfel (1995) f0 coefficients
 *   src/data/neutron-sears1992.json     Sears (1992) bound scattering lengths
 *   src/data/manifest.json              dataset versions, source and output hashes
 *   fixtures/xray-f0-wk1995-values.json f0 evaluated by this script's own evaluator
 *   docs/data-verification/*.md         row-level verification reports
 *
 * Usage: node scripts/data/build-tables.ts [--check]
 *   --check  fail (exit 1) if any output differs from what is committed.
 *
 * No row is ever repaired here. A row that fails a check is kept with
 * status "discrepant" and listed in the report for resolution against the
 * printed publication.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareDecimals, halfUlpPrinted, type Agreement } from "./decimal.ts";
import { elementSymbol } from "./elements.ts";
import {
  parseCctbxGaussianTable,
  parseDabaxF0,
  parseDansSears,
  parseGemmiIt92,
  parseGemmiNeutron92,
  parseGsasAtmBlens,
  parseGsasXrayFF,
  parseMantidNeutronAtoms,
  parseMateriaCromerMann,
  parseMateriaNeutronB,
  parseNistTable,
  parsePeriodictableNsf,
  type GaussianRow,
  type Measured,
  type NistRow,
  type SimpleNeutronRow,
} from "./parsers.ts";
import { REPO_ROOT, readSource, sha256, type SourceEntry } from "./sources.ts";
import { canonicalSpecies, parseSpeciesLabel } from "./species.ts";
import { flattenIdf } from "./idf.ts";

const RETRIEVED = "2026-10-02";
const MATERIA_DIR = process.env.MATERIA_DIR ?? join(REPO_ROOT, "../web-refinement");
const MATERIA_COMMIT = "0ee9a7e96700e4ee7da239812096e863be250fec";

const outputs = new Map<string, string>();
/**
 * Files holding computed floating-point values (not transcribed decimals) are
 * compared numerically in --check: Math.exp may differ in the last bit between
 * platforms (e.g. arm64 macOS vs x86-64 Linux CI), which would otherwise make
 * an unchanged fixture look stale.
 */
const numericOutputs = new Map<string, number>();
function emit(relPath: string, content: string, opts: { numericRelTol?: number } = {}): void {
  outputs.set(relPath, content);
  if (opts.numericRelTol !== undefined) numericOutputs.set(relPath, opts.numericRelTol);
}

/** Same JSON structure, numbers equal within relTol (relative, with a 1e-300 floor). */
function sameJsonNumeric(a: string, b: string, relTol: number): boolean {
  const eq = (x: unknown, y: unknown): boolean => {
    if (typeof x === "number" && typeof y === "number") return x === y || Math.abs(x - y) <= relTol * Math.max(Math.abs(x), Math.abs(y), 1e-300);
    if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => eq(v, y[i]));
    if (x && y && typeof x === "object" && typeof y === "object") {
      const kx = Object.keys(x), ky = Object.keys(y);
      return kx.length === ky.length && kx.every((k) => eq((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]));
    }
    return x === y;
  };
  try {
    return eq(JSON.parse(a), JSON.parse(b));
  } catch {
    return false;
  }
}
const json = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";
const fmt = (x: number, digits = 4): string => (Number.isFinite(x) ? x.toFixed(digits) : String(x));

function sourceRef(e: SourceEntry) {
  return { id: e.id, url: e.urls[0], sha256: e.sha256 };
}

// ======================================================================= X-ray

function f0(row: { a: readonly { value: number }[]; b: readonly { value: number }[]; c: { value: number } }, s: number): number {
  let f = row.c.value;
  for (let i = 0; i < row.a.length; i++) f += row.a[i]!.value * Math.exp(-row.b[i]!.value * s * s);
  return f;
}

/** Index rows by canonical species; rows with a qualifier go to `pseudo`. */
function indexSpecies(rows: GaussianRow[], qualifierMap: Record<string, string> = {}) {
  const byId = new Map<string, GaussianRow>();
  const pseudo: string[] = [];
  for (const r of rows) {
    if (r.label in qualifierMap) {
      const mapped = qualifierMap[r.label]!;
      if (mapped !== "") byId.set(mapped, r);
      else pseudo.push(r.label);
      continue;
    }
    const sp = parseSpeciesLabel(r.label);
    if (sp.qualifier !== "") {
      pseudo.push(r.label);
      continue;
    }
    const id = canonicalSpecies(sp);
    if (byId.has(id)) throw new Error(`Duplicate species ${id} (${r.label})`);
    byId.set(id, r);
  }
  return { byId, pseudo };
}

function coefficientAgreement(x: GaussianRow, y: GaussianRow): { worst: Agreement; diffs: string[] } {
  const diffs: string[] = [];
  let worst: Agreement = "identical";
  const rank = { identical: 0, float32: 1, different: 2 } as const;
  const check = (name: string, p: string, q: string) => {
    const a = compareDecimals(p, q);
    if (rank[a] > rank[worst]) worst = a;
    if (a === "different") diffs.push(`${name}: ${p} vs ${q}`);
  };
  if (x.a.length !== y.a.length) return { worst: "different", diffs: ["Gaussian count differs"] };
  x.a.forEach((v, i) => check(`a${i + 1}`, v.raw, y.a[i]!.raw));
  x.b.forEach((v, i) => check(`b${i + 1}`, v.raw, y.b[i]!.raw));
  check("c", x.c.raw, y.c.raw);
  return { worst, diffs };
}

const S_GRID_FIXTURE = [0, 0.1, 0.5, 1, 2, 4, 6];
const S_GRID_CM = Array.from({ length: 41 }, (_, i) => i * 0.05); // 0..2 Å⁻¹, Cromer–Mann domain
/** Mislabel screen range: Cromer–Mann fits with negative exponents degrade toward s = 2 (Sc3+, Ti3+, Ti4+). */
const S_MAX_SCREEN = 1.5;
/** Adjacent charge states differ by 1 e at s = 0; 0.25 e cleanly separates a mislabeled row from fit differences. */
const WK_VS_CM_SCREEN = 0.25;
/** Core electrons dominate at high s, so an ion's f0 must approach the neutral atom's for 2 ≤ s ≤ 6 Å⁻¹. */
const S_GRID_HIGH = Array.from({ length: 81 }, (_, i) => 2 + i * 0.05);
const ION_CONVERGENCE_SCREEN = 0.25;
/** Screening threshold on |f0(0) − N_electrons|; reported, never used to alter coefficients. */
const F0_ZERO_SCREEN = 0.05;

function buildXray() {
  const dabax = readSource("dabax-wk1995");
  const cctbx = readSource("cctbx-wk1995");
  const cmCctbx = readSource("cctbx-it1992");
  const cmDabax = readSource("dabax-it1992");

  const wk = indexSpecies(parseDabaxF0(dabax.text, 5));
  // cctbx: "Hiso" is the WK isolated H atom; its "H" is an SDS bonded-H fit added by cctbx, not WK.
  const wkC = indexSpecies(parseCctbxGaussianTable(cctbx.text, 5), { Hiso: "H", H: "" });
  const cmSources = {
    cctbx: indexSpecies(parseCctbxGaussianTable(cmCctbx.text, 4)).byId,
    DABAX: indexSpecies(parseDabaxF0(cmDabax.text, 4)).byId,
  };

  const species: unknown[] = [];
  const fixtureRows: unknown[] = [];
  const reportRows: string[] = [];
  const stats = { total: 0, crosschecked: 0, discrepant: 0, maxF0Zero: 0, maxCmScreen: 0, maxIon: 0 };
  const onlyInCctbx = [...wkC.byId.keys()].filter((k) => !wk.byId.has(k));

  for (const [id, row] of wk.byId) {
    const sp = parseSpeciesLabel(id);
    const electrons = sp.z - sp.charge;
    const notes: string[] = [];
    const problems: string[] = [];

    const other = wkC.byId.get(id);
    let transcription: string;
    if (!other) {
      transcription = "missing in cctbx";
      problems.push("no independent transcription (absent from cctbx wk1995)");
    } else {
      const ag = coefficientAgreement(row, other);
      transcription = ag.worst;
      if (ag.worst === "different") problems.push(`coefficients differ from cctbx: ${ag.diffs.join("; ")}`);
    }

    const finite = [...row.a, ...row.b, row.c].every((v) => Number.isFinite(v.value));
    if (!finite) problems.push("non-finite coefficient");

    const dZero = f0(row, 0) - electrons;
    stats.maxF0Zero = Math.max(stats.maxF0Zero, Math.abs(dZero));
    if (Math.abs(dZero) > F0_ZERO_SCREEN) problems.push(`f0(0) − N = ${fmt(dZero)} e exceeds ${F0_ZERO_SCREEN} e screen`);

    // Mislabel screen: agreement with an ITC Cromer–Mann transcription for s ≤ S_MAX_SCREEN.
    const cmCells: string[] = [];
    let cmScreen: number | undefined;
    for (const [name, map] of Object.entries(cmSources)) {
      const cmRow = map.get(id);
      if (!cmRow) {
        cmCells.push("—");
        continue;
      }
      const full = Math.max(...S_GRID_CM.map((s) => Math.abs(f0(row, s) - f0(cmRow, s))));
      const low = Math.max(...S_GRID_CM.filter((s) => s <= S_MAX_SCREEN + 1e-9).map((s) => Math.abs(f0(row, s) - f0(cmRow, s))));
      cmScreen = cmScreen === undefined ? low : Math.min(cmScreen, low);
      cmCells.push(`${fmt(low, 3)} / ${fmt(full, 3)}`);
      if (full > WK_VS_CM_SCREEN) notes.push(`${name} Cromer–Mann differs by ${fmt(full, 3)} e at s ≤ 2`);
    }
    if (cmScreen === undefined) notes.push("no ITC Cromer–Mann row to compare");
    else {
      stats.maxCmScreen = Math.max(stats.maxCmScreen, cmScreen);
      if (cmScreen > WK_VS_CM_SCREEN) problems.push(`differs from every Cromer–Mann transcription by > ${WK_VS_CM_SCREEN} e for s ≤ ${S_MAX_SCREEN}`);
    }

    // Ion → neutral convergence at high s.
    let ionDev: number | undefined;
    if (sp.charge !== 0) {
      const neutral = wk.byId.get(sp.element);
      if (!neutral) problems.push("no neutral-atom row for the convergence check");
      else {
        ionDev = Math.max(...S_GRID_HIGH.map((s) => Math.abs(f0(row, s) - f0(neutral, s))));
        stats.maxIon = Math.max(stats.maxIon, ionDev);
        if (ionDev > ION_CONVERGENCE_SCREEN) problems.push(`|f_ion − f_neutral| = ${fmt(ionDev, 3)} e for 2 ≤ s ≤ 6 (screen ${ION_CONVERGENCE_SCREEN} e)`);
      }
    }

    if (id === "O2-") notes.push("Free O2− is unbound; tabulated f0 depend on the stabilizing model, so WK and ITC rows differ by ~0.2 e at low s. Use with caution.");
    if (id === "O1-") notes.push("Fit to Rez, Rez & Grant (1994) Table 2, not to ITC Vol. C (per the WK README); separate provenance.");

    const status = problems.length === 0 ? "crosschecked" : "discrepant";
    stats.total++;
    stats[status]++;
    species.push({
      id,
      element: sp.element,
      z: sp.z,
      charge: sp.charge,
      a: row.a.map((v) => v.value),
      b: row.b.map((v) => v.value),
      c: row.c.value,
      status,
      ...(notes.length ? { notes } : {}),
      ...(problems.length ? { problems } : {}),
    });
    fixtureRows.push({ id, f0: S_GRID_FIXTURE.map((s) => f0(row, s)) });
    reportRows.push(
      `| ${id} | ${electrons} | ${fmt(dZero)} | ${transcription} | ${cmCells.join(" | ")} | ${ionDev === undefined ? "—" : fmt(ionDev, 3)} | ${status} | ${[...problems, ...notes].join("; ") || ""} |`,
    );
  }

  emit(
    "src/data/xray-f0-wk1995.json",
    json({
      dataset: "xray-f0-wk1995",
      version: "0.1.0",
      tier: "crosschecked-not-certified",
      model: "f0(s) = Σ_{i=1..5} a_i·exp(−b_i·s²) + c, s = sinθ/λ = 1/(2d) in Å⁻¹; f0 in electrons",
      domain: { sMin: 0, sMax: 6, unit: "1/angstrom" },
      citation:
        "Waasmaier, D. & Kirfel, A. (1995). New analytical scattering-factor functions for free atoms and ions. Acta Cryst. A51, 416–431. doi:10.1107/S0108767394013292",
      source: sourceRef(dabax.entry),
      crosscheck: [sourceRef(cctbx.entry), sourceRef(cmCctbx.entry), sourceRef(cmDabax.entry)],
      retrieved: RETRIEVED,
      excludedPseudoSpecies: wk.pseudo,
      species,
    }),
  );
  emit(
    "fixtures/xray-f0-wk1995-values.json",
    json({
      description: "f0 (electrons) evaluated by scripts/data/build-tables.ts from the DABAX coefficients; compared against the app evaluator in tests.",
      s: S_GRID_FIXTURE,
      rows: fixtureRows,
    }),
    { numericRelTol: 1e-12 },
  );

  const md = `# X-ray f0: Waasmaier & Kirfel (1995) verification

Generated by \`scripts/data/build-tables.ts\`; do not edit by hand.

**Production source:** DABAX \`f0_WaasKirf.dat\` (sha256 \`${dabax.entry.sha256.slice(0, 16)}…\`), a 2013 reformat of the
authors' electronic file \`sfac.dat\`.
**Independent transcription:** cctbx \`wk1995.cpp\` (sha256 \`${cctbx.entry.sha256.slice(0, 16)}…\`), reformatted from
the same \`sfac.dat\` in 1995 and verified in 2001.

Both trace to the authors' own file, so their agreement checks the two reformatting paths, not the
authors' fit. The printed paper can differ from \`sfac.dat\`. A human audit against the printed table is
still required before any row is labeled certified (see the audit list below).

## Checks

1. **Transcription:** every coefficient is compared as a canonical decimal (\`7.35730\` = \`7.3573\`).
2. **Electron count:** f0(0) = Σaᵢ + c is compared with N = Z − charge. The table reports the deviation and
   flags rows above ${F0_ZERO_SCREEN} e. Coefficients are never adjusted.
3. **Mislabel screen:** each species is compared with the ITC Vol. C Cromer–Mann fit, a separate
   parameterization of the same Hartree–Fock values. Two transcriptions are used: cctbx \`it1992.cpp\` and
   DABAX \`f0_InterTables.dat\`. Adjacent charge states differ by 1 e at s = 0, so a row that is more than
   ${WK_VS_CM_SCREEN} e from *every* transcription for s ≤ ${S_MAX_SCREEN} Å⁻¹ is flagged.
4. **Ion convergence:** core electrons dominate at high s, so an ion's f0 must approach the neutral atom's.
   A row is flagged when |f_ion − f_neutral| > ${ION_CONVERGENCE_SCREEN} e anywhere in 2 ≤ s ≤ 6 Å⁻¹. This also
   covers the part of the WK domain, s > 2, that Cromer–Mann does not reach.

**Method change after the first run (recorded so it is auditable).** The first run compared only against
cctbx Cromer–Mann over s ≤ 2 and flagged Sc3+, Ti3+, Ti4+, Ru4+ and Bi5+. Investigation found two causes, both on the
Cromer–Mann side. WK coefficients were not changed.

- Bi5+ and Ru4+: cctbx, gemmi and GSAS-II carry b2 = 0.39042 (Bi5+) and b3 = 0.36495 (Ru4+). Their curves go
  unphysical: Bi5+ reaches f = −0.68 e at s = 2, and the ion fails to converge to the neutral atom. DABAX carries
  0.039042 and 0.036495, which reproduce the WK curves within 0.04 e everywhere. This is most likely a dropped
  digit in the ITC Vol. C reprint, propagated into those packages. See \`MATERIA_TABLES.md\`.
- Sc3+, Ti3+, Ti4+: the Cromer–Mann fits have negative exponents and leave the true curve near s = 2 (by 0.3–0.5 e).
  Below s = 1.5 they agree with WK within 0.03 e, and the WK rows converge to the neutral atom as expected.

The screen was therefore restricted to s ≤ ${S_MAX_SCREEN} against either transcription, and check 4 was added.
Full-range differences are still listed in the table.

## Summary

- Species in the production table: **${stats.total}**. Crosschecked: **${stats.crosschecked}**. Discrepant: **${stats.discrepant}**.
- Largest |f0(0) − N|: ${fmt(stats.maxF0Zero, 5)} e.
- Largest mislabel-screen difference (best CM transcription, s ≤ ${S_MAX_SCREEN}): ${fmt(stats.maxCmScreen)} e.
- Largest |f_ion − f_neutral| for 2 ≤ s ≤ 6: ${fmt(stats.maxIon, 3)} e.
- Pseudo-species excluded from production (not atoms or ions): ${wk.pseudo.join(", ") || "none"}.
- In cctbx but not DABAX: ${onlyInCctbx.join(", ") || "none"}.

## Rows

| Species | N | f0(0) − N | Transcription vs cctbx | Δ vs cctbx CM (s ≤ 1.5 / ≤ 2) | Δ vs DABAX CM (s ≤ 1.5 / ≤ 2) | ion − neutral, 2 ≤ s ≤ 6 | Status | Notes |
|---|---:|---:|---|---|---|---:|---|---|
${reportRows.join("\n")}

## Human audit still required

Check these against Waasmaier & Kirfel (1995), Table 1 (printed). Tick each one in a reviewed commit:

- Every row marked *discrepant* above.
- A stratified sample of crosschecked rows: H, C, O, Si, Fe, Fe2+, Fe3+, Cu, Mo, Ag, Ba, Gd, W, Au, Pb, U.
- O1−: confirm the fit provenance (Rez, Rez & Grant 1994).
`;
  emit("docs/data-verification/XRAY_WK1995.md", md);
  return stats;
}

// ===================================================== MATERIA X-ray (Cromer–Mann) audit

function auditMateriaXray() {
  const materiaPath = join(MATERIA_DIR, "src/core/scattering/cromerMannData.ts");
  const materiaText = readFileSync(materiaPath, "utf8");
  const materia = parseMateriaCromerMann(materiaText);
  const sources = {
    "cctbx it1992": indexSpecies(parseCctbxGaussianTable(readSource("cctbx-it1992").text, 4)).byId,
    "gemmi it92": indexSpecies(parseGemmiIt92(readSource("gemmi-it92").text).filter((r) => r.label !== "X=O")).byId,
    // GSAS-II also lists D and T as copies of H; they are aliases, not separate X-ray species.
    "GSAS-II XrayFF": indexSpecies(parseGsasXrayFF(readSource("gsas2-atmdata").text).filter((r) => !/^[DT](?![a-z])/.test(r.label))).byId,
    "DABAX f0_InterTables": indexSpecies(parseDabaxF0(readSource("dabax-it1992").text, 4)).byId,
  };
  const rows: string[] = [];
  let agreeAll = 0;
  for (const r of materia) {
    const z = parseSpeciesLabel(r.label).z;
    const cells: string[] = [];
    let allIdentical = true;
    for (const map of Object.values(sources)) {
      const other = map.get(r.label);
      if (!other) {
        cells.push("absent");
        allIdentical = false;
        continue;
      }
      const ag = coefficientAgreement(r, other);
      if (ag.worst === "different") allIdentical = false;
      cells.push(ag.worst === "different" ? `**different** (${ag.diffs.join("; ")})` : ag.worst);
    }
    const dz = f0(r, 0) - z;
    if (allIdentical && Math.abs(dz) <= 0.1) agreeAll++;
    else rows.push(`| ${r.label} | ${fmt(dz)} | ${cells.join(" | ")} |`);
  }
  // Pu: MATERIA omits it because the DABAX row gives f(0) ≠ Z. Check the other transcriptions.
  const puRows = Object.entries(sources).map(([name, map]) => {
    const pu = map.get("Pu");
    return pu ? `| ${name} | ${[...pu.a, ...pu.b, pu.c].map((v) => v.raw).join(", ")} | ${fmt(f0(pu, 0) - 94)} |` : `| ${name} | absent | — |`;
  });
  // Rows where the Cromer–Mann transcriptions disagree, for any species, with a physics check of each variant:
  // f(0) − N and, for ions, |f_ion − f_neutral| at s = 2 (neutral from the same source).
  const disputes: string[] = [];
  const ids = new Set(Object.values(sources).flatMap((m) => [...m.keys()]));
  for (const id of [...ids].sort()) {
    const variants = new Map<string, { names: string[]; row: GaussianRow }>();
    for (const [name, map] of Object.entries(sources)) {
      const row = map.get(id);
      if (!row) continue;
      const match = [...variants.values()].find((v) => coefficientAgreement(v.row, row).worst !== "different");
      if (match) match.names.push(name);
      else variants.set(name, { names: [name], row });
    }
    if (variants.size < 2) continue;
    const sp = parseSpeciesLabel(id);
    const cells = [...variants.values()].map(({ names, row }) => {
      const neutral = sources[names[0] as keyof typeof sources].get(sp.element);
      const conv = sp.charge !== 0 && neutral ? `, |f−f_neutral|(s=2) = ${fmt(Math.abs(f0(row, 2) - f0(neutral, 2)), 2)}` : "";
      return `${names.join(", ")}: [${[...row.a, ...row.b, row.c].map((v) => v.raw).join(", ")}] → f(0)−N = ${fmt(f0(row, 0) - (sp.z - sp.charge), 3)}, f(2) = ${fmt(f0(row, 2), 2)}${conv}`;
    });
    disputes.push(`| ${id} | ${cells.join("<br>")} |`);
  }
  return { materiaPath, total: materia.length, agreeAll, rows, puRows, disputes, sourceNames: Object.keys(sources) };
}

// ===================================================================== Neutron

interface NeutronEntryOut {
  id: string;
  element: string;
  z: number;
  mass?: number;
  kind: "natural-element" | "isotope" | "element-row-radioactive";
  abundance?: number;
  abundanceSu?: number;
  halfLife?: string;
  bCoh?: { re: number; im: number; reSu?: number; imSu?: number; raw: string };
  bInc?: { re: number; im: number; reSu?: number; raw: string; signUnknown?: true };
  xs: Record<string, { value: number; su?: number; upperLimit?: true; raw: string }>;
  complex: boolean;
  status: "crosschecked" | "discrepant" | "unavailable" | "unresolved";
  checks: Record<string, string>;
  problems?: string[];
}

function measuredOut(m: Measured) {
  return { value: m.value, ...(m.su !== undefined ? { su: m.su } : {}), ...(m.upperLimit ? { upperLimit: true as const } : {}), raw: m.raw };
}

/** Is σ_coh consistent with 4π|b_c|²/100 given the printed precision (and su, if needed)? */
function sigmaIdentity(row: NistRow): { verdict: string; detail: string } {
  if (!row.cohB || !row.cohXs) return { verdict: "n/a", detail: "missing b or σ_coh" };
  const re = row.cohB.re;
  const im = row.cohB.im;
  const mod = Math.hypot(re.value, im?.value ?? 0);
  const sigmaFromB = (4 * Math.PI * mod * mod) / 100;
  const dbRound = Math.max(halfUlpPrinted(re.raw.replace(/\(.*\)$/, "")), im ? halfUlpPrinted(im.raw.replace(/\(.*\)$/, "").replace(/^\+/, "")) : 0);
  const dsRound = halfUlpPrinted(row.cohXs.raw.replace(/\(.*\)$/, ""));
  const diff = Math.abs(row.cohXs.value - sigmaFromB);
  const tolRound = (8 * Math.PI * mod * dbRound) / 100 + dsRound + 1e-12;
  const detail = `σ=${row.cohXs.raw}, 4π|b|²/100=${sigmaFromB.toPrecision(5)}`;
  if (diff <= tolRound) return { verdict: "consistent", detail };
  const suB = Math.max(re.su ?? 0, im?.su ?? 0);
  const tolSu = tolRound + (8 * Math.PI * mod * suB) / 100 + (row.cohXs.su ?? 0);
  if (diff <= tolSu) return { verdict: "consistent-within-su", detail };
  return { verdict: "inconsistent", detail };
}

function keyOf(symbol: string, mass?: number): string {
  return mass === undefined ? symbol : `${mass}${symbol}`;
}

function indexNeutron(rows: SimpleNeutronRow[]): Map<string, SimpleNeutronRow> {
  const m = new Map<string, SimpleNeutronRow>();
  for (const r of rows) m.set(keyOf(r.symbol, r.mass), r);
  return m;
}

function buildNeutron() {
  const nist = readSource("nist-sears1992");
  const mantidSrc = readSource("mantid-neutronatom");
  const gemmiSrc = readSource("gemmi-neutron92");
  const dansSrc = readSource("dans-sears-itc");
  const ptSrc = readSource("periodictable-nsf");
  const gsasSrc = readSource("gsas2-atmdata");

  const rows = parseNistTable(nist.text);
  const mantid = indexNeutron(parseMantidNeutronAtoms(mantidSrc.text, elementSymbol));
  const gemmi = indexNeutron(parseGemmiNeutron92(gemmiSrc.text));
  const dans = indexNeutron(parseDansSears(dansSrc.text));
  const pt = indexNeutron(parsePeriodictableNsf(ptSrc.text));
  const gsas = indexNeutron(parseGsasAtmBlens(gsasSrc.text));

  const entries: NeutronEntryOut[] = [];
  const zOf = (sym: string) => parseSpeciesLabel(sym).z;

  for (const row of rows) {
    const id = keyOf(row.symbol, row.mass);
    const problems: string[] = [];
    const checks: Record<string, string> = {};
    const kind: NeutronEntryOut["kind"] =
      row.mass !== undefined ? "isotope" : row.halfLife !== undefined ? "element-row-radioactive" : "natural-element";

    // Transcription: Mantid (full table) and gemmi (elements).
    const mt = mantid.get(id);
    if (!mt) {
      checks.mantid = "absent";
      problems.push("absent from Mantid transcription");
    } else if (row.cohB) {
      const reAg = compareDecimals(row.cohB.re.raw.replace(/\(.*\)$/, ""), mt.cohBRe.raw);
      const imNist = row.cohB.im ? row.cohB.im.raw.replace(/\(.*\)$/, "") : "0";
      const imAg = compareDecimals(imNist, mt.cohBIm?.raw ?? "0");
      const xsAg = row.cohXs && mt.cohXs ? compareDecimals(row.cohXs.raw.replace(/\(.*\)$/, ""), mt.cohXs.raw) : "identical";
      const bad = [reAg, imAg, xsAg].some((a) => a === "different");
      checks.mantid = bad ? `different (b ${mt.cohBRe.raw}${mt.cohBIm ? `${mt.cohBIm.value >= 0 ? "+" : ""}${mt.cohBIm.raw}i` : ""}, σcoh ${mt.cohXs?.raw})` : "identical";
      if (bad) problems.push(`Mantid transcription differs: ${checks.mantid}`);
    }
    if (kind !== "isotope") {
      const g = gemmi.get(row.symbol);
      if (g && row.cohB) {
        const ag = compareDecimals(row.cohB.re.raw.replace(/\(.*\)$/, ""), g.cohBRe.raw);
        checks.gemmi = ag === "different" ? `different (${g.cohBRe.raw})` : "identical";
        if (ag === "different") problems.push(`gemmi transcription differs: ${g.cohBRe.raw}`);
      } else checks.gemmi = g ? "n/a" : "absent";
    }

    // Physical identity σ_coh = 4π|b_c|²/100.
    const ident = sigmaIdentity(row);
    checks.sigmaIdentity = `${ident.verdict} (${ident.detail})`;
    if (ident.verdict === "inconsistent") problems.push(`σ_coh inconsistent with b_c: ${ident.detail}`);

    // Other editions/evaluations (informational only).
    const d = dans.get(id);
    if (d && row.cohB) {
      const sameRe = Math.abs(d.cohBRe.value - row.cohB.re.value) < 1e-9;
      const imN = row.cohB.im?.value ?? 0;
      const imD = d.cohBIm?.value ?? 0;
      checks.itcEdition = sameRe && Math.abs(imD - imN) < 1e-9 ? "same" : sameRe && Math.abs(imD + imN) < 1e-9 ? "imag sign flipped" : `differs (${d.cohBRe.raw}${imD ? `, im ${d.cohBIm!.raw}` : ""})`;
    }
    const newer = [pt.get(id), gsas.get(id)].filter((x): x is SimpleNeutronRow => !!x);
    if (row.cohB && newer.length) {
      const devs = newer.map((n) => n.cohBRe.value - row.cohB!.re.value);
      const maxDev = Math.max(...devs.map(Math.abs));
      if (maxDev > Math.max(0.02, 0.01 * Math.abs(row.cohB.re.value))) checks.newerEvaluations = `differ by up to ${fmt(maxDev, 3)} fm (periodictable/GSAS-II)`;
    }

    let status: NeutronEntryOut["status"];
    if (!row.cohB) status = "unavailable";
    else if (kind === "element-row-radioactive") {
      status = "unresolved";
      problems.push(`element row carries a half-life (${row.halfLife}); the specific isotope is not named on the NIST page`);
    } else status = problems.length === 0 ? "crosschecked" : "discrepant";

    const entry: NeutronEntryOut = {
      id,
      element: row.symbol,
      z: zOf(row.symbol),
      ...(row.mass !== undefined ? { mass: row.mass } : {}),
      kind,
      ...(row.abundance ? { abundance: row.abundance.value, ...(row.abundance.su !== undefined ? { abundanceSu: row.abundance.su } : {}) } : {}),
      ...(row.halfLife !== undefined ? { halfLife: row.halfLife } : {}),
      ...(row.cohB
        ? {
            bCoh: {
              re: row.cohB.re.value,
              im: row.cohB.im?.value ?? 0,
              ...(row.cohB.re.su !== undefined ? { reSu: row.cohB.re.su } : {}),
              ...(row.cohB.im?.su !== undefined ? { imSu: row.cohB.im.su } : {}),
              raw: row.cohB.raw,
            },
          }
        : {}),
      ...(row.incB
        ? {
            bInc: {
              re: row.incB.re.value,
              im: row.incB.im?.value ?? 0,
              ...(row.incB.re.su !== undefined ? { reSu: row.incB.re.su } : {}),
              raw: row.rawCells[3]!,
              ...(row.incBSignUnknown ? { signUnknown: true as const } : {}),
            },
          }
        : {}),
      xs: Object.fromEntries(
        (
          [
            ["coh", row.cohXs],
            ["inc", row.incXs],
            ["scatt", row.scattXs],
            ["abs2200", row.absXs],
          ] as const
        )
          .filter(([, m]) => m !== undefined)
          .map(([k, m]) => [k, measuredOut(m!)]),
      ),
      complex: !!row.cohB?.im,
      status,
      checks,
      ...(problems.length ? { problems } : {}),
    };
    entries.push(entry);
  }

  // Abundance-weighted isotope average vs element value (informational; Sears' element values are often measured directly).
  const avgRows: string[] = [];
  for (const el of entries.filter((e) => e.kind === "natural-element" && e.bCoh)) {
    const isos = entries.filter((e) => e.kind === "isotope" && e.element === el.element && e.abundance !== undefined && e.bCoh);
    if (isos.length < 2) continue;
    const sumC = isos.reduce((s, e) => s + e.abundance!, 0);
    const re = isos.reduce((s, e) => s + e.abundance! * e.bCoh!.re, 0) / sumC;
    const dev = re - el.bCoh!.re;
    el.checks.isotopeAverage = `Σc=${fmt(sumC, 3)}%, Σc·b/Σc=${fmt(re, 3)} fm, Δ=${fmt(dev, 3)} fm`;
    if (Math.abs(sumC - 100) > 0.1 || Math.abs(dev) > Math.max(0.05, 0.02 * Math.abs(el.bCoh!.re))) {
      avgRows.push(`| ${el.id} | ${fmt(sumC, 3)} | ${el.bCoh!.raw} | ${fmt(re, 3)} | ${fmt(dev, 3)} |`);
    }
  }

  emit(
    "src/data/neutron-sears1992.json",
    json({
      dataset: "neutron-b-sears1992",
      version: "0.1.0",
      tier: "crosschecked-not-certified",
      units: { b: "fm", xs: "barn", abundance: "atom %" },
      conventions: {
        imaginarySign:
          "As printed by Sears (1992): b = b' − i·b'', so Im(b) ≤ 0 for absorbing nuclei. In the crystallographic structure factor F = Σ b·exp(+2πi h·x), use conj(b) (docs/CONVENTIONS.md §5).",
        abs2200: "Absorption cross section for 2200 m/s neutrons (λ = 1.798 Å).",
        energyDependence: "Values are thermal bound values. Rows with complex b have resonances and are only valid near 2200 m/s.",
      },
      citation: "Sears, V. F. (1992). Neutron scattering lengths and cross sections. Neutron News 3(3), 26–37. doi:10.1080/10448639208218770",
      source: { ...sourceRef(nist.entry), note: "Normalized data-table snapshot; see data-sources/snapshots/" },
      crosscheck: [mantidSrc.entry, gemmiSrc.entry, dansSrc.entry, ptSrc.entry, gsasSrc.entry].map(sourceRef),
      retrieved: RETRIEVED,
      entries,
    }),
  );

  const count = (s: string) => entries.filter((e) => e.status === s).length;
  const problemRows = entries
    .filter((e) => e.problems?.length)
    .map((e) => `| ${e.id} | ${e.bCoh?.raw ?? "—"} | ${e.status} | ${e.problems!.join("; ")} |`);
  const identityCounts = new Map<string, number>();
  for (const e of entries) {
    const v = (e.checks.sigmaIdentity ?? "n/a").split(" ")[0]!;
    identityCounts.set(v, (identityCounts.get(v) ?? 0) + 1);
  }
  const editionRows = entries
    .filter((e) => e.checks.itcEdition && e.checks.itcEdition !== "same")
    .map((e) => `| ${e.id} | ${e.bCoh?.raw ?? "—"} | ${e.checks.itcEdition} |`);
  const newerRows = entries.filter((e) => e.checks.newerEvaluations).map((e) => `| ${e.id} | ${e.bCoh?.raw} | ${e.checks.newerEvaluations} |`);

  const md = `# Neutron scattering lengths: Sears (1992) verification

Generated by \`scripts/data/build-tables.ts\`; do not edit by hand.

**Production source:** NCNR/NIST "Neutron scattering lengths and cross sections". It is a manual entry of Sears,
*Neutron News* 3(3) (1992), and NIST warns that it may contain entry errors. The data table is stored as a normalized
snapshot, \`data-sources/snapshots/${nist.entry.file}\` (sha256 \`${nist.entry.sha256.slice(0, 16)}…\`).

**Independent transcriptions:**
- Mantid \`NeutronAtom.cpp\` (all ${mantid.size} rows).
- gemmi \`neutron92.hpp\` (elements only).

Both appear to have been copied from the NIST page, not from the printed article. They catch copying errors on
their side, not NIST's own entry errors. NIST entry errors are caught by the internal identity check below.

**Other editions and evaluations (informational):**
- Dans_Diffraction's Sears table from ITC Vol. C §4.4.4, a later edition. MATERIA's neutron table comes from this file.
- periodictable (Rauch 2003 plus newer measurements).
- GSAS-II \`AtmBlens\` (Rauch & Waschkowski 2003 plus newer). It is **not** Sears 1992.

## Summary

- Rows: **${entries.length}**. Crosschecked: **${count("crosschecked")}**. Discrepant: **${count("discrepant")}**. Unresolved: **${count("unresolved")}**. Unavailable (no b_c printed): **${count("unavailable")}**.
- σ_coh vs 4π|b_c|²/100: ${[...identityCounts].map(([k, v]) => `${k} ${v}`).join(", ")}.

## Rows needing resolution against the printed table

| Row | b_c (NIST) | Status | Problems |
|---|---|---|---|
${problemRows.join("\n")}

## Element value vs abundance-weighted isotope average (informational)

Sears' element values are often measured directly, so a difference is not by itself an error. Rows are listed when
|Δ| > max(0.05 fm, 2 %) or when the abundances do not sum to 100 ± 0.1 %.

| Element | Σ abundance (%) | b_c (element) | Σc·b/Σc (fm) | Δ (fm) |
|---|---:|---|---:|---:|
${avgRows.join("\n")}

## ITC Vol. C edition (Dans_Diffraction) vs Neutron News 1992

The ITC edition revises some values. "imag sign flipped" means the Dans_Diffraction file stores +b'' where NIST prints
−b''. The Dans_Diffraction file is internally inconsistent: for example B is +0.213 but ³He is −1.483.

| Row | b_c (NIST) | ITC edition |
|---|---|---|
${editionRows.join("\n")}

## Newer evaluations differ by more than max(0.02 fm, 1 %) (informational)

| Row | b_c (Sears 1992) | Newer evaluations |
|---|---|---|
${newerRows.join("\n")}
`;
  emit("docs/data-verification/NEUTRON_SEARS1992.md", md);

  return { entries, mantid, gemmi, dans, gsas, pt, counts: { crosschecked: count("crosschecked"), discrepant: count("discrepant") } };
}

// ===================================================== MATERIA neutron audit + report

function auditMateriaNeutron(neutron: ReturnType<typeof buildNeutron>) {
  const path = join(MATERIA_DIR, "src/core/scattering/neutronData.ts");
  const rows = parseMateriaNeutronB(readFileSync(path, "utf8"));
  const out: string[] = [];
  let same = 0;
  for (const r of rows) {
    const nistKey = r.symbol === "D" ? "2H" : r.symbol;
    const e = neutron.entries.find((x) => x.id === nistKey);
    const sears = e?.bCoh;
    const itc = neutron.dans.get(r.symbol === "D" ? "2H" : r.symbol);
    const rauch = neutron.gsas.get(r.symbol === "D" ? "2H" : r.symbol);
    const eq = sears && Math.abs(sears.re - r.cohBRe.value) < 1e-9;
    if (eq && !sears!.im) same++;
    else
      out.push(
        `| ${r.symbol} | ${r.cohBRe.raw} | ${sears ? sears.raw : "—"} | ${itc ? itc.cohBRe.raw + (itc.cohBIm ? ` (im ${itc.cohBIm.raw})` : "") : "—"} | ${rauch ? fmt(rauch.cohBRe.value, 3) : "—"} | ${!eq ? "value differs from Sears 1992" : "imaginary part dropped"} |`,
      );
  }
  return { path, total: rows.length, same, out };
}

function writeMateriaReport(x: ReturnType<typeof auditMateriaXray>, n: ReturnType<typeof auditMateriaNeutron>) {
  const md = `# MATERIA scattering tables: literature check

Generated by \`scripts/data/build-tables.ts\`; do not edit by hand. Checks the tables in MATERIA
(\`web-refinement\` @ \`${MATERIA_COMMIT.slice(0, 7)}\`) against independent transcriptions of the same publications.

## X-ray: Cromer–Mann (ITC Vol. C Table 6.1.1.4)

Compared with: ${x.sourceNames.join(", ")}.

- MATERIA rows: **${x.total}**.
- Rows identical (canonical decimals) to every source that has them, with |f(0) − Z| ≤ 0.1 e: **${x.agreeAll}**.
- Other rows: ${x.rows.length}. "float32" means equal at single precision, i.e. DABAX's \`3.0380001E-03\` style.

| Element | f(0) − Z | ${x.sourceNames.join(" | ")} |
|---|---:|${x.sourceNames.map(() => "---").join("|")}|
${x.rows.join("\n")}

### Plutonium (omitted by MATERIA because its DABAX row gives f(0) ≠ Z)

| Source | a1..a4, b1..b4, c | f(0) − 94 |
|---|---|---:|
${x.puRows.join("\n")}

### Cromer–Mann rows where the transcriptions disagree (all species)

Each variant is listed with the sources that carry it. Physical tests: f(0) should equal N = Z − charge; f must stay
positive; and for ions, f at s = 2 Å⁻¹ should be close to the neutral atom's, because core electrons dominate there.
A variant that fails these is a corrupted row. A variant that passes is the more credible reading of the printed
table, but still needs to be checked against the print.

| Species | Variants |
|---|---|
${x.disputes.join("\n")}

## Neutron: bound coherent b

MATERIA documents its source as "Sears, ITC Vol. C §4.4.4, via Dans_Diffraction", with Ti, Mn, Zn and Au pinned to
"GSAS-II's Sears (1992) Neutron News values". GSAS-II's \`AtmBlens\` table is in fact Rauch & Waschkowski (2003) plus
newer measurements, not Sears (1992). The columns below separate the three evaluations.

- MATERIA rows: **${n.total}**. Rows equal to Sears (1992) and real: **${n.same}**. Other rows: ${n.out.length}.

| Symbol | MATERIA (fm) | Sears 1992 / NIST | ITC edition (Dans) | GSAS-II AtmBlens (fm) | Finding |
|---|---:|---|---|---:|---|
${n.out.join("\n")}
`;
  emit("docs/data-verification/MATERIA_TABLES.md", md);
}

// ===================================================================== instruments

/** Detector geometry flattened from Mantid IDFs (SNS instruments on the Experiment page). */
function buildInstruments() {
  const r6 = (v: readonly number[]) => v.map((x) => Math.round(x * 1e6) / 1e6);
  const instruments = (["idf-topaz", "idf-corelli", "idf-nomad", "idf-powgen", "idf-arcs", "idf-sequoia", "idf-cncs"] as const).map((id) => {
    const src = readSource(id);
    const validFrom = /valid-from\s*=\s*"([^"]*)"/.exec(src.text)?.[1] ?? "";
    const g = flattenIdf(src.text);
    return {
      id: g.name === "PG3" ? "POWGEN" : g.name,
      l1: Math.round(g.l1 * 1e6) / 1e6,
      idf: { ...sourceRef(src.entry), validFrom },
      panels: g.panels.map((p) => ({
        name: p.name,
        kind: p.kind,
        center: r6(p.center),
        base: r6(p.base),
        up: r6(p.up),
        width: Math.round(p.width * 1e6) / 1e6,
        height: Math.round(p.height * 1e6) / 1e6,
        nCols: p.nCols,
        nRows: p.nRows,
        planarity: Math.round(p.planarity * 1e9) / 1e9,
      })),
    };
  });
  emit(
    "src/data/instruments.json",
    json({
      dataset: "instrument-geometry",
      version: "0.1.0",
      tier: "derived-from-mantid-idf",
      description:
        "Detector panels in the Mantid lab frame (beam +z, up +y), metres. Rectangular detectors are exact; tube packs are fitted rectangles (planarity = largest pixel distance from the fitted plane). Columns run along 'base', rows along 'up'.",
      generator: "scripts/data/idf.ts (flattenIdf)",
      source: { id: "mantid-instrument-definitions", sha256: "" },
      instruments,
    }),
  );
}

// ===================================================================== main

const xrayStats = buildXray();
buildInstruments();
const neutron = buildNeutron();
const materiaX = existsSync(join(MATERIA_DIR, "src")) ? auditMateriaXray() : undefined;
if (materiaX) writeMateriaReport(materiaX, auditMateriaNeutron(neutron));
else console.warn(`MATERIA not found at ${MATERIA_DIR}; skipping MATERIA audit (set MATERIA_DIR).`);

const manifest = {
  description: "Generated scattering datasets. Regenerate with `npm run data:build`; never edit generated files by hand.",
  datasets: [...outputs.entries()]
    .filter(([p]) => p.startsWith("src/data/") && p !== "src/data/manifest.json")
    .map(([p, content]) => {
      const parsed = JSON.parse(content) as { dataset: string; version: string; tier: string; source: { id: string; sha256: string } };
      return { file: p, dataset: parsed.dataset, version: parsed.version, tier: parsed.tier, sha256: sha256(content), source: parsed.source };
    }),
};
const sgPath = join(REPO_ROOT, "src/data/space-groups.json");
if (existsSync(sgPath)) {
  const sgText = readFileSync(sgPath, "utf8");
  const sg = JSON.parse(sgText) as { dataset: string; version: string; generator: string };
  manifest.datasets.push({
    file: "src/data/space-groups.json",
    dataset: sg.dataset,
    version: sg.version,
    tier: "generated-from-gemmi",
    sha256: sha256(sgText),
    source: { id: sg.generator, sha256: "" },
  });
}
emit("src/data/manifest.json", json(manifest));

const check = process.argv.includes("--check");
let stale = 0;
for (const [rel, content] of outputs) {
  const abs = join(REPO_ROOT, rel);
  const current = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  if (current === content) continue;
  const tol = numericOutputs.get(rel);
  if (check && current !== undefined && tol !== undefined && sameJsonNumeric(current, content, tol)) continue;
  if (check) {
    stale++;
    console.error(`stale: ${rel}`);
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    console.log(`wrote ${rel}`);
  }
}
console.log(`X-ray WK1995: ${xrayStats.crosschecked}/${xrayStats.total} crosschecked; neutron: ${neutron.counts.crosschecked} crosschecked, ${neutron.counts.discrepant} discrepant`);
if (stale) process.exit(1);
