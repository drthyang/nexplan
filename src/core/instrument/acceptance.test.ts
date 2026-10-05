import { describe, expect, it } from "vitest";
import type { Vec3 } from "@materia/core/math/types";
import { mulVec, transpose } from "@materia/core/math/mat3";
import type { GoniometerModel } from "../ub/goniometer.ts";
import { goniometerMatrix } from "../ub/goniometer.ts";
import { SNS_INSTRUMENTS } from "../ub/instrumentsSns.ts";
import { ubFromU } from "../ub/ub.ts";
import { applyMasks, formatIdRanges, idMaskBitmaps, maskedPixelCount, parseIdRanges, parseMantidMask, shadowTest, stageRotation, type ShadowShape } from "./acceptance.ts";
import { coverageSolver } from "./coverage.ts";
import { rayHit, type DetectorPanel } from "./detectors.ts";
import { focusCells } from "./focus.ts";
import { familyCounts, targetCoverage, type PlanTarget } from "./plan.ts";
import { mapCells } from "./powderRings.ts";
import { cylinderAngles, observeAt, reflectionCoverage } from "./simulate.ts";

const DEG = Math.PI / 180;
const dirOf = (gammaDeg: number, nuDeg: number): Vec3 => [Math.cos(nuDeg * DEG) * Math.sin(gammaDeg * DEG), Math.sin(nuDeg * DEG), Math.cos(nuDeg * DEG) * Math.cos(gammaDeg * DEG)];
const ambient = SNS_INSTRUMENTS.find((i) => i.id === "topaz-ambient")!;
const topazPanels = ambient.detectors!;

/** The lab direction to the centre of pixel (col, row) of a panel (pixel centres at 1 … n). */
function pixelDirection(p: DetectorPanel, col: number, row: number): Vec3 {
  const x = ((col - 0.5) / p.nCols - 0.5) * p.width;
  const y = ((row - 0.5) / p.nRows - 0.5) * p.height;
  const v: Vec3 = [p.center[0] + x * p.base[0] + y * p.up[0], p.center[1] + x * p.base[1] + y * p.up[1], p.center[2] + x * p.base[2] + y * p.up[2]];
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

const omegaStage = (sense: 1 | -1): GoniometerModel => ({ id: "w", label: "ω", note: "", axes: [{ name: "omega", direction: [0, 1, 0], sense, min: 0, max: 360 }] });

describe("masks", () => {
  it("edge pixels and switched-off panels, counted pixel by pixel; nothing masked leaves a panel as it is", () => {
    const p = topazPanels[0]!;
    expect(p.nCols).toBe(256);
    expect(p.nRows).toBe(256);
    expect(applyMasks(topazPanels, { edgeRows: 0, edgeCols: 0, panelsOff: [] })[0]).toBe(p);
    const masked = applyMasks(topazPanels, { edgeRows: 18, edgeCols: 10, panelsOff: [topazPanels[3]!.name] });
    expect(masked[3]!.off).toBe(true);
    const count = maskedPixelCount(masked);
    const perPanel = 256 * 256 - (256 - 36) * (256 - 20);
    expect(count.panelsOff).toBe(1);
    expect(count.total).toBe(topazPanels.length * 256 * 256);
    expect(count.pixels).toBe((topazPanels.length - 1) * perPanel + 256 * 256);
    // Masking every pixel switches the panel off.
    expect(applyMasks([p], { edgeRows: 128, edgeCols: 0, panelsOff: [] })[0]!.off).toBe(true);
  });

  it("a ray at a masked pixel is not recorded, its neighbour is, and col/row index the bitmap as rayHit reports them", () => {
    const p = topazPanels[5]!;
    const [col, row] = [40, 200];
    const hit = rayHit([p], pixelDirection(p, col, row))!;
    // Panel axes are stored to finite precision: the hit is within 1e-3 pixel of the centre aimed at.
    expect(hit.col).toBeCloseTo(col, 3);
    expect(hit.row).toBeCloseTo(row, 3);
    const bits = new Uint8Array(p.nCols * p.nRows);
    bits[(row - 1) * p.nCols + (col - 1)] = 1;
    const [m] = applyMasks([p], { edgeRows: 0, edgeCols: 0, panelsOff: [] }, [bits]);
    expect(rayHit([m!], pixelDirection(p, col, row))).toBeUndefined();
    expect(rayHit([m!], pixelDirection(p, col + 1, row))).toBeDefined();
    expect(rayHit([m!], pixelDirection(p, col, row - 1))).toBeDefined();
  });

  it("a ray stops at the first panel it meets: a masked panel in front hides the one behind", () => {
    const panel = (z: number, name: string): DetectorPanel => ({ name, kind: "rectangular", center: [0, 0, z], base: [1, 0, 0], up: [0, 1, 0], width: 0.2, height: 0.2, nCols: 10, nRows: 10 });
    const u: Vec3 = [0, 0, 1];
    expect(rayHit([panel(2, "far"), panel(1, "near")], u)!.name).toBe("near");
    const panels = applyMasks([panel(2, "far"), panel(1, "near")], { edgeRows: 0, edgeCols: 0, panelsOff: ["near"] });
    expect(rayHit(panels, u)).toBeUndefined();
  });
});

describe("shadows", () => {
  it("in the lab: an opening, a sector and a box, across the ±180° seam", () => {
    const test = (s: ShadowShape) => shadowTest([s], undefined, [])!;
    const opening = test({ kind: "opening", halfAngle: 10 });
    expect(opening(...dirOf(60, 20))).toBe(true);
    expect(opening(...dirOf(60, -11))).toBe(true);
    expect(opening(...dirOf(60, 5))).toBe(false);
    const leg = test({ kind: "sector", gamma: 45, halfWidth: 5 });
    expect(leg(...dirOf(48, 30))).toBe(true);
    expect(leg(...dirOf(52, 0))).toBe(false);
    expect(test({ kind: "sector", gamma: 178, halfWidth: 5 })(...dirOf(-179, 0))).toBe(true);
    const box = test({ kind: "box", gammaMin: 170, gammaMax: 190, nuMin: -5, nuMax: 5 });
    expect(box(...dirOf(-175, 0))).toBe(true);
    expect(box(...dirOf(175, 0))).toBe(true);
    expect(box(...dirOf(-165, 0))).toBe(false);
    expect(box(...dirOf(-175, 8))).toBe(false);
    expect(shadowTest([], undefined, [])).toBeUndefined();
  });

  it("on a stage: a leg at γ = 45° turns to 45° ± ω with the stage's sense, and agrees with the lab test at (R₀…R_k)ᵀ·u", () => {
    const leg: ShadowShape = { kind: "sector", gamma: 45, halfWidth: 3, turnsWith: 0 };
    expect(shadowTest([leg], omegaStage(1), [30])!(...dirOf(75, 10))).toBe(true);
    expect(shadowTest([leg], omegaStage(1), [30])!(...dirOf(45, 10))).toBe(false);
    expect(shadowTest([leg], omegaStage(-1), [30])!(...dirOf(15, 10))).toBe(true);
    // TOPAZ ambient (ω, χ = 135°, φ), mounted on φ: the environment turns with all three axes.
    const model = ambient.goniometer;
    const shapes: ShadowShape[] = [
      { kind: "box", gammaMin: -40, gammaMax: 70, nuMin: -20, nuMax: 35, turnsWith: 2 },
      { kind: "opening", halfAngle: 25, turnsWith: 0 },
    ];
    const angles = [37, 135, 211];
    const blocked = shadowTest(shapes, model, angles)!;
    const lab = (k: number) => {
      const { turnsWith: _, ...fixed } = shapes[k]!;
      return shadowTest([fixed as ShadowShape], undefined, [])!;
    };
    for (let g = -180; g < 180; g += 13)
      for (let n = -80; n <= 80; n += 11) {
        const u = dirOf(g, n);
        const expected = shapes.some((s, k) => lab(k)(...mulVec(transpose(stageRotation(model, s.turnsWith!, angles)), u)));
        expect(blocked(...u)).toBe(expected);
      }
    // Mounted on the last stage, the environment turns with the whole goniometer.
    expect(stageRotation(model, 2, angles)).toEqual(goniometerMatrix(model, angles));
  });
});

describe("masks and shadows in every hit test", () => {
  // The crystal of plan.test.ts: a 5.431 Å cubic cell, tilted, every hkl with |h|, |k|, |l| ≤ 4, P-1 families.
  const UB = ubFromU(
    [
      [0.96, -0.2, 0.19],
      [0.2, 0.98, 0.0],
      [-0.19, 0.04, 0.98],
    ].map((r) => {
      const n = Math.hypot(...r);
      return r.map((v) => v / n);
    }) as unknown as [Vec3, Vec3, Vec3],
    { a: 5.431, b: 5.431, c: 5.431, alpha: 90, beta: 90, gamma: 90 },
  );
  const keys = new Map<string, number>();
  const refl: PlanTarget[] = [];
  for (let h = -4; h <= 4; h++)
    for (let k = -4; k <= 4; k++)
      for (let l = -4; l <= 4; l++) {
        if (!h && !k && !l) continue;
        const first = [h, k, l].find((v) => v !== 0)!;
        const key = (first < 0 ? [-h, -k, -l] : [h, k, l]).join(",");
        if (!keys.has(key)) keys.set(key, keys.size);
        refl.push({ h: [h, k, l], family: keys.get(key)! });
      }
  const masked = applyMasks(topazPanels, { edgeRows: 30, edgeCols: 30, panelsOff: [topazPanels[7]!.name, topazPanels[12]!.name] });
  const shapes: ShadowShape[] = [
    { kind: "sector", gamma: -60, halfWidth: 12 },
    { kind: "box", gammaMin: 20, gammaMax: 80, nuMin: -10, nuMax: 40, turnsWith: 0 },
  ];
  const shadows = { shapes, model: ambient.goniometer };

  it("the planner's compiled test agrees reflection by reflection with observeAt, and records less than without them", () => {
    const settings = Array.from({ length: 16 }, (_, k) => [(k * 47) % 360, 135, (k * 83) % 360]);
    let withAcceptance = 0;
    let without = 0;
    for (const s of settings) {
      const fast = targetCoverage(ambient.goniometer, [s], UB, refl, masked, 0.4, 3.5, shadows);
      const slow = new Set(observeAt(goniometerMatrix(ambient.goniometer, s), UB, refl, masked, 0.4, 3.5, shadowTest(shapes, ambient.goniometer, s)).map((o) => o.index));
      refl.forEach((_, i) => expect(fast[i] === 1).toBe(slow.has(i)));
      const families = [...familyCounts(ambient.goniometer, [s], UB, refl, masked, 0.4, 3.5, shadows).keys()].sort((a, b) => a - b);
      expect(families).toEqual([...new Set([...slow].map((i) => refl[i]!.family))].sort((a, b) => a - b));
      withAcceptance += slow.size;
      without += observeAt(goniometerMatrix(ambient.goniometer, s), UB, refl, topazPanels, 0.4, 3.5).length;
    }
    expect(withAcceptance).toBeGreaterThan(100);
    expect(withAcceptance).toBeLessThan(without * 0.85);
  });

  it("exact coverage: never in a lab shadow, open at its own angles, and every stepped landing still solvable", () => {
    const cubicUB = ubFromU(
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      { a: 5.431, b: 5.431, c: 5.431, alpha: 90, beta: 90, gamma: 90 },
    );
    const h: Vec3 = [4, 0, 0];
    const solver = coverageSolver(ambient.goniometer, cubicUB, [h], 0.4, 3.5, shadows);
    const lab = shadowTest([shapes[0]!], undefined, [])!;
    let solved = 0;
    for (let g = -170; g <= 170; g += 5)
      for (let n = -50; n <= 50; n += 5) {
        const u = dirOf(g, n);
        const sol = solver.solve(u, 1e-7);
        if (!sol) continue;
        solved++;
        expect(lab(...u)).toBe(false);
        expect(shadowTest(shapes, ambient.goniometer, sol.angles)!(...u)).toBe(false);
      }
    expect(solved).toBeGreaterThan(50);
    const stepped = reflectionCoverage(ambient.goniometer, [0, 135, 0], cubicUB, [{ h }], masked, 0.4, 3.5, 4, 200_000, shadows);
    expect(stepped.points.length).toBeGreaterThan(50);
    for (const p of stepped.points) {
      const l2 = Math.hypot(...p.hit.position);
      expect(solver.solve([p.hit.position[0] / l2, p.hit.position[1] / l2, p.hit.position[2] / l2], 1e-7)).toBeDefined();
    }
  });

  it("focused banks: a cell's solid angle counts only the pixels that record; a panel fully masked adds nothing", () => {
    const nomad = SNS_INSTRUMENTS.find((i) => i.id === "nomad")!.detectors!;
    const pack = nomad.find((p) => p.kind === "tube-pack")!;
    expect(pack.nRows).toBe(128);
    // Solid angle of the unmasked pixels, summed pixel by pixel.
    const solidAngle = (p: DetectorPanel, keep: (c: number, r: number) => boolean) => {
      const n: Vec3 = [p.base[1] * p.up[2] - p.base[2] * p.up[1], p.base[2] * p.up[0] - p.base[0] * p.up[2], p.base[0] * p.up[1] - p.base[1] * p.up[0]];
      let omega = 0;
      for (let r = 0; r < p.nRows; r++)
        for (let c = 0; c < p.nCols; c++) {
          if (!keep(c, r)) continue;
          const x = ((c + 0.5) / p.nCols - 0.5) * p.width;
          const y = ((r + 0.5) / p.nRows - 0.5) * p.height;
          const v: Vec3 = [p.center[0] + x * p.base[0] + y * p.up[0], p.center[1] + x * p.base[1] + y * p.up[1], p.center[2] + x * p.base[2] + y * p.up[2]];
          const l = Math.hypot(...v);
          omega += ((p.width / p.nCols) * (p.height / p.nRows) * Math.abs((v[0] * n[0] + v[1] * n[1] + v[2] * n[2]) / l)) / (l * l);
        }
      return omega;
    };
    const [edged] = applyMasks([pack], { edgeRows: 16, edgeCols: 0, panelsOff: [] });
    const total = (cells: ReturnType<typeof focusCells>) => cells.reduce((s, c) => s + c.omega, 0);
    const expected = solidAngle(pack, (_, r) => r >= 16 && r < 112);
    // One cell per pixel: exactly the pixel sum. The default 4 × 8 cells: within the cells' flat-area approximation.
    expect(total(focusCells([edged!], pack.nCols, pack.nRows)) / expected).toBeCloseTo(1, 10);
    expect(total(focusCells([edged!])) / expected).toBeCloseTo(1, 2);
    expect(total(focusCells([edged!])) / total(focusCells([pack]))).toBeLessThan(0.8);
    expect(focusCells(applyMasks([pack], { edgeRows: 0, edgeCols: 0, panelsOff: [pack.name] }))).toHaveLength(0);
  });

  it("unrolled map: masked pixels and blocked directions record nothing", () => {
    const nomad = SNS_INSTRUMENTS.find((i) => i.id === "nomad")!.detectors!;
    const [w, h, nuMax] = [360, 120, 60];
    const plain = mapCells(nomad, w, h, nuMax);
    const off = applyMasks(nomad, { edgeRows: 0, edgeCols: 0, panelsOff: [nomad[10]!.name] });
    const leg = shadowTest([{ kind: "sector", gamma: 90, halfWidth: 10 }], undefined, [])!;
    const cells = mapCells(off, w, h, nuMax, leg);
    let kept = 0;
    for (let c = 0; c < w * h; c++) {
      if (plain.panel[c]! < 0) continue;
      const g = -180 + ((c % w) + 0.5) * (360 / w);
      const nu = nuMax - (Math.floor(c / w) + 0.5) * ((2 * nuMax) / h);
      const shadowed = Math.abs(cylinderAngles(dirOf(g, nu)).gamma - 90) <= 10;
      if (plain.panel[c] === 10 || shadowed) expect(cells.panel[c]).toBe(-1);
      else {
        expect(cells.panel[c]).toBe(plain.panel[c]);
        kept++;
      }
    }
    expect(kept).toBeGreaterThan(1000);
  });
});

describe("Mantid mask files", () => {
  const corelli = SNS_INSTRUMENTS.find((i) => i.id === "corelli")!.detectors!;
  const idOf = (p: DetectorPanel, c: number, r: number) => p.ids![0] + c * p.ids![1] + r * p.ids![2];

  it("detector IDs from the IDF: TOPAZ banks from idstart (bank·65536, 256 per column), CORELLI 4096 per bank, 256 per tube", () => {
    const bank13 = topazPanels.find((p) => p.name === "bank13")!;
    expect(bank13.ids).toEqual([13 * 65536, 256, 1]);
    expect(corelli[0]!.name).toBe("bank1");
    expect(corelli[0]!.ids).toEqual([0, 256, 1]);
    expect(corelli.find((p) => p.name === "bank91")!.ids).toEqual([90 * 4096, 256, 1]);
    // Every instrument: one ID per pixel, none shared.
    for (const ins of SNS_INSTRUMENTS) {
      if (ins.id === "topaz-ambient" || ins.id === "topaz-cryo") continue;
      const seen = new Set<number>();
      for (const p of ins.detectors!) for (let c = 0; c < p.nCols; c++) for (let r = 0; r < p.nRows; r++) seen.add(idOf(p, c, r));
      expect(seen.size).toBe(ins.detectors!.reduce((n, p) => n + p.nCols * p.nRows, 0));
    }
  });

  it("parses SaveMask XML into merged ranges and component names; refuses spectrum numbers", () => {
    const xml = `<?xml version="1.0"?>
<detector-masking>
  <group>
    <detids>4100-4103,4096-4099, 9000,-1</detids>
    <component>bank5</component>
  </group>
  <group><detids>9001</detids></group>
</detector-masking>`;
    const m = parseMantidMask(xml, "corelli_mask.xml");
    expect(m.detids).toBe("-1,4096-4103,9000-9001");
    expect(m.components).toEqual(["bank5"]);
    expect(formatIdRanges(parseIdRanges("5, 1-3, 4"))).toBe("1-5");
    expect(() => parseMantidMask("<detector-masking><group><ids>1-10</ids></group></detector-masking>", "s.xml")).toThrow(/spectrum numbers/);
    expect(() => parseMantidMask("<masking/>", "x.xml")).toThrow(/Not a Mantid mask file/);
  });

  it("each masked ID lands on its own pixel; IDs no panel has are counted, not placed", () => {
    // Pixels 0–15 of tube 3 of bank2, one pixel of bank91, and two monitor IDs.
    const bank2 = corelli.find((p) => p.name === "bank2")!;
    const bank91 = corelli.find((p) => p.name === "bank91")!;
    const ranges = parseIdRanges(`${idOf(bank2, 3, 0)}-${idOf(bank2, 3, 15)},${idOf(bank91, 15, 255)},-2,-1`);
    const { bitmaps, matched, unmatched } = idMaskBitmaps(corelli, ranges);
    expect(matched).toBe(17);
    expect(unmatched).toBe(2);
    const b2 = bitmaps[corelli.indexOf(bank2)]!;
    for (let r = 0; r < bank2.nRows; r++) for (let c = 0; c < bank2.nCols; c++) expect(b2[r * bank2.nCols + c]).toBe(c === 3 && r < 16 ? 1 : 0);
    expect(bitmaps[corelli.indexOf(bank91)]![255 * 16 + 15]).toBe(1);
    expect(bitmaps.filter(Boolean)).toHaveLength(2);
    // Round trip on TOPAZ's rectangular panels too: a random pixel's ID masks that pixel and no other.
    for (const [k, c, r] of [
      [0, 0, 0],
      [7, 200, 13],
      [24, 255, 255],
    ] as const) {
      const p = topazPanels[k]!;
      const res = idMaskBitmaps(topazPanels, [[idOf(p, c, r), idOf(p, c, r)]]);
      expect(res.matched).toBe(1);
      expect(res.bitmaps[k]![r * p.nCols + c]).toBe(1);
      expect(res.bitmaps[k]!.reduce((a, b) => a + b, 0)).toBe(1);
    }
  });

  it("a mask file masks those pixels in every hit test: a ray at a masked ID is not recorded", () => {
    const p = topazPanels[5]!;
    const file = { name: "m.xml", detids: formatIdRanges([[idOf(p, 39, 199), idOf(p, 39, 199)]]), components: [topazPanels[9]!.name] };
    const masked = applyMasks(topazPanels, { edgeRows: 0, edgeCols: 0, panelsOff: [], file });
    expect(maskedPixelCount(masked).pixels).toBe(1 + 256 * 256);
    expect(masked[9]!.off).toBe(true);
    // Pixel (40, 200) in rayHit's 1-based numbering is column 39, row 199.
    expect(rayHit(masked, pixelDirection(p, 40, 200))).toBeUndefined();
    expect(rayHit(masked, pixelDirection(p, 41, 200))).toBeDefined();
  });
});
