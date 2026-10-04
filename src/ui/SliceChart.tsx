/**
 * Reciprocal-space slice: one reciprocal-lattice plane in true 1/Å units (so
 * oblique cells look oblique), with the scan's coverage of the plane as a
 * shaded image and the reflections as markers:
 *  - filled in its λ colour: on a detector at the current goniometer setting;
 *  - filled dark: recorded somewhere in the scan;
 *  - hollow: never recorded.
 * Marker area follows |F|². Click a marker to select it.
 */
import { lambdaCss } from "../views/colormaps.ts";
import { useMeasuredWidth } from "./useMeasuredWidth.ts";

export interface SlicePoint {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly f2: number;
  readonly state: "now" | "scan" | "never";
  readonly lambda?: number;
  readonly label: string;
}

export function SliceChart({
  points,
  extent,
  coverage,
  selected,
  onSelect,
  lambdaMin,
  lambdaMax,
  xLabel,
  yLabel,
  limitRadius,
  axes,
}: {
  points: readonly SlicePoint[];
  /** Half-width of the plotted square (1/Å). */
  extent: number;
  /** Image covering [−extent, extent]² (top row = +y), e.g. the scan coverage. */
  coverage?: string | undefined;
  selected: number | null;
  onSelect: (i: number | null) => void;
  lambdaMin: number;
  lambdaMax: number;
  xLabel: string;
  yLabel: string;
  /** Radius of the d_min limit in this plane (1/Å), drawn dashed. */
  limitRadius?: number | undefined;
  /** In-plane reciprocal axes to draw from the origin (unit-cell vectors), with labels. */
  axes?: readonly { readonly x: number; readonly y: number; readonly label: string }[];
}) {
  const { ref: setWrapEl, width } = useMeasuredWidth(560, 280);
  // The square grows with the type size (rem) but stays within the window's height, on phones and 4K alike.
  const rem = typeof document !== "undefined" ? parseFloat(getComputedStyle(document.documentElement).fontSize) || 15 : 15;
  const limit = Math.max(240, Math.min(42 * rem, (typeof window !== "undefined" ? window.innerHeight : 900) - 16 * rem));
  const m = { l: 52, r: 14, t: 12, b: 44 };
  const S = Math.max(220, Math.min(limit, width - m.l - m.r));
  const W = S + m.l + m.r;
  const H = S + m.t + m.b;
  const sx = (x: number) => m.l + ((x + extent) / (2 * extent)) * S;
  const sy = (y: number) => m.t + ((extent - y) / (2 * extent)) * S;
  const fMax = Math.max(1e-300, ...points.map((p) => p.f2));
  const rOf = (f2: number) => 2 + 6 * Math.sqrt(f2 / fMax);
  const step = [0.1, 0.2, 0.25, 0.5, 1, 2].find((s) => extent / s <= 5) ?? 2;
  const ticks: number[] = [];
  for (let t = -Math.floor(extent / step) * step; t <= extent + 1e-9; t += step) ticks.push(Number(t.toFixed(6)));
  const order = [...points].sort((a, b) => (a.state === b.state ? 0 : a.state === "never" ? -1 : b.state === "never" ? 1 : a.state === "scan" ? -1 : 1));

  return (
    <div ref={setWrapEl} className="plot-wrap slice-wrap">
      <svg className="plot" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Reciprocal-space slice" onClick={() => onSelect(null)}>
        <clipPath id="slice-clip">
          <rect x={m.l} y={m.t} width={S} height={S} />
        </clipPath>
        {ticks.map((t) => (
          <g key={t}>
            <line className="plot-grid-line" x1={sx(t)} x2={sx(t)} y1={m.t} y2={m.t + S} />
            <line className="plot-grid-line" x1={m.l} x2={m.l + S} y1={sy(t)} y2={sy(t)} />
          </g>
        ))}
        <g clipPath="url(#slice-clip)">
          {coverage && <image href={coverage} x={m.l} y={m.t} width={S} height={S} preserveAspectRatio="none" />}
          {limitRadius !== undefined && limitRadius > 0 && <circle className="slice-limit" cx={sx(0)} cy={sy(0)} r={(limitRadius / (2 * extent)) * S} />}
          {axes?.map((a) => (
            <g key={a.label}>
              <line className="slice-axis" x1={sx(0)} y1={sy(0)} x2={sx(a.x)} y2={sy(a.y)} />
              <text className="slice-axis-label" x={sx(a.x) + 4} y={sy(a.y) - 4}>
                {a.label}
              </text>
            </g>
          ))}
          {order.map((p) => {
            const isSel = p.index === selected;
            return (
              <circle
                key={p.index}
                className={`slice-point is-${p.state}${isSel ? " is-selected" : ""}`}
                cx={sx(p.x)}
                cy={sy(p.y)}
                r={rOf(p.f2) + (isSel ? 2 : 0)}
                style={p.state === "now" ? { fill: lambdaCss(((p.lambda ?? lambdaMin) - lambdaMin) / (lambdaMax - lambdaMin)) } : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(isSel ? null : p.index);
                }}
              >
                <title>{p.label}</title>
              </circle>
            );
          })}
        </g>
        <rect className="plot-frame" x={m.l} y={m.t} width={S} height={S} />
        {ticks.map((t) => (
          <g key={`l${t}`}>
            <text className="plot-tick" x={sx(t)} y={m.t + S + 16} textAnchor="middle">
              {Number(t.toPrecision(3))}
            </text>
            <text className="plot-tick" x={m.l - 7} y={sy(t) + 4} textAnchor="end">
              {Number(t.toPrecision(3))}
            </text>
          </g>
        ))}
        <text className="axis-label" x={m.l + S / 2} y={H - 6} textAnchor="middle">
          {xLabel}
        </text>
        <text className="axis-label" transform={`translate(13 ${m.t + S / 2}) rotate(-90)`} textAnchor="middle">
          {yLabel}
        </text>
      </svg>
    </div>
  );
}
