/**
 * Single-crystal page (Simulation): the measurement plan and what it records.
 *
 *  - Plan, as the instrument is run: an orientation list (TOPAZ: ~10 chosen
 *    settings) or a rotation scan of one axis (CORELLI: 3° steps, optionally
 *    interleaved; chopper spectrometers: ψ, with exact Bragg crossings).
 *  - Completeness: symmetry families recorded, cumulative over the plan.
 *  - Reciprocal slice: one lattice plane with the plan's coverage shaded and
 *    each reflection marked as on a detector now, recorded in the plan, or never.
 *  - "Find a setting": goniometer angles that put a chosen reflection near the
 *    middle of a panel at a mid-band wavelength (to build a TOPAZ-style list).
 *  - Wanted reflections and "Suggest settings" (lists): a greedy search over a
 *    grid of goniometer settings for the ones that record the wanted
 *    reflections first, then the most new families (src/core/instrument/plan.ts).
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulVec } from "@materia/core/math/mat3";
import { familyCounts, wantedStatus } from "../core/instrument/plan.ts";
import { braggCrossings, crossingsToScan, pointCoverage, reflectionCoverage, scanSettings, simulateSettings, type ScanResult } from "../core/instrument/simulate.ts";
import { suggestPlan } from "../workers/client.ts";
import { goniometerMatrix, type GoniometerModel } from "../core/ub/goniometer.ts";
import type { InstrumentPreset } from "../core/ub/instruments.ts";
import { Card, cx, Segmented, UnitField } from "./components.tsx";
import { downloadText, fmt, hklText } from "./format.ts";
import { ScanChart } from "./ScanChart.tsx";
import { SliceChart, type SlicePoint } from "./SliceChart.tsx";
import { DMinNote, findHkl, GoniometerLimits, HklField, InstrumentRequired, lam, useObservations, useSnsInstrument, type SimPageProps } from "./snsShared.tsx";
import { GoniometerControls } from "./UbPage.tsx";

const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(...a);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** The three principal planes: in-plane index vectors u1, u2, the normal direction u3, and the index held at the layer value. */
const PLANES = {
  hk0: { u1: [1, 0, 0] as Vec3, u2: [0, 1, 0] as Vec3, u3: [0, 0, 1] as Vec3, fixed: 2, label: "(h k L)", axes: ["a*", "b*"] },
  h0l: { u1: [1, 0, 0] as Vec3, u2: [0, 0, 1] as Vec3, u3: [0, 1, 0] as Vec3, fixed: 1, label: "(h L l)", axes: ["a*", "c*"] },
  "0kl": { u1: [0, 1, 0] as Vec3, u2: [0, 0, 1] as Vec3, u3: [1, 0, 0] as Vec3, fixed: 0, label: "(L k l)", axes: ["b*", "c*"] },
} as const;
type PlaneId = keyof typeof PLANES;

export function CrystalPage(props: SimPageProps) {
  const sns = useSnsInstrument(props.exp);
  const ins = sns.instrument;
  if (!ins || !ins.modes?.includes("single-crystal") || !ins.goniometer.axes.some((ax) => ax.fixed === undefined))
    return (
      <InstrumentRequired exp={props.exp} onExp={props.onExp} need="single-crystal" title="Choose a single-crystal instrument">
        The Single-crystal page plans the measurement (an orientation list or a rotation scan), reports the completeness, and shows reciprocal-space slices of what the plan records. It needs an instrument that turns the crystal.
      </InstrumentRequired>
    );
  return <CrystalPlan key={ins.id} {...props} instrument={ins} catalogGoniometer={sns.catalogGoniometer!} panels={sns.panels} info={sns.info} />;
}

function CrystalPlan({ result, ub, exp, onExp, onDMin, onOpenOrientation, instrument, catalogGoniometer, panels, info }: SimPageProps & { instrument: InstrumentPreset; catalogGoniometer: GoniometerModel; panels: NonNullable<InstrumentPreset["detectors"]>; info: readonly { twoThetaMax: number }[] }) {
  const { viewUB, fileUB, points, sim, tofOf } = useObservations(result, ub, exp, instrument);
  const model = instrument.goniometer;
  const axes = model.axes;
  const free = axes.map((ax, i) => ({ ax, i })).filter(({ ax }) => ax.fixed === undefined);
  const planKind = instrument.plan?.kind ?? "scan";
  const mono = instrument.incident;
  const lambdaMid = (exp.lambdaMin + exp.lambdaMax) / 2;
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => setSelected(null), [points]);

  // ---------------------------------------------------------------- the plan's goniometer settings
  const scanAxis = free.some((f) => f.i === exp.scan.axis) ? exp.scan.axis : (free[0]?.i ?? 0);
  const baseKey = exp.angles.map((v, i) => (i === scanAxis ? 0 : v)).join(",");
  const deferredBase = useDeferredValue(baseKey);
  const plan = useMemo((): (ScanResult & { settings: (readonly number[])[] }) | { error: string } => {
    try {
      if (planKind === "list") return { ...simulateSettings(model, exp.orientations, viewUB, points, panels, exp.lambdaMin, exp.lambdaMax), settings: [...exp.orientations] };
      const base = deferredBase.split(",").map(Number);
      if (mono) {
        // Monochromatic: exact Bragg crossings, binned into the scan steps (nothing is missed between steps).
        const half = exp.scan.step / 2;
        const crossings = braggCrossings(model, scanAxis, base, { start: exp.scan.start - half, end: exp.scan.end + half }, viewUB, points, panels, lambdaMid);
        return { ...crossingsToScan(crossings, points, scanAxis, base, exp.scan), settings: scanSettings(scanAxis, base, exp.scan) };
      }
      const settings = scanSettings(scanAxis, base, exp.scan, exp.scan.interleave);
      return { ...simulateSettings(model, settings, viewUB, points, panels, exp.lambdaMin, exp.lambdaMax), settings };
    } catch (e) {
      return { error: (e as Error).message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKind, exp.orientations, deferredBase, scanAxis, exp.scan, model, viewUB, points, panels, exp.lambdaMin, exp.lambdaMax, mono, lambdaMid]);
  const planOk = "steps" in plan ? plan : undefined;
  const reach90 = planOk?.steps.find((s) => s.completeness >= 0.9);
  // Lists: families recorded in two or more settings (redundancy for scaling and absorption corrections).
  const twice = useMemo(() => {
    if (planKind !== "list" || !planOk || !planOk.settings.length) return undefined;
    const counts = familyCounts(model, planOk.settings, viewUB, points.map((p) => ({ h: p.h as Vec3, family: p.family })), panels, exp.lambdaMin, exp.lambdaMax);
    return [...counts.values()].filter((c) => c >= 2).length;
  }, [planKind, planOk, model, viewUB, points, panels, exp.lambdaMin, exp.lambdaMax]);

  // ---------------------------------------------------------------- reciprocal slice
  const [planeId, setPlaneId] = useState<PlaneId>("hk0");
  const [layer, setLayer] = useState(0);
  const [showCoverage, setShowCoverage] = useState(true);
  const plane = PLANES[planeId];
  const geom = useMemo(() => {
    const a1 = mulVec(viewUB, plane.u1);
    const a2 = mulVec(viewUB, plane.u2);
    const a3 = mulVec(viewUB, plane.u3);
    const e1 = unit(a1);
    const n = unit(cross(a1, a2));
    const e2 = cross(n, e1);
    return { e1, e2, n, off: layer * dot(a3, n), a1, a2 };
  }, [viewUB, plane, layer]);
  const dMin = result.provenance.dMin;
  const limit = Math.sqrt(Math.max(0, 1 / (dMin * dMin) - geom.off * geom.off));
  const slicePoints = useMemo<SlicePoint[]>(() => {
    const out: SlicePoint[] = [];
    points.forEach((p, i) => {
      if (p.h[plane.fixed] !== layer) return;
      const q = mulVec(viewUB, p.h);
      const now = sim.status[i] === 2;
      const measured = planOk?.measured.has(i) ?? false;
      out.push({
        index: i,
        x: dot(q, geom.e1),
        y: dot(q, geom.e2),
        f2: p.f2,
        state: now ? "now" : measured ? "scan" : "never",
        ...(now ? { lambda: sim.lambdas[i]! } : {}),
        label: `(${hklText(p.h)}) d ${fmt(p.d, 4)} Å · |F|² ${p.f2.toPrecision(4)} · ${now ? `on a detector now (λ ${fmt(sim.lambdas[i]!, 3)} Å)` : measured ? "recorded in the plan" : "not recorded by the plan"}`,
      });
    });
    return out;
  }, [points, plane, layer, viewUB, geom, sim, planOk]);
  const extent = Math.max(limit, ...slicePoints.map((p) => Math.hypot(p.x, p.y))) * 1.06 || 1;

  // Coverage of the plane by the plan, as a shaded image (number of settings recording each point).
  const [covImage, setCovImage] = useState<{ key: string; href: string; max: number } | null>(null);
  const [covBusy, setCovBusy] = useState(false);
  const covKey = `${planeId}|${layer}|${extent.toFixed(4)}|${planOk ? planOk.settings.length : -1}|${exp.lambdaMin}|${exp.lambdaMax}|${deferredBase}|${JSON.stringify(exp.orientations)}|${JSON.stringify(exp.scan)}`;
  useEffect(() => {
    if (!showCoverage || !planOk || !planOk.settings.length) {
      setCovImage(null);
      setCovBusy(false);
      return;
    }
    let alive = true;
    setCovBusy(true);
    const t = setTimeout(() => {
      const N = 140;
      const qs: Vec3[] = [];
      for (let j = 0; j < N; j++) {
        const y = extent - ((j + 0.5) / N) * 2 * extent;
        for (let i = 0; i < N; i++) {
          const x = -extent + ((i + 0.5) / N) * 2 * extent;
          qs.push([x * geom.e1[0] + y * geom.e2[0] + geom.off * geom.n[0], x * geom.e1[1] + y * geom.e2[1] + geom.off * geom.n[1], x * geom.e1[2] + y * geom.e2[2] + geom.off * geom.n[2]]);
        }
      }
      let counts: Uint16Array;
      if (mono && planKind === "scan") {
        counts = new Uint16Array(qs.length);
        const half = exp.scan.step / 2;
        const base = deferredBase.split(",").map(Number);
        for (const c of braggCrossings(model, scanAxis, base, { start: exp.scan.start - half, end: exp.scan.end + half }, I3, qs.map((h) => ({ h, family: 0 })), panels, lambdaMid)) if (c.hit) counts[c.index]!++;
      } else counts = pointCoverage(planOk.settings.map((a) => goniometerMatrix(model, a)), qs, panels, exp.lambdaMin, exp.lambdaMax);
      let max = 0;
      for (const c of counts) max = Math.max(max, c);
      const canvas = document.createElement("canvas");
      canvas.width = N;
      canvas.height = N;
      const ctx = canvas.getContext("2d")!;
      const img = ctx.createImageData(N, N);
      counts.forEach((c, k) => {
        if (!c) return;
        // Accent blue, darker with more settings recording the point.
        img.data.set([59, 110, 220, Math.round(255 * (0.18 + 0.5 * Math.min(1, c / Math.max(1, max))))], 4 * k);
      });
      ctx.putImageData(img, 0, 0);
      if (alive) {
        setCovImage({ key: covKey, href: canvas.toDataURL("image/png"), max });
        setCovBusy(false);
      }
    }, 40);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [covKey, showCoverage, planOk]);
  const coverage = covImage && covImage.key === covKey ? covImage : null;

  // ---------------------------------------------------------------- selection and "find a setting"
  const sel = selected !== null ? points[selected] : undefined;
  const selObs = sim.obs.find((o) => o.index === selected);
  const [findNote, setFindNote] = useState<string | null>(null);
  useEffect(() => setFindNote(null), [selected]);
  const findSetting = () => {
    if (!sel) return;
    const h = sel.h;
    let best: { angles: readonly number[]; score: number; panel: string } | undefined;
    const consider = (angles: readonly number[], lambda: number, hit: { col: number; row: number; panel: number; name: string }) => {
      const p = panels[hit.panel]!;
      const off = Math.hypot((hit.col - 0.5) / p.nCols - 0.5, (hit.row - 0.5) / p.nRows - 0.5);
      const score = Math.abs(lambda - lambdaMid) / (exp.lambdaMax - exp.lambdaMin || 1) + off;
      if (!best || score < best.score) best = { angles, score, panel: hit.name };
    };
    try {
      if (mono) {
        const k = free[0]!.i;
        const ax = axes[k]!;
        for (const c of braggCrossings(model, k, exp.angles, { start: ax.min, end: Math.min(ax.max, ax.min + 360) - 1e-9 }, viewUB, [{ h, family: 0 }], panels, lambdaMid))
          if (c.hit) consider(exp.angles.map((v, i) => (i === k ? c.angle : v)), lambdaMid, c.hit);
      } else for (const p of reflectionCoverage(model, exp.angles, viewUB, [{ h }], panels, exp.lambdaMin, exp.lambdaMax, free.length > 1 ? 2 : 1).points) consider(p.angles, p.lambda, p.hit);
    } catch (e) {
      setFindNote((e as Error).message);
      return;
    }
    if (!best) {
      setFindNote(`(${hklText(h)}) cannot be recorded with this goniometer and band.`);
      return;
    }
    onExp({ ...exp, angles: best.angles.map((v) => Number(v.toFixed(2))) });
    setFindNote(`Goniometer set: (${hklText(h)}) now lands near the middle of ${best.panel}.${planKind === "list" ? " Add this setting to the list to keep it." : ""}`);
  };

  // Scan presets: the instrument's full-volume scan, or a rocking scan about the current angle (within the limits).
  const fullPlan = instrument.plan?.kind === "scan" ? instrument.plan : { start: 0, end: 357, step: 3 };
  const [rockHalf, setRockHalf] = useState(15);
  // A full-turn axis wraps (−15° is 345°); a narrower range is a hard limit.
  const clampAxis = (v: number) => {
    const ax = axes[scanAxis]!;
    return ax.max - ax.min >= 360 ? v : Math.min(ax.max, Math.max(ax.min, v));
  };
  const fullVolume = () => {
    const ax = axes[scanAxis]!;
    const start = Math.max(fullPlan.start, ax.min);
    const end = Math.min(fullPlan.end, ax.max - (ax.max - ax.min >= 360 && fullPlan.end >= ax.max ? fullPlan.step : 0));
    onExp({ ...exp, scan: { ...exp.scan, axis: scanAxis, start, end, step: fullPlan.step } });
  };
  const rocking = () => {
    const c = exp.angles[scanAxis] ?? 0;
    onExp({ ...exp, scan: { ...exp.scan, axis: scanAxis, start: Number(clampAxis(c - rockHalf).toFixed(2)), end: Number(clampAxis(c + rockHalf).toFixed(2)) } });
  };
  const addCurrent = () => onExp({ ...exp, orientations: [...exp.orientations, exp.angles.map((v) => Number(v.toFixed(2)))] });
  const [fillN, setFillN] = useState(10);
  const fillEven = () => {
    const k = free[0]!.i;
    const ax = axes[k]!;
    const span = Math.min(ax.max - ax.min, 360);
    const n = Math.max(1, Math.round(fillN));
    const step = span >= 360 ? span / n : span / Math.max(1, n - 1);
    onExp({ ...exp, orientations: Array.from({ length: n }, (_, j) => exp.angles.map((v, i) => (i === k ? Number((ax.min + j * step).toFixed(2)) : v))) });
  };

  // ---------------------------------------------------------------- wanted reflections and suggested settings
  const wantedTargets = useMemo(
    () =>
      exp.wanted.map((h, k) => {
        const i = points.findIndex((p) => p.h[0] === h[0] && p.h[1] === h[1] && p.h[2] === h[2]);
        const q = mulVec(viewUB, h as Vec3);
        const d = 1 / Math.hypot(...q);
        if (i < 0) return { h: h as Vec3, d, index: undefined, family: -(k + 1), members: [h as Vec3] };
        const family = points[i]!.family;
        return { h: h as Vec3, d, index: i, family, members: points.filter((p) => p.family === family).map((p) => p.h as Vec3) };
      }),
    [exp.wanted, points, viewUB],
  );
  // Settings of the list that record each wanted reflection (any symmetry equivalent in the list).
  // Settings of the list that record each wanted reflection (any equivalent in the list), and that place it well.
  const wantedSeen = useMemo(
    () => (planKind !== "list" || !planOk ? wantedTargets.map(() => ({ recorded: 0, well: 0 })) : wantedStatus(model, planOk.settings, viewUB, wantedTargets.map((t) => t.members), panels, exp.lambdaMin, exp.lambdaMax, exp.placement)),
    [wantedTargets, planKind, planOk, model, viewUB, panels, exp.lambdaMin, exp.lambdaMax, exp.placement],
  );
  const addWanted = (h: readonly number[]) => {
    if (exp.wanted.some((w) => w[0] === h[0] && w[1] === h[1] && w[2] === h[2])) return;
    onExp({ ...exp, wanted: [...exp.wanted, [...h]] });
  };
  const [suggestN, setSuggestN] = useState(10);
  const [search, setSearch] = useState<{ done: number; total: number; cancel: () => void } | null>(null);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  // Stop a running search when the page closes (not on progress updates).
  const cancelSearch = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancelSearch.current?.(), []);
  const runSuggest = () => {
    const n = Math.max(1, Math.round(suggestN));
    const job = suggestPlan(
      {
        model,
        base: exp.angles,
        UB: viewUB,
        reflections: points.map((p) => ({ h: p.h as Vec3, family: p.family })),
        wanted: wantedTargets.map((t) => t.members),
        placement: exp.placement,
        existing: exp.orientations,
        panels,
        lambdaMin: exp.lambdaMin,
        lambdaMax: exp.lambdaMax,
        n,
      },
      (done, total) => setSearch((s) => (s ? { ...s, done, total } : s)),
    );
    setSuggestNote(null);
    cancelSearch.current = job.cancel;
    setSearch({ done: 0, total: 0, cancel: job.cancel });
    job.result.then(
      (res) => {
        cancelSearch.current = undefined;
        setSearch(null);
        onExp({ ...exp, orientations: [...exp.orientations, ...res.settings.map((a) => a.map((v) => Number(v.toFixed(2))))] });
        const wantedText = res.wantedTotal
          ? ` Wanted reflections: ${res.wellAfter} of ${res.wantedTotal} well placed${res.recordedAfter > res.wellAfter ? `, ${res.recordedAfter} recorded` : ""}${res.recordedBefore ? ` (${res.wellBefore} and ${res.recordedBefore} before)` : ""}.`
          : "";
        const full = res.picks.findIndex((p) => p.wellPlaced === 0 && p.wanted === 0 && p.families === 0);
        const redundancy = full >= 0 ? ` Every reachable family is recorded after ${full}; the other ${res.picks.length - full} add second and third recordings.` : "";
        const stopped = res.settings.length < n ? (full >= 0 ? ` Stopped after ${res.settings.length}: every reachable family is already recorded three times.` : ` Stopped after ${res.settings.length}: more settings would record nothing new with this goniometer and band.`) : "";
        setSuggestNote(`Added ${res.settings.length} setting${res.settings.length === 1 ? "" : "s"}, chosen from ${res.candidates.toLocaleString()} on a ${res.step}° grid of ${freeNames.join(", ")}.${wantedText}${redundancy}${stopped}`);
      },
      (e: Error) => {
        cancelSearch.current = undefined;
        setSearch(null);
        if (e.message !== "cancelled") setSuggestNote(e.message);
      },
    );
  };

  const freeNames = free.map(({ ax }) => ax.name);
  // ---------------------------------------------------------------- export
  const exportPlan = () => {
    if (!planOk) return;
    const col = (name: string) => ({ ω: "omega", χ: "chi", φ: "phi", ψ: "psi" })[name] ?? name;
    const lines = [
      `# NEXPLAN measurement plan (${planKind === "list" ? "orientation list" : "rotation scan"}); ${instrument.label}; ${new Date().toISOString()}`,
      `# structure ${result.structure.name || result.blockName} (data_${result.blockName}), input sha256 ${result.provenance.inputSha256}; d_min ${result.provenance.dMin} A`,
      `# orientation: ${fileUB ? (ub.fileName ?? "loaded UB") : "no UB loaded (U = I with the CIF cell)"}; lambda band ${lam(exp.lambdaMin)}-${lam(exp.lambdaMax)} A`,
      `# goniometer: ${axes.map((ax) => (ax.fixed !== undefined ? `${col(ax.name)} fixed at ${ax.fixed}` : `${col(ax.name)} ${ax.min} to ${ax.max} deg`)).join("; ")}`,
      "# a reflection is recorded when its Laue wavelength is in the band and k_f hits a panel; completeness over symmetry families",
      ["setting", ...axes.map((ax) => `${col(ax.name)}_deg`), "reflections_on_detectors", "families_cumulative", "completeness_pct"].join(","),
      ...planOk.steps.map((st, k) => [k + 1, ...axes.map((ax, i) => ax.fixed ?? st.angles[i] ?? 0), st.observed, Math.round(st.completeness * planOk.families), (100 * st.completeness).toFixed(2)].join(",")),
    ];
    if (planKind === "list" && wantedTargets.length) {
      lines.push(`# wanted reflections; well placed = lambda in the inner ${Math.round(exp.placement.bandFraction * 100)} % of the band and at least ${Math.round(exp.placement.edgeFraction * 100)} % of a panel from its edges`);
      lines.push("h,k,l,d_A,settings_recording,settings_well_placed");
      wantedTargets.forEach((t, k) => lines.push([...t.h, t.d.toFixed(4), wantedSeen[k]?.recorded ?? 0, wantedSeen[k]?.well ?? 0].join(",")));
    }
    downloadText(`${result.blockName}-${instrument.id}-plan.csv`, lines.join("\n") + "\n", "text/csv");
  };
  const outsideLimits = (angles: readonly number[]) => free.some(({ ax, i }) => angles[i]! < ax.min - 1e-9 || angles[i]! > ax.max + 1e-9);
  const nOutside = planKind === "list" ? exp.orientations.filter(outsideLimits).length : 0;
  return (
    <div className="ui-stack">
      <div className="ui-grid ui-grid--split">
        <Card
          title={planKind === "list" ? "Orientation list" : "Rotation scan"}
          meta={planOk ? `${planOk.steps.length} setting${planOk.steps.length === 1 ? "" : "s"} · ${fmt(100 * (planOk.steps.at(-1)?.completeness ?? 0), 1)} % of families` : undefined}
          actions={
            planOk && planOk.steps.length > 0 ? (
              <button type="button" className="ui-pill" onClick={exportPlan} title="The settings, what each records, and the wanted reflections, as CSV with the plan's provenance">
                Export CSV
              </button>
            ) : undefined
          }
          info={
            planKind === "list"
              ? "As TOPAZ is run: a short list of chosen orientations (about ten), each measured for a while. Add the current goniometer setting, use \"Find a setting\" to bring a wanted reflection onto a detector, fill the list evenly, or let Suggest pick settings: a greedy search over a grid of the free axes (within (1 − 1/e) of the best coverage; Nemhauser, Wolsey & Fisher 1978) that records the wanted reflections first, then the most new symmetry families, then second and third recordings (redundancy for scaling and absorption corrections), after the settings already listed. Completeness is the fraction of symmetry families (Friedel mates merged when the amplitudes are real) recorded by the list so far. A setting counts a reflection when its Laue wavelength is in the band and k_f hits a panel; detector gaps, masks and sample-environment shadows are not modelled."
              : mono
                ? "Rotate one axis through a range (the others stay where they are). With a monochromatic beam each reflection diffracts only where it crosses the Ewald sphere; those angles are solved exactly and binned into the steps, so nothing is missed between steps. Completeness is the fraction of symmetry families recorded so far. Click the chart to move the goniometer there."
                : "As CORELLI is run: a rocking or full-volume scan of one axis in fixed steps (3° by default); interleave adds the half-way steps, a second pass in between. Completeness is the fraction of symmetry families (Friedel mates merged when the amplitudes are real) recorded so far. Click the chart to move the goniometer there."
          }
        >
          {planKind === "list" ? (
            <>
              <div className="plan-step">
                <div className="wanted-head">
                  <span className="plan-step__title">
                    <span className="plan-step__n">1</span> Wanted reflections
                  </span>
                  <HklAdder onAdd={addWanted} />
                </div>
                {wantedTargets.length === 0 ? (
                  <p className="empty-note">The peaks this measurement is for: type them, or use "Add to wanted" on a reflection picked in the slice below.</p>
                ) : (
                  <div className="wanted-list">
                    {wantedTargets.map((t, k) => {
                      const { recorded: seen, well } = wantedSeen[k] ?? { recorded: 0, well: 0 };
                      const unreachable = t.d < exp.lambdaMin / 2;
                      return (
                        <span
                          key={t.h.join(",")}
                          className={cx("ui-chip", well > 0 ? "ui-chip--success" : unreachable ? "ui-chip--danger" : "ui-chip--warn", t.index !== undefined && "is-clickable")}
                          title={`(${hklText(t.h)}) d ${fmt(t.d, 4)} Å${t.index === undefined ? " · not in the reflection list (absent, weak or beyond d_min): targeted as this exact hkl" : ` · any of its ${t.members.length} symmetry equivalents counts`}${unreachable ? ` · d < λmin/2 = ${fmt(exp.lambdaMin / 2, 3)} Å: no setting can record it` : ""}${seen ? ` · recorded by ${seen} setting${seen === 1 ? "" : "s"}, well placed (mid band, away from panel edges) in ${well}` : ""}`}
                          onClick={() => {
                            if (t.index === undefined) return;
                            setSelected(t.index);
                            setLayer(t.h[plane.fixed]!);
                          }}
                        >
                          ({hklText(t.h)}) {seen > 0 ? (well > 0 ? `✓ ${well} well · ${seen}×` : `${seen}× · edge or band end`) : unreachable ? "unreachable" : "not recorded"}
                          <button
                            type="button"
                            className="chip-x"
                            aria-label={`Remove (${hklText(t.h)}) from the wanted reflections`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onExp({ ...exp, wanted: exp.wanted.filter((_, j) => j !== k) });
                            }}
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="plan-step">
                <div className="wanted-head">
                  <span className="plan-step__title">
                    <span className="plan-step__n">2</span> Settings
                  </span>
                  <span className="ui-controls ui-controls--inline">
                    <UnitField label="Number of settings to suggest" value={suggestN} unit="settings" min={1} max={40} width="4ch" onCommit={setSuggestN} />
                    {search ? (
                      <>
                        <span className="dim-note">Searching{search.total ? ` ${Math.round((100 * search.done) / search.total)} %` : "…"}</span>
                        <button type="button" className="ui-pill" onClick={() => search.cancel()}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className="ui-btn-brand" onClick={runSuggest} title="Search a grid of goniometer settings for the ones that place the wanted reflections well first, then record the most new families, then add redundancy; they are added after the settings already in the list">
                        {exp.orientations.length ? "Suggest more" : "Suggest settings"}
                      </button>
                    )}
                  </span>
                </div>
                <div className="ui-controls ui-controls--inline placement-row" title="A recording of a wanted reflection is well placed when its wavelength is near the middle of the band and it lands away from the panel edges. Suggest places wanted reflections well first.">
                  <span className="dim-note">Well placed: λ in the inner</span>
                  <UnitField label="Inner fraction of the band counted as mid band" value={Math.round(exp.placement.bandFraction * 100)} unit="%" min={5} max={100} width="3.5ch" onCommit={(v) => onExp({ ...exp, placement: { ...exp.placement, bandFraction: v / 100 } })} />
                  <span className="dim-note">of the band, at least</span>
                  <UnitField label="Margin from the panel edges, as a fraction of the panel" value={Math.round(exp.placement.edgeFraction * 100)} unit="%" min={0} max={45} width="3.5ch" onCommit={(v) => onExp({ ...exp, placement: { ...exp.placement, edgeFraction: v / 100 } })} />
                  <span className="dim-note">of a panel from its edges</span>
                </div>
                {suggestNote && <p className="empty-note">{suggestNote}</p>}
                <div className="ui-controls ui-controls--inline plan-manual">
                  <span className="dim-note">By hand:</span>
                  <button type="button" className="ui-pill" onClick={addCurrent} title="Add the goniometer setting shown on the right">
                    Add current setting
                  </button>
                  <span className="ui-control">
                    <UnitField label="Number of evenly spaced settings" value={fillN} unit={`× ${free[0]!.ax.name}`} min={1} max={72} width="4ch" onCommit={setFillN} />
                    <button type="button" className="ui-pill" onClick={fillEven}>
                      Fill evenly
                    </button>
                  </span>
                  {exp.orientations.length > 0 && (
                    <button type="button" className="ui-pill" onClick={() => onExp({ ...exp, orientations: [] })}>
                      Clear list
                    </button>
                  )}
                </div>
              </div>
              {"error" in plan ? (
                <p className="error-note">{plan.error}</p>
              ) : exp.orientations.length === 0 ? (
                <p className="empty-note">No settings yet: suggest them, or add them by hand.</p>
              ) : (
                <div className="ui-table-wrap" style={{ maxHeight: "20rem" }}>
                  <table className="ui-table">
                    <thead>
                      <tr>
                        <th className="left">#</th>
                        {freeNames.map((n) => (
                          <th key={n}>{n} (°)</th>
                        ))}
                        <th>On detectors</th>
                        <th>Families so far</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {plan.steps.map((s, k) => (
                        <tr key={k} className={cx("is-clickable", outsideLimits(s.angles) && "is-warn")} title={outsideLimits(s.angles) ? "Outside the goniometer limits" : "Set the goniometer to this setting"} onClick={() => onExp({ ...exp, angles: [...s.angles] })}>
                          <th>{k + 1}</th>
                          {free.map(({ i }) => (
                            <td key={i}>{fmt(s.angles[i]!, 1)}</td>
                          ))}
                          <td>{s.observed.toLocaleString()}</td>
                          <td>{fmt(100 * s.completeness, 1)} %</td>
                          <td>
                            <button
                              type="button"
                              className="ui-pill"
                              aria-label={`Remove setting ${k + 1}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onExp({ ...exp, orientations: exp.orientations.filter((_, j) => j !== k) });
                              }}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="ui-controls ui-controls--inline">
                <span className="ui-control">
                  <span className="ui-control-label">Axis</span>
                  <select className="ui-select" aria-label="Scan axis" value={scanAxis} onChange={(e) => onExp({ ...exp, scan: { ...exp.scan, axis: Number(e.target.value) } })}>
                    {free.map(({ ax, i }) => (
                      <option key={i} value={i}>
                        {ax.name}
                      </option>
                    ))}
                  </select>
                </span>
                <span className="ui-control">
                  <span className="ui-control-label">From</span>
                  <UnitField label="Scan start" value={exp.scan.start} unit="°" width="4.5ch" onCommit={(v) => onExp({ ...exp, scan: { ...exp.scan, start: v } })} />
                  <span className="ui-control-label">to</span>
                  <UnitField label="Scan end" value={exp.scan.end} unit="°" width="4.5ch" onCommit={(v) => onExp({ ...exp, scan: { ...exp.scan, end: v } })} />
                  <span className="ui-control-label">step</span>
                  <UnitField label="Scan step" value={exp.scan.step} unit="°" min={0.1} width="3.5ch" onCommit={(v) => onExp({ ...exp, scan: { ...exp.scan, step: v } })} />
                </span>
                {!mono && (
                  <label className="ui-check" title="A second pass at the half-way angles">
                    <input type="checkbox" checked={exp.scan.interleave ?? false} onChange={(e) => onExp({ ...exp, scan: { ...exp.scan, interleave: e.target.checked } })} /> Interleave
                  </label>
                )}
              </div>
              <div className="ui-controls ui-controls--inline scan-presets">
                <span className="ui-control-label">Presets</span>
                <button type="button" className="ui-pill" onClick={fullVolume} title="The instrument's usual full-volume scan, within the goniometer limits">
                  Full volume ({fullPlan.start}–{fullPlan.end}°, {fullPlan.step}°)
                </button>
                <span className="ui-control">
                  <button type="button" className="ui-pill" onClick={rocking} title="A rocking scan about the current angle, with the current step">
                    Rocking ±{rockHalf}° about {axes[scanAxis]!.name} = {fmt(exp.angles[scanAxis] ?? 0, 1)}°
                  </button>
                  <UnitField label="Rocking half-range" value={rockHalf} unit="°" min={1} max={180} width="3ch" onCommit={setRockHalf} />
                </span>
              </div>
              {"error" in plan ? (
                <p className="error-note">{plan.error}</p>
              ) : (
                <>
                  <ScanChart steps={plan.steps} axisIndex={scanAxis} axisName={axes[scanAxis]!.name} current={exp.angles[scanAxis] ?? 0} onPick={(a) => onExp({ ...exp, angles: exp.angles.map((v, i) => (i === scanAxis ? a : v)) })} />
                </>
              )}
            </>
          )}
          {planOk && (
            <p className="plot-hint">
              {planOk.observedFamilies.toLocaleString()} of {planOk.families.toLocaleString()} families recorded
              {planOk.steps.length ? (reach90 ? `; 90 % after ${planOk.steps.indexOf(reach90) + 1} setting${planOk.steps.indexOf(reach90) ? "s" : ""}` : "; 90 % is not reached") : ""}
              {twice !== undefined && planOk.families ? `; ${fmt((100 * twice) / planOk.families, 0)} % in two or more settings` : ""}.
              {nOutside > 0 && <span className="warn-inline"> {nOutside} listed setting{nOutside === 1 ? " is" : "s are"} outside the goniometer limits.</span>}
            </p>
          )}
        </Card>

        <div className="ui-stack">
          <Card title="Goniometer" meta={instrument.label} info={`${model.note} ${instrument.source}`}>
            <div className="form-rows">
              <GoniometerControls axes={axes} angles={exp.angles} onAngles={(angles) => onExp({ ...exp, angles })} />
              <GoniometerLimits catalog={catalogGoniometer} exp={exp} onExp={onExp} />
            </div>
            <dl className="ui-stats ui-stats--three" style={{ marginTop: "0.6rem" }}>
              <div>
                <dt>On detectors now</dt>
                <dd>{sim.obs.length.toLocaleString()}</dd>
              </div>
              <div>
                <dt>In band</dt>
                <dd>{sim.inBand.toLocaleString()}</dd>
              </div>
              <div>
                <dt>λ band</dt>
                <dd>
                  {lam(exp.lambdaMin)}–{lam(exp.lambdaMax)} <small>Å</small>
                </dd>
              </div>
            </dl>
            {planKind === "list" && (
              <button type="button" className="ui-btn-brand" style={{ marginTop: "0.6rem" }} onClick={addCurrent}>
                Add this setting to the list
              </button>
            )}
            <p className="empty-note">
              {fileUB ? `Orientation from ${ub.fileName ?? "the loaded UB"}. ` : "No UB loaded: U = I with the CIF cell. "}
              <button type="button" className="ui-link" onClick={onOpenOrientation}>
                {fileUB ? "Change it on the Orientation page" : "Load an orientation on the Orientation page"}
              </button>
              .
            </p>
            <DMinNote result={result} info={info} lambdaMin={exp.lambdaMin} onDMin={onDMin} />
          </Card>
        </div>
      </div>

      <div className="ui-grid ui-grid--split">
        <Card
          title="Reciprocal slice"
          meta={`${plane.label.replace("L", String(layer))} · ${slicePoints.length} reflections${covBusy ? " · shading…" : ""}`}
          info="One reciprocal-lattice plane in the sample frame, in 1/Å without 2π, true to the cell metric. Shaded: the points of the plane that the plan records (darker = more settings). Markers: coloured by λ = on a detector at the current goniometer setting; dark = recorded somewhere in the plan; hollow = never recorded. Marker area follows |F|². The dashed circle is d_min: reflections outside it are not calculated. Click a reflection to select it."
          actions={
            <>
              <Segmented label="Plane" value={planeId} onChange={setPlaneId} options={(Object.keys(PLANES) as PlaneId[]).map((id) => ({ value: id, label: PLANES[id].label.replace("L", "0").replace(/[()]/g, "").replace(/ /g, "") }))} />
              <span className="ui-control">
                <span className="ui-control-label">Layer</span>
                <UnitField label="Layer index" value={layer} unit="" width="3ch" onCommit={(v) => setLayer(Math.round(v))} />
              </span>
              <label className="ui-check">
                <input type="checkbox" checked={showCoverage} onChange={(e) => setShowCoverage(e.target.checked)} /> Coverage
              </label>
            </>
          }
        >
          <SliceChart
            points={slicePoints}
            extent={extent}
            coverage={showCoverage ? coverage?.href : undefined}
            selected={selected}
            onSelect={setSelected}
            lambdaMin={exp.lambdaMin}
            lambdaMax={exp.lambdaMax}
            xLabel={`along ${plane.axes[0]} (Å⁻¹)`}
            yLabel={`in plane, ⟂ ${plane.axes[0]} (Å⁻¹)`}
            limitRadius={limit}
            axes={[
              { x: dot(geom.a1, geom.e1), y: dot(geom.a1, geom.e2), label: plane.axes[0] },
              { x: dot(geom.a2, geom.e1), y: dot(geom.a2, geom.e2), label: plane.axes[1] },
            ]}
          />
          <p className="plot-hint slice-legend">
            <span className="slice-key is-now" /> on a detector now <span className="slice-key is-scan" /> recorded in the plan <span className="slice-key is-never" /> not recorded
            {coverage && <span className="dim-note"> · shading: settings recording each point (up to {coverage.max})</span>}
          </p>
        </Card>

        <div className="ui-stack">
          <Card title="Reflection" meta={sel ? `(${hklText(sel.h)})` : "click one in the slice"}>
            <div className="form-rows">
              <div className="form-row">
                <span className="ui-control-label">hkl</span>
                <HklField
                  value={sel ? sel.h : null}
                  onPick={(t) => {
                    const i = findHkl(points, t);
                    if (i === undefined) return false;
                    setSelected(i);
                    const p = points[i]!;
                    // Show its plane: the layer of the plane in view that contains it.
                    setLayer(p.h[plane.fixed]!);
                    return true;
                  }}
                />
              </div>
            </div>
            {sel ? (
              <>
                <dl className="ui-stats ui-stats--three" style={{ marginTop: "0.6rem" }}>
                  <div>
                    <dt>d</dt>
                    <dd>
                      {fmt(sel.d, 4)} <small>Å</small>
                    </dd>
                  </div>
                  <div>
                    <dt>|F|²</dt>
                    <dd>{sel.f2.toPrecision(4)}</dd>
                  </div>
                  <div>
                    <dt>In the plan</dt>
                    <dd>{planOk?.measured.has(selected!) ? "recorded" : "not recorded"}</dd>
                  </div>
                </dl>
                <p className="selection-note">
                  {selObs
                    ? `Now on ${selObs.hit.name} (col ${fmt(selObs.hit.col, 0)}, row ${fmt(selObs.hit.row, 0)}) at λ ${fmt(selObs.lambda, 3)} Å, TOF ${fmt(tofOf(selObs), 0)} µs.`
                    : "Not on a detector at the current setting."}
                </p>
                <div className="ui-controls ui-controls--inline" style={{ marginTop: "0.5rem" }}>
                  <button type="button" className="ui-btn-brand" onClick={findSetting}>
                    Find a setting that records it
                  </button>
                  {planKind === "list" && (
                    <button type="button" className="ui-pill" disabled={exp.wanted.some((w) => w.every((v, i) => v === sel.h[i]))} onClick={() => addWanted(sel.h)}>
                      {exp.wanted.some((w) => w.every((v, i) => v === sel.h[i])) ? "Wanted" : "Add to wanted"}
                    </button>
                  )}
                </div>
                {findNote && <p className="empty-note">{findNote}</p>}
              </>
            ) : (
              <p className="empty-note">Pick a reflection in the slice or type its hkl, then "Find a setting" turns the goniometer so it lands near the middle of a panel at a mid-band wavelength.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/** "h k l" entry that adds to a list: any whole-number indices (absent or weak reflections can be wanted too). */
function HklAdder({ onAdd }: { onAdd: (h: number[]) => void }) {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  // Enter reads the field itself, so a keystroke not yet rendered is not lost.
  const commit = (raw = text) => {
    const v = raw.trim().split(/[\s,]+/).map(Number);
    if (v.length !== 3 || v.some((x) => !Number.isInteger(x)) || v.every((x) => x === 0)) return setBad(raw.trim() !== "");
    onAdd(v);
    setText("");
    setBad(false);
  };
  return (
    <span className="ui-controls ui-controls--inline">
      <span className={cx("ui-unit-field", bad && "is-invalid")} title="Miller indices, e.g. 1 1 3">
        <input className="ui-unit-field__input" aria-label="Wanted reflection h k l" placeholder="h k l" value={text} style={{ width: "7ch" }} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget.value)} />
        <span className="ui-unit-field__unit">hkl</span>
      </span>
      <button type="button" className="ui-pill" onClick={() => commit()}>
        Add
      </button>
    </span>
  );
}
