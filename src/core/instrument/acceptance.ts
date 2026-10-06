/**
 * What the detectors record beyond their geometry: masked pixels, and the
 * directions the sample environment blocks (its shadows).
 *
 * Masks are per pixel. `applyMasks` gives each panel a bitmap or marks it off
 * (detectors.ts), and every hit test honours them: rayHit, the planner,
 * coverage, powder rings and focused banks. A ray stops at the first panel it
 * meets, so a masked pixel is not seen through. Besides edge pixels and whole
 * panels, a Mantid mask file (SaveMask XML) masks detector IDs, mapped to
 * pixels through each panel's IDs from the IDF (scripts/data/idf.ts).
 *
 * Shadows are blocked directions in the angles of the unrolled detector map
 * (simulate.ts cylinderAngles: γ about the vertical from the beam, ν above the
 * horizontal plane), in the environment's own frame:
 *  - an opening: the window is |ν| ≤ ν₀, so everything above and below it is blocked;
 *  - a sector: a leg or post at γ₀ ± Δγ, at every ν;
 *  - a box: γ₁ … γ₂ × ν₁ … ν₂.
 * Each is fixed in the lab, or turns with a goniometer stage: mounted on axis
 * k, it turns with axes 0 … k (R = R₀·R₁·…, axis 0 outermost), so a lab
 * direction u is tested at (R₀ … R_k)ᵀ·u. The two frames agree only where that
 * product is the identity (not, for example, above TOPAZ's χ fixed at 135°).
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulMat } from "@materia/core/math/mat3";
import { axisRotation, type GoniometerModel } from "../ub/goniometer.ts";
import type { Blocked, DetectorPanel } from "./detectors.ts";

const DEG = 180 / Math.PI;

export interface MaskSettings {
  /** Pixels masked at each end of the tubes (tube packs) or at the top and bottom (rectangular panels): rows along `up`. */
  readonly edgeRows: number;
  /** Tubes (tube packs) or pixel columns (rectangular panels) masked at each side: columns along `base`. */
  readonly edgeCols: number;
  /** Panels switched off, by name. */
  readonly panelsOff: readonly string[];
  /** A Mantid mask file. */
  readonly file?: MaskFile;
}

/** A Mantid mask file (SaveMask XML): masked detector IDs as ranges ("0-15,4096"), and masked components by name. */
export interface MaskFile {
  readonly name: string;
  readonly detids: string;
  readonly components: readonly string[];
}

export const NO_MASKS: MaskSettings = { edgeRows: 0, edgeCols: 0, panelsOff: [] };

/** Inclusive ID ranges from "a-b, c, …", merged and sorted. */
export function parseIdRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of text.split(/[\s,]+/)) {
    if (!part) continue;
    const m = /^(-?\d+)(?:-(-?\d+))?$/.exec(part);
    if (!m) throw new Error(`Not a detector ID or range: "${part}"`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    out.push(a <= b ? [a, b] : [b, a]);
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

export const formatIdRanges = (ranges: readonly (readonly [number, number])[]) => ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");

/**
 * A Mantid mask file as SaveMask writes it: <detector-masking><group><detids>…</detids> and <component>…</component>.
 * Spectrum numbers (<ids>) depend on a workspace's spectrum mapping and are refused.
 */
export function parseMantidMask(xml: string, name: string): MaskFile {
  if (!/<detector-masking[\s>]/.test(xml)) throw new Error("Not a Mantid mask file: no <detector-masking> element.");
  if (/<ids>\s*[^<\s]/.test(xml)) throw new Error("This mask lists spectrum numbers (<ids>), which depend on a workspace; save it with detector IDs (<detids>).");
  const detids = [...xml.matchAll(/<detids>([^<]*)<\/detids>/g)].map((m) => m[1]!).join(",");
  const components = [...xml.matchAll(/<component>([^<]*)<\/component>/g)].map((m) => m[1]!.trim()).filter(Boolean);
  return { name, detids: formatIdRanges(parseIdRanges(detids)), components };
}

/**
 * Bitmaps (DetectorPanel.mask layout) of the masked detector IDs on each panel, and the IDs no panel has
 * (e.g. monitors, or a mask made for another detector configuration).
 */
export function idMaskBitmaps(panels: readonly DetectorPanel[], ranges: readonly (readonly [number, number])[]): { bitmaps: (Uint8Array | undefined)[]; matched: number; unmatched: number } {
  const spans = panels
    .map((p, k) => {
      if (!p.ids) return undefined;
      const [s, sc, sr] = p.ids;
      const ends = [s, s + (p.nCols - 1) * sc, s + (p.nRows - 1) * sr, s + (p.nCols - 1) * sc + (p.nRows - 1) * sr];
      return { k, p, lo: Math.min(...ends), hi: Math.max(...ends) };
    })
    .filter((x) => x !== undefined)
    .sort((a, b) => a.lo - b.lo);
  const bitmaps: (Uint8Array | undefined)[] = panels.map(() => undefined);
  let matched = 0;
  let unmatched = 0;
  const pixelOf = (p: DetectorPanel, id: number): number | undefined => {
    const [s, sc, sr] = p.ids!;
    // The larger stride first: id − s = c·sc + r·sr with 0 ≤ c < nCols, 0 ≤ r < nRows.
    const [big, small, nBig, nSmall, colFirst] = Math.abs(sc) >= Math.abs(sr) ? [sc, sr, p.nCols, p.nRows, true] : [sr, sc, p.nRows, p.nCols, false];
    const rel = id - s;
    const i = Math.floor(rel / big);
    const rem = rel - i * big;
    if (i < 0 || i >= nBig || rem % small !== 0) return undefined;
    const j = rem / small;
    if (j < 0 || j >= nSmall) return undefined;
    const [c, r] = colFirst ? [i, j] : [j, i];
    return r * p.nCols + c;
  };
  for (const [a, b] of ranges)
    for (let id = a; id <= b; id++) {
      // Binary search for the last span starting at or below id, then look back over any that overlap.
      let lo = 0;
      let hi = spans.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (spans[mid]!.lo <= id) lo = mid;
        else hi = mid - 1;
      }
      let hit = false;
      for (let q = lo; q >= 0 && !hit; q--) {
        const sp = spans[q]!;
        if (sp.lo > id || sp.hi < id) continue;
        const px = pixelOf(sp.p, id);
        if (px === undefined) continue;
        (bitmaps[sp.k] ??= new Uint8Array(sp.p.nCols * sp.p.nRows))[px] = 1;
        hit = true;
      }
      if (hit) matched++;
      else unmatched++;
    }
  return { bitmaps, matched, unmatched };
}

/**
 * The panels with their masks: edge pixels, panels switched off, and further
 * masked pixels per panel (`extra[k]`, a bitmap like DetectorPanel.mask, e.g.
 * from a mask file). A panel with nothing masked is returned as it is, one with
 * every pixel masked as off.
 */
export function applyMasks(panels: readonly DetectorPanel[], m: MaskSettings, extra?: readonly (Uint8Array | undefined)[]): DetectorPanel[] {
  const off = new Set([...m.panelsOff, ...(m.file?.components ?? [])]);
  const fromFile = m.file ? idMaskBitmaps(panels, parseIdRanges(m.file.detids)).bitmaps : undefined;
  return panels.map((p, k) => {
    if (off.has(p.name)) return { ...p, off: true };
    const er = Math.max(0, Math.floor(m.edgeRows));
    const ec = Math.max(0, Math.floor(m.edgeCols));
    const given = [extra?.[k], fromFile?.[k]].filter((b): b is Uint8Array => b !== undefined);
    if (!er && !ec && !given.length) return p;
    if (2 * er >= p.nRows || 2 * ec >= p.nCols) return { ...p, off: true };
    const bits = new Uint8Array(p.nCols * p.nRows);
    for (const g of given) for (let i = 0; i < bits.length; i++) bits[i] = bits[i]! | g[i]!;
    for (let r = 0; r < p.nRows; r++) {
      const edgeRow = r < er || r >= p.nRows - er;
      for (let c = 0; c < p.nCols; c++) if (edgeRow || c < ec || c >= p.nCols - ec) bits[r * p.nCols + c] = 1;
    }
    return bits.every((b) => b === 1) ? { ...p, off: true } : { ...p, mask: bits };
  });
}

/** Masked pixels and switched-off panels in a panel list. */
export function maskedPixelCount(panels: readonly DetectorPanel[]): { pixels: number; total: number; panelsOff: number } {
  let pixels = 0;
  let total = 0;
  let panelsOff = 0;
  for (const p of panels) {
    const n = p.nCols * p.nRows;
    total += n;
    if (p.off) {
      pixels += n;
      panelsOff++;
    } else if (p.mask) for (const b of p.mask) pixels += b;
  }
  return { pixels, total, panelsOff };
}

interface ShadowFrame {
  /** Goniometer axis the environment is mounted on (it turns with axes 0 … turnsWith); absent: fixed in the lab. */
  readonly turnsWith?: number;
}

export type ShadowShape =
  | (ShadowFrame & { readonly kind: "opening"; readonly halfAngle: number })
  | (ShadowFrame & { readonly kind: "sector"; readonly gamma: number; readonly halfWidth: number })
  | (ShadowFrame & { readonly kind: "box"; readonly gammaMin: number; readonly gammaMax: number; readonly nuMin: number; readonly nuMax: number });

/** An angle in [−180°, 180°). */
const wrap = (a: number) => a - 360 * Math.floor((a + 180) / 360);

/** Whether a shape blocks the direction at map angles γ, ν (deg) of its own frame. */
export function shapeBlocks(s: ShadowShape, gamma: number, nu: number): boolean {
  switch (s.kind) {
    case "opening":
      return Math.abs(nu) > s.halfAngle;
    case "sector":
      return Math.abs(wrap(gamma - s.gamma)) <= s.halfWidth;
    case "box": {
      if (nu < s.nuMin || nu > s.nuMax) return false;
      const span = s.gammaMax - s.gammaMin;
      return span >= 360 || (span >= 0 && gamma - s.gammaMin - 360 * Math.floor((gamma - s.gammaMin) / 360) <= span);
    }
  }
}

/** The rotation of goniometer stages 0 … k at `angles`: what an environment mounted on axis k turns with. */
export function stageRotation(model: GoniometerModel, k: number, angles: readonly number[]): Mat3 {
  let R: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  model.axes.slice(0, k + 1).forEach((ax, i) => {
    R = mulMat(R, axisRotation(ax.direction, ax.sense * (ax.fixed ?? angles[i] ?? 0)));
  });
  return R;
}

/** The frame a shape is tested in: −1 for the lab, else the stage axis (an axis the goniometer lacks counts as the lab). */
const frameOf = (s: ShadowShape, model: GoniometerModel | undefined) => (s.turnsWith !== undefined && model && s.turnsWith >= 0 && s.turnsWith < model.axes.length ? s.turnsWith : -1);

/**
 * The lab directions the shadows block at one goniometer setting, or undefined
 * when there are none. The test takes the components of a unit vector.
 */
export function shadowTest(shapes: readonly ShadowShape[], model: GoniometerModel | undefined, angles: readonly number[]): Blocked | undefined {
  if (!shapes.length) return undefined;
  const byFrame = new Map<number, ShadowShape[]>();
  for (const s of shapes) {
    const k = frameOf(s, model);
    byFrame.set(k, [...(byFrame.get(k) ?? []), s]);
  }
  // Each frame as Rᵀ (rows of R's transpose), so the test needs no allocation.
  const frames = [...byFrame].map(([k, list]) => {
    if (k < 0) return { t: undefined, list };
    const R = stageRotation(model!, k, angles);
    return { t: [R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]] as const, list };
  });
  return (x, y, z) => {
    for (const { t, list } of frames) {
      const a = t ? t[0] * x + t[1] * y + t[2] * z : x;
      const b = t ? t[3] * x + t[4] * y + t[5] * z : y;
      const c = t ? t[6] * x + t[7] * y + t[8] * z : z;
      const gamma = Math.atan2(a, c) * DEG;
      const nu = Math.atan2(b, Math.hypot(a, c)) * DEG;
      for (const s of list) if (shapeBlocks(s, gamma, nu)) return true;
    }
    return false;
  };
}

/** Whether all shapes are fixed in the lab, so the blocked directions do not depend on the goniometer. */
export const labFixed = (shapes: readonly ShadowShape[], model: GoniometerModel | undefined) => shapes.every((s) => frameOf(s, model) < 0);

/** Shadows with the goniometer they turn with: what functions that step through settings take. */
export interface Shadows {
  readonly shapes: readonly ShadowShape[];
  readonly model: GoniometerModel | undefined;
}

/** shadowTest for a Shadows value that may be absent. */
export const blockedAt = (shadows: Shadows | undefined, angles: readonly number[]): Blocked | undefined => (shadows ? shadowTest(shadows.shapes, shadows.model, angles) : undefined);

/** Whether a lab direction is blocked at a setting (one-off checks; shadowTest for many). */
export function shadowBlocks(shadows: Shadows | undefined, angles: readonly number[], u: Vec3): boolean {
  return blockedAt(shadows, angles)?.(u[0], u[1], u[2]) ?? false;
}
