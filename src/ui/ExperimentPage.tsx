/**
 * Experiment page (experimental builds only): simulations on real detector
 * geometry (src/core/instrument/simulate.ts).
 *
 *  - Single crystal (TOPAZ, CORELLI): the goniometer turns the crystal; spots
 *    land on the panels at the Laue wavelength of each reflection. 3D detector
 *    and reciprocal-space views, the unrolled detector map, a rotation scan
 *    with family completeness, and the reflections on the detectors.
 *  - Powder (NOMAD, POWGEN; sample fixed): which panels see which d-spacings
 *    for the wavelength band, and the simulated TOF pattern of one panel.
 */
import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import { mulMat, mulVec } from "@materia/core/math/mat3";
import type { CalcSuccess } from "../app/compute.ts";
import { synthesizeTof, tofPeaks, type TofBank } from "../core/diffraction/tof.ts";
import { rayHit, type DetectorHit } from "../core/instrument/detectors.ts";
import { dRangeAt, panelAngles, panelDifc, panelsSeeing, simulateScan, twoThetaRangeForD, type PanelAngles } from "../core/instrument/simulate.ts";
import { goniometerMatrix, laueCondition } from "../core/ub/goniometer.ts";
import type { InstrumentPreset } from "../core/ub/instruments.ts";
import { EXPERIMENTAL_INSTRUMENTS } from "../core/ub/instrumentsExperimental.ts";
import { ANGLE_RAMP_CSS, angleCss, angleHex, LAMBDA_RAMP_CSS } from "../views/colormaps.ts";
import { Card, Segmented, UnitField } from "./components.tsx";
import { CoverageChart, type CoverageLine } from "./CoverageChart.tsx";
import { DetectorMap, type MapRing, type MapSpot } from "./DetectorMap.tsx";
import type { ExperimentState } from "./experimentState.ts";
import { fmt, hklText } from "./format.ts";
import { PowderPlot } from "./PowderPlot.tsx";
import { ScanChart } from "./ScanChart.tsx";
import { GoniometerControls } from "./UbPage.tsx";
import { presentReflections, useViewUB, type UbState } from "./ubShared.ts";

const InstrumentView = lazy(() => import("../views/InstrumentView.tsx").then((m) => ({ default: m.InstrumentView })));
const ReciprocalView = lazy(() => import("../views/ReciprocalView.tsx").then((m) => ({ default: m.ReciprocalView })));

interface PageProps {
  readonly result: CalcSuccess;
  readonly theme: "light" | "dark";
  readonly ub: UbState;
  readonly radiation: "xray" | "neutron";
  readonly onNeutron: () => void;
  readonly onDMin: (d: number) => void;
  readonly exp: ExperimentState;
  readonly onExp: (e: ExperimentState) => void;
}

interface ModeProps extends PageProps {
  readonly instrument: InstrumentPreset;
  readonly panels: NonNullable<InstrumentPreset["detectors"]>;
  readonly info: readonly PanelAngles[];
  readonly setup: (children: ReactNode) => ReactNode;
}

const firstFreeAxis = (ins: InstrumentPreset) => Math.max(0, ins.goniometer.axes.findIndex((ax) => ax.fixed === undefined));

export function ExperimentPage(props: PageProps) {
  const { exp, onExp, result } = props;
  const instrument = EXPERIMENTAL_INSTRUMENTS.find((i) => i.id === exp.instrumentId) ?? EXPERIMENTAL_INSTRUMENTS[0]!;
  const panels = instrument.detectors ?? [];
  const info = useMemo(() => panels.map(panelAngles), [panels]);
  const choose = (id: string) => {
    const ins = EXPERIMENTAL_INSTRUMENTS.find((i) => i.id === id);
    if (!ins) return;
    onExp({ ...exp, instrumentId: id, angles: ins.goniometer.axes.map((ax) => ax.fixed ?? 0), lambdaMin: ins.lambdaMin, lambdaMax: ins.lambdaMax, panel: null, scan: { ...exp.scan, axis: firstFreeAxis(ins) } });
  };

  // Shortest d any panel reaches: λmin / (2 sin θmax).
  const reach = exp.lambdaMin / (2 * Math.sin((Math.max(...info.map((a) => a.twoThetaMax)) * Math.PI) / 360));
  const dMin = result.provenance.dMin;
  const suggest = Math.max(0.3, Math.ceil(reach * 100) / 100);

  const setup = (children: ReactNode) => (
    <Card
      title={
        <>
          Instrument <span className="ui-chip ui-chip--warn exp-chip">experimental</span>
        </>
      }
      meta={instrument.mode === "powder" ? "powder · sample fixed" : "single crystal · TOF Laue"}
      info={`${instrument.source} ${instrument.goniometer.note}`}
    >
      <div className="form-rows">
        <label className="form-row">
          <span className="ui-control-label">Instrument</span>
          <select className="ui-select" aria-label="Instrument" value={instrument.id} onChange={(e) => choose(e.target.value)}>
            {(["single-crystal", "powder"] as const).map((mode) => (
              <optgroup key={mode} label={mode === "powder" ? "Powder" : "Single crystal"}>
                {EXPERIMENTAL_INSTRUMENTS.filter((i) => i.mode === mode).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="form-row">
          <span className="ui-control-label">
            <span className="sym">λ</span> band
          </span>
          <UnitField label="Minimum wavelength" value={exp.lambdaMin} unit="Å" min={0.05} width="5ch" onCommit={(v) => onExp({ ...exp, lambdaMin: Math.min(v, exp.lambdaMax - 0.01) })} />
          <UnitField label="Maximum wavelength" value={exp.lambdaMax} unit="Å" min={0.06} width="5ch" onCommit={(v) => onExp({ ...exp, lambdaMax: Math.max(v, exp.lambdaMin + 0.01) })} />
        </div>
        {children}
      </div>
      {props.radiation === "xray" && (
        <p className="warn-note">
          These are neutron instruments, but the structure factors are for X-rays.{" "}
          <button type="button" className="ui-pill" onClick={props.onNeutron}>
            Use neutrons
          </button>
        </p>
      )}
      {reach < dMin - 1e-9 && (
        <p className="warn-note">
          The detectors reach d = {fmt(reach, 3)} Å; reflections are calculated down to d_min = {dMin} Å only.{" "}
          {suggest < dMin && (
            <button type="button" className="ui-pill" onClick={() => props.onDMin(suggest)}>
              Use d_min = {suggest} Å
            </button>
          )}
        </p>
      )}
    </Card>
  );

  const mode: ModeProps = { ...props, instrument, panels, info, setup };
  return instrument.mode === "powder" ? <PowderExperiment key={instrument.id} {...mode} /> : <SingleCrystalExperiment key={instrument.id} {...mode} />;
}

/* ------------------------------------------------------------------ single crystal */

interface Observed {
  readonly index: number;
  readonly lambda: number;
  readonly twoTheta: number;
  readonly azimuth: number;
  readonly hit: DetectorHit;
}

function SingleCrystalExperiment({ result, theme, ub, exp, onExp, instrument, panels, setup }: ModeProps) {
  const { viewUB, fileUB } = useViewUB(result, ub);
  const points = useMemo(() => presentReflections(result), [result]);
  const [selected, setSelected] = useState<number | null>(null);
  const [panelFilter, setPanelFilter] = useState<number | null>(null);
  const [view, setView] = useState<"detectors" | "reciprocal">("detectors");
  useEffect(() => {
    setSelected(null);
    setPanelFilter(null);
  }, [points]);

  const axes = instrument.goniometer.axes;
  const R = useMemo(() => goniometerMatrix(instrument.goniometer, exp.angles), [instrument, exp.angles]);
  const sim = useMemo(() => {
    const RUB = mulMat(R, viewUB);
    const status = new Uint8Array(points.length);
    const lambdas = new Float64Array(points.length);
    const obs: Observed[] = [];
    points.forEach((p, i) => {
      const s = laueCondition(mulVec(RUB, p.h));
      lambdas[i] = s.lambda;
      if (!(s.lambda >= exp.lambdaMin && s.lambda <= exp.lambdaMax)) return;
      status[i] = 1;
      const hit = rayHit(panels, s.kf);
      if (!hit) return;
      status[i] = 2;
      obs.push({ index: i, lambda: s.lambda, twoTheta: s.twoTheta, azimuth: s.azimuth, hit });
    });
    return { status, lambdas, obs, inBand: status.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) };
  }, [R, viewUB, points, panels, exp.lambdaMin, exp.lambdaMax]);
  const families = useMemo(() => new Set(points.map((p) => p.family)).size, [points]);
  const familiesNow = useMemo(() => new Set(sim.obs.map((o) => points[o.index]!.family)).size, [sim, points]);
  const panelsHit = useMemo(() => new Set(sim.obs.map((o) => o.hit.panel)).size, [sim]);

  // Rotation scan: recomputed only when something other than the scanned axis changes.
  const free = axes.map((ax, i) => ({ ax, i })).filter(({ ax }) => ax.fixed === undefined);
  const scanAxis = free.some((f) => f.i === exp.scan.axis) ? exp.scan.axis : (free[0]?.i ?? 0);
  const baseKey = exp.angles.map((v, i) => (i === scanAxis ? 0 : v)).join(",");
  const deferredBase = useDeferredValue(baseKey);
  const scan = useMemo(() => {
    if (!free.length) return undefined;
    try {
      const base = deferredBase.split(",").map(Number);
      return simulateScan(instrument.goniometer, scanAxis, base, exp.scan, viewUB, points, panels, exp.lambdaMin, exp.lambdaMax);
    } catch (e) {
      return { error: (e as Error).message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredBase, scanAxis, exp.scan, instrument, viewUB, points, panels, exp.lambdaMin, exp.lambdaMax]);
  const reach90 = scan && "steps" in scan ? scan.steps.find((s) => s.completeness >= 0.9) : undefined;

  const spots3d = useMemo(() => sim.obs.map((o) => ({ index: o.index, position: o.hit.position, lambda: o.lambda, panel: o.hit.panel })), [sim]);
  const mapSpots = useMemo<MapSpot[]>(
    () => sim.obs.map((o) => ({ index: o.index, dir: o.hit.position, lambda: o.lambda, label: `(${hklText(points[o.index]!.h)}) λ ${fmt(o.lambda, 3)} Å · ${o.hit.name} col ${fmt(o.hit.col, 0)} row ${fmt(o.hit.row, 0)}` })),
    [sim, points],
  );
  const selObs = sim.obs.find((o) => o.index === selected);
  const sel = selected !== null ? points[selected] : undefined;
  const togglePanel = (i: number) => setPanelFilter((p) => (p === i ? null : i));
  const rows = useMemo(
    () =>
      sim.obs
        .filter((o) => panelFilter === null || o.hit.panel === panelFilter)
        .sort((a, b) => points[b.index]!.f2 - points[a.index]!.f2)
        .slice(0, 400),
    [sim, panelFilter, points],
  );
  const lambdaLegend = (
    <span className="lambda-legend">
      λ {exp.lambdaMin} Å <span className="lambda-ramp" style={{ background: LAMBDA_RAMP_CSS }} /> {exp.lambdaMax} Å
    </span>
  );

  return (
    <div className="ui-stack">
      <div className="ui-grid ui-grid--split">
        <Card
          title={view === "detectors" ? "Detectors" : "Reciprocal space"}
          meta={`${sim.obs.length.toLocaleString()} of ${points.length.toLocaleString()} reflections on the detectors`}
          info={
            view === "detectors"
              ? "Lab frame, metres: sample at the origin, beam along +z (orange), up +y. Panels from the Mantid instrument definition; each spot is where a reflection's scattered ray hits a panel, coloured by its Laue wavelength. Click a spot to select the reflection, a panel to filter the table to it."
              : "Reciprocal lattice in the lab frame (1/Å, no 2π) with the Ewald spheres for λmin and λmax. Coloured points diffract onto a detector; tan points diffract in the band but miss every panel; grey points do not diffract in the band."
          }
          className="viewer-card"
          actions={<Segmented label="View" value={view} onChange={setView} options={[{ value: "detectors", label: "Detectors" }, { value: "reciprocal", label: "Reciprocal space" }]} />}
        >
          <Suspense fallback={<p className="empty-note">Loading the 3D view…</p>}>
            {view === "detectors" ? (
              <InstrumentView
                panels={panels}
                spots={spots3d}
                lambdaMin={exp.lambdaMin}
                lambdaMax={exp.lambdaMax}
                selected={selected}
                onSelect={setSelected}
                theme={theme}
                fileStem={result.blockName}
                instrumentName={instrument.goniometer.label}
                selectedPanel={selObs?.hit.panel ?? panelFilter}
                onPanelClick={togglePanel}
                legend={lambdaLegend}
              />
            ) : (
              <ReciprocalView
                UB={viewUB}
                R={R}
                qSign={1}
                lambdaMin={exp.lambdaMin}
                lambdaMax={exp.lambdaMax}
                points={points}
                frame="lab"
                selected={selected}
                onSelect={setSelected}
                theme={theme}
                showEwald
                fileStem={result.blockName}
                status={sim.status}
                lambdas={sim.lambdas}
                hasDetectors
              />
            )}
          </Suspense>
          {sel && (
            <p className="selection-note">
              <b>({hklText(sel.h)})</b> d {fmt(sel.d, 4)} Å · |F|² {sel.f2.toPrecision(4)} ·{" "}
              {selObs
                ? `λ ${fmt(selObs.lambda, 4)} Å, 2θ ${fmt(selObs.twoTheta, 2)}°, azimuth ${fmt(selObs.azimuth, 1)}° → ${selObs.hit.name}, col ${fmt(selObs.hit.col, 1)}, row ${fmt(selObs.hit.row, 1)}, L2 ${fmt(selObs.hit.l2, 4)} m`
                : sim.status[selected!] === 1
                  ? `diffracts at λ ${fmt(sim.lambdas[selected!]!, 4)} Å but misses every panel`
                  : "does not diffract in the band at this setting"}
            </p>
          )}
        </Card>

        <div className="ui-stack">
          {setup(
            <>
              <GoniometerControls axes={axes} angles={exp.angles} onAngles={(angles) => onExp({ ...exp, angles })} />
              <dl className="ui-stats ui-stats--three" style={{ marginTop: "0.4rem" }}>
                <div>
                  <dt>On detectors</dt>
                  <dd>
                    {sim.obs.length.toLocaleString()} <small>of {sim.inBand.toLocaleString()} in band</small>
                  </dd>
                </div>
                <div>
                  <dt>Families seen</dt>
                  <dd>
                    {familiesNow.toLocaleString()} <small>of {families.toLocaleString()}</small>
                  </dd>
                </div>
                <div>
                  <dt>Panels hit</dt>
                  <dd>
                    {panelsHit} <small>of {panels.length}</small>
                  </dd>
                </div>
              </dl>
              <p className="empty-note">
                {fileUB ? `Orientation from ${ub.fileName ?? "the loaded UB"}.` : "No UB loaded: U = I with the CIF cell. Load an ISAW UB on the UB matrix page."} The {points.length.toLocaleString()} strongest present reflections with d ≥ d_min are simulated.
              </p>
            </>,
          )}
        </div>
      </div>

      <Card
        title="Detector map"
        meta={panelFilter !== null ? `${panels[panelFilter]!.name} selected · click it again to clear` : `${panels.length} panels unrolled about the vertical axis`}
        info="Every panel projected onto a cylinder around the sample with its axis vertical: γ is the horizontal angle from the beam (positive towards +x), ν the elevation. Dashed curves are cones of constant 2θ (Debye–Scherrer rings). Hover a spot or panel for details; click a spot to select it, a panel to filter the table."
      >
        <DetectorMap panels={panels} spots={mapSpots} lambdaMin={exp.lambdaMin} lambdaMax={exp.lambdaMax} selected={selected} onSelect={setSelected} selectedPanel={selObs?.hit.panel ?? panelFilter} onPanelClick={togglePanel} />
        <p className="plot-hint">{lambdaLegend}</p>
      </Card>

      <div className="ui-grid ui-grid--split">
        <Card
          title="Rotation scan"
          meta={scan && "steps" in scan ? `${scan.steps.length} orientations · ${fmt(100 * (scan.steps.at(-1)?.completeness ?? 0), 1)} % complete` : undefined}
          info="Step one goniometer axis through a range (the other axes stay where they are) and count, at each step, the reflections that land on a panel. Completeness is the fraction of symmetry families (Friedel mates merged when the amplitudes are real) with at least one member seen so far, over the families among the simulated reflections. Click the chart to move the goniometer to that step."
        >
          {free.length === 0 ? (
            <p className="empty-note">This goniometer has no free axis.</p>
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
              </div>
              {scan && "error" in scan ? (
                <p className="error-note">{scan.error}</p>
              ) : scan ? (
                <>
                  <ScanChart
                    steps={scan.steps}
                    axisIndex={scanAxis}
                    axisName={axes[scanAxis]!.name}
                    current={exp.angles[scanAxis] ?? 0}
                    onPick={(a) => onExp({ ...exp, angles: exp.angles.map((v, i) => (i === scanAxis ? a : v)) })}
                  />
                  <p className="plot-hint">
                    {scan.observedFamilies.toLocaleString()} of {scan.families.toLocaleString()} families seen
                    {reach90 ? `; 90 % reached at ${axes[scanAxis]!.name} = ${fmt(reach90.angles[scanAxis]!, 1)}°` : "; 90 % is not reached in this range"}. Bars: reflections on the detectors per step; line: cumulative completeness.
                  </p>
                </>
              ) : null}
            </>
          )}
        </Card>

        <Card
          title="Reflections on the detectors"
          meta={`${(panelFilter === null ? sim.obs.length : rows.length).toLocaleString()}${panelFilter !== null ? ` on ${panels[panelFilter]!.name}` : ""} · strongest first`}
          actions={
            panelFilter !== null ? (
              <button type="button" className="ui-pill" onClick={() => setPanelFilter(null)}>
                All panels
              </button>
            ) : undefined
          }
          flush
        >
          <div className="ui-table-wrap" style={{ maxHeight: "26rem" }}>
            <table className="ui-table">
              <thead>
                <tr>
                  <th className="left">hkl</th>
                  <th>d (Å)</th>
                  <th>λ (Å)</th>
                  <th>2θ (°)</th>
                  <th className="left">Panel</th>
                  <th>col</th>
                  <th>row</th>
                  <th>|F|²</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const p = points[o.index]!;
                  return (
                    <tr key={o.index} className={`is-clickable${o.index === selected ? " is-selected" : ""}`} onClick={() => setSelected(o.index === selected ? null : o.index)}>
                      <th>({hklText(p.h)})</th>
                      <td>{fmt(p.d, 4)}</td>
                      <td>{fmt(o.lambda, 4)}</td>
                      <td>{fmt(o.twoTheta, 2)}</td>
                      <td className="left">{o.hit.name}</td>
                      <td>{fmt(o.hit.col, 1)}</td>
                      <td>{fmt(o.hit.row, 1)}</td>
                      <td>{p.f2.toPrecision(5)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ powder */

function PowderExperiment({ result, theme, exp, onExp, instrument, panels, info, setup }: ModeProps) {
  const l1 = instrument.l1 ?? 0;
  const colorsHex = useMemo(() => info.map((a) => angleHex(a.twoThetaCenter)), [info]);
  const colorsCss = useMemo(() => info.map((a) => angleCss(a.twoThetaCenter)), [info]);
  const groups = useMemo(() => {
    const max = Math.max(0, ...result.groups.map((g) => g.sumF2));
    return result.groups.filter((g) => g.sumF2 > 1e-9 * max);
  }, [result]);
  const groupOfD = useMemo(() => new Map(groups.map((g, i) => [g.d, i])), [groups]);
  const [sel, setSel] = useState<number | null>(null);
  const [axis, setAxis] = useState<"tof" | "d">("tof");
  useEffect(() => setSel(null), [groups]);

  const defaultPanel = useMemo(() => info.reduce((best, a, i) => (Math.abs(a.twoThetaCenter - 90) < Math.abs(info[best]!.twoThetaCenter - 90) ? i : best), 0), [info]);
  const panel = exp.panel !== null && exp.panel < panels.length ? exp.panel : defaultPanel;
  const pa = info[panel]!;
  const bank: TofBank = useMemo(
    () => ({ twoThetaDeg: pa.twoThetaCenter, difc: panelDifc(panels[panel]!, l1), difa: 0, zero: 0, lambdaMin: exp.lambdaMin, lambdaMax: exp.lambdaMax }),
    [pa, panels, panel, l1, exp.lambdaMin, exp.lambdaMax],
  );
  const peaks = useMemo(() => tofPeaks(groups, bank), [groups, bank]);
  const profile = useMemo(() => synthesizeTof(peaks, bank, { kind: "gaussian", dOverD: exp.dOverD }, axis), [peaks, bank, exp.dOverD, axis]);
  const peakSel = sel !== null ? peaks.findIndex((p) => p.d === groups[sel]!.d) : -1;

  const g = sel !== null ? groups[sel] : undefined;
  const range = g ? twoThetaRangeForD(g.d, exp.lambdaMin, exp.lambdaMax) : undefined;
  const seeing = useMemo(() => (g ? new Set(panelsSeeing(g.d, info, exp.lambdaMin, exp.lambdaMax)) : undefined), [g, info, exp.lambdaMin, exp.lambdaMax]);
  const rings = useMemo<MapRing[]>(() => (range ? [range.min, range.max].filter((t) => t > 0.5 && t < 179.5).map((t) => ({ twoTheta: t, emphasis: true })) : []), [range?.min, range?.max]);
  const lines = useMemo<CoverageLine[]>(() => groups.map((x) => ({ d: x.d, weight: x.sumF2, label: x.families.map((f) => `(${hklText(f.hkl)})`).join(" + ") })), [groups]);
  const seen = dRangeAt(pa.twoThetaCenter, exp.lambdaMin, exp.lambdaMax);
  const pickPanel = (i: number) => onExp({ ...exp, panel: i });
  const label = (x: (typeof groups)[number]) => x.families.map((f) => `(${hklText(f.hkl)})`).join(" + ");
  const angleLegend = (
    <span className="lambda-legend">
      2θ 0° <span className="lambda-ramp" style={{ background: ANGLE_RAMP_CSS }} /> 180°
    </span>
  );

  return (
    <div className="ui-stack">
      <div className="ui-grid ui-grid--split">
        <Card
          title="Detectors"
          meta={g ? `${seeing!.size} of ${panels.length} panels see ${label(g)}` : `${panels.length} panels · coloured by 2θ`}
          info="Lab frame, metres: sample at the origin, beam along +z (orange), up +y. Panels from the Mantid instrument definition, coloured by the 2θ of their centre. Select a reflection (in the coverage chart or the pattern) to see which panels record it; click a panel to simulate its pattern."
          className="viewer-card"
        >
          <Suspense fallback={<p className="empty-note">Loading the 3D view…</p>}>
            <InstrumentView
              panels={panels}
              lambdaMin={exp.lambdaMin}
              lambdaMax={exp.lambdaMax}
              selected={null}
              onSelect={() => setSel(null)}
              theme={theme}
              fileStem={result.blockName}
              instrumentName={instrument.goniometer.label}
              panelColors={colorsHex}
              {...(seeing ? { highlight: seeing } : {})}
              selectedPanel={panel}
              onPanelClick={pickPanel}
              summary={`${instrument.goniometer.label}: ${panels.length} panels, 2θ ${fmt(Math.min(...info.map((a) => a.twoThetaMin)), 1)}–${fmt(Math.max(...info.map((a) => a.twoThetaMax)), 1)}°`}
              legend={angleLegend}
            />
          </Suspense>
          {g && range && (
            <p className="selection-note">
              <b>{label(g)}</b> d {fmt(g.d, 5)} Å · diffracts at 2θ {fmt(range.min, 1)}–{fmt(range.max, 1)}° for λ {exp.lambdaMin}–{exp.lambdaMax} Å · seen by {seeing!.size} of {panels.length} panels
            </p>
          )}
        </Card>

        <div className="ui-stack">
          {setup(
            <div className="form-row">
              <span className="ui-control-label">
                Δ<span className="sym">d</span>/<span className="sym">d</span>
              </span>
              <UnitField label="Relative resolution (FWHM)" value={Number((100 * exp.dOverD).toPrecision(6))} unit="%" min={0.01} max={20} width="4.5ch" onCommit={(v) => onExp({ ...exp, dOverD: v / 100 })} />
            </div>,
          )}
          <Card title="Selected panel" meta={panels[panel]!.name} info="The simulated pattern treats the panel as one bank at its centre: DIFC = 252.778·(L1 + L2)·2 sinθ µs/Å (no DIFA, ZERO). Real banks are calibrated, and their resolution varies with angle; Δd/d sets a constant Gaussian width.">
            <dl className="ui-stats ui-stats--three">
              <div>
                <dt>2θ centre</dt>
                <dd>{fmt(pa.twoThetaCenter, 2)}°</dd>
              </div>
              <div>
                <dt>2θ span</dt>
                <dd>
                  {fmt(pa.twoThetaMin, 1)}–{fmt(pa.twoThetaMax, 1)}°
                </dd>
              </div>
              <div>
                <dt>L1 + L2</dt>
                <dd>
                  {fmt(l1 + pa.l2, 3)} <small>m</small>
                </dd>
              </div>
              <div>
                <dt>DIFC</dt>
                <dd>
                  {fmt(bank.difc, 1)} <small>µs/Å</small>
                </dd>
              </div>
              <div>
                <dt>d range</dt>
                <dd>
                  {fmt(seen.dMin, 3)}–{fmt(seen.dMax, 2)} <small>Å</small>
                </dd>
              </div>
              <div>
                <dt>Peaks</dt>
                <dd>{peaks.length.toLocaleString()}</dd>
              </div>
            </dl>
            <p className="empty-note">
              TOF window {fmt(bank.difc * seen.dMin, 0)}–{fmt(bank.difc * seen.dMax, 0)} µs at the panel centre.
            </p>
          </Card>
        </div>
      </div>

      <div className="ui-grid ui-grid--split">
        <Card
          title="d coverage"
          meta={`λ ${exp.lambdaMin}–${exp.lambdaMax} Å`}
          info="A detector at 2θ records d from λmin/(2 sinθ) to λmax/(2 sinθ): the shaded band, darker where panels are. Each reflection is a line over the 2θ range where it diffracts, darker when stronger (Σ|F|² over its equivalents). The strip below the axis shows each panel's 2θ span in its colour. Click a line to select a reflection, a panel in the strip to simulate it."
        >
          <CoverageChart
            lambdaMin={exp.lambdaMin}
            lambdaMax={exp.lambdaMax}
            panels={info}
            panelColors={colorsCss}
            lines={lines}
            selected={sel}
            onSelect={setSel}
            selectedPanel={panel}
            onPanelPick={pickPanel}
            dFloor={result.provenance.dMin}
          />
        </Card>
        <Card title="Detector map" meta={g ? "bold curves: where the selected reflection can land" : "unrolled about the vertical axis"} info="Panels projected onto a cylinder around the sample (γ horizontal angle from the beam, ν elevation), coloured by 2θ. Dashed curves are cones of constant 2θ. With a reflection selected, the bold cones bound the 2θ range where it diffracts for the band, and only the panels that record it stay bright. Click a panel to simulate its pattern.">
          <DetectorMap panels={panels} panelColors={colorsCss} {...(seeing ? { highlight: seeing } : {})} selectedPanel={panel} onPanelClick={pickPanel} lambdaMin={exp.lambdaMin} lambdaMax={exp.lambdaMax} rings={rings} />
          <p className="plot-hint">{angleLegend}</p>
        </Card>
      </div>

      <Card
        title={`Simulated pattern · ${panels[panel]!.name}`}
        meta={`2θ ${fmt(pa.twoThetaCenter, 2)}° · DIFC ${fmt(bank.difc, 1)} µs/Å · Δd/d ${Number((100 * exp.dOverD).toPrecision(6))} %`}
        info="Neutron TOF pattern of the selected panel treated as one bank at its centre angle: I = Σ|F|²·sinθ·d⁴ (GSAS-II TOF Lorentz factor, incident spectrum normalised out), Gaussian peaks of constant Δd/d on a logarithmic TOF grid. Click a peak to select its reflection everywhere on the page."
        actions={<Segmented label="Axis" value={axis} onChange={setAxis} options={[{ value: "tof", label: "TOF" }, { value: "d", label: "d" }]} />}
      >
        {peaks.length ? (
          <PowderPlot peaks={peaks} profile={profile} axis={axis} selected={peakSel >= 0 ? peakSel : null} onSelect={(i) => setSel(i === null ? null : (groupOfD.get(peaks[i]!.d) ?? null))} showSticks={false} />
        ) : (
          <p className="empty-note">No reflections fall in this panel's d range ({fmt(seen.dMin, 3)}–{fmt(seen.dMax, 2)} Å) above d_min.</p>
        )}
      </Card>
    </div>
  );
}
