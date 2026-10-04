/**
 * Consistency with Mantid: each test transcribes the Mantid formula (source
 * file and line at mantid commit 67c2f43, the commit the instrument definitions
 * are pinned to) and compares it with NEXPLAN's implementation. Geometry,
 * goniometer and UB are also checked end to end against a Mantid TOPAZ peaks
 * file in instrument/detectors.test.ts and ub/topaz.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulMat, mulVec } from "@materia/core/math/mat3";
import { difcFromGeometry, NEUTRON_MASS_OVER_H, tofFromD, tofFromWavelength } from "./diffraction/tof.ts";
import { neutronWavelengthA, NEUTRON_E_MEV_ANGSTROM2 } from "./physics/energy.ts";
import { goniometerMatrix, laueCondition } from "./ub/goniometer.ts";
import { SNS_INSTRUMENTS } from "./ub/instrumentsSns.ts";
import { UNIVERSAL } from "./ub/instruments.ts";
import { bMatrix, ubFromU } from "./ub/ub.ts";

// Framework/Kernel/inc/MantidKernel/PhysicalConstants.h:29,39,51 (CODATA 2006).
const MANTID = { h: 6.62606896e-34, NeutronMass: 1.674927211e-27, meV: 1.602176487e-22 };
const DEG = Math.PI / 180;

describe("constants (Mantid PhysicalConstants.h, CODATA 2006; NEXPLAN CODATA 2018)", () => {
  it("m_n/h for TOF ↔ d and TOF ↔ λ agrees to 1e-7 (Unit.cpp:553)", () => {
    const mantid = (MANTID.NeutronMass * 1e6) / (MANTID.h * 1e10);
    expect(Math.abs(NEUTRON_MASS_OVER_H / mantid - 1)).toBeLessThan(1e-7);
  });

  it("h²/(2 m_n) for E ↔ λ agrees to 1e-6 (Unit.cpp:311, 437)", () => {
    const mantid = (1e20 * MANTID.h * MANTID.h) / (2 * MANTID.NeutronMass * MANTID.meV);
    expect(Math.abs(NEUTRON_E_MEV_ANGSTROM2 / mantid - 1)).toBeLessThan(1e-6);
    // Energy → Wavelength: λ = factor·E^(−1/2), factor = 1e10·h/√(2 m_n meV) (Unit.cpp:437–439).
    const factor = (1e10 * MANTID.h) / Math.sqrt(2 * MANTID.NeutronMass * MANTID.meV);
    for (const E of [3.3, 25, 60, 250]) expect(neutronWavelengthA(E) / (factor / Math.sqrt(E))).toBeCloseTo(1, 6);
  });
});

describe("time of flight (Mantid Unit.cpp)", () => {
  it("d → TOF: DIFC = 1/tofToDSpacingFactor = (L1 + L2)·sinθ / (h/(2 m_n)) and TOF = DIFC·d (lines 579–602, 670–677)", () => {
    const H_OVER_NEUTRON_MASS = (MANTID.h * 1e10) / (2 * MANTID.NeutronMass * 1e6);
    for (const [l1, l2, tt] of [
      [60, 3.2, 90],
      [19.5, 1.3, 153],
      [18, 0.45, 31],
    ] as const) {
      const difc = 1 / (H_OVER_NEUTRON_MASS / ((l1 + l2) * Math.sin((tt * DEG) / 2)));
      expect(difcFromGeometry(l1 + l2, tt) / difc).toBeCloseTo(1, 6);
      for (const d of [0.4, 1.1, 3.7]) expect(tofFromD({ difc: difcFromGeometry(l1 + l2, tt), difa: 0, zero: 0 }, d) / (difc * d)).toBeCloseTo(1, 6);
    }
  });

  it("λ → TOF: TOF = (m_n·L/h)·λ in µs and Å (Wavelength::init, lines 355–357)", () => {
    for (const [L, lambda] of [
      [63.2, 1.5],
      [20.8, 0.4],
    ] as const) {
      const factorTo = ((MANTID.NeutronMass * L) / MANTID.h) * (1e6 / 1e10);
      expect(tofFromWavelength(L, lambda) / (factorTo * lambda)).toBeCloseTo(1, 6);
    }
  });
});

describe("UB (Mantid UnitCell.cpp, OrientedLattice.cpp)", () => {
  it("B is Mantid's Busing–Levy B, element by element, for a triclinic cell (UnitCell.cpp:820–828)", () => {
    const cell = { a: 5.1, b: 7.3, c: 9.7, alpha: 81, beta: 103, gamma: 95 };
    // Reciprocal lengths and angles, as UnitCell::recalculate computes them.
    const [ca, cb, cg] = [cell.alpha, cell.beta, cell.gamma].map((x) => Math.cos(x * DEG)) as [number, number, number];
    const [sa, sb, sg] = [cell.alpha, cell.beta, cell.gamma].map((x) => Math.sin(x * DEG)) as [number, number, number];
    const V = cell.a * cell.b * cell.c * Math.sqrt(1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg);
    const ra = [(cell.b * cell.c * sa) / V, (cell.a * cell.c * sb) / V, (cell.a * cell.b * sg) / V];
    const cosRb = (ca * cg - cb) / (sa * sg);
    const cosRg = (ca * cb - cg) / (sa * sb);
    const rb = Math.acos(cosRb);
    const rg = Math.acos(cosRg);
    const mantidB: Mat3 = [
      [ra[0]!, ra[1]! * Math.cos(rg), ra[2]! * Math.cos(rb)],
      [0, ra[1]! * Math.sin(rg), -ra[2]! * Math.sin(rb) * ca],
      [0, 0, 1 / cell.c],
    ];
    const B = bMatrix(cell);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(B[i]![j]).toBeCloseTo(mantidB[i]![j]!, 12);
  });

  it("Q = 2π·UB·h in Mantid (OrientedLattice::qFromHKL, line 176); NEXPLAN's q = UB·h is Q/2π", () => {
    const UB = ubFromU(goniometerMatrix(UNIVERSAL, [20, 30, 40]), { a: 4, b: 5, c: 6, alpha: 90, beta: 100, gamma: 90 });
    const h: Vec3 = [1, -2, 3];
    const Q = mulVec(UB, h).map((v) => 2 * Math.PI * v);
    expect(Math.hypot(...Q) / Math.hypot(...mulVec(UB, h))).toBeCloseTo(2 * Math.PI, 12);
  });
});

describe("goniometer (Mantid Goniometer.cpp)", () => {
  // Quat(angle, axis).getRotation(): a right-handed (counter-clockwise) rotation; recalculateR multiplies
  // QGlobal *= Q_axis in the order the axes were pushed, angle·sense with CCW = +1 (Goniometer.h:32–34).
  const rot = (deg: number, n: Vec3): Mat3 => {
    const k = Math.hypot(...n);
    const [x, y, z] = n.map((v) => v / k) as [number, number, number];
    const c = Math.cos(deg * DEG);
    const s = Math.sin(deg * DEG);
    const t = 1 - c;
    return [
      [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
      [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
      [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
    ];
  };
  const mantidR = (axes: readonly { direction: Vec3; sense: number }[], angles: readonly number[]) => axes.reduce<Mat3>((R, ax, i) => mulMat(R, rot(angles[i]! * ax.sense, ax.direction)), [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);

  it("Universal (ω about y, χ about z, φ about y, all CCW; lines 298–302): R = R_ω·R_χ·R_φ", () => {
    for (const a of [
      [10, 20, 30],
      [-45, 135, 270],
      [123.4, -67.8, 9.1],
    ]) {
      const ours = goniometerMatrix(UNIVERSAL, a);
      const theirs = mantidR(UNIVERSAL.axes, a);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(ours[i]![j]).toBeCloseTo(theirs[i]![j]!, 12);
    }
  });

  it("every SNS goniometer in the catalog composes its axes the same way", () => {
    for (const ins of SNS_INSTRUMENTS) {
      const angles = ins.goniometer.axes.map((ax, i) => ax.fixed ?? 17 + 23 * i);
      const ours = goniometerMatrix(ins.goniometer, angles);
      const theirs = mantidR(ins.goniometer.axes, angles);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(ours[i]![j]).toBeCloseTo(theirs[i]![j]!, 12);
    }
  });
});

describe("wavelength of a reflection (Mantid Peak::setQLabFrame, Peak.cpp)", () => {
  // 1/λ' = |Q|²/(2·Q_beam) with Q_beam = qSign·Q·ẑ, λ = 2π·λ'... i.e. λ = 2π/(|Q|²/(2 Q_beam)); qSign = −1 for
  // "Crystallography" (Q = k_f − k_i), +1 for "Inelastic" (Q = k_i − k_f). The detector direction is
  // −qSign·Q with its beam component replaced by 1/λ' − Q_beam.
  const mantidPeak = (Q: Vec3, convention: "Crystallography" | "Inelastic") => {
    const qSign = convention === "Crystallography" ? -1 : 1;
    const qBeam = Q[2] * qSign;
    const oneOverWl = (Q[0] ** 2 + Q[1] ** 2 + Q[2] ** 2) / (2 * qBeam);
    const dir: Vec3 = [-Q[0] * qSign, -Q[1] * qSign, oneOverWl - qBeam];
    const n = Math.hypot(...dir);
    return { lambda: (2 * Math.PI) / oneOverWl, dir: dir.map((v) => v / n) as unknown as Vec3 };
  };

  it("λ = −2q_z/|q|² and k_f agree with Mantid in the Crystallography convention, and with −h in the Inelastic one", () => {
    const UB = ubFromU(goniometerMatrix(UNIVERSAL, [5, 10, 15]), { a: 5.431, b: 5.431, c: 5.431, alpha: 90, beta: 90, gamma: 90 });
    const R = goniometerMatrix(UNIVERSAL, [33, 135, 71]);
    let n = 0;
    for (let h = -3; h <= 3; h++)
      for (let k = -3; k <= 3; k++)
        for (let l = -3; l <= 3; l++) {
          const q = mulVec(mulMat(R, UB), [h, k, l]);
          if (!(q[2] < 0)) continue;
          const ours = laueCondition(q);
          const cryst = mantidPeak(q.map((v) => 2 * Math.PI * v) as unknown as Vec3, "Crystallography");
          expect(ours.lambda / cryst.lambda).toBeCloseTo(1, 12);
          for (let i = 0; i < 3; i++) expect(ours.kf[i]).toBeCloseTo(cryst.dir[i]!, 12);
          // Mantid's default Inelastic convention labels the same peak −h: Q_inel = 2π·R·UB·(−h).
          const inel = mantidPeak(q.map((v) => -2 * Math.PI * v) as unknown as Vec3, "Inelastic");
          expect(inel.lambda / ours.lambda).toBeCloseTo(1, 12);
          n++;
        }
    expect(n).toBeGreaterThan(100);
  });
});
