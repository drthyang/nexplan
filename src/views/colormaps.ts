/** Colour ramps shared by the 3D views and the SVG charts (no three.js dependency). */

type Rgb = readonly [number, number, number];

function ramp(stops: readonly Rgb[], t: number): Rgb {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
}

const css = ([r, g, b]: Rgb) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
const hex = ([r, g, b]: Rgb) => (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);

/** Viridis-like ramp for wavelength (short = purple, long = yellow). */
const VIRIDIS: readonly Rgb[] = [
  [0.267, 0.005, 0.329],
  [0.229, 0.322, 0.546],
  [0.128, 0.567, 0.551],
  [0.369, 0.789, 0.383],
  [0.993, 0.906, 0.144],
];
export const lambdaRgb = (t: number): Rgb => ramp(VIRIDIS, t);
export const lambdaCss = (t: number): string => css(lambdaRgb(t));
export const LAMBDA_RAMP_CSS = "linear-gradient(90deg, #440154, #3b528b, #21918c, #5ec962, #fde725)";

/** Blue → red ramp for scattering angle (forward = blue, backscattering = red), after ColorBrewer RdYlBu. */
const ANGLE: readonly Rgb[] = [
  [0.192, 0.212, 0.584],
  [0.271, 0.459, 0.706],
  [0.455, 0.678, 0.82],
  [0.996, 0.878, 0.565],
  [0.957, 0.427, 0.263],
  [0.647, 0.0, 0.149],
];
export const angleCss = (twoThetaDeg: number): string => css(ramp(ANGLE, twoThetaDeg / 180));
export const angleHex = (twoThetaDeg: number): number => hex(ramp(ANGLE, twoThetaDeg / 180));
export const ANGLE_RAMP_CSS = "linear-gradient(90deg, #313695, #4575b4, #74add1, #fee090, #f46d43, #a50026)";
