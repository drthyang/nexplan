import { describe, expect, it } from "vitest";
import { energyResolution } from "../core/instrument/pychop.ts";
import { chooseInstrument, chopperOf, CUSTOM_CHOPPER, DEFAULT_EXPERIMENT, dgsOf, withDgs, withEi, withIncident } from "./experimentState.ts";

describe("a chopper spectrometer's elastic width follows its chopper", () => {
  it("CNCS: High Flux at 300 Hz by default, ΔE/E from PyChop at Ei, and the band from it (Δλ/λ = ΔE/2E)", () => {
    const e = chooseInstrument(DEFAULT_EXPERIMENT, "cncs");
    const fwhm = energyResolution({ instrument: "cncs", mode: "High Flux", frequency: 300 }, e.eiMeV, 0)!;
    expect(chopperOf(e)).toEqual({ instrument: "cncs", mode: "High Flux", frequency: 300 });
    expect(e.eRes).toBeCloseTo(fwhm / e.eiMeV, 12);
    expect(e.eRes).toBeGreaterThan(0.05);
    const lambda = (e.lambdaMin + e.lambdaMax) / 2;
    expect((e.lambdaMax - e.lambdaMin) / lambda).toBeCloseTo(e.eRes / 2, 6);
    // A new Ei, and a new chopper setting, recompute it.
    const low = withIncident(e, 3.32);
    expect(low.eRes * 3.32).toBeCloseTo(energyResolution({ instrument: "cncs", mode: "High Flux", frequency: 300 }, 3.32, 0)!, 12);
    const hr = withDgs(low, { ...dgsOf(low), chopper: "High Resolution", frequency: 180 });
    expect(hr.eRes * 3.32 * 1000).toBeCloseTo(58, -1);
  });

  it("custom ΔE/E is kept as typed; where the chopper does not transmit, the width stays as it was", () => {
    const e = chooseInstrument(DEFAULT_EXPERIMENT, "arcs");
    const custom = withEi(withDgs(e, { ...dgsOf(e), chopper: CUSTOM_CHOPPER }), e.eiMeV, 0.07);
    expect(chopperOf(custom)).toBeUndefined();
    expect(withIncident(custom, 100).eRes).toBe(0.07);
    // ARCS-100-1.5 at 600 Hz does not transmit 30 meV (PyChop).
    const fast = withDgs(e, { ...dgsOf(e), frequency: 600 });
    expect(energyResolution(chopperOf(fast)!, 30, 0)).toBeUndefined();
    expect(withIncident(fast, 30).eRes).toBe(fast.eRes);
  });
});
