/**
 * Powder plot: unit-area profile and a row of reflection ticks under it
 * (MATERIA-style Bragg ticks), in CSS-pixel SVG with RMCProfile chart ink.
 *
 * Interaction: click a tick or a peak to select it (the parent links the
 * selection to its table), drag to zoom, double-click to reset, ←/→ step
 * through peaks, Esc clears. A selection made elsewhere that lies outside the
 * zoomed range pans the view to it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { peakPosition, type PowderAxis, type PowderPeak } from "../core/diffraction/powder.ts";
import { fmt, hklText } from "./format.ts";

export const AXIS_LABEL: Record<PowderAxis, string> = { twoTheta: "2θ (deg)", tof: "TOF (µs)", d: "d (Å)", q: "Q (Å⁻¹)" };

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

const PICK_PX = 10;

export function PowderPlot({
  peaks,
  profile,
  axis,
  selected,
  onSelect,
  showSticks,
  marker,
}: {
  peaks: readonly PowderPeak[];
  profile: { x: Float64Array; y: Float64Array };
  axis: PowderAxis;
  selected: number | null;
  onSelect: (index: number | null) => void;
  showSticks: boolean;
  /** Optional position (axis units) to mark, e.g. the current time-of-flight slice. */
  marker?: number | undefined;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const height = Math.max(280, Math.min(480, width * 0.44));
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pos = useMemo(() => peaks.map((p) => peakPosition(p, axis)), [peaks, axis]);
  /** Peak indices in increasing axis position, for ←/→ navigation. */
  const order = useMemo(() => pos.map((_, i) => i).sort((a, b) => pos[a]! - pos[b]!), [pos]);
  const full = useMemo<[number, number]>(() => {
    if (profile.x.length > 1) return [profile.x[0]!, profile.x[profile.x.length - 1]!];
    return pos.length ? [Math.min(...pos), Math.max(...pos)] : [0, 1];
  }, [profile, pos]);
  const [view, setView] = useState<[number, number] | null>(null);
  useEffect(() => setView(null), [axis, peaks]);
  const [x0, x1] = view ?? full;

  // Pan to a selection made outside the current window, keeping the zoom width.
  useEffect(() => {
    if (selected === null || !view) return;
    const p = pos[selected];
    if (p === undefined || (p >= view[0] && p <= view[1])) return;
    const w = view[1] - view[0];
    setView([p - w / 2, p + w / 2]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const m = { l: 58, r: 16, t: 14, b: 66 };
  const tickBand = { top: 0, height: 16 };
  const W = width - m.l - m.r;
  const H = height - m.t - m.b;
  tickBand.top = m.t + H + 6;
  const sx = (x: number) => m.l + ((x - x0) / (x1 - x0)) * W;

  const visibleIdx = useMemo(() => pos.map((p, i) => (p >= x0 && p <= x1 ? i : -1)).filter((i) => i >= 0), [pos, x0, x1]);
  const iMax = Math.max(1e-300, ...visibleIdx.map((i) => peaks[i]!.intensity));
  let yMax = 1e-300;
  for (let i = 0; i < profile.x.length; i++) if (profile.x[i]! >= x0 && profile.x[i]! <= x1) yMax = Math.max(yMax, profile.y[i]!);
  const sy = (v: number) => m.t + H - (v / 105) * H;

  const path = useMemo(() => {
    const n = profile.x.length;
    if (!n) return "";
    // One min/max pair per pixel column keeps the path light and the peaks sharp.
    const cols = new Map<number, { min: number; max: number }>();
    for (let i = 0; i < n; i++) {
      const x = profile.x[i]!;
      if (x < x0 || x > x1) continue;
      const c = Math.round(sx(x));
      const v = (100 * profile.y[i]!) / yMax;
      const e = cols.get(c);
      if (!e) cols.set(c, { min: v, max: v });
      else {
        e.min = Math.min(e.min, v);
        e.max = Math.max(e.max, v);
      }
    }
    const pts: string[] = [];
    for (const [c, e] of [...cols].sort((a, b) => a[0] - b[0])) {
      pts.push(`${c},${sy(e.min).toFixed(1)}`);
      if (e.max !== e.min) pts.push(`${c},${sy(e.max).toFixed(1)}`);
    }
    return pts.length ? `M${pts.join("L")}` : "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, x0, x1, W, H, yMax]);

  const [hover, setHover] = useState<{ index: number; py: number } | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number; px0: number } | null>(null);
  const local = (clientX: number, clientY: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { px: clientX - r.left, py: clientY - r.top };
  };
  const toData = (px: number) => x0 + ((px - m.l) / W) * (x1 - x0);
  const nearest = (px: number): number | null => {
    let best: number | null = null;
    let bd = PICK_PX;
    for (const i of visibleIdx) {
      const d = Math.abs(sx(pos[i]!) - px);
      if (d < bd || (d === bd && best !== null && peaks[i]!.intensity > peaks[best]!.intensity)) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return onSelect(null);
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const k = selected === null ? -1 : order.indexOf(selected);
    const next = e.key === "ArrowRight" ? order[Math.min(order.length - 1, k + 1)] : order[Math.max(0, k <= 0 ? 0 : k - 1)];
    if (next !== undefined) onSelect(next);
  };

  const xticks = niceTicks(x0, x1, Math.max(4, Math.floor(W / 90)));
  const yticks = [0, 25, 50, 75, 100];
  const sel = selected !== null && pos[selected] !== undefined && pos[selected]! >= x0 && pos[selected]! <= x1 ? selected : null;
  const tip = hover ? peaks[hover.index] : undefined;

  return (
    <div ref={wrapRef} className="plot-wrap" tabIndex={0} onKeyDown={onKey} aria-label="Powder pattern; arrow keys step through peaks">
      <svg
        className="plot"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Calculated powder pattern versus ${AXIS_LABEL[axis]}`}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const { px } = local(e.clientX, e.clientY);
          const v = toData(px);
          setDrag({ a: v, b: v, px0: px });
        }}
        onPointerMove={(e) => {
          const { px, py } = local(e.clientX, e.clientY);
          if (drag) setDrag({ ...drag, b: toData(px) });
          const i = nearest(px);
          setHover(i === null ? null : { index: i, py });
        }}
        onPointerUp={(e) => {
          const { px } = local(e.clientX, e.clientY);
          if (drag && Math.abs(px - drag.px0) > 4) setView([Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)]);
          else onSelect(nearest(px));
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
          <rect x={m.l} y={m.t} width={W} height={H + tickBand.height + 8} />
        </clipPath>
        <g clipPath="url(#plot-clip)">
          {sel !== null && <line className="selection-line" x1={sx(pos[sel]!)} x2={sx(pos[sel]!)} y1={m.t} y2={tickBand.top + tickBand.height} />}
          {showSticks &&
            visibleIdx.map((i) => <line key={`s${i}`} className="series-stick" x1={sx(pos[i]!)} x2={sx(pos[i]!)} y1={sy(0)} y2={sy((100 * peaks[i]!.intensity) / iMax)} />)}
          {path && <path className="series-profile" d={path} />}
          {marker !== undefined && marker >= x0 && marker <= x1 && <line className="slice-line" x1={sx(marker)} x2={sx(marker)} y1={m.t} y2={m.t + H} />}
          {hover && hover.index !== sel && <line className="hover-line" x1={sx(pos[hover.index]!)} x2={sx(pos[hover.index]!)} y1={m.t} y2={m.t + H} />}
          {/* Reflection ticks */}
          {visibleIdx.map((i) => (
            <line
              key={`t${i}`}
              className={`reflection-tick${i === sel ? " is-selected" : ""}${hover?.index === i ? " is-hover" : ""}`}
              x1={sx(pos[i]!)}
              x2={sx(pos[i]!)}
              y1={tickBand.top + (i === sel ? 0 : 3)}
              y2={tickBand.top + tickBand.height}
            />
          ))}
          {drag && Math.abs(sx(drag.b) - sx(drag.a)) > 4 && <rect className="zoom-selection" x={Math.min(sx(drag.a), sx(drag.b))} y={m.t} width={Math.abs(sx(drag.b) - sx(drag.a))} height={H} />}
        </g>
        <rect className="plot-frame" x={m.l} y={m.t} width={W} height={H} />
        <text className="plot-tick tick-band-label" x={m.l - 8} y={tickBand.top + tickBand.height - 3} textAnchor="end">
          hkl
        </text>
        {xticks.map((t) => (
          <g key={`tx${t}`}>
            <line className="plot-tick-mark" x1={sx(t)} x2={sx(t)} y1={tickBand.top + tickBand.height + 2} y2={tickBand.top + tickBand.height + 7} />
            <text className="plot-tick" x={sx(t)} y={tickBand.top + tickBand.height + 21} textAnchor="middle">
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
      {tip && hover && (
        <div className="plot-tooltip" style={{ left: Math.min(sx(pos[hover.index]!) + 12, width - 220), top: Math.max(8, Math.min(hover.py - 20, height - 90)) }}>
          <div>
            {tip.families.map((f, i) => (
              <span key={i}>
                {i > 0 && " + "}
                <b>({hklText(f.hkl)})</b> ×{f.multiplicity}
              </span>
            ))}
          </div>
          <div>
            d {fmt(tip.d, 5)} Å · {tip.twoTheta !== undefined ? `2θ ${fmt(tip.twoTheta, 3)}°` : `TOF ${fmt(tip.tof!, 1)} µs`} · Q {fmt(tip.q, 4)} Å⁻¹
          </div>
          <div>
            I {fmt((100 * tip.intensity) / iMax, 2)} · click to select
          </div>
        </div>
      )}
    </div>
  );
}
