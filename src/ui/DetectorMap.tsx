/**
 * Detector map: the instrument's panels unrolled onto a vertical cylinder
 * around the sample (γ in the horizontal plane from the beam, ν elevation;
 * src/core/instrument/simulate.ts). Debye–Scherrer cones at fixed 2θ appear as
 * the dashed curves. Single crystal: spots where the reflections land,
 * coloured by λ. Powder: panels coloured by 2θ, the panels that see the
 * selected reflection emphasised, and the cones that bound where it lands.
 * With a raster (powder rings), the panels become outlines over the image.
 */
import { useMemo } from "react";
import type { Vec3 } from "@materia/core/math/types";
import type { DetectorPanel } from "../core/instrument/detectors.ts";
import { coneDirections, cylinderAngles, panelAngles, panelCylinderPolygons } from "../core/instrument/simulate.ts";
import { lambdaCss } from "../views/colormaps.ts";
import { fmt } from "./format.ts";
import { typeScale, useMeasuredWidth } from "./useMeasuredWidth.ts";

export interface MapSpot {
  readonly index: number;
  /** Lab direction of the scattered ray. */
  readonly dir: Vec3;
  readonly lambda: number;
  readonly label: string;
}

export interface MapRing {
  readonly twoTheta: number;
  readonly emphasis?: boolean;
}

type Pt = readonly [number, number];

/** Polyline in (γ, ν), split where it wraps across γ = ±180°. */
function projectPolyline(dirs: readonly Vec3[]): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let last: number | undefined;
  for (const u of dirs) {
    const { gamma, nu } = cylinderAngles(u);
    if (last !== undefined && Math.abs(gamma - last) > 180) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
    cur.push([gamma, nu]);
    last = gamma;
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

export function DetectorMap({
  panels,
  panelColors,
  highlight,
  selectedPanel = null,
  onPanelClick,
  spots = [],
  lambdaMin,
  lambdaMax,
  selected = null,
  onSelect,
  rings = [],
  raster,
  traces = [],
}: {
  panels: readonly DetectorPanel[];
  /** Per-panel CSS fill; default the accent colour. */
  panelColors?: readonly string[];
  highlight?: ReadonlySet<number>;
  selectedPanel?: number | null;
  onPanelClick?: (i: number) => void;
  spots?: readonly MapSpot[];
  lambdaMin: number;
  lambdaMax: number;
  selected?: number | null;
  onSelect?: (i: number | null) => void;
  /** Extra cones to draw (the 30° grid is always drawn). */
  rings?: readonly MapRing[];
  /** Image for the plot area (width × height pixels over γ −180…180°, ν ν_max…−ν_max), as a data URL. */
  raster?: (width: number, height: number, nuMax: number) => string | undefined;
  /** Polylines on the detectors (lab frame), drawn in the selection colour. */
  traces?: readonly (readonly Vec3[])[];
}) {
  const { ref: wrapRef, width } = useMeasuredWidth(800, 320);

  const shapes = useMemo(() => panels.map((p) => panelCylinderPolygons(p)), [panels]);
  const info = useMemo(() => panels.map(panelAngles), [panels]);
  const nuMax = useMemo(() => {
    let m = 0;
    for (const s of shapes) for (const poly of s) for (const [, n] of poly) m = Math.max(m, Math.abs(n));
    return Math.min(90, Math.max(30, Math.ceil((m + 3) / 15) * 15));
  }, [shapes]);
  const grid = useMemo(() => [30, 60, 90, 120, 150].map((t) => ({ t, lines: projectPolyline(coneDirections(t, 360)) })), []);
  const extra = useMemo(() => rings.map((r) => ({ ...r, lines: projectPolyline(coneDirections(r.twoTheta, 360)) })), [rings]);
  const traceLines = useMemo(() => traces.flatMap((t) => projectPolyline(t)), [traces]);

  const m = { l: 46, r: 12, t: 10, b: 40 };
  const W = width - m.l - m.r;
  const H = Math.max(200, Math.min(440 * typeScale(), (W * (2 * nuMax)) / 360));
  const height = H + m.t + m.b;
  const sx = (g: number) => m.l + ((g + 180) / 360) * W;
  const sy = (n: number) => m.t + ((nuMax - n) / (2 * nuMax)) * H;
  const pathOf = (pts: readonly Pt[], close: boolean) => `M${pts.map(([g, n]) => `${sx(g).toFixed(1)},${sy(n).toFixed(1)}`).join("L")}${close ? "Z" : ""}`;
  const clipId = useMemo(() => `dmap-clip-${Math.random().toString(36).slice(2, 8)}`, []);
  const rw = Math.max(1, Math.round(W));
  const rh = Math.max(1, Math.round(H));
  const href = useMemo(() => raster?.(rw, rh, nuMax), [raster, rw, rh, nuMax]);

  const xticks = [-180, -120, -60, 0, 60, 120, 180];
  const yticks: number[] = [];
  for (let n = -nuMax; n <= nuMax; n += nuMax > 45 ? 30 : 15) yticks.push(n);
  const selSpot = spots.find((s) => s.index === selected);

  return (
    <div ref={wrapRef} className="plot-wrap">
      <svg className="plot detector-map" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Detector panels unrolled onto a cylinder about the vertical axis" onClick={() => onSelect?.(null)}>
        <clipPath id={clipId}>
          <rect x={m.l} y={m.t} width={W} height={H} />
        </clipPath>
        {yticks.map((t) => (
          <line key={`gy${t}`} className="plot-grid-line" x1={m.l} x2={m.l + W} y1={sy(t)} y2={sy(t)} />
        ))}
        {xticks.map((t) => (
          <line key={`gx${t}`} className="plot-grid-line" x1={sx(t)} x2={sx(t)} y1={m.t} y2={m.t + H} />
        ))}
        <g clipPath={`url(#${clipId})`}>
          {href && <image href={href} x={m.l} y={m.t} width={W} height={H} preserveAspectRatio="none" />}
          {grid.map(({ t, lines }) => (
            <g key={t}>
              {lines.map((l, k) => (
                <path key={k} className="map-ring" d={pathOf(l, false)} />
              ))}
              <text className="map-ring-label" x={sx(t) + 3} y={sy(0) - 3}>
                {t}°
              </text>
            </g>
          ))}
          {shapes.map((s, i) => {
            const on = !highlight || highlight.has(i);
            const fill = panelColors?.[i];
            const a = info[i]!;
            return s.map((poly, k) => (
              <path
                key={`${i}-${k}`}
                className={`map-panel${href ? " is-outline" : ""}${i === selectedPanel ? " is-selected" : ""}${on ? "" : " is-dim"}${onPanelClick ? " is-clickable" : ""}`}
                d={pathOf(poly, true)}
                style={fill && !href ? { fill, stroke: fill } : undefined}
                onClick={(e) => {
                  if (!onPanelClick) return;
                  e.stopPropagation();
                  onPanelClick(i);
                }}
              >
                <title>{`${panels[i]!.name}: 2θ ${fmt(a.twoThetaMin, 1)}–${fmt(a.twoThetaMax, 1)}°, L2 ${fmt(a.l2, 3)} m`}</title>
              </path>
            ));
          })}
          {extra.map((r, j) =>
            r.lines.map((l, k) => <path key={`r${j}-${k}`} className={`map-ring${r.emphasis ? " is-emphasis" : ""}`} d={pathOf(l, false)} />),
          )}
          {traceLines.map((l, k) => (
            <path key={`t${k}`} className="map-trace" d={pathOf(l, false)} />
          ))}
          {spots.map((s) => {
            const { gamma, nu } = cylinderAngles(s.dir);
            const isSel = s.index === selected;
            return (
              <circle
                key={s.index}
                className={`map-spot${isSel ? " is-selected" : ""}`}
                cx={sx(gamma)}
                cy={sy(nu)}
                r={isSel ? 5.5 : 3}
                style={{ fill: lambdaCss((s.lambda - lambdaMin) / (lambdaMax - lambdaMin)) }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect?.(isSel ? null : s.index);
                }}
              >
                <title>{s.label}</title>
              </circle>
            );
          })}
          {selSpot &&
            (() => {
              const { gamma, nu } = cylinderAngles(selSpot.dir);
              return <circle className="map-spot-ring" cx={sx(gamma)} cy={sy(nu)} r={9} />;
            })()}
        </g>
        <rect className="plot-frame" x={m.l} y={m.t} width={W} height={H} />
        {xticks.map((t) => (
          <text key={`tx${t}`} className="plot-tick" x={sx(t)} y={m.t + H + 16} textAnchor="middle">
            {t}
          </text>
        ))}
        {yticks.map((t) => (
          <text key={`ty${t}`} className="plot-tick" x={m.l - 7} y={sy(t) + 4} textAnchor="end">
            {t}
          </text>
        ))}
        <text className="axis-label" x={m.l + W / 2} y={height - 5} textAnchor="middle">
          γ, horizontal angle from the beam (deg)
        </text>
        <text className="axis-label" transform={`translate(13 ${m.t + H / 2}) rotate(-90)`} textAnchor="middle">
          ν (deg)
        </text>
      </svg>
    </div>
  );
}
