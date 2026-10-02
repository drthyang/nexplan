/**
 * Rotation-scan chart: reflections on the detectors at each step (bars, right
 * axis) and the cumulative fraction of symmetry families seen (line, left
 * axis). Click a step to move the goniometer there.
 */
import { useEffect, useRef, useState } from "react";
import type { ScanStep } from "../core/instrument/simulate.ts";
import { fmt } from "./format.ts";

export function ScanChart({ steps, axisIndex, axisName, current, onPick }: { steps: readonly ScanStep[]; axisIndex: number; axisName: string; current: number; onPick: (angle: number) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(300, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [hover, setHover] = useState<number | null>(null);

  const xs = steps.map((s) => s.angles[axisIndex]!);
  const x0 = xs[0] ?? 0;
  const x1 = xs.length > 1 ? xs[xs.length - 1]! : x0 + 1;
  const nMax = Math.max(1, ...steps.map((s) => s.observed));
  const height = Math.max(240, Math.min(340, width * 0.5));
  const m = { l: 48, r: 46, t: 12, b: 44 };
  const W = width - m.l - m.r;
  const H = height - m.t - m.b;
  const sx = (x: number) => m.l + ((x - x0) / (x1 - x0 || 1)) * W;
  const syC = (c: number) => m.t + (1 - c) * H;
  const syN = (n: number) => m.t + (1 - n / nMax) * H;
  const barW = Math.max(1, Math.min(14, (W / Math.max(1, steps.length)) * 0.7));
  const line = steps.map((s, i) => `${i ? "L" : "M"}${sx(xs[i]!).toFixed(1)},${syC(s.completeness).toFixed(1)}`).join("");
  const nearest = (px: number) => {
    let best = 0;
    xs.forEach((x, i) => {
      if (Math.abs(sx(x) - px) < Math.abs(sx(xs[best]!) - px)) best = i;
    });
    return best;
  };
  const nTicks = [0, 0.5, 1].map((f) => Math.round(f * nMax));
  const xTickStep = [5, 10, 15, 30, 45, 60, 90, 180].find((s) => (x1 - x0) / s <= Math.max(3, W / 70)) ?? 180;
  const xTicks: number[] = [];
  for (let t = Math.ceil(x0 / xTickStep) * xTickStep; t <= x1 + 1e-9; t += xTickStep) xTicks.push(t);
  const h = hover !== null ? steps[hover] : undefined;

  return (
    <div ref={wrapRef} className="plot-wrap">
      <svg
        className="plot"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Rotation scan over ${axisName}: reflections per step and cumulative completeness`}
        onPointerMove={(e) => {
          const r = wrapRef.current!.getBoundingClientRect();
          setHover(steps.length ? nearest(e.clientX - r.left) : null);
        }}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const r = wrapRef.current!.getBoundingClientRect();
          if (steps.length) onPick(xs[nearest(e.clientX - r.left)]!);
        }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((c) => (
          <line key={c} className="plot-grid-line" x1={m.l} x2={m.l + W} y1={syC(c)} y2={syC(c)} />
        ))}
        {steps.map((s, i) => (
          <rect key={i} className="scan-bar" x={sx(xs[i]!) - barW / 2} y={syN(s.observed)} width={barW} height={m.t + H - syN(s.observed)} />
        ))}
        <path className="series-profile" d={line} />
        {current >= Math.min(x0, x1) && current <= Math.max(x0, x1) && <line className="selection-line" x1={sx(current)} x2={sx(current)} y1={m.t} y2={m.t + H} />}
        {hover !== null && <line className="hover-line" x1={sx(xs[hover]!)} x2={sx(xs[hover]!)} y1={m.t} y2={m.t + H} />}
        <rect className="plot-frame" x={m.l} y={m.t} width={W} height={H} />
        {[0, 0.5, 1].map((c) => (
          <text key={c} className="plot-tick" x={m.l - 7} y={syC(c) + 4} textAnchor="end">
            {c * 100}
          </text>
        ))}
        {nTicks.map((n) => (
          <text key={n} className="plot-tick" x={m.l + W + 7} y={syN(n) + 4} textAnchor="start">
            {n}
          </text>
        ))}
        {xTicks.map((t) => (
          <text key={t} className="plot-tick" x={sx(t)} y={m.t + H + 16} textAnchor="middle">
            {t}
          </text>
        ))}
        <text className="axis-label" x={m.l + W / 2} y={height - 5} textAnchor="middle">
          {axisName} (deg)
        </text>
        <text className="axis-label" transform={`translate(13 ${m.t + H / 2}) rotate(-90)`} textAnchor="middle">
          Completeness (%)
        </text>
        <text className="axis-label" transform={`translate(${width - 8} ${m.t + H / 2}) rotate(90)`} textAnchor="middle">
          On detectors
        </text>
      </svg>
      {h && hover !== null && (
        <div className="plot-tooltip" style={{ left: Math.min(sx(xs[hover]!) + 12, width - 200), top: m.t + 8 }}>
          <div>
            <b>
              {axisName} = {fmt(xs[hover]!, 1)}°
            </b>
          </div>
          <div>{h.observed.toLocaleString()} reflections on detectors</div>
          <div>{fmt(100 * h.completeness, 1)} % of families so far · click to go there</div>
        </div>
      )}
    </div>
  );
}
