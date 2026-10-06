/**
 * Detector geometry checked against Mantid's own output for TOPAZ run 3007:
 * TOPAZ_3007.peaks carries the panel geometry Mantid used (DetCal lines) and,
 * for every peak, its detector, column and row. The IDF valid for that run
 * (TOPAZ_Definition_2011-10-21.xml) is read with NEXPLAN's IDF reader.
 * Data are fetched and hash-checked by `npm run data:fetch`; skipped if absent.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Vec3 } from "@materia/core/math/types";
import { flattenIdf } from "../../../scripts/data/idf.ts";
import instruments from "../../data/instruments.json";
import { parseIsawUB } from "../../io/isaw.ts";
import { goniometerMatrix, laueCondition, qLab } from "../ub/goniometer.ts";
import { UNIVERSAL } from "../ub/instruments.ts";
import { panelCorners, rayHit, type DetectorPanel } from "./detectors.ts";

const cache = new URL("../../../data-sources/cache/", import.meta.url).pathname;
const idf2011 = `${cache}idf-topaz-2011/TOPAZ_Definition_2011-10-21.xml`;
const peaksPath = `${cache}mantid-topaz3007-peaks/TOPAZ_3007.peaks`;
const matPath = `${cache}mantid-topaz3007-mat/TOPAZ_3007.mat`;

describe("ray–panel geometry", () => {
  const panel: DetectorPanel = { name: "p", kind: "rectangular", center: [0, 0, 1], base: [1, 0, 0], up: [0, 1, 0], width: 0.2, height: 0.1, nCols: 100, nRows: 50 };
  it("hits the centre pixel straight ahead and the corners at 0.5 and n + 0.5", () => {
    const h = rayHit([panel], [0, 0, 1])!;
    expect(h.col).toBeCloseTo(50.5, 12);
    expect(h.row).toBeCloseTo(25.5, 12);
    expect(h.l2).toBeCloseTo(1, 12);
    const c = panelCorners(panel);
    const u = (v: Vec3): Vec3 => { const n = Math.hypot(...v); return [v[0] / n, v[1] / n, v[2] / n]; };
    const lo = rayHit([panel], u([c[0]![0] * 0.999999, c[0]![1] * 0.999999, 1]))!;
    expect(lo.col).toBeCloseTo(0.5, 3);
    expect(lo.row).toBeCloseTo(0.5, 3);
  });
  it("misses behind the sample and outside the panel; takes the nearest of two panels", () => {
    expect(rayHit([panel], [0, 0, -1])).toBeUndefined();
    expect(rayHit([panel], [0.6, 0, 0.8])).toBeUndefined();
    const near = { ...panel, name: "near", center: [0, 0, 0.5] as Vec3 };
    expect(rayHit([panel, near], [0, 0, 1])!.name).toBe("near");
  });
});

describe("IDF reader defaults, as Mantid's parser (InstrumentDefinitionParser.cpp @ 67c2f43)", () => {
  it("a rotation axis defaults per component, axis-z to 1; idstepbyrow to the pixels along the fill", () => {
    const xml = `<instrument name="T">
      <component type="bank" idstart="1000" idstep="2"><location x="0" y="0" z="1" rot="90" axis-x="1"/></component>
      <type name="bank" is="rectangular_detector" type="pixel" xpixels="4" xstart="-0.015" xstep="0.01" ypixels="3" ystart="-0.01" ystep="0.01"/>
      <type name="pixel" is="detector"/>
    </instrument>`;
    const p = flattenIdf(xml).panels[0]!;
    // axis-x="1" alone is the axis (1, 0, 1) (lines 645-655), so 90° about it takes +y to (−1, 0, 1)/√2.
    p.up.forEach((v, i) => expect(v).toBeCloseTo([-Math.SQRT1_2, 0, Math.SQRT1_2][i]!, 12));
    // Filled along y first: id = idstart + column·idstepbyrow + row·idstep, idstepbyrow = ypixels (lines 1489-1492).
    expect(p.ids).toEqual([1000, 3, 2]);
  });
});

describe("generated instrument geometry", () => {
  it("has the seven SNS instruments with sensible panels facing the sample region", () => {
    const byId = new Map(instruments.instruments.map((i) => [i.id, i]));
    expect([...byId.keys()].sort()).toEqual(["ARCS", "CNCS", "CORELLI", "NOMAD", "POWGEN", "SEQUOIA", "TOPAZ"]);
    expect(byId.get("TOPAZ")!.panels).toHaveLength(25);
    expect(byId.get("CORELLI")!.panels).toHaveLength(91);
    expect(byId.get("NOMAD")!.panels).toHaveLength(99);
    expect(byId.get("POWGEN")!.panels).toHaveLength(40);
    expect(byId.get("ARCS")!.panels).toHaveLength(115);
    expect(byId.get("SEQUOIA")!.panels).toHaveLength(117);
    expect(byId.get("CNCS")!.panels).toHaveLength(50);
    expect(byId.get("TOPAZ")!.l1).toBeCloseTo(18.035, 3);
    for (const ins of instruments.instruments) for (const p of ins.panels) expect(p.planarity).toBeLessThan(1e-4);
  });
});

// The pinned Mantid files (npm run data:fetch). A skipped suite still runs its body to collect tests, so it returns early.
const haveTopaz3007 = existsSync(idf2011) && existsSync(peaksPath) && existsSync(matPath);

describe.skipIf(!haveTopaz3007)("TOPAZ_3007: IDF reader and pixel mapping vs Mantid", () => {
  if (!haveTopaz3007) return;
  const geom = flattenIdf(readFileSync(idf2011, "utf8"));
  const lines = readFileSync(peaksPath, "utf8").split("\n");
  const detcal = lines.filter((l) => l.trim().startsWith("5 ")).map((l) => l.trim().split(/\s+/).map(Number));
  const peaks: { det: number; h: Vec3; col: number; row: number; tt: number; az: number; angles: [number, number, number] }[] = [];
  let det = 0;
  let angles: [number, number, number] = [0, 0, 0];
  for (const l of lines) {
    const t = l.trim().split(/\s+/).map(Number);
    if (l.trim().startsWith("1 ")) {
      det = t[2]!;
      angles = [t[5]!, t[3]!, t[4]!]; // ω, χ, φ
    }
    if (l.trim().startsWith("3 ")) peaks.push({ det, h: [t[2]!, t[3]!, t[4]!], col: t[5]!, row: t[6]!, tt: t[9]!, az: t[10]!, angles });
  }

  it("reproduces the panel geometry Mantid wrote into the peaks file (centres to 0.01 mm)", () => {
    expect(detcal.length).toBe(13);
    for (const t of detcal) {
      const p = geom.panels.find((x) => x.name === `bank${t[1]}`)!;
      expect(p, `bank${t[1]}`).toBeDefined();
      expect(Math.hypot(t[8]! / 100 - p.center[0], t[9]! / 100 - p.center[1], t[10]! / 100 - p.center[2])).toBeLessThan(1e-5);
      expect(Math.hypot(t[11]! - p.base[0], t[12]! - p.base[1], t[13]! - p.base[2])).toBeLessThan(5e-4);
      expect(Math.hypot(t[14]! - p.up[0], t[15]! - p.up[1], t[16]! - p.up[2])).toBeLessThan(5e-4);
    }
  });

  it("puts every observed peak on its recorded detector, column and row (within 0.1 pixel)", () => {
    for (const p of peaks) {
      const u: Vec3 = [Math.sin(p.tt) * Math.cos(p.az), Math.sin(p.tt) * Math.sin(p.az), Math.cos(p.tt)];
      const hit = rayHit(geom.panels, u)!;
      expect(hit, `${p.h}`).toBeDefined();
      expect(hit.name).toBe(`bank${p.det}`);
      expect(Math.abs(hit.col - p.col)).toBeLessThan(0.1);
      expect(Math.abs(hit.row - p.row)).toBeLessThan(0.1);
    }
  });

  it("predicts from UB and the goniometer the detector of every peak, and its pixel within the UB fit's angular residual", () => {
    const ub = parseIsawUB(readFileSync(matPath, "utf8")).UB;
    let worst = 0;
    for (const p of peaks) {
      const s = laueCondition(qLab(goniometerMatrix(UNIVERSAL, p.angles), ub, p.h, 1));
      const hit = rayHit(geom.panels, s.kf)!;
      expect(hit?.name, `${p.h}`).toBe(`bank${p.det}`);
      worst = Math.max(worst, Math.hypot(hit.col - p.col, hit.row - p.row));
    }
    // The UB reproduces these peaks to ≤ 0.45° in direction (topaz.test.ts); at L2 ≤ 0.456 m that is
    // ≤ 3.6 mm, i.e. 5.8 pixels of 0.618 mm. Observed worst case: 5.4 pixels.
    const pixelBound = (0.456 * Math.tan((0.45 * Math.PI) / 180)) / 0.000618;
    expect(worst).toBeLessThan(pixelBound);
  });
});
