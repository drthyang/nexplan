import { describe, expect, it } from "vitest";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { determinant, mulVec } from "@materia/core/math/mat3";
import { axisRotation, goniometerMatrix, laueCondition, qLab, type GoniometerModel } from "./goniometer.ts";
import { ubFromU } from "./ub.ts";

const close = (a: Vec3, b: Vec3, tol = 1e-12) => a.every((v, i) => Math.abs(v - b[i]!) < tol);

describe("goniometer rotations", () => {
  it("rotates counter-clockwise about the axis (right-hand rule)", () => {
    // +90° about +y takes +z to +x and +x to −z.
    const Ry = axisRotation([0, 1, 0], 90);
    expect(close(mulVec(Ry, [0, 0, 1]), [1, 0, 0])).toBe(true);
    expect(close(mulVec(Ry, [1, 0, 0]), [0, 0, -1])).toBe(true);
    // +90° about +z takes +x to +y.
    expect(close(mulVec(axisRotation([0, 0, 1], 90), [1, 0, 0]), [0, 1, 0])).toBe(true);
    expect(determinant(axisRotation([1, 2, 3], 71))).toBeCloseTo(1, 14);
  });

  it("composes axes outermost first, with sense", () => {
    const euler: GoniometerModel = {
      id: "t",
      label: "t",
      note: "",
      axes: [
        { name: "omega", direction: [0, 1, 0], sense: 1, min: -180, max: 180 },
        { name: "chi", direction: [0, 0, 1], sense: 1, min: -180, max: 180 },
        { name: "phi", direction: [0, 1, 0], sense: -1, min: -180, max: 180 },
      ],
    };
    const R = goniometerMatrix(euler, [30, 45, 60]);
    const expected = [axisRotation([0, 1, 0], 30), axisRotation([0, 0, 1], 45), axisRotation([0, 1, 0], -60)];
    const m = (A: Mat3, B: Mat3): Mat3 => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[i]![0]! * B[0]![j]! + A[i]![1]! * B[1]![j]! + A[i]![2]! * B[2]![j]!)) as unknown as Mat3;
    const E = m(m(expected[0]!, expected[1]!), expected[2]!);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(R[i]![j]).toBeCloseTo(E[i]![j]!, 14);
  });
});

describe("Laue condition (Q = k_f − k_i, k = 1/λ along +z)", () => {
  it("backscattering: q antiparallel to the beam gives λ = 2d and 2θ = 180°", () => {
    const d = 1.5;
    const s = laueCondition([0, 0, -1 / d]);
    expect(s.lambda).toBeCloseTo(2 * d, 14);
    expect(s.twoTheta).toBeCloseTo(180, 10);
  });

  it("satisfies Bragg's law λ = 2d sinθ and |k_f| = |k_i| for a general q", () => {
    const q: Vec3 = [0.31, -0.22, -0.47];
    const s = laueCondition(q);
    const d = 1 / Math.hypot(...q);
    expect(s.lambda).toBeCloseTo(2 * d * Math.sin(((s.twoTheta / 2) * Math.PI) / 180), 12);
    const kf: Vec3 = [q[0], q[1], 1 / s.lambda + q[2]];
    expect(Math.hypot(...kf)).toBeCloseTo(1 / s.lambda, 12);
  });

  it("forward-pointing q (q_z ≥ 0) cannot diffract", () => {
    expect(Number.isNaN(laueCondition([0.2, 0, 0.1]).lambda)).toBe(true);
  });

  it("the inelastic-convention sign flips which reflections are in the Ewald half-space", () => {
    const UB = ubFromU(axisRotation([0, 0, 1], 0), { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 });
    const R = axisRotation([0, 1, 0], 0);
    const h: Vec3 = [0, 0, -1];
    expect(laueCondition(qLab(R, UB, h, 1)).lambda).toBeCloseTo(8, 12); // q along −z: backscattering at λ = 2d
    expect(Number.isNaN(laueCondition(qLab(R, UB, h, -1)).lambda)).toBe(true);
  });
});
