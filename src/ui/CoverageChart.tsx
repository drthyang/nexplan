/**
 * Powder coverage in (2θ, d): a pixel at 2θ sees d from λmin/(2 sinθ) to
 * λmax/(2 sinθ) (shaded band, darker where detectors are). Each reflection is
 * a horizontal line over the 2θ range where it diffracts; the strip under the
 * plot shows every panel's 2θ span. Click a line to select a reflection, a
 * panel in the strip (or the band above it) to pick a panel.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PanelAngles } from "../core/instrument/simulate.ts";
import { coveredTwoTheta, twoThetaRangeForD } from "../core/instrument/simulate.ts";
import { fmt } from "./format.ts";

export interface CoverageLine {
  readonly d: number;
  /** Relative strength (any scale); sets the line opacity. */
  readonly weight: number;
  readonly label: string;
}

const PICK_PX = 6;
/** Lines drawn at most (the strongest); the selected one is always drawn. */
const MAX_LINES = 2500;

export function CoverageChart({
  lambdaMin,
  lambdaMax,
  panels,
  panelColors,
  lines,
  selected,
  onSelect,
  selectedPanel,
  onPanelPick,
  dFloor,
}: {
  lambdaMin: number;
  lambdaMax: number;
  panels: readonly PanelAngles[];
  panelColors: readonly string[];
  lines: readonly CoverageLine[];
  selected: number | null;
  onSelect: (i: number | null) => void;
  selectedPanel: number | null;
  onPanelPick: (i: number) => void;
  /** Reflections are calculated only down to this d. */
  dFloor: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [hover, setHover] = useState<{ i: number; px: number; py: number } | null>(null);

  const covered = useMemo(() => coveredTwoTheta(panels), [panels]);
  const tMin = Math.max(0.5, Math.min(...panels.map((p) => p.twoThetaMin)));
  const dLo = lambdaMin / 2;
  const dHiBand = lambdaMax / (2 * Math.sin((tMin * Math.PI) / 360));
  const dMaxLine = Math.max(0, ...lines.map((l) => l.d));
  const dHi = Math.min(dHiBand, Math.max(dMaxLine * 1.4, dLo * 8));
  const height = Math.max(300, Math.min(440, width * 0.62));
  const m = { l: 52, r: 12, t: 10, b: 66 };
  const W = width - m.l - m.r;
  const H = height - m.t - m.b;
  const strip = { top: m.t + H + 6, height: 14 };
  const sx = (t: number) => m.l + (t / 180) * W;
  const ly0 = Math.log(dLo);
  const ly1 = Math.log(dHi);
  const sy = (d: number) => m.t + ((ly1 - Math.log(d)) / (ly1 - ly0)) * H;
  const clipId = useMemo(() => `cov-clip-${Math.random().toString(36).slice(2, 8)}`, []);

  const band = useMemo(() => {
    const up: string[] = [];
    const lo: string[] = [];
    for (let t = 0.5; t <= 180; t += 0.5) {
      const s = 2 * Math.sin((t * Math.PI) / 360);
      up.push(`${sx(t).toFixed(1)},${sy(Math.min(dHi * 4, lambdaMax / s)).toFixed(1)}`);
      lo.push(`${sx(t).toFixed(1)},${sy(lambdaMin / s).toFixed(1)}`);
    }
    return `M${up.join("L")}L${lo.reverse().join("L")}Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lambdaMin, lambdaMax, W, H, dLo, dHi]);

  const drawn = useMemo(() => {
    if (lines.length <= MAX_LINES) return undefined;
    const order = lines.map((_, i) => i).sort((a, b) => lines[b]!.weight - lines[a]!.weight);
    return new Set(order.slice(0, MAX_LINES));
  }, [lines]);
  const segs = useMemo(
    () =>
      lines.map((l, i) => {
        const r = l.d >= dLo && l.d <= dHi && (!drawn || drawn.has(i) || i === selected) ? twoThetaRangeForD(l.d, lambdaMin, lambdaMax) : undefined;
        return r ? { x0: sx(r.min), x1: sx(r.max), y: sy(l.d) } : undefined;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, drawn, selected, lambdaMin, lambdaMax, W, H, dLo, dHi],
  );
  const wMax = Math.max(1e-300, ...lines.map((l) => l.weight));

  const nearestLine = (px: number, py: number): number | null => {
    let best: number | null = null;
    let bd = PICK_PX;
    segs.forEach((s, i) => {
      if (!s || px < s.x0 - 2 || px > s.x1 + 2) return;
      const d = Math.abs(s.y - py);
      if (d < bd || (d === bd && best !== null && lines[i]!.weight > lines[best]!.weight)) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const panelAt = (px: number): number | null => {
    const t = ((px - m.l) / W) * 180;
    let best: number | null = null;
    let bd = Infinity;
    panels.forEach((p, i) => {
      if (t < p.twoThetaMin || t > p.twoThetaMax) return;
      const d = Math.abs(p.twoThetaCenter - t);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };

  const dTicks = useMemo(() => {
    const out: number[] = [];
    for (let e = Math.floor(Math.log10(dLo)); e <= Math.ceil(Math.log10(dHi)); e++)
      for (const k of [1, 2, 5]) {
        const v = k * 10 ** e;
        if (v >= dLo && v <= dHi) out.push(v);
      }
    return out;
  }, [dLo, dHi]);
  const sp = selectedPanel !== null ? panels[selectedPanel] : undefined;
  const hoverLine = hover ? lines[hover.i] : undefined;

  return (
    <div ref={wrapRef} className="plot-wrap">
      <svg
        className="plot"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="d-spacing coverage versus scattering angle"
        onPointerMove={(e) => {
          const { px, py } = local(e);
          const i = nearestLine(px, py);
          setHover(i === null ? null : { i, px, py });
        }}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const { px, py } = local(e);
          if (py >= strip.top - 2) {
            const p = panelAt(px);
            if (p !== null) onPanelPick(p);
            return;
          }
          const i = nearestLine(px, py);
          if (i !== null) return onSelect(i === selected ? null : i);
          const p = panelAt(px);
          if (p !== null) onPanelPick(p);
          else onSelect(null);
        }}
      >
        <clipPath id={clipId}>
          <rect x={m.l} y={m.t} width={W} height={H} />
        </clipPath>
        {dTicks.map((t) => (
          <line key={`gy${t}`} className="plot-grid-line" x1={m.l} x2={m.l + W} y1={sy(t)} y2={sy(t)} />
        ))}
        {[30, 60, 90, 120, 150].map((t) => (
          <line key={`gx${t}`} className="plot-grid-line" x1={sx(t)} x2={sx(t)} y1={m.t} y2={m.t + H} />
        ))}
        <g clipPath={`url(#${clipId})`}>
          <path className="coverage-band" d={band} />
          <clipPath id={`${clipId}-cov`}>
            {covered.map(([a, b]) => (
              <rect key={a} x={sx(a)} y={m.t} width={Math.max(0.5, sx(b) - sx(a))} height={H} />
            ))}
          </clipPath>
          <path className="coverage-band is-covered" d={band} clipPath={`url(#${clipId}-cov)`} />
          {sp && <rect className="coverage-panel-span" x={sx(sp.twoThetaMin)} y={m.t} width={Math.max(1, sx(sp.twoThetaMax) - sx(sp.twoThetaMin))} height={H} />}
          {dFloor > dLo && <rect className="coverage-floor" x={m.l} y={sy(dFloor)} width={W} height={m.t + H - sy(dFloor)} />}
          {segs.map((s, i) =>
            s && i !== selected ? <line key={i} className="coverage-line" x1={s.x0} x2={s.x1} y1={s.y} y2={s.y} style={{ opacity: 0.15 + 0.85 * Math.sqrt(lines[i]!.weight / wMax) }} /> : null,
          )}
          {selected !== null && segs[selected] && <line className="coverage-line is-selected" x1={segs[selected]!.x0} x2={segs[selected]!.x1} y1={segs[selected]!.y} y2={segs[selected]!.y} />}
          {hover && hover.i !== selected && segs[hover.i] && <line className="coverage-line is-hover" x1={segs[hover.i]!.x0} x2={segs[hover.i]!.x1} y1={segs[hover.i]!.y} y2={segs[hover.i]!.y} />}
        </g>
        {dFloor > dLo && (
          <text className="plot-tick coverage-floor-label" x={m.l + W - 6} y={Math.min(m.t + H - 6, sy(dFloor) + 14)} textAnchor="end">
            below d_min = {dFloor} Å: not calculated
          </text>
        )}
        <rect className="plot-frame" x={m.l} y={m.t} width={W} height={H} />
        {panels.map((p, i) => (
          <rect
            key={i}
            className={`coverage-strip${i === selectedPanel ? " is-selected" : ""}`}
            x={sx(p.twoThetaMin)}
            y={strip.top}
            width={Math.max(1, sx(p.twoThetaMax) - sx(p.twoThetaMin))}
            height={strip.height}
            style={{ fill: panelColors[i] }}
          />
        ))}
        {[0, 30, 60, 90, 120, 150, 180].map((t) => (
          <text key={`tx${t}`} className="plot-tick" x={sx(t)} y={strip.top + strip.height + 17} textAnchor="middle">
            {t}
          </text>
        ))}
        {dTicks.map((t) => (
          <text key={`ty${t}`} className="plot-tick" x={m.l - 7} y={sy(t) + 4} textAnchor="end">
            {Number(t.toPrecision(3))}
          </text>
        ))}
        <text className="axis-label" x={m.l + W / 2} y={height - 6} textAnchor="middle">
          2θ (deg)
        </text>
        <text className="axis-label" transform={`translate(14 ${m.t + H / 2}) rotate(-90)`} textAnchor="middle">
          d (Å)
        </text>
      </svg>
      {hover && hoverLine && (
        <div className="plot-tooltip" style={{ left: Math.min(hover.px + 12, width - 220), top: Math.max(8, Math.min(hover.py - 20, height - 80)) }}>
          <div>
            <b>{hoverLine.label}</b>
          </div>
          <div>
            d {fmt(hoverLine.d, 5)} Å
            {(() => {
              const r = twoThetaRangeForD(hoverLine.d, lambdaMin, lambdaMax);
              return r ? ` · 2θ ${fmt(r.min, 1)}–${fmt(r.max, 1)}°` : "";
            })()}
          </div>
          <div>click to select</div>
        </div>
      )}
    </div>
  );
}
