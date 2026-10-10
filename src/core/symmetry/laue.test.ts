import { describe, expect, it } from "vitest";
import { centringConditions, closeHklGroup, formatHklOp, laueClassName, laueGroupHkl, matchViewerPreset, parseHklOp } from "./laue.ts";
import { isSystematicallyAbsent } from "./ops.ts";
import { findByHM, SETTINGS, settingOps } from "./spaceGroups.ts";

const setting = (xhm: string) => {
  const s = SETTINGS.find((x) => x.xhm === xhm) ?? findByHM(xhm)[0];
  if (!s) throw new Error(`no setting ${xhm}`);
  return settingOps(s);
};

describe("Laue groups on Miller indices", () => {
  // One space group per Laue class, in the settings the NeXus Viewer's presets use.
  const cases: [string, string, number][] = [
    ["P -1", "-1", 2],
    ["P 1 2/m 1", "2/m (b unique)", 4],
    ["P 1 1 2/m", "2/m (c unique)", 4],
    ["P m m m", "mmm", 8],
    ["P 4/m", "4/m", 8],
    ["P 4/m m m", "4/mmm", 16],
    ["R -3:H", "-3", 6],
    ["R -3 m:H", "-3m1", 12],
    ["P -3 1 m", "-31m", 12],
    ["P 6/m", "6/m", 12],
    ["P 63/m m c", "6/mmm", 24],
    ["P m -3", "m-3", 24],
    ["F d -3 m:2", "m-3m", 48],
  ];
  it.each(cases)("%s: Laue class %s, order %i, equal to the viewer preset", (sg, preset, order) => {
    const laue = laueGroupHkl(setting(sg));
    expect(laue).toHaveLength(order);
    expect(matchViewerPreset(laue)).toBe(preset);
    expect(laueClassName(laue)).toBe(preset.replace(/ \(.*\)$/, "").replace(/^-3m1$|^-31m$/, "-3m"));
  });

  it("acts on hkl as Rᵀ: each operation maps a reflection to one with the same |F| condition", () => {
    // In P 63/m m c, (0 0 l) with odd l is absent; its images under the Laue group are absent too.
    const ops = setting("P 63/m m c");
    for (const M of laueGroupHkl(ops)) {
      const h = [M[0][2], M[1][2], M[2][2]] as const;
      expect(isSystematicallyAbsent(ops, [3 * h[0], 3 * h[1], 3 * h[2]])).toBe(true);
    }
  });

  it("formats and parses triplets as the NeXus Viewer and NEBULA3D write them", () => {
    for (const text of ["h+k,-h,l", "-h-k,k,-l", "k,l,h", "2h,-k,l"]) expect(formatHklOp(parseHklOp(text))).toBe(text);
    expect(closeHklGroup([parseHklOp("h+k,-h,l"), parseHklOp("-h,-k,-l")])).toHaveLength(12);
  });

  it("states the centring conditions: F, I, C and obverse R", () => {
    expect(centringConditions(setting("F m -3 m"))).toEqual(["k+l = 2n", "h+l = 2n", "h+k = 2n"]);
    expect(centringConditions(setting("I m -3 m"))).toEqual(["h+k+l = 2n"]);
    expect(centringConditions(setting("C 1 2/m 1"))).toEqual(["h+k = 2n"]);
    expect(centringConditions(setting("R -3 m:H"))).toEqual(["h-k-l = 3n"]);
    expect(centringConditions(setting("P m m m"))).toEqual([]);
  });
});
