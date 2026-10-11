/**
 * GSAS-II instrument parameter files (.instprm) for a time-of-flight bank: the key:value lines GSAS-II writes (and
 * MATERIA's parser reads, src/parsers/instrument.ts in web-refinement). TOF = Zero + difC·d + difA·d² + difB/d (µs);
 * back-to-back exponentials α = alpha/d, β = beta-0 + beta-1/d⁴ + beta-q/d² (µs⁻¹); Gaussian
 * σ² = sig-0 + sig-1·d² + sig-2·d⁴ + sig-q·d (µs²); Lorentzian X, Y, Z. Toby & Von Dreele, J. Appl. Cryst. 46, 544
 * (2013); GSASIIpwd.py.
 */

export interface TofInstprm {
  readonly bank: number;
  /** Total flight path L1 + L2 (m) and the bank's 2θ (deg). */
  readonly fltPath: number;
  readonly twoTheta: number;
  readonly difC: number;
  readonly difA: number;
  readonly difB: number;
  readonly zero: number;
  /** Profile terms; an absent one is left out of the file (so it is not a complete GSAS-II file). */
  readonly alpha?: number;
  readonly beta0?: number;
  readonly beta1?: number;
  readonly betaQ?: number;
  readonly sig0?: number;
  readonly sig1?: number;
  readonly sig2?: number;
  readonly sigQ?: number;
  readonly X?: number;
  readonly Y?: number;
  readonly Z?: number;
}

/** The .instprm text, with `comments` as # lines (GSAS-II skips them). */
export function formatTofInstprm(p: TofInstprm, comments: readonly string[] = []): string {
  const v = (x: number) => String(Number(x.toPrecision(12)));
  const rows: [string, number | undefined][] = [
    ["Bank", p.bank],
    ["fltPath", p.fltPath],
    ["2-theta", p.twoTheta],
    ["Azimuth", 0],
    ["difC", p.difC],
    ["difA", p.difA],
    ["difB", p.difB],
    ["Zero", p.zero],
    ["alpha", p.alpha],
    ["beta-0", p.beta0],
    ["beta-1", p.beta1],
    ["beta-q", p.betaQ],
    ["sig-0", p.sig0],
    ["sig-1", p.sig1],
    ["sig-2", p.sig2],
    ["sig-q", p.sigQ],
    ["X", p.X],
    ["Y", p.Y],
    ["Z", p.Z],
  ];
  return [
    "#GSAS-II instrument parameter file; do not add/delete items!",
    ...comments.map((c) => `#${c}`),
    "Type:PNT",
    ...rows.filter(([, x]) => x !== undefined).map(([k, x]) => `${k}:${k === "Bank" ? x!.toFixed(1) : v(x!)}`),
  ].join("\n") + "\n";
}
