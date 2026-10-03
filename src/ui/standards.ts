/**
 * Reference materials for the scattering-power comparison: common neutron
 * standards from the Crystallography Open Database, then the demo structures.
 * The standards' CIFs are fetched only when chosen.
 */
import { DEMOS } from "./demos.ts";

export interface ReferenceMaterial {
  readonly id: string;
  readonly label: string;
  readonly file: string;
  /** Where the structure comes from, with the certified cell where there is one. */
  readonly source: string;
  readonly load: () => Promise<string>;
}

const demo = (id: string) => DEMOS.find((d) => d.id === id)!;
const fromDemo = (id: string, label: string, source: string): ReferenceMaterial => {
  const d = demo(id);
  return { id: d.id, label, file: d.file, source, load: () => Promise.resolve(d.text) };
};

export const STANDARDS: readonly ReferenceMaterial[] = [
  {
    id: "vanadium",
    label: "V (incoherent standard) — COD 9012770",
    file: "cod-9012770.cif",
    source: "James & Straumanis, J. Electrochem. Soc. 107, 69 (1960), via AMCSD 0014111: a = 3.0241 Å at 298 K. No ADPs in the file (B = 0 assumed); its Bragg lines are negligible anyway.",
    load: () => import("../../fixtures/cif/cod-9012770.cif?raw").then((m) => m.default),
  },
  {
    id: "diamond",
    label: "Diamond — COD 2300702",
    file: "cod-2300702.cif",
    source: "Houben et al., J. Appl. Cryst. 56, 633 (2023), neutron TOF refinement on POWGEN: a = 3.566636(7) Å at 293 K (Hom et al. 1975: 3.566986(15) Å).",
    load: () => import("../../fixtures/cif/cod-2300702.cif?raw").then((m) => m.default),
  },
  fromDemo("si", "Si — COD 2104737", "Elliot, Acta Cryst. B66, 271 (2010): a = 5.43096(6) Å."),
  {
    id: "ceo2",
    label: "CeO₂ — COD 4343161",
    file: "cod-4343161.cif",
    source: "Artini et al., Inorg. Chem. 54, 4126 (2015), synchrotron powder: a = 5.40972(11) Å at 295 K (NIST SRM 674b certifies 5.41153(30) Å).",
    load: () => import("../../fixtures/cif/cod-4343161.cif?raw").then((m) => m.default),
  },
  {
    id: "al2o3",
    label: "α-Al₂O₃ corundum — COD 9007496",
    file: "cod-9007496.cif",
    source: "Lewis, Schwarzenbach & Flack, Acta Cryst. A38, 733 (1982), via AMCSD 0009325: a = 4.7602, c = 12.9933 Å (NIST SRM 676a certifies 4.759355(8), 12.99231(15) Å). Anisotropic ADPs enter as U_eq.",
    load: () => import("../../fixtures/cif/cod-9007496.cif?raw").then((m) => m.default),
  },
];

export const DEMO_REFERENCES: readonly ReferenceMaterial[] = [
  fromDemo("spinel", demo("spinel").label, "Demo structure."),
  fromDemo("quartz", demo("quartz").label, "Demo structure."),
  fromDemo("nacl", demo("nacl").label, "Demo structure."),
];

export const REFERENCES: readonly ReferenceMaterial[] = [...STANDARDS, ...DEMO_REFERENCES];
