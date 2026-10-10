import { describe, expect, it } from "vitest";
import { formatTofInstprm } from "./instprm.ts";
import { npyBytes } from "./npy.ts";

/** Reads an .npy file as numpy.load does: magic, version 1.0, a header dict, then C-order little-endian data. */
function readNpy(bytes: Uint8Array) {
  expect([...bytes.slice(0, 8)]).toEqual([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  const len = bytes[8]! | (bytes[9]! << 8);
  const header = String.fromCharCode(...bytes.slice(10, 10 + len));
  expect((10 + len) % 64).toBe(0);
  expect(header.endsWith("\n")).toBe(true);
  const descr = /'descr': '([^']+)'/.exec(header)![1];
  const shape = /'shape': \(([^)]*)\)/.exec(header)![1]!.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  expect(header).toMatch(/'fortran_order': False/);
  return { descr, shape, data: bytes.slice(10 + len) };
}

describe(".npy files", () => {
  it("write a uint16 array with its shape, as numpy.load reads it", () => {
    const data = Uint16Array.from({ length: 24 }, (_, i) => i * 1000);
    const f = readNpy(npyBytes(data, [2, 3, 4]));
    expect(f.descr).toBe("<u2");
    expect(f.shape).toEqual([2, 3, 4]);
    expect([...new Uint16Array(f.data.buffer.slice(f.data.byteOffset))]).toEqual([...data]);
  });

  it("write uint8 masks and one-dimensional arrays", () => {
    const f = readNpy(npyBytes(Uint8Array.from([1, 0, 1]), [3]));
    expect(f.descr).toBe("|u1");
    expect(f.shape).toEqual([3]);
    expect([...f.data]).toEqual([1, 0, 1]);
    expect(() => npyBytes(new Uint8Array(4), [3])).toThrow(/does not hold/);
  });
});

describe(".instprm files", () => {
  it("write GSAS-II's key:value lines, leaving out terms that are not known", () => {
    const text = formatTofInstprm({ bank: 2, fltPath: 20.66, twoTheta: 65, difC: 5612.385, difA: 0, difB: 0, zero: 0, sig1: 1.5 }, ["a note"]);
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("#GSAS-II instrument parameter file; do not add/delete items!");
    expect(lines).toContain("#a note");
    expect(lines).toContain("Type:PNT");
    expect(lines).toContain("Bank:2.0");
    expect(lines).toContain("difC:5612.385");
    expect(lines).toContain("sig-1:1.5");
    expect(text).not.toMatch(/alpha|beta-0/);
  });
});
