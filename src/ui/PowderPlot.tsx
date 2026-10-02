/**
 * Powder plot: unit-area profile (line) and integrated-intensity sticks, both
 * scaled to 100 at their maximum. SVG in CSS pixels (as MATERIA's
 * WorkbenchPlot), RMCProfile chart ink. Drag to zoom, double-click to reset,
 * hover a stick for its hkl families.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PowderAxis, PowderPeak } from "../core/diffraction/powder.ts";
import { fmt, hklText } from "./format.ts";

const AXIS_LABEL: Record<PowderAxis, string> = { twoTheta: "2θ (deg)", d: "d (Å)", q: "Q (Å⁻¹)" };

function niceTicks(lo: number, hi: number, target: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= target) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * span; v += step) out.push(Math.abs(v) < 1e-12 * step ? 0 : v);
  return out;
}

export function PowderPlot({ peaks, profile, axis }: { peaks: readonly PowderPeak[]; profile: { x: Float64Array; y: Float64Array }; axis: PowderAxis }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const height = Math.max(260, Math.min(460, width * 0.42));
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pos = (p: PowderPeak) => (axis === "twoTheta" ? p.twoTheta : axis === "d" ? p.d : p.q);
  const full = useMemo<[number, number]>(() => {
    if (profile.x.length > 1) return [profile.x[0]!, profile.x[profile.x.length - 1]!];
    const xs = peaks.map(pos);
    return xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 1];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, peaks, axis]);
  const [view, setView] = useState<[number, number] | null>(null);
  useEffect(() => setView(null), [axis, peaks]);
  const [x0, x1] = view ?? full;

  const m = { l: 58, r: 16, t: 14, b: 46 };
  const W = width - m.l - m.r;
  const H = height - m.t - m.b;
  const sx = (x: number) => m.l + ((x - x0) / (x1 - x0)) * W;

  const visible = peaks.filter((p) => pos(p) >= x0 && pos(p) <= x1);
  const iMax = Math.max(1e-300, ...visible.map((p) => p.intensity));
  let yMax = 1e-300;
  for (let i = 0; i < profile.x.length; i++) if (profile.x[i]! >= x0 && profile.x[i]! <= x1) yMax = Math.max(yMax, profile.y[i]!);
  const sy = (v: number) => m.t + H - (v / 105) * H;

  const path = useMemo(() => {
    const pts: string[] = [];
    const n = profile.x.length;
    if (!n) return "";
    // Decimate to ~2 points per pixel column (min/max) to keep the path light.
    const perPx = Math.max(1, Math.floor(n / Math.max(1, ((x1 - x0) / (full[1] - full[0])) * W * 2)));
    for (let i = 0; i < n; i += perPx) {
      const x = profile.x[i]!;
      if (x < x0 || x > x1) continue;
      let ymax = profile.y[i]!;
      for (let j = i + 1; j < Math.min(n, i + perPx); j++) ymax = Math.max(ymax, profile.y[j]!);
      pts.push(`${sx(x).toFixed(1)},${sy((100 * ymax) / yMax).toFixed(1)}`);
    }
    return pts.length ? `M${pts.join("L")}` : "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, x0, x1, W, H, yMax]);

  const [hover, setHover] = useState<{ peak: PowderPeak; px: number; py: number } | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const toData = (clientX: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return x0 + ((clientX - r.left - m.l) / W) * (x1 - x0);
  };

  const xticks = niceTicks(x0, x1, Math.max(4, Math.floor(W / 90)));
  const yticks = [0, 25, 50, 75, 100];

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <svg
        className="plot"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Calculated powder pattern versus ${AXIS_LABEL[axis]}`}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const v = toData(e.clientX);
          setDrag({ a: v, b: v });
        }}
        onPointerMove={(e) => {
          const v = toData(e.clientX);
          if (drag) setDrag({ ...drag, b: v });
          const r = wrapRef.current!.getBoundingClientRect();
          const px = e.clientX - r.left;
          let best: PowderPeak | undefined;
          let bd = 8;
          for (const p of visible) {
            const d = Math.abs(sx(pos(p)) - px);
            if (d < bd) {
              bd = d;
              best = p;
            }
          }
          setHover(best ? { peak: best, px: sx(pos(best)), py: e.clientY - r.top } : null);
        }}
        onPointerUp={() => {
          if (drag && Math.abs(sx(drag.a) - sx(drag.b)) > 6) setView([Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)]);
          setDrag(null);
        }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={() => setView(null)}
      >
        {yticks.map((t) => (
          <line key={`gy${t}`} className="plot-grid-line" x1={m.l} x2={m.l + W} y1={sy(t)} y2={sy(t)} />
        ))}
        {xticks.map((t) => (
          <line key={`gx${t}`} className="plot-grid-line" x1={sx(t)} x2={sx(t)} y1={m.t} y2={m.t + H} />
        ))}
        <clipPath id="plot-clip">
          <rect x={m.l} y={m.t} width={W} height={H} />
        </clipPath>
        <g clipPath="url(#plot-clip)">
          {visible.map((p, i) => (
            <line key={i} className={`series-stick${hover?.peak === p ? " is-hover" : ""}`} x1={sx(pos(p))} x2={sx(pos(p))} y1={sy(0)} y2={sy((100 * p.intensity) / iMax)} />
          ))}
          {path && <path className="series-profile" d={path} />}
          {hover && <line className="hover-line" x1={hover.px} x2={hover.px} y1={m.t} y2={m.t + H} />}
          {drag && <rect className="zoom-selection" x={Math.min(sx(drag.a), sx(drag.b))} y={m.t} width={Math.abs(sx(drag.b) - sx(drag.a))} height={H} />}
        </g>
        <rect className="plot-frame" x={m.l} y={m.t} width={W} height={H} />
        {xticks.map((t) => (
          <g key={`tx${t}`}>
            <line className="plot-tick-mark" x1={sx(t)} x2={sx(t)} y1={m.t + H} y2={m.t + H + 5} />
            <text className="plot-tick" x={sx(t)} y={m.t + H + 19} textAnchor="middle">
              {Number(t.toPrecision(6))}
            </text>
          </g>
        ))}
        {yticks.map((t) => (
          <text key={`ty${t}`} className="plot-tick" x={m.l - 8} y={sy(t) + 4} textAnchor="end">
            {t}
          </text>
        ))}
        <text className="axis-label" x={m.l + W / 2} y={height - 6} textAnchor="middle">
          {AXIS_LABEL[axis]}
        </text>
        <text className="axis-label" transform={`translate(15 ${m.t + H / 2}) rotate(-90)`} textAnchor="middle">
          Relative intensity
        </text>
      </svg>
      {hover && (
        <div className="plot-tooltip" style={{ left: Math.min(hover.px + 12, width - 200), top: Math.max(8, hover.py - 20) }}>
          <div>
            {hover.peak.families.map((f, i) => (
              <span key={i}>
                {i > 0 && " + "}
                <b>({hklText(f.hkl)})</b> ×{f.multiplicity}
              </span>
            ))}
          </div>
          <div>
            d {fmt(hover.peak.d, 5)} Å · 2θ {fmt(hover.peak.twoTheta, 3)}° · Q {fmt(hover.peak.q, 4)} Å⁻¹
          </div>
          <div>
            Σ|F|² {hover.peak.sumF2.toPrecision(5)} · I {fmt((100 * hover.peak.intensity) / iMax, 2)}
          </div>
        </div>
      )}
    </div>
  );
}
