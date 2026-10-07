import { describe, expect, it } from "vitest";
import { focusedBank } from "../instrument/focus.ts";
import { SNS_INSTRUMENTS } from "./instrumentsSns.ts";

const ins = (id: string) => SNS_INSTRUMENTS.find((i) => i.id === id)!;

describe("focused banks in the catalog (NOMAD, POWGEN)", () => {
  it("NOMAD: banks 0–5 (Mantid's numbering) covering every one of the IDF's 99 eight-packs exactly once (IDF Group1–Group6)", () => {
    const nomad = ins("nomad");
    const names = nomad.detectors!.map((p) => p.name);
    const members = nomad.banks!.list.flatMap((b) => b.panels);
    expect(nomad.banks!.list.map((b) => b.name)).toEqual(["Bank 0", "Bank 1", "Bank 2", "Bank 3", "Bank 4", "Bank 5"]);
    expect(members).toHaveLength(99);
    expect(new Set(members).size).toBe(99);
    expect([...members].sort()).toEqual([...names].sort());
    expect(nomad.banks!.list.map((b) => b.panels.length)).toEqual([14, 23, 14, 12, 18, 18]);
  });

  it("NOMAD: each bank's solid-angle-weighted 2θ is near its nominal angle (15, 31, 67, 122, 154, 7°)", () => {
    const nomad = ins("nomad");
    for (const spec of nomad.banks!.list) {
      const panels = nomad.detectors!.filter((p) => spec.panels.includes(p.name));
      const geometric = focusedBank(spec.name, panels, nomad.l1!, 0.1, 3).twoThetaDeg;
      expect(Math.abs(geometric - spec.twoThetaDeg!)).toBeLessThan(6);
    }
  });

  it("POWGEN: one bank of all 40 panels; L2 3.18 m and 2θ 90° with L1 60 m give DIFC 22585.7 µs/Å (autoreduction FinalDIFC 22585.8)", () => {
    const pg = ins("powgen");
    const spec = pg.banks!.list[0]!;
    expect(pg.banks!.list).toHaveLength(1);
    expect([...spec.panels].sort()).toEqual(pg.detectors!.map((p) => p.name).sort());
    expect(pg.l1).toBeCloseTo(60, 6);
    const bank = focusedBank(spec.name, pg.detectors!, pg.l1!, 0.54, 1.59, { twoThetaDeg: spec.twoThetaDeg!, l2: spec.l2! });
    expect(bank.difc).toBeCloseTo(22585.7, 0);
  });

  it("POWGEN frames: the four standard 60 Hz frames are 1.066 Å wide and centred; the default band is the 1.5 Å frame", () => {
    const pg = ins("powgen");
    const frames = pg.frames!.list;
    for (const c of [0.8, 1.5, 2.665, 4.797]) {
      const f = frames.find((x) => x.hz === 60 && x.centre === c)!;
      expect(f.lambdaMax - f.lambdaMin).toBeCloseTo(1.066, 6);
      expect((f.lambdaMin + f.lambdaMax) / 2).toBeCloseTo(c, 6);
    }
    expect([pg.lambdaMin, pg.lambdaMax]).toEqual([0.967, 2.033]);
  });

  it("POWGEN frames: the d range the reduction keeps lies within what the detectors record for that band (IDF 2θ span)", () => {
    const pg = ins("powgen");
    for (const f of pg.frames!.list) {
      const bank = focusedBank("all", pg.detectors!, pg.l1!, f.lambdaMin, f.lambdaMax);
      expect(f.dMin).toBeGreaterThanOrEqual(bank.dMin * 0.99);
      expect(f.dMax).toBeLessThanOrEqual(bank.dMax * 1.01);
    }
  });
});
