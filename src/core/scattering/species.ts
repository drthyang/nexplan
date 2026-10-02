/**
 * Scattering species: element, ionic charge and (for neutrons) isotope.
 *
 * Species come from `_atom_site_type_symbol` when the file has it, else from the
 * site label. Labels never decide an oxidation state or an isotope, and a label
 * that could be two elements (`CA1`: C or Ca) is reported as ambiguous instead
 * of guessed.
 */

export const ELEMENT_SYMBOLS: readonly string[] = [
  "", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar",
  "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr",
  "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Sb", "Te", "I", "Xe",
  "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu",
  "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg", "Tl", "Pb", "Bi", "Po", "At", "Rn",
  "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr",
  "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
];
const Z_OF = new Map(ELEMENT_SYMBOLS.map((s, z) => [s, z] as const).filter(([s]) => s !== ""));
const LOWER = new Map([...Z_OF.keys()].map((s) => [s.toLowerCase(), s] as const));

export interface Species {
  readonly element: string;
  readonly z: number;
  /** Ionic charge; 0 for neutral. */
  readonly charge: number;
  /** Mass number for an explicitly named isotope; undefined = natural abundance. */
  readonly isotope?: number;
}

export function speciesKey(s: Species): string {
  const ion = s.charge === 0 ? "" : `${Math.abs(s.charge)}${s.charge > 0 ? "+" : "-"}`;
  return `${s.isotope ?? ""}${s.element}${ion}`;
}

export function atomicNumber(element: string): number | undefined {
  return Z_OF.get(element);
}

export type SpeciesParse =
  | { readonly ok: true; readonly species: Species; readonly note?: string }
  | { readonly ok: false; readonly candidates: readonly string[]; readonly reason: string };

const make = (element: string, charge = 0, isotope?: number): Species => ({
  element,
  z: Z_OF.get(element)!,
  charge,
  ...(isotope !== undefined ? { isotope } : {}),
});

/**
 * Parse a CIF type symbol: `Fe`, `Fe3+`, `Fe+3`, `O2-`, `O-2`, `Na+`, `D`, `T`,
 * `2H`, `57Fe`. Symbols are case-sensitive as written in CIF (`FE` is accepted
 * only when unambiguous). A trailing digit without a sign (`Fe1`) is treated as
 * a label suffix and reported.
 */
export function parseTypeSymbol(raw: string): SpeciesParse {
  const s = raw.trim();
  if (s === "D") return { ok: true, species: make("H", 0, 2), note: "D read as the isotope ²H." };
  if (s === "T") return { ok: true, species: make("H", 0, 3), note: "T read as the isotope ³H." };
  const iso = /^(\d+)([A-Z][a-z]?)$/.exec(s);
  if (iso && Z_OF.has(iso[2]!)) return { ok: true, species: make(iso[2]!, 0, Number(iso[1])) };
  const ion = /^([A-Za-z]{1,2}?)(?:(\d*)([+-])|([+-])(\d*))$/.exec(s);
  if (ion) {
    const el = resolveCase(ion[1]!);
    if (el.length === 1) {
      const mag = Number(ion[2] || ion[5] || "1");
      const sign = (ion[3] ?? ion[4]) === "-" ? -1 : 1;
      return { ok: true, species: make(el[0]!, sign * mag) };
    }
  }
  if (Z_OF.has(s)) return { ok: true, species: make(s) };
  return speciesFromLabel(s);
}

/** Element candidates for a 1–2 letter string, honouring case when it decides. */
function resolveCase(letters: string): string[] {
  if (Z_OF.has(letters)) return [letters];
  const hit = LOWER.get(letters.toLowerCase());
  return hit ? [hit] : [];
}

/**
 * Element from a site label (`Fe1`, `O2a`, `Ow`, `CA1`). Proper case decides
 * (`Ca1` → Ca, `C1` → C). All-caps two-letter prefixes that spell both an
 * element and a one-letter element followed by a letter (`CA` → Ca or C) are
 * ambiguous and need the user's choice.
 */
export function speciesFromLabel(label: string): SpeciesParse {
  const m = /^([A-Za-z]+)/.exec(label.trim());
  if (!m) return { ok: false, candidates: [], reason: `Label '${label}' does not start with an element symbol.` };
  const letters = m[1]!;
  const two = letters.slice(0, 2);
  const one = letters.slice(0, 1);
  if (two.length === 2 && Z_OF.has(two)) return { ok: true, species: make(two), note: `Element ${two} taken from label '${label}'.` };
  const oneExact = Z_OF.has(one) ? one : undefined;
  const twoCi = two.length === 2 ? LOWER.get(two.toLowerCase()) : undefined;
  const isAllCaps = two === two.toUpperCase() && two.length === 2;
  if (oneExact && twoCi && isAllCaps) {
    return { ok: false, candidates: [twoCi, oneExact], reason: `Label '${label}' could be ${twoCi} or ${oneExact}.` };
  }
  if (oneExact) return { ok: true, species: make(oneExact), note: `Element ${oneExact} taken from label '${label}'.` };
  const oneCi = LOWER.get(one.toLowerCase());
  if (twoCi && oneCi) return { ok: false, candidates: [twoCi, oneCi], reason: `Label '${label}' could be ${twoCi} or ${oneCi}.` };
  const only = twoCi ?? oneCi;
  if (only) return { ok: true, species: make(only), note: `Element ${only} taken from label '${label}'.` };
  return { ok: false, candidates: [], reason: `No element symbol found in label '${label}'.` };
}
