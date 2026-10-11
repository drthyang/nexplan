/**
 * NumPy .npy files (format version 1.0), for arrays other programs read with numpy.load: C order, little-endian.
 * https://numpy.org/doc/stable/reference/generated/numpy.lib.format.html
 */

export type NpyArray = Uint8Array | Uint16Array | Float32Array;

const DESCR = (a: NpyArray) => (a instanceof Uint8Array ? "|u1" : a instanceof Uint16Array ? "<u2" : "<f4");

/** The bytes of an .npy file holding `data` with `shape` (C order). */
export function npyBytes(data: NpyArray, shape: readonly number[]): Uint8Array {
  if (shape.reduce((n, s) => n * s, 1) !== data.length) throw new Error(`Shape ${shape.join("×")} does not hold ${data.length} values.`);
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error("A big-endian platform: .npy output is written little-endian only.");
  let header = `{'descr': '${DESCR(data)}', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  // Magic (6) + version (2) + header length (2) + header + newline, padded with spaces to a multiple of 64.
  const total = Math.ceil((10 + header.length + 1) / 64) * 64;
  header = header.padEnd(total - 10 - 1, " ") + "\n";
  const out = new Uint8Array(total + data.byteLength);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, header.length & 0xff, header.length >> 8]);
  for (let i = 0; i < header.length; i++) out[10 + i] = header.charCodeAt(i);
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), total);
  return out;
}
