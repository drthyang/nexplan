/**
 * Detector images: powder rings (src/core/instrument/powderRings.ts) and
 * single-crystal reflection coverage, as per-panel RGBA textures for the 3D
 * view and a raster of the unrolled map. For rings:
 * Each slice is scaled to its brightest detector element (auto contrast) and
 * shown on a square-root scale so weak rings stay visible.
 */
import type { DetectorPanel } from "../core/instrument/detectors.ts";
import { panelCells, ringIntensity, type ElementCells, type RingProfile, type RingSlice } from "../core/instrument/powderRings.ts";
import { intensityRgb, lambdaRgb } from "../views/colormaps.ts";

const LUT = (() => {
  const t = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = intensityRgb(i / 255);
    t[3 * i] = Math.round(r * 255);
    t[3 * i + 1] = Math.round(g * 255);
    t[3 * i + 2] = Math.round(b * 255);
  }
  return t;
})();

const level = (v: number, gain: number) => Math.min(255, Math.round(Math.sqrt(Math.max(0, v * gain)) * 255));

export interface PanelImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface PanelGrid {
  readonly nx: number;
  readonly ny: number;
  readonly cells: ElementCells;
}

/** Element grids at the panels' pixel resolution (capped at 64 × 128 per panel). */
export function panelGrids(panels: readonly DetectorPanel[]): PanelGrid[] {
  return panels.map((p) => {
    const nx = Math.max(1, Math.min(64, p.nCols));
    const ny = Math.max(1, Math.min(128, p.nRows));
    return { nx, ny, cells: panelCells(p, nx, ny) };
  });
}

/** Flight-path range (m) over every element: L1 + L2. */
export function flightPathRange(grids: readonly PanelGrid[], l1: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const g of grids)
    for (const v of g.cells.l2) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  return [l1 + lo, l1 + hi];
}

/** Panel images for one slice and the gain (1 / brightest element) used, to share with the map. */
export function paintPanels(grids: readonly PanelGrid[], profile: RingProfile, slice: RingSlice, l1: number): { images: PanelImage[]; gain: number } {
  const values = grids.map(({ nx, ny, cells }) => {
    const v = new Float32Array(nx * ny);
    for (let c = 0; c < nx * ny; c++) v[c] = ringIntensity(profile, slice, cells.twoTheta[c]!, l1 + cells.l2[c]!);
    return v;
  });
  let max = 0;
  for (const v of values) for (const x of v) max = Math.max(max, x);
  const gain = max > 0 ? 1 / max : 1;
  const images = grids.map(({ nx, ny }, i) => {
    const data = new Uint8Array(nx * ny * 4);
    const v = values[i]!;
    for (let c = 0; c < nx * ny; c++) {
      const k = 3 * level(v[c]!, gain);
      data[4 * c] = LUT[k]!;
      data[4 * c + 1] = LUT[k + 1]!;
      data[4 * c + 2] = LUT[k + 2]!;
      data[4 * c + 3] = 255;
    }
    return { width: nx, height: ny, data };
  });
  return { images, gain };
}

let canvas: HTMLCanvasElement | undefined;

/** The unrolled-map raster (cells from mapCells, top row first) as a PNG data URL; cells off the detectors are transparent. */
export function paintMap(cells: ElementCells & { readonly panel: Int16Array }, width: number, height: number, profile: RingProfile, slice: RingSlice, l1: number, gain = 1): string {
  canvas ??= document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  const d = img.data;
  for (let c = 0; c < width * height; c++) {
    if (cells.panel[c]! < 0) continue;
    const k = 3 * level(ringIntensity(profile, slice, cells.twoTheta[c]!, l1 + cells.l2[c]!), gain);
    d[4 * c] = LUT[k]!;
    d[4 * c + 1] = LUT[k + 1]!;
    d[4 * c + 2] = LUT[k + 2]!;
    d[4 * c + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/* ---------------------------------------------------------------- reflection coverage */

const GREY: readonly [number, number, number] = [188, 194, 204];
const EDGE: readonly [number, number, number] = [52, 64, 84];
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Display only. Swept by one goniometer axis, a reflection reaches a curve one cell wide, too thin to see.
 * Each reachable cell is spread over an ellipse of rx × ry cells (exact cells keep their own λ), and the
 * result is ringed by a one-cell dark edge so the pale end of the λ ramp stands out on grey. Both stay on
 * detector cells. The page's counts and percentages use the exact cells, not this.
 */
export function widenCoverage(lam: Float32Array, nx: number, ny: number, rx: number, ry: number, onDetector: (c: number) => boolean = () => true): { lam: Float32Array; edge: Uint8Array } {
  const out = Float32Array.from(lam);
  const spread: [number, number][] = [];
  for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) if ((dx / rx) ** 2 + (dy / ry) ** 2 <= 1.5) spread.push([dx, dy]);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const v = lam[j * nx + i]!;
      if (Number.isNaN(v)) continue;
      for (const [dx, dy] of spread) {
        const x = i + dx;
        const y = j + dy;
        if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        const c = y * nx + x;
        if (Number.isNaN(out[c]!) && onDetector(c)) out[c] = v;
      }
    }
  const edge = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!Number.isNaN(out[c]!) || !onDetector(c)) continue;
      edge[c] = NEIGHBOURS.some(([dx, dy]) => {
        const x = i + dx;
        const y = j + dy;
        return x >= 0 && y >= 0 && x < nx && y < ny && !Number.isNaN(out[y * nx + x]!);
      })
        ? 1
        : 0;
    }
  return { lam: out, edge };
}

/** A cell coloured by wavelength on the shared λ ramp. */
function lambdaPixel(lambda: number, lambdaMin: number, lambdaMax: number): [number, number, number] {
  const [rr, g, b] = lambdaRgb((lambda - lambdaMin) / (lambdaMax - lambdaMin || 1));
  return [Math.round(rr * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** Coverage on the panel images: grey detectors, each reachable cell coloured by its λ (NaN = not reachable), widened to about 1.5 % of the panel each way. */
export function paintLambdaPanels(grids: readonly { readonly nx: number; readonly ny: number }[], lambdas: readonly Float32Array[], lambdaMin: number, lambdaMax: number): PanelImage[] {
  return grids.map(({ nx, ny }, k) => {
    const data = new Uint8Array(nx * ny * 4);
    const { lam, edge } = widenCoverage(lambdas[k]!, nx, ny, Math.max(1, Math.round(0.015 * nx)), Math.max(1, Math.round(0.015 * ny)));
    for (let c = 0; c < nx * ny; c++) data.set([...(edge[c] ? EDGE : Number.isNaN(lam[c]!) ? GREY : lambdaPixel(lam[c]!, lambdaMin, lambdaMax)), 255], 4 * c);
    return { width: nx, height: ny, data };
  });
}

/** The same on the unrolled-map raster (top row first, one cell per CSS pixel) as a PNG data URL, widened by 2 px; off the detectors stays transparent. */
export function paintLambdaMap(panelOf: Int16Array, lambdas: Float32Array, width: number, height: number, lambdaMin: number, lambdaMax: number): string {
  canvas ??= document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  const { lam, edge } = widenCoverage(lambdas, width, height, 2, 2, (c) => panelOf[c]! >= 0);
  for (let c = 0; c < width * height; c++) {
    if (panelOf[c]! < 0) continue;
    img.data.set([...(edge[c] ? EDGE : Number.isNaN(lam[c]!) ? GREY : lambdaPixel(lam[c]!, lambdaMin, lambdaMax)), 255], 4 * c);
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}
