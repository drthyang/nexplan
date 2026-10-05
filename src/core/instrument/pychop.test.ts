import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { energyResolution, type ChopperSetting, type CncsMode, type FermiInstrument } from "./pychop.ts";

interface Row {
  readonly instrument: FermiInstrument | "cncs";
  readonly chopper: string;
  readonly frequency: number;
  readonly ei: number;
  readonly transfer: number;
  readonly fwhm: number | null;
}
const reference = JSON.parse(readFileSync(new URL("../../../fixtures/pychop-resolution.json", import.meta.url), "utf8")) as { rows: Row[] };

const setting = (r: Row): ChopperSetting => (r.instrument === "cncs" ? { instrument: "cncs", mode: r.chopper as CncsMode, frequency: r.frequency } : { instrument: r.instrument, package: r.chopper, frequency: r.frequency });

describe("energy resolution: the port of Mantid PyChop", () => {
  it("agrees with PyChop's getResolution (mantid 67c2f43) to 1e-6, closed settings included", () => {
    expect(reference.rows.length).toBeGreaterThan(1000);
    let open = 0;
    for (const r of reference.rows) {
      const v = energyResolution(setting(r), r.ei, r.transfer);
      if (r.fwhm === null) expect(v).toBeUndefined();
      else {
        open++;
        expect(Math.abs(v! / r.fwhm - 1)).toBeLessThan(1e-6);
      }
    }
    expect(open).toBeGreaterThan(800);
  });

  it("standard settings: CNCS at 3.32 meV, and the elastic line narrowing with energy transfer", () => {
    // ORNL measured 105 µeV (High Flux, 300 Hz) and 54 µeV (High Resolution, 180 Hz); PyChop gives about 113 and 58.
    expect(energyResolution({ instrument: "cncs", mode: "High Flux", frequency: 300 }, 3.32)! * 1000).toBeCloseTo(113, -1);
    expect(energyResolution({ instrument: "cncs", mode: "High Resolution", frequency: 180 }, 3.32)! * 1000).toBeCloseTo(58, -1);
    const arcs: ChopperSetting = { instrument: "arcs", package: "ARCS-100-1.5-AST", frequency: 420 };
    expect(energyResolution(arcs, 60, 45)!).toBeLessThan(energyResolution(arcs, 60, 0)!);
    expect(energyResolution(arcs, 60, 60)).toBeUndefined();
  });
});
