export const fmt = (x: number, digits: number): string => (Number.isFinite(x) ? x.toFixed(digits) : "—");

/** Value with its standard uncertainty in CIF notation, e.g. 5.4310(2). */
export function withSu(value: number, su: number | undefined, fallbackDigits = 4): string {
  if (su === undefined || !(su > 0)) return value.toFixed(fallbackDigits);
  const decimals = Math.max(0, -Math.floor(Math.log10(su)) + (su / 10 ** Math.floor(Math.log10(su)) < 2 ? 1 : 0));
  const digits = Math.round(su * 10 ** decimals);
  return `${value.toFixed(decimals)}(${digits})`;
}

export function hklText(h: readonly number[]): string {
  const needsSep = h.some((v) => Math.abs(v) > 9);
  return h.map((v) => (v < 0 ? `${needsSep ? " " : ""}${v}` : `${needsSep ? " " : ""}${v}`)).join(needsSep ? "" : " ").trim();
}

export function downloadText(name: string, text: string, type = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Full-precision number for exports (display rounding never reaches files). */
export const exact = (x: number): string => (Number.isFinite(x) ? String(x) : "");
