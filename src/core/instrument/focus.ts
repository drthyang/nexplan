/**
 * Focused banks of a TOF powder diffractometer (NOMAD, POWGEN): the pattern a
 * group of detector panels gives after focusing and vanadium normalisation.
 *
 * Each panel is split into nx × ny cells. A cell at scattering angle 2θ_c and
 * distance L2_c subtends Ω_c = A_c·|cos α_c| / L2_c² (α_c between the panel
 * normal and the ray to the cell) and records d from λmin/(2 sin θ_c) to
 * λmax/(2 sin θ_c).
 *
 * Focusing sums the sample counts of the cells in d, and divides by the summed
 * vanadium counts. Per unit solid angle the sample gives Σ|F|²·d⁴·sin θ_c for a
 * line at d (the GSAS-II TOF Lorentz factor, incident spectrum normalised out;
 * see powderRings.ts), and vanadium scatters isotropically, so the cells are
 * weighted by Ω_c over those that record d:
 *
 *   I(d) = Σ|F|²·d⁴·⟨sin θ⟩(d),   ⟨sin θ⟩(d) = Σ_c Ω_c sin θ_c [d ∈ c] / Σ_c Ω_c [d ∈ c].
 *
 * Lines are drawn on the focused bank's TOF axis, t = DIFC_f·d with
 * DIFC_f = (m_n/h)·(L1 + L2_f)·2 sin θ_f, where the effective L2_f and 2θ_f are
 * given (as Mantid's focusing assigns them) or else the Ω-weighted means, unless
 * a calibrated DIFC is given.
 * Every line has the same relative width Δd/d; real focused banks are calibrated
 * and their resolution depends on the group.
 *
 * Masked pixels and directions the sample environment blocks (acceptance.ts)
 * are left out: a cell's solid angle counts only the pixels that record, and
 * the cell sits at their centroid.
 */
import type { Vec3 } from "@materia/core/math/types";
import type { PeakGroup, PowderPeak } from "../diffraction/powder.ts";
import { difcFromGeometry, type TofBank } from "../diffraction/tof.ts";
import type { Blocked, DetectorPanel } from "./detectors.ts";

const DEG = Math.PI / 180;

export interface FocusCell {
  /** Scattering angle 2θ (deg), sample–cell distance L2 (m), solid angle (sr). */
  readonly twoTheta: number;
  readonly l2: number;
  readonly omega: number;
}

/**
 * Cells of the panels (nx along the width, ny along the height of each panel), counting only the pixels that
 * record: a cell with none is left out.
 */
export function focusCells(panels: readonly DetectorPanel[], nx = 4, ny = 8, blocked?: Blocked): FocusCell[] {
  const out: FocusCell[] = [];
  for (const p of panels) {
    if (p.off) continue;
    const n: Vec3 = [p.base[1] * p.up[2] - p.base[2] * p.up[1], p.base[2] * p.up[0] - p.base[0] * p.up[2], p.base[0] * p.up[1] - p.base[1] * p.up[0]];
    const at = (x: number, y: number): Vec3 => [p.center[0] + x * p.base[0] + y * p.up[0], p.center[1] + x * p.base[1] + y * p.up[1], p.center[2] + x * p.base[2] + y * p.up[2]];
    const pixelArea = (p.width / p.nCols) * (p.height / p.nRows);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let x = ((i + 0.5) / nx - 0.5) * p.width;
        let y = ((j + 0.5) / ny - 0.5) * p.height;
        let area = (p.width / nx) * (p.height / ny);
        if (p.mask || blocked) {
          // The pixels of this cell that record, and their centroid.
          let k = 0;
          let sx = 0;
          let sy = 0;
          for (let r = Math.round((j * p.nRows) / ny); r < Math.round(((j + 1) * p.nRows) / ny); r++)
            for (let c = Math.round((i * p.nCols) / nx); c < Math.round(((i + 1) * p.nCols) / nx); c++) {
              if (p.mask?.[r * p.nCols + c] === 1) continue;
              const px = ((c + 0.5) / p.nCols - 0.5) * p.width;
              const py = ((r + 0.5) / p.nRows - 0.5) * p.height;
              if (blocked) {
                const v = at(px, py);
                const l = Math.hypot(v[0], v[1], v[2]);
                if (blocked(v[0] / l, v[1] / l, v[2] / l)) continue;
              }
              k++;
              sx += px;
              sy += py;
            }
          if (!k) continue;
          x = sx / k;
          y = sy / k;
          area = k * pixelArea;
        }
        const c = at(x, y);
        const l2 = Math.hypot(c[0], c[1], c[2]);
        const cosA = Math.abs((c[0] * n[0] + c[1] * n[1] + c[2] * n[2]) / l2);
        out.push({ twoTheta: Math.acos(Math.max(-1, Math.min(1, c[2] / l2))) / DEG, l2, omega: (area * cosA) / (l2 * l2) });
      }
  }
  return out;
}

export interface FocusedBank {
  readonly name: string;
  readonly cells: readonly FocusCell[];
  /** Effective scattering angle (deg), L2 (m) and DIFC (µs/Å) of the focused bank. */
  readonly twoThetaDeg: number;
  readonly l2: number;
  readonly difc: number;
  /** d recorded by any cell (Å), and the 2θ span of the cells (deg). */
  readonly dMin: number;
  readonly dMax: number;
  readonly twoThetaMin: number;
  readonly twoThetaMax: number;
  /** Total solid angle (sr). */
  readonly omega: number;
}

export function focusedBank(
  name: string,
  panels: readonly DetectorPanel[],
  l1: number,
  lambdaMin: number,
  lambdaMax: number,
  opts: { readonly twoThetaDeg?: number; readonly l2?: number; readonly difc?: number; readonly nx?: number; readonly ny?: number; readonly blocked?: Blocked } = {},
): FocusedBank {
  const cells = focusCells(panels, opts.nx, opts.ny, opts.blocked);
  let omega = 0;
  let tt = 0;
  let l2 = 0;
  let sMin = Infinity;
  let sMax = 0;
  let ttMin = Infinity;
  let ttMax = 0;
  for (const c of cells) {
    omega += c.omega;
    tt += c.omega * c.twoTheta;
    l2 += c.omega * c.l2;
    const s = Math.sin((c.twoTheta * DEG) / 2);
    sMin = Math.min(sMin, s);
    sMax = Math.max(sMax, s);
    ttMin = Math.min(ttMin, c.twoTheta);
    ttMax = Math.max(ttMax, c.twoTheta);
  }
  const twoThetaDeg = opts.twoThetaDeg ?? tt / omega;
  const L2 = opts.l2 ?? l2 / omega;
  // A published (calibrated) DIFC takes precedence over the one from the effective geometry.
  return { name, cells, twoThetaDeg, l2: L2, difc: opts.difc ?? difcFromGeometry(l1 + L2, twoThetaDeg), dMin: lambdaMin / (2 * sMax), dMax: lambdaMax / (2 * sMin), twoThetaMin: ttMin, twoThetaMax: ttMax, omega };
}

/** ⟨sin θ⟩(d) over the cells that record d, weighted by solid angle; NaN when none does. */
export function meanSinTheta(bank: FocusedBank, d: number, lambdaMin: number, lambdaMax: number): number {
  let w = 0;
  let ws = 0;
  for (const c of bank.cells) {
    const s = Math.sin((c.twoTheta * DEG) / 2);
    const lambda = 2 * d * s;
    if (lambda < lambdaMin * (1 - 1e-12) || lambda > lambdaMax * (1 + 1e-12)) continue;
    w += c.omega;
    ws += c.omega * s;
  }
  return w > 0 ? ws / w : NaN;
}

/**
 * Lines of the focused pattern: I = Σ|F|²·d⁴·⟨sin θ⟩(d), at t = DIFC_f·d. The cells record a line at
 * different wavelengths, so `lambda` here is only nominal (λ at the effective angle) and is not exported.
 */
export function focusedPeaks(groups: readonly PeakGroup[], bank: FocusedBank, lambdaMin: number, lambdaMax: number): PowderPeak[] {
  const sf = Math.sin((bank.twoThetaDeg * DEG) / 2);
  const out: PowderPeak[] = [];
  for (const g of groups) {
    if (g.d < bank.dMin * (1 - 1e-12) || g.d > bank.dMax * (1 + 1e-12)) continue;
    const s = meanSinTheta(bank, g.d, lambdaMin, lambdaMax);
    if (!Number.isFinite(s)) continue;
    const lp = s * g.d ** 4;
    out.push({ ...g, tof: bank.difc * g.d, lambda: 2 * g.d * sf, lp, intensity: g.sumF2 * lp });
  }
  return out;
}

/**
 * A TofBank for drawing the focused pattern (synthesizeTof): the focused DIFC
 * and 2θ, with the band chosen so that its d range is the bank's (λ = 2d sin θ_f),
 * optionally ended at dMax (a bank with a low-angle panel records d far beyond
 * the structure's longest spacing).
 */
export function focusedTofBank(bank: FocusedBank, opts: { readonly dMax?: number } = {}): TofBank {
  const sf = Math.sin((bank.twoThetaDeg * DEG) / 2);
  const dMax = Math.min(bank.dMax, opts.dMax ?? Infinity);
  return { twoThetaDeg: bank.twoThetaDeg, difc: bank.difc, difa: 0, zero: 0, lambdaMin: 2 * bank.dMin * sf, lambdaMax: 2 * Math.max(bank.dMin, dMax) * sf };
}
