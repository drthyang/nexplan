import { describe, expect, it } from "vitest";
import { HC_KEV_ANGSTROM, NEUTRON_E_MEV_ANGSTROM2, neutronEnergyMeV, neutronWavelengthA, xrayEnergyKeV, xrayWavelengthA } from "./energy.ts";

describe("wavelength ↔ energy (CODATA 2018)", () => {
  it("uses hc = 12.398419843 keV·Å and h²/2m_n = 81.8042 meV·Å²", () => {
    expect(HC_KEV_ANGSTROM).toBeCloseTo(12.398419843320026, 12);
    expect(NEUTRON_E_MEV_ANGSTROM2).toBeCloseTo(81.8042, 4);
  });

  it("reproduces literature line energies (Deslattes et al. 2003, Rev. Mod. Phys. 75, 35)", () => {
    expect(xrayEnergyKeV(1.540593)).toBeCloseTo(8.0478227, 4); // Cu Kα1, 8047.8227 eV
    expect(xrayEnergyKeV(0.709317)).toBeCloseTo(17.47934, 3); // Mo Kα1, 17479.34 eV
    expect(neutronEnergyMeV(1.798)).toBeCloseTo(25.30, 2); // 2200 m/s thermal neutron
  });

  it("round-trips", () => {
    for (const l of [0.1, 0.5, 1.54, 4.05]) {
      expect(xrayWavelengthA(xrayEnergyKeV(l))).toBeCloseTo(l, 13);
      expect(neutronWavelengthA(neutronEnergyMeV(l))).toBeCloseTo(l, 13);
    }
  });
});
