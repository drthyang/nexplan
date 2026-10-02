/**
 * Parsers for the upstream scattering-table transcriptions in data-sources/.
 * Every numeric field keeps its source text (`raw`) next to the parsed value so
 * comparisons can report exactly what each source printed.
 */

export interface Num {
  readonly raw: string;
  readonly value: number;
}

function num(raw: string): Num {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Non-finite numeric field '${raw}'`);
  return { raw, value };
}

/** Gaussian-sum form factor f0(s) = Σ a_i exp(-b_i s²) + c. */
export interface GaussianRow {
  readonly label: string;
  readonly z?: number;
  readonly a: readonly Num[];
  readonly b: readonly Num[];
  readonly c: Num;
}

/**
 * DABAX f0 files: `#S <Z> <label>` blocks, a `#L` line naming the columns
 * (a1..an, c, b1..bn in some order), then one data line.
 */
export function parseDabaxF0(text: string, nGauss: number): GaussianRow[] {
  const rows: GaussianRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^#S\s+(\d+)\s+(\S+)\s*$/.exec(lines[i]!);
    if (!m) continue;
    const z = Number(m[1]);
    const label = m[2]!;
    let cols: string[] | undefined;
    let data: string[] | undefined;
    for (let j = i + 1; j < lines.length && !lines[j]!.startsWith("#S"); j++) {
      const line = lines[j]!.trim();
      if (line.startsWith("#L")) cols = line.slice(2).trim().split(/\s+/);
      else if (line !== "" && !line.startsWith("#")) {
        data = line.split(/\s+/);
        break;
      }
    }
    if (!cols || !data) throw new Error(`DABAX block ${label}: missing #L or data line`);
    if (cols.length !== 2 * nGauss + 1 || data.length !== cols.length) {
      throw new Error(`DABAX block ${label}: expected ${2 * nGauss + 1} columns, got ${cols.length}/${data.length}`);
    }
    const field = (name: string): Num => {
      const k = cols!.indexOf(name);
      if (k < 0) throw new Error(`DABAX block ${label}: no column ${name}`);
      return num(data![k]!);
    };
    const a: Num[] = [];
    const b: Num[] = [];
    for (let k = 1; k <= nGauss; k++) {
      a.push(field(`a${k}`));
      b.push(field(`b${k}`));
    }
    rows.push({ label, z, a, b, c: field("c") });
  }
  return rows;
}

/**
 * cctbx eltbx raw tables: `{ "Label", { a1..an }, { b1..bn }, c }` entries
 * between BEGIN_COMPILED_IN_REFERENCE_DATA and END_COMPILED_IN_REFERENCE_DATA.
 */
export function parseCctbxGaussianTable(text: string, nGauss: number): GaussianRow[] {
  const begin = text.indexOf("BEGIN_COMPILED_IN_REFERENCE_DATA");
  const end = text.indexOf("END_COMPILED_IN_REFERENCE_DATA");
  if (begin < 0 || end < 0) throw new Error("cctbx table markers not found");
  const body = text.slice(begin, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const re = /\{\s*"([^"]+)"\s*,\s*\{([^}]*)\}\s*,\s*\{([^}]*)\}\s*,\s*([-+0-9.eE]+)\s*\}/g;
  const rows: GaussianRow[] = [];
  for (const m of body.matchAll(re)) {
    const a = m[2]!.split(",").map((s) => num(s.trim()));
    const b = m[3]!.split(",").map((s) => num(s.trim()));
    if (a.length !== nGauss || b.length !== nGauss) throw new Error(`cctbx entry ${m[1]}: wrong coefficient count`);
    rows.push({ label: m[1]!, a, b, c: num(m[4]!) });
  }
  return rows;
}

/** gemmi it92.hpp: `{a1, a2, a3, a4, b1, b2, b3, b4, c}, // Label`. */
export function parseGemmiIt92(text: string): GaussianRow[] {
  const rows: GaussianRow[] = [];
  const re = /^\s*\{([-+0-9.eE,\s]+)\},\s*\/\/\s*(\S+)/gm;
  for (const m of text.matchAll(re)) {
    const v = m[1]!.split(",").map((s) => num(s.trim()));
    if (v.length !== 9) continue;
    rows.push({ label: m[2]!, a: v.slice(0, 4), b: v.slice(4, 8), c: v[8]! });
  }
  return rows;
}

/** GSAS-II atmdata.py XrayFF: `'Fe+2': {'Z':26,'fa':[...],'fb':[...],'fc': x},`. */
export function parseGsasXrayFF(text: string): GaussianRow[] {
  const start = text.indexOf("XrayFF = {");
  const end = text.indexOf("\n}", start);
  const body = text.slice(start, end);
  const re = /'([^']+)':\s*\{'Z':\s*(\d+),\s*'fa':\s*\[([^\]]*)\],\s*'fb':\s*\[([^\]]*)\],\s*'fc':\s*([-+0-9.eE]+)\s*\}/g;
  const rows: GaussianRow[] = [];
  for (const m of body.matchAll(re)) {
    rows.push({
      label: m[1]!,
      z: Number(m[2]),
      a: m[3]!.split(",").map((s) => num(s.trim())),
      b: m[4]!.split(",").map((s) => num(s.trim())),
      c: num(m[5]!),
    });
  }
  return rows;
}

/** MATERIA cromerMannData.ts: `Fe: { a: [...], b: [...], c: x },`. */
export function parseMateriaCromerMann(text: string): GaussianRow[] {
  const re = /^\s*([A-Z][a-z]?):\s*\{\s*a:\s*\[([^\]]*)\],\s*b:\s*\[([^\]]*)\],\s*c:\s*([-+0-9.eE]+)\s*\}/gm;
  const rows: GaussianRow[] = [];
  for (const m of text.matchAll(re)) {
    rows.push({
      label: m[1]!,
      a: m[2]!.split(",").map((s) => num(s.trim())),
      b: m[3]!.split(",").map((s) => num(s.trim())),
      c: num(m[4]!),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- neutron

/** A value printed with an optional standard uncertainty, e.g. `5.333(7)` or `5333.(7.)`. */
export interface Measured {
  readonly raw: string;
  readonly value: number;
  /** Uncertainty in the same units, when printed. */
  readonly su?: number;
  /** Printed as an upper limit, e.g. `<8.`; value is the limit. */
  readonly upperLimit?: true;
}

/**
 * Parse a scalar with optional parenthesized uncertainty. Two notations occur:
 * `3.26(3)` (su in units of the last digit → 0.03) and `5333.(7.)` / `25.0(1.8)`
 * (su written with its own decimal point → 7, 1.8).
 */
export function parseMeasured(raw: string): Measured {
  if (raw.startsWith("<")) return { ...parseMeasured(raw.slice(1)), raw, upperLimit: true };
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(?:\(([\d.]+)\))?$/.exec(raw);
  if (!m) throw new Error(`Cannot parse measured value '${raw}'`);
  const mant = m[1]!;
  const value = Number(mant);
  if (m[2] === undefined) return { raw, value };
  const suText = m[2];
  let su: number;
  if (suText.includes(".")) su = Number(suText);
  else {
    const dot = mant.indexOf(".");
    const decimals = dot < 0 ? 0 : mant.replace(/[eE].*$/, "").length - dot - 1;
    su = Number(suText) * 10 ** -decimals;
  }
  return { raw, value, su };
}

export interface ComplexMeasured {
  readonly raw: string;
  readonly re: Measured;
  /** Imaginary part exactly as printed (sign included); undefined when real. */
  readonly im?: Measured;
}

/** NIST/Sears complex notation `5.74-1.483i`, `-0.1-1.066i`, or a real value. */
export function parseComplex(raw: string): ComplexMeasured {
  const s = raw.replace(/\s+/g, "");
  const m = /^([-+]?[\d.]+(?:\([\d.]+\))?)([-+][\d.]+(?:\([\d.]+\))?)i$/.exec(s);
  if (m) return { raw, re: parseMeasured(m[1]!), im: parseMeasured(m[2]!) };
  return { raw, re: parseMeasured(s) };
}

export interface NistRow {
  readonly label: string;
  /** Element symbol, mass number (undefined for an element row). */
  readonly symbol: string;
  readonly mass?: number;
  /** Natural abundance in %, or half-life text for radioisotopes, or undefined ('---'). */
  readonly abundance?: Measured;
  readonly halfLife?: string;
  readonly cohB?: ComplexMeasured;
  readonly incB?: ComplexMeasured;
  /** Incoherent b printed with (+/-): sign undetermined. */
  readonly incBSignUnknown?: boolean;
  readonly cohXs?: Measured;
  readonly incXs?: Measured;
  readonly scattXs?: Measured;
  readonly absXs?: Measured;
  readonly rawCells: readonly string[];
}

const MISSING = new Set(["---", ""]);

/** Parse the normalized NIST table snapshot (tab-separated, one row per line). */
export function parseNistTable(tsv: string): NistRow[] {
  const rows: NistRow[] = [];
  for (const line of tsv.split("\n")) {
    if (line.trim() === "") continue;
    const cells = line.split("\t");
    if (cells.length !== 8) throw new Error(`NIST row with ${cells.length} cells: ${line}`);
    const label = cells[0]!;
    const lm = /^(\d+)?([A-Z][a-z]?)$/.exec(label);
    if (!lm) throw new Error(`Unrecognized NIST label '${label}'`);
    const opt = (k: number): Measured | undefined => (MISSING.has(cells[k]!) ? undefined : parseMeasured(cells[k]!));
    const conc = cells[1]!;
    let abundance: Measured | undefined;
    let halfLife: string | undefined;
    if (/^\(.*\)$/.test(conc)) halfLife = conc.slice(1, -1);
    else if (!MISSING.has(conc)) abundance = parseMeasured(conc);
    let incRaw = cells[3]!;
    const incBSignUnknown = incRaw.startsWith("(+/-)");
    if (incBSignUnknown) incRaw = incRaw.slice(5);
    rows.push({
      label,
      symbol: lm[2]!,
      ...(lm[1] !== undefined ? { mass: Number(lm[1]) } : {}),
      ...(abundance ? { abundance } : {}),
      ...(halfLife !== undefined ? { halfLife } : {}),
      ...(MISSING.has(cells[2]!) ? {} : { cohB: parseComplex(cells[2]!) }),
      ...(MISSING.has(incRaw) ? {} : { incB: parseComplex(incRaw) }),
      ...(incBSignUnknown ? { incBSignUnknown } : {}),
      ...(opt(4) ? { cohXs: opt(4)! } : {}),
      ...(opt(5) ? { incXs: opt(5)! } : {}),
      ...(opt(6) ? { scattXs: opt(6)! } : {}),
      ...(opt(7) ? { absXs: opt(7)! } : {}),
      rawCells: cells,
    });
  }
  return rows;
}

export interface SimpleNeutronRow {
  readonly symbol: string;
  readonly mass?: number;
  readonly cohBRe: Num;
  readonly cohBIm?: Num;
  readonly cohXs?: Num;
}

/**
 * Mantid NeutronAtom.cpp: `static const NeutronAtom Name(z, [a,] cohRe, [cohIm,] incRe, [incIm,] cohXs, incXs, totXs, absXs);`
 * 7 args = element real; 8 = isotope real; 9 = element complex; 10 = isotope complex.
 */
export function parseMantidNeutronAtoms(text: string, zToSymbol: (z: number) => string): SimpleNeutronRow[] {
  const rows: SimpleNeutronRow[] = [];
  const re = /static const NeutronAtom (\w+)\(([^)]*)\);/g;
  for (const m of text.matchAll(re)) {
    const args = m[2]!.split(",").map((s) => s.trim());
    const z = Number(args[0]);
    if (z === 0) continue;
    let mass: number | undefined;
    let rest: string[];
    if (args.length === 8 || args.length === 10) {
      mass = Number(args[1]);
      rest = args.slice(2);
    } else if (args.length === 7 || args.length === 9) {
      rest = args.slice(1);
    } else continue;
    const complex = rest.length === 8;
    const cohBRe = num(rest[0]!);
    const cohBIm = complex ? num(rest[1]!) : undefined;
    const cohXs = num(rest[complex ? 4 : 2]!);
    rows.push({
      symbol: zToSymbol(z),
      ...(mass !== undefined && mass !== 0 ? { mass } : {}),
      cohBRe,
      ...(cohBIm ? { cohBIm } : {}),
      cohXs,
    });
  }
  return rows;
}

/** gemmi neutron92.hpp: `/*Sym*\/ value,` pairs in the Neutron92 data array. */
export function parseGemmiNeutron92(text: string): SimpleNeutronRow[] {
  const start = text.indexOf("Neutron92<Real>::data[");
  const body = text.slice(start, text.indexOf("};", start));
  const rows: SimpleNeutronRow[] = [];
  for (const m of body.matchAll(/\/\*([A-Z][a-z]?)\*\/\s*([-+0-9.eE]+)/g)) {
    if (m[1] === "X") continue;
    rows.push({ symbol: m[1]!, cohBRe: num(m[2]!) });
  }
  return rows;
}

/** Dans_Diffraction Sears file: `Sym, re, im` or `A-Sym, re, im`. */
export function parseDansSears(text: string): SimpleNeutronRow[] {
  const rows: SimpleNeutronRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const [label, re, im] = line.split(",").map((s) => s.trim());
    const m = /^(?:(\d+)-)?([A-Z][a-z]?)$/.exec(label!);
    if (!m) continue;
    rows.push({
      symbol: m[2]!,
      ...(m[1] ? { mass: Number(m[1]) } : {}),
      cohBRe: num(re!),
      ...(im !== undefined && Number(im) !== 0 ? { cohBIm: num(im) } : {}),
    });
  }
  return rows;
}

/**
 * periodictable nsf.py `nsftable`: `Z-Sym[-A],abundance,spin,b_c,b+,b-,flag,coh_xs,inc_xs,tot_xs,abs_xs`.
 * Values are a different evaluation (Rauch 2003 plus later measurements).
 */
export function parsePeriodictableNsf(text: string): SimpleNeutronRow[] {
  const start = text.indexOf('nsftable = """');
  const end = text.indexOf('"""', start + 14);
  const rows: SimpleNeutronRow[] = [];
  for (const line of text.slice(start + 15, end).split("\n")) {
    const cells = line.split(",");
    const m = /^\d+-([A-Z][a-z]?)(?:-(\d+))?$/.exec(cells[0] ?? "");
    if (!m || cells.length < 11) continue;
    const bc = cells[3]!.trim();
    const cm = /^([-+]?[\d.]+)(?:\([\d.]+\))?$/.exec(bc);
    if (!cm) continue;
    rows.push({ symbol: m[1]!, ...(m[2] ? { mass: Number(m[2]) } : {}), cohBRe: num(cm[1]!) });
  }
  return rows;
}

/** MATERIA neutronData.ts: `  Sym: value,` lines inside NEUTRON_B. */
export function parseMateriaNeutronB(text: string): SimpleNeutronRow[] {
  const start = text.indexOf("NEUTRON_B");
  const rows: SimpleNeutronRow[] = [];
  for (const m of text.slice(start).matchAll(/^\s*([A-Z][a-z]?):\s*([-+0-9.eE]+),/gm)) {
    rows.push({ symbol: m[1]!, cohBRe: num(m[2]!) });
  }
  return rows;
}

/**
 * GSAS-II atmdata.py AtmBlens: `'Fe_57': {'Mass': .., 'SL':[re, im], ...}` with
 * SL in units of 1e-12 cm (= 10 fm). Rauch & Waschkowski (2003) plus newer values.
 */
export function parseGsasAtmBlens(text: string): SimpleNeutronRow[] {
  const start = text.indexOf("AtmBlens = {");
  const body = text.slice(start, text.indexOf("\n}", start));
  const rows: SimpleNeutronRow[] = [];
  const re = /'([A-Z][a-z]?)_(\d*)':\s*\{'Mass':\s*[\d.]+,\s*'SL':\s*\[\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\]/g;
  for (const m of body.matchAll(re)) {
    if (m[1] === "D" || m[1] === "T") continue;
    const toFm = (s: string): Num => ({ raw: s, value: Number(s) * 10 });
    const im = Number(m[4]);
    rows.push({
      symbol: m[1]!,
      ...(m[2] ? { mass: Number(m[2]) } : {}),
      cohBRe: toFm(m[3]!),
      ...(im !== 0 ? { cohBIm: toFm(m[4]!) } : {}),
    });
  }
  return rows;
}
