import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCifStructure, summarizeBlocks, CifStructureError } from "./structure.ts";
import { CifSyntaxError, parseCifBlocks, parseNumber, tokenize } from "./tokenizer.ts";

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/cif/${name}`, import.meta.url), "utf8");

describe("CIF 1.1 tokenizer", () => {
  it("handles quotes closed only by quote+whitespace, semicolon fields, comments and multi-line loop rows", () => {
    const text = `data_test # trailing comment
_publ_author_name 'O'Neil, J.'
_title "a"b c"
_journal_name_full
;
Line one
_not_a_tag ; still text
;
loop_
_atom_site_label _atom_site_fract_x
_atom_site_fract_y
Fe1 0.1
0.2 O1
0.3 0.4  # comment inside loop
_cell_length_a 5.431(2)
_missing ? _na .
_quoted_dot '.'
`;
    const [b] = parseCifBlocks(text);
    expect(b!.name).toBe("test");
    expect(b!.items.get("_publ_author_name")!.text).toBe("O'Neil, J.");
    expect(b!.items.get("_title")!.text).toBe('a"b c');
    expect(b!.items.get("_journal_name_full")!.text).toBe("Line one\n_not_a_tag ; still text");
    expect(b!.loops[0]!.rows.map((r) => r.map((v) => v.text))).toEqual([
      ["Fe1", "0.1", "0.2"],
      ["O1", "0.3", "0.4"],
    ]);
    expect(b!.items.get("_missing")!.special).toBe("unknown");
    expect(b!.items.get("_na")!.special).toBe("inapplicable");
    expect(b!.items.get("_quoted_dot")!.special).toBeUndefined();
    expect(parseNumber(b!.items.get("_cell_length_a"))).toEqual({ value: 5.431, su: 0.002 });
  });

  it("parses standard uncertainties in all common notations", () => {
    const v = (text: string) => parseNumber({ text, quoted: false, line: 1 });
    expect(v("0.12345(67)")).toEqual({ value: 0.12345, su: 0.00067 });
    expect(v("120")).toEqual({ value: 120 });
    expect(v("90.00(3)")!.su).toBeCloseTo(0.03, 15);
    expect(v("1.2e-3(4)")!.value).toBeCloseTo(0.0012, 15);
    expect(v("1.2e-3(4)")!.su).toBeCloseTo(0.0004, 15);
    expect(v("-.5")).toEqual({ value: -0.5 });
    expect(() => v("abc")).toThrow(CifSyntaxError);
  });

  it("rejects malformed input with a line number", () => {
    expect(() => parseCifBlocks("data_a\nloop_\n_x _y\n1 2 3\n")).toThrow(/not a multiple/);
    expect(() => parseCifBlocks("data_a\n_x 1\n_x 2\n")).toThrow(/duplicate data name/);
    expect(() => parseCifBlocks("_x 1\n")).toThrow(/before the first data_/);
    expect(() => parseCifBlocks("data_a\n_x\n;\nunterminated\n")).toThrow(/unterminated/);
    expect(() => parseCifBlocks("data_a\n_x 'open\n")).toThrow(/line 2/);
    expect(() => tokenize("#\\#CIF_2.0\ndata_a\n")).toThrow(/CIF 2.0/);
  });
});

describe("CIF structure reader on COD files (public domain)", () => {
  it("reads quartz (COD 1011097) with su, type symbols with charge and listed operations", () => {
    const s = readCifStructure(fixture("cod-1011097.cif"));
    expect(s.blockName).toBe("1011097");
    expect(s.cell.a.value).toBe(4.913);
    expect(s.symmetry.hall).toBe('P 31 2"');
    expect(s.symmetry.ops).toHaveLength(6);
    expect(s.sites.map((x) => [x.label, x.typeSymbol, x.multiplicity])).toEqual([
      ["Si1", "Si4+", 3],
      ["O1", "O2-", 6],
    ]);
    expect(s.sites[0]!.fract[0]).toEqual({ value: 0.465, su: 0.004 });
    expect(s.diagnostics.some((d) => d.severity === "assumption" && /ADP/.test(d.message))).toBe(true);
  });

  it("reads mixed-occupancy spinel (COD 9001364) and converts U to B", () => {
    const s = readCifStructure(fixture("cod-9001364.cif"));
    const mg1 = s.sites.find((x) => x.label === "Mg1")!;
    expect(mg1.occupancy.value).toBe(0.68);
    expect(mg1.bIso.value).toBeCloseTo(8 * Math.PI ** 2 * 0.00304, 12);
    expect(mg1.adpSource).toBe("Uiso");
  });

  it("requires block selection when several blocks hold structures", () => {
    const two = fixture("cod-1000041.cif") + "\n" + fixture("cod-1011097.cif");
    expect(summarizeBlocks(two).filter((b) => b.hasStructure)).toHaveLength(2);
    expect(() => readCifStructure(two)).toThrow(/choose one/);
    expect(readCifStructure(two, "1011097").phaseName).toBe("Quartz low");
  });

  it("rejects DDLm names and incomplete cells", () => {
    expect(() => readCifStructure("data_x\n_cell.length_a 5\nloop_\n_atom_site.fract_x\n0\n")).toThrow(CifStructureError);
    expect(() => readCifStructure("data_x\n_cell_length_a 5\nloop_\n_atom_site_label\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\nA 0 0 0\n")).toThrow(/Incomplete unit cell/);
  });
});
