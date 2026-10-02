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

/** A cell coloured by wavelength on the shared λ ramp. */
function lambdaPixel(lambda: number, lambdaMin: number, lambdaMax: number): [number, number, number] {
  const [r, g, b] = lambdaRgb((lambda - lambdaMin) / (lambdaMax - lambdaMin || 1));
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Coverage of one reflection (or its equivalents) on the panel images: grey
 * detectors, and every pixel it can reach coloured by the wavelength it is
 * recorded at. Each point fills a square about one goniometer step across
 * (`stepDeg`; 0 for isolated points), so a stepped sweep reads as an area.
 */
export function paintCoveragePanels(
  grids: readonly PanelGrid[],
  panels: readonly DetectorPanel[],
  points: readonly { readonly lambda: number; readonly hit: { readonly panel: number; readonly col: number; readonly row: number } }[],
  lambdaMin: number,
  lambdaMax: number,
  stepDeg = 0,
): PanelImage[] {
  // Half-width in cells: half a step at the panel's distance, at least one cell.
  const reach = panels.map((p, k) => Math.max(1, Math.ceil(((stepDeg * Math.PI) / 360) * Math.hypot(...p.center) / (p.width / grids[k]!.nx))));
  const images = grids.map(({ nx, ny }) => {
    const data = new Uint8Array(nx * ny * 4);
    for (let c = 0; c < nx * ny; c++) data.set([...GREY, 255], 4 * c);
    return { width: nx, height: ny, data };
  });
  for (const p of points) {
    const img = images[p.hit.panel]!;
    const panel = panels[p.hit.panel]!;
    const i = Math.floor(((p.hit.col - 0.5) / panel.nCols) * img.width);
    const j = Math.floor(((p.hit.row - 0.5) / panel.nRows) * img.height);
    const rgb = lambdaPixel(p.lambda, lambdaMin, lambdaMax);
    const r = Math.min(8, reach[p.hit.panel]!);
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const x = i + di;
        const y = j + dj;
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        img.data.set([...rgb, 255], 4 * (y * img.width + x));
      }
  }
  return images;
}

/** The same coverage on the unrolled map raster (cells from mapCells, top row first), as a PNG data URL. */
export function paintCoverageMap(
  cells: ElementCells & { readonly panel: Int16Array },
  width: number,
  height: number,
  nuMax: number,
  points: readonly { readonly lambda: number; readonly hit: { readonly position: readonly [number, number, number] } }[],
  lambdaMin: number,
  lambdaMax: number,
  stepDeg = 0,
): string {
  canvas ??= document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  const d = img.data;
  for (let c = 0; c < width * height; c++) if (cells.panel[c]! >= 0) d.set([...GREY, 255], 4 * c);
  const r = Math.min(8, Math.max(1, Math.ceil((stepDeg * width) / 360 / 2)));
  for (const p of points) {
    const [x, y, z] = p.hit.position;
    const gamma = (Math.atan2(x, z) * 180) / Math.PI;
    const nu = (Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI;
    const i = Math.floor(((gamma + 180) / 360) * width);
    const j = Math.floor(((nuMax - nu) / (2 * nuMax)) * height);
    const rgb = lambdaPixel(p.lambda, lambdaMin, lambdaMax);
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const u = i + di;
        const v = j + dj;
        // Only on the detectors: a dot must not spill into the gaps between panels.
        if (u < 0 || v < 0 || u >= width || v >= height || cells.panel[v * width + u]! < 0) continue;
        d.set([...rgb, 255], 4 * (v * width + u));
      }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}
