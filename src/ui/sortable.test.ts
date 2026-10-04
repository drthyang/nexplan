import { describe, expect, it } from "vitest";
import { byHkl, byNumber, byText } from "./sortable.tsx";

describe("table sorting", () => {
  it("orders numbers both ways and puts NaN (a '—' cell) last either way", () => {
    const v = [3, NaN, -1, 2, NaN, 0];
    expect([...v].sort((a, b) => byNumber(a, b, "asc"))).toEqual([-1, 0, 2, 3, NaN, NaN]);
    expect([...v].sort((a, b) => byNumber(a, b, "desc"))).toEqual([3, 2, 0, -1, NaN, NaN]);
  });

  it("orders hkl by h, then k, then l, with negative indices before positive", () => {
    const hkl = [
      [1, 1, 1],
      [0, 0, 4],
      [1, -1, 1],
      [-2, 2, 0],
      [1, 1, -1],
    ];
    expect([...hkl].sort((a, b) => byHkl(a, b, "asc"))).toEqual([
      [-2, 2, 0],
      [0, 0, 4],
      [1, -1, 1],
      [1, 1, -1],
      [1, 1, 1],
    ]);
    expect([...hkl].sort((a, b) => byHkl(a, b, "desc"))[0]).toEqual([1, 1, 1]);
  });

  it("orders panel names naturally and puts a missing panel last", () => {
    const names = ["bank10", undefined, "bank2", "bank1"];
    expect([...names].sort((a, b) => byText(a, b, "asc"))).toEqual(["bank1", "bank2", "bank10", undefined]);
    expect([...names].sort((a, b) => byText(a, b, "desc"))).toEqual(["bank10", "bank2", "bank1", undefined]);
  });

  it("keeps the default order among ties (stable sort)", () => {
    // Equal |F|² keeps the decreasing-d order the table starts from.
    const rows = [
      { d: 2.0, f2: 5 },
      { d: 1.5, f2: 9 },
      { d: 1.2, f2: 5 },
    ];
    expect([...rows].sort((a, b) => byNumber(a.f2, b.f2, "desc")).map((r) => r.d)).toEqual([1.5, 2.0, 1.2]);
  });
});
