/** Bundled demo structures: public-domain CIFs from the Crystallography Open Database. */
import nacl from "../../fixtures/cif/cod-1000041.cif?raw";
import spinel from "../../fixtures/cif/cod-9001364.cif?raw";
import quartz from "../../fixtures/cif/cod-1011097.cif?raw";
import silicon from "../../fixtures/cif/cod-2104737.cif?raw";

export const DEMOS = [
  { id: "si", label: "Si — COD 2104737", file: "cod-2104737.cif", text: silicon },
  { id: "spinel", label: "MgAl₂O₄ spinel — COD 9001364", file: "cod-9001364.cif", text: spinel },
  { id: "quartz", label: "α-quartz — COD 1011097", file: "cod-1011097.cif", text: quartz },
  { id: "nacl", label: "NaCl — COD 1000041", file: "cod-1000041.cif", text: nacl },
] as const;
