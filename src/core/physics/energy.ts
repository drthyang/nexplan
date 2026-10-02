/**
 * Wavelength ↔ energy, CODATA 2018 (h, c, e exact; m_n = 1.67492749804e-27 kg).
 *
 *   X-ray photon:   E = hc/λ           hc = 12.398 419 843 keV·Å
 *   Neutron:        E = h²/(2 m_n λ²)   h²/2m_n = 81.804 2 meV·Å²
 */
const H = 6.62607015e-34; // J s
const C = 299792458; // m/s
const E_CHARGE = 1.602176634e-19; // C
const M_N = 1.67492749804e-27; // kg

/** hc in keV·Å. */
export const HC_KEV_ANGSTROM = (H * C) / (E_CHARGE * 1e3) / 1e-10;
/** h²/(2 m_n) in meV·Å². */
export const NEUTRON_E_MEV_ANGSTROM2 = (H * H) / (2 * M_N) / (E_CHARGE * 1e-3) / 1e-20;

export const xrayEnergyKeV = (lambdaA: number): number => HC_KEV_ANGSTROM / lambdaA;
export const xrayWavelengthA = (keV: number): number => HC_KEV_ANGSTROM / keV;
export const neutronEnergyMeV = (lambdaA: number): number => NEUTRON_E_MEV_ANGSTROM2 / (lambdaA * lambdaA);
export const neutronWavelengthA = (meV: number): number => Math.sqrt(NEUTRON_E_MEV_ANGSTROM2 / meV);
