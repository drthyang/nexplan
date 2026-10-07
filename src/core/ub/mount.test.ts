import { describe, expect, it } from "vitest";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { determinant, mulMat, mulVec, transpose } from "@materia/core/math/mat3";
import { goniometerMatrix, laueCondition } from "./goniometer.ts";
import { UNIVERSAL } from "./instruments.ts";
import { isPlane, mountable, mountUB, MountError, PLANE_PRESETS, planeGeometry, planeTrace, setUBCall, uFromVectors, zoneAxis } from "./mount.ts";
import { bMatrix } from "./ub.ts";

const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => a.map((x) => x / Math.hypot(...a)) as unknown as Vec3;
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

describe("mount (Mantid SetUB with u and v)", () => {
  it("reproduces the SetUB documentation example (a 5, b 6, c 7, u = 1,1,0, v = 0,0,1)", () => {
    // docs/source/algorithms/SetUB-v1.rst @ 67c2f43 prints the UB to three decimals (… for |x| < 0.0005).
    const UB = mountUB({ a: 5, b: 6, c: 7, alpha: 90, beta: 90, gamma: 90 }, { u: [1, 1, 0], v: [0, 0, 1] });
    const expected = [
      [0, 0, 0.143],
      [0.128, -0.128, 0],
      [0.154, 0.107, 0],
    ];
    UB.forEach((row, i) => row.forEach((x, j) => expect(Math.abs(x - expected[i]![j]!)).toBeLessThan(0.0006)));
  });

  it("puts B·u along the beam, v horizontal and u × v up, with U a proper rotation, for any cell", () => {
    const cells = [
      { a: 5.431, b: 5.431, c: 5.431, alpha: 90, beta: 90, gamma: 90 },
      { a: 4.76, b: 4.76, c: 12.99, alpha: 90, beta: 90, gamma: 120 },
      { a: 6.1, b: 7.3, c: 8.9, alpha: 77, beta: 101, gamma: 113 },
    ];
    for (const cell of cells)
      for (const { plane } of PLANE_PRESETS) {
        const B = bMatrix(cell);
        const U = uFromVectors(B, plane.u, plane.v);
        const UtU = mulMat(transpose(U), U);
        UtU.forEach((r, i) => r.forEach((x, j) => expect(x).toBeCloseTo(i === j ? 1 : 0, 12)));
        expect(determinant(U)).toBeCloseTo(1, 12);
        const UB = mulMat(U, B);
        const qu = unit(mulVec(UB, plane.u));
        const qv = mulVec(UB, plane.v);
        expect(qu[2]).toBeCloseTo(1, 12); // along +z, the beam
        expect(qv[1]).toBeCloseTo(0, 12); // v horizontal
        expect(qv[0]).toBeGreaterThan(0); // its part ⟂ u towards +x
        const w = unit(cross(mulVec(UB, plane.u), qv));
        expect(w[1]).toBeCloseTo(1, 12); // u × v up
      }
  });

  it("refuses a zero or parallel u, v", () => {
    const B = bMatrix({ a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 });
    expect(() => uFromVectors(B, [0, 0, 0], [1, 0, 0])).toThrow(MountError);
    expect(() => uFromVectors(B, [1, 1, 0], [2, 2, 0])).toThrow(/parallel/);
    const cubic = { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 };
    expect(mountable(cubic, { u: [1, 1, 0], v: [2, 2, 0] })).toBe(false);
    // Nearly parallel: Mantid's own threshold refuses it (an r.l.u. cross product would not).
    expect(mountable(cubic, { u: [1, 0, 0], v: [1, 0, 1e-6] })).toBe(false);
    expect(mountable(cubic, { u: [1, 0, 0], v: [0, 1, 0] })).toBe(true);
    expect(isPlane({ u: [1, 0, 0], v: [0, 1] })).toBe(false);
  });

  it("zone axis u × v (Weiss zone law): perpendicular to every reflection of the plane, reduced to coprime integers", () => {
    expect(zoneAxis({ u: [1, 0, 0], v: [0, 1, 0] })).toEqual([0, 0, 1]);
    expect(zoneAxis({ u: [1, 1, 0], v: [0, 0, 1] })).toEqual([1, -1, 0]);
    expect(zoneAxis({ u: [2, 2, 0], v: [0, 0, 2] })).toEqual([1, -1, 0]);
    const z = zoneAxis({ u: [1, 1, 0], v: [0, 0, 1] });
    for (const h of [[1, 1, 0], [0, 0, 1], [3, 3, -2], [2, 2, 5]] as Vec3[]) expect(dot(h, z)).toBe(0);
  });

  it("geometry: horizontal at zero angles; stays so about a vertical axis; tilted 45° by TOPAZ's χ = 135°", () => {
    const cell = { a: 5.431, b: 5.431, c: 5.431, alpha: 90, beta: 90, gamma: 90 };
    const plane = { u: [1, 1, 0] as Vec3, v: [0, 0, 1] as Vec3 };
    const UB = mountUB(cell, plane);
    const g0 = planeGeometry(UB, I3, plane);
    expect(g0.normal[1]).toBeCloseTo(1, 12);
    expect(g0.tiltDeg).toBeCloseTo(0, 6);
    expect(g0.beamDeg).toBeCloseTo(0, 6);
    expect(g0.uDir[2]).toBeCloseTo(1, 12);
    // ω about the vertical axis keeps the plane horizontal and the beam in it.
    for (const w of [17, 90, 233]) {
      const g = planeGeometry(UB, goniometerMatrix(UNIVERSAL, [w, 0, 0]), plane);
      expect(g.tiltDeg).toBeCloseTo(0, 6);
      expect(g.beamDeg).toBeCloseTo(0, 6);
    }
    // χ = 135° about the beam tilts it by 45°; the beam stays in it.
    const g = planeGeometry(UB, goniometerMatrix(UNIVERSAL, [0, 135, 0]), plane);
    expect(g.tiltDeg).toBeCloseTo(45, 6);
    expect(g.beamDeg).toBeCloseTo(0, 6);
  });

  it("trace: every reflection of the plane that diffracts is scattered along it (n·û = n·ẑ), at any setting", () => {
    const cell = { a: 6.1, b: 7.3, c: 8.9, alpha: 77, beta: 101, gamma: 113 };
    const plane = { u: [1, 1, 0] as Vec3, v: [0, 0, 1] as Vec3 };
    const UB = mountUB(cell, plane);
    let checked = 0;
    for (const angles of [[10, 0, 0], [70, 30, 20], [200, 135, 45]]) {
      const R = goniometerMatrix(UNIVERSAL, angles);
      const { normal } = planeGeometry(UB, R, plane);
      for (const t of planeTrace(normal, 90)) {
        expect(Math.hypot(...t)).toBeCloseTo(1, 12);
        expect(dot(normal, t)).toBeCloseTo(normal[2], 12);
      }
      // Reflections h·u + k·v: their scattered rays satisfy the same equation, at their own wavelengths.
      for (let i = -4; i <= 4; i++)
        for (let j = -4; j <= 4; j++) {
          const h: Vec3 = [i * plane.u[0] + j * plane.v[0], i * plane.u[1] + j * plane.v[1], i * plane.u[2] + j * plane.v[2]];
          const s = laueCondition(mulVec(mulMat(R, UB), h));
          if (!Number.isFinite(s.lambda)) continue;
          expect(dot(normal, unit(s.kf))).toBeCloseTo(normal[2], 9);
          checked++;
        }
    }
    expect(checked).toBeGreaterThan(40);
    // A horizontal plane's trace is the horizontal plane.
    for (const t of planeTrace([0, 1, 0], 36)) expect(t[1]).toBeCloseTo(0, 12);
  });

  it("writes the SetUB call", () => {
    expect(setUBCall({ a: 5, b: 6, c: 7, alpha: 90, beta: 90, gamma: 90 }, { u: [1, 1, 0], v: [0, 0, 1] })).toBe('SetUB(Workspace="ws", a=5, b=6, c=7, alpha=90, beta=90, gamma=90, u="1,1,0", v="0,0,1")');
  });
});
