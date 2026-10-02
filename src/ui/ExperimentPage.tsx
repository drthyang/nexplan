/**
 * Experiment page (experimental builds only): simulations on real detector
 * geometry (src/core/instrument/simulate.ts).
 *
 *  - Single crystal (TOPAZ, CORELLI): the goniometer turns the crystal; spots
 *    land on the panels at the Laue wavelength of each reflection. 3D detector
 *    and reciprocal-space views, the unrolled detector map, a rotation scan
 *    with family completeness, and the reflections on the detectors.
 *  - Powder (NOMAD, POWGEN; sample fixed): which panels see which d-spacings
 *    for the wavelength band, the Debye–Scherrer rings on the detectors in a
 *    time-of-flight slice (src/core/instrument/powderRings.ts), and the
 *    simulated TOF pattern of one panel.
 */
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mulMat, mulVec } from "@materia/core/math/mat3";
import type { CalcSuccess } from "../app/compute.ts";
import { cwPeaks } from "../core/diffraction/powder.ts";
import { NEUTRON_MASS_OVER_H, synthesizeTof, tofPeaks, type TofBank } from "../core/diffraction/tof.ts";
import { rayHit, type DetectorHit } from "../core/instrument/detectors.ts";
import { elasticPattern, mapCells, ringProfile, ringTrace, type RingSlice } from "../core/instrument/powderRings.ts";
import { braggCrossings, coveredTwoTheta, crossingsToScan, dRangeAt, panelAngles, panelDifc, panelsSeeing, simulateScan, twoThetaRangeForD, type PanelAngles } from "../core/instrument/simulate.ts";
import { neutronWavelengthA } from "../core/physics/energy.ts";
import { goniometerMatrix, laueCondition } from "../core/ub/goniometer.ts";
import type { InstrumentPreset } from "../core/ub/instruments.ts";
import { EXPERIMENTAL_INSTRUMENTS } from "../core/ub/instrumentsExperimental.ts";
import { ANGLE_RAMP_CSS, angleCss, angleHex, INTENSITY_RAMP_CSS, LAMBDA_RAMP_CSS } from "../views/colormaps.ts";
import { Card, Segmented, UnitField } from "./components.tsx";
import { CoverageChart, type CoverageLine } from "./CoverageChart.tsx";
import { DetectorMap, type MapRing, type MapSpot } from "./DetectorMap.tsx";
import type { ExperimentState } from "./experimentState.ts";
import { fmt, hklText } from "./format.ts";
import { PowderPlot } from "./PowderPlot.tsx";
import { ScanChart } from "./ScanChart.tsx";
import { GoniometerControls } from "./UbPage.tsx";
import { flightPathRange, paintMap, paintPanels, panelGrids } from "./ringImages.ts";
import { presentReflections, useViewUB, type UbState } from "./ubShared.ts";

const InstrumentView = lazy(() => import("../views/InstrumentView.tsx").then((m) => ({ default: m.InstrumentView })));
const ReciprocalView = lazy(() => import("../views/ReciprocalView.tsx").then((m) => ({ default: m.ReciprocalView })));

interface PageProps {
  readonly result: CalcSuccess;
  readonly theme: "light" | "dark";
  readonly ub: UbState;
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

/** Wavelengths for display: four significant figures. */
const lam = (x: number) => Number(x.toPrecision(4));

const firstFreeAxis = (ins: InstrumentPreset) => Math.max(0, ins.goniometer.axes.findIndex((ax) => ax.fixed === undefined));

export function ExperimentPage(props: PageProps) {
  const { exp, onExp, result } = props;
  const instrument = EXPERIMENTAL_INSTRUMENTS.find((i) => i.id === exp.instrumentId) ?? EXPERIMENTAL_INSTRUMENTS[0]!;
  const panels = instrument.detectors ?? [];
  const info = useMemo(() => panels.map(panelAngles), [panels]);
  const modes = instrument.modes ?? ["single-crystal"];
  const sample = modes.includes(exp.sample) ? exp.sample : modes[0]!;
  const mono = instrument.incident;
  const choose = (id: string) => {
    const ins = EXPERIMENTAL_INSTRUMENTS.find((i) => i.id === id);
    if (!ins) return;
    const inc = ins.incident;
    const next = { ...exp, instrumentId: id, angles: ins.goniometer.axes.map((ax) => ax.fixed ?? 0), panel: null, scan: { ...exp.scan, axis: firstFreeAxis(ins) } };
    onExp(inc ? withEi(next, inc.eiMeV, inc.elasticFwhm) : { ...next, lambdaMin: ins.lambdaMin, lambdaMax: ins.lambdaMax });
  };

  // Shortest d any panel reaches: λmin / (2 sin θmax).
  const reach = exp.lambdaMin / (2 * Math.sin((Math.max(...info.map((a) => a.twoThetaMax)) * Math.PI) / 360));
  const dMin = result.provenance.dMin;
  const suggest = Math.max(0.3, Math.ceil(reach * 100) / 100);
  const groups: { label: string; list: readonly InstrumentPreset[] }[] = [
    { label: "Single-crystal diffractometers", list: EXPERIMENTAL_INSTRUMENTS.filter((i) => !i.incident && i.modes?.includes("single-crystal")) },
    { label: "Powder diffractometers", list: EXPERIMENTAL_INSTRUMENTS.filter((i) => !i.incident && i.modes?.includes("powder")) },
    { label: "Chopper spectrometers (elastic)", list: EXPERIMENTAL_INSTRUMENTS.filter((i) => i.incident) },
  ];
  const lambda0 = (exp.lambdaMin + exp.lambdaMax) / 2;

  const setup = (children: ReactNode) => (
    <Card
      title={
        <>
          Instrument <span className="ui-chip ui-chip--warn exp-chip">experimental</span>
        </>
      }
      meta={mono ? `${sample === "powder" ? "powder" : "single crystal"} · elastic, Ei ${Number(exp.eiMeV.toPrecision(6))} meV` : sample === "powder" ? "powder · sample fixed" : "single crystal · TOF Laue"}
      info={`${instrument.source} ${instrument.goniometer.note}`}
    >
      <div className="form-rows">
        <label className="form-row">
          <span className="ui-control-label">Instrument</span>
          <select className="ui-select" aria-label="Instrument" value={instrument.id} onChange={(e) => choose(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.list.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {modes.length > 1 && (
          <div className="form-row">
            <span className="ui-control-label">Sample</span>
            <Segmented label="Sample" value={sample} onChange={(v) => onExp({ ...exp, sample: v })} options={[{ value: "single-crystal", label: "Single crystal" }, { value: "powder", label: "Powder" }]} />
          </div>
        )}
        {mono ? (
          <>
            <div className="form-row">
              <span className="ui-control-label">
                <span className="sym">E</span>
                <sub>i</sub>
              </span>
              <UnitField label="Incident energy" value={Number(exp.eiMeV.toPrecision(6))} unit="meV" min={mono.eiMin} max={mono.eiMax} width="5ch" onCommit={(v) => onExp(withEi(exp, v, exp.eRes))} />
              <span className="dim-note">
                <span className="sym">λ</span> = {fmt(lambda0, 4)} Å
              </span>
            </div>
            <div className="form-row">
              <span className="ui-control-label">
                Δ<span className="sym">E</span>/<span className="sym">E</span>
              </span>
              <UnitField label="Elastic resolution (FWHM)" value={Number((100 * exp.eRes).toPrecision(6))} unit="%" min={0.01} max={50} width="4.5ch" onCommit={(v) => onExp(withEi(exp, exp.eiMeV, v / 100))} />
            </div>
          </>
        ) : (
          <div className="form-row">
            <span className="ui-control-label">
              <span className="sym">λ</span> band
            </span>
            <UnitField label="Minimum wavelength" value={exp.lambdaMin} unit="Å" min={0.05} width="5ch" onCommit={(v) => onExp({ ...exp, lambdaMin: Math.min(v, exp.lambdaMax - 0.01) })} />
            <UnitField label="Maximum wavelength" value={exp.lambdaMax} unit="Å" min={0.06} width="5ch" onCommit={(v) => onExp({ ...exp, lambdaMax: Math.max(v, exp.lambdaMin + 0.01) })} />
          </div>
        )}
        {children}
      </div>
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
  const key = `${instrument.id}-${sample}`;
  return sample === "powder" ? <PowderExperiment key={key} {...mode} /> : <SingleCrystalExperiment key={key} {...mode} />;
}

/** Ei (meV) and ΔE/E set the band: λ = √(81.8042/Ei), Δλ/λ = ΔE/(2E), split about λ. */
function withEi(exp: ExperimentState, eiMeV: number, eRes: number): ExperimentState {
  const lambda = neutronWavelengthA(eiMeV);
  const half = eRes / 4;
  return { ...exp, eiMeV, eRes, lambdaMin: lambda * (1 - half), lambdaMax: lambda * (1 + half) };
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
      if (instrument.incident) {
        // Monochromatic: exact Bragg crossings, binned into the scan steps (nothing is missed between steps).
        const half = exp.scan.step / 2;
        const crossings = braggCrossings(instrument.goniometer, scanAxis, base, { start: exp.scan.start - half, end: exp.scan.end + half }, viewUB, points, panels, (exp.lambdaMin + exp.lambdaMax) / 2);
        return crossingsToScan(crossings, points, scanAxis, base, exp.scan);
      }
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
      λ {lam(exp.lambdaMin)} Å <span className="lambda-ramp" style={{ background: LAMBDA_RAMP_CSS }} /> {lam(exp.lambdaMax)} Å
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
              ? instrument.incident
                ? "Lab frame, metres: sample at the origin, beam along +z (orange), up +y. Panels from the Mantid instrument definition. With a monochromatic beam only reflections within the elastic band (Δλ/λ = ΔE/2E) of the Ewald sphere diffract at one setting; each spot is where its scattered ray hits a panel. Rotate ψ (or run the scan) to bring others in. Click a spot to select the reflection, a panel to filter the table to it."
                : "Lab frame, metres: sample at the origin, beam along +z (orange), up +y. Panels from the Mantid instrument definition; each spot is where a reflection's scattered ray hits a panel, coloured by its Laue wavelength. Click a spot to select the reflection, a panel to filter the table to it."
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
          info={
            instrument.incident
              ? "Rotate one axis through a range (the other axes stay where they are). With a monochromatic beam each reflection diffracts only where it crosses the Ewald sphere; those angles are solved exactly (q_z = −λ|q|²/2 along the rotation) and binned into the steps, so nothing is missed between steps. Bars: reflections reaching a panel per step. Completeness is the fraction of symmetry families (Friedel mates merged when the amplitudes are real) seen so far. Click the chart to move the goniometer there."
              : "Step one goniometer axis through a range (the other axes stay where they are) and count, at each step, the reflections that land on a panel. Completeness is the fraction of symmetry families (Friedel mates merged when the amplitudes are real) with at least one member seen so far, over the families among the simulated reflections. Click the chart to move the goniometer to that step."
          }
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
  // Chopper spectrometers: monochromatic beam, elastic scattering at λ0 (an elastic 2θ pattern over the detectors).
  const mono = instrument.incident;
  const lambda0 = (exp.lambdaMin + exp.lambdaMax) / 2;
  const covered = useMemo(() => coveredTwoTheta(info), [info]);
  const peaks = useMemo(
    () =>
      mono
        ? cwPeaks(groups, { wavelength: lambda0, lorentz: true, polarization: { kind: "none" } }).filter((p) => covered.some(([a, b]) => p.twoTheta! >= a && p.twoTheta! <= b))
        : tofPeaks(groups, bank),
    [mono, groups, bank, lambda0, covered],
  );
  const profile = useMemo(
    () => (mono ? elasticPattern(peaks, Math.hypot(exp.dOverD, exp.eRes / 2), covered) : synthesizeTof(peaks, bank, { kind: "gaussian", dOverD: exp.dOverD }, axis)),
    [mono, peaks, bank, exp.dOverD, exp.eRes, covered, axis],
  );
  const peakSel = sel !== null ? peaks.findIndex((p) => p.d === groups[sel]!.d) : -1;

  // Powder rings in a time-of-flight slice: an element with flight path L sees λ = t/(K·L).
  const [display, setDisplay] = useState<"rings" | "angle">("rings");
  const ringsOn = display === "rings";
  const [sliceWidth, setSliceWidth] = useState(0.01);
  const [playing, setPlaying] = useState(false);
  const grids = useMemo(() => panelGrids(panels), [panels]);
  const [lMin, lMax] = useMemo(() => flightPathRange(grids, l1), [grids, l1]);
  const lNom = useMemo(() => l1 + [...info.map((a) => a.l2)].sort((a, b) => a - b)[Math.floor(info.length / 2)]!, [info, l1]);
  const tMin = NEUTRON_MASS_OVER_H * lMin * exp.lambdaMin;
  const tMax = NEUTRON_MASS_OVER_H * lMax * exp.lambdaMax;
  const [tofRaw, setTof] = useState(() => (NEUTRON_MASS_OVER_H * lNom * (exp.lambdaMin + exp.lambdaMax)) / 2);
  const tof = Math.min(tMax, Math.max(tMin, tofRaw));
  const lambdaNom = mono ? lambda0 : tof / (NEUTRON_MASS_OVER_H * lNom);
  useEffect(() => {
    if (!playing || mono) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 40) return;
      const dt = now - last;
      last = now;
      setTof((t) => {
        const next = Math.min(tMax, Math.max(tMin, t)) + ((tMax - tMin) * dt) / 12000;
        return next > tMax ? tMin : next;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, mono, tMin, tMax]);
  const slice = useMemo<RingSlice>(() => (mono ? { lambda: lambda0 } : { tof }), [mono, lambda0, tof]);
  const ringProf = useMemo(
    () => ringProfile(groups, mono ? "fixed" : "tof", Math.hypot(exp.dOverD, mono ? exp.eRes / 2 : sliceWidth)),
    [groups, mono, exp.dOverD, exp.eRes, sliceWidth],
  );
  const frame = useMemo(() => (ringsOn ? paintPanels(grids, ringProf, slice, l1) : undefined), [ringsOn, grids, ringProf, slice, l1]);
  const panelImages = frame?.images;
  const gain = frame?.gain ?? 1;
  const mapCache = useRef<{ key: string; cells: ReturnType<typeof mapCells> } | null>(null);
  const raster = useCallback(
    (w: number, h: number, nuMax: number) => {
      const key = `${w}x${h}x${nuMax}`;
      if (mapCache.current?.key !== key) mapCache.current = { key, cells: mapCells(panels, w, h, nuMax) };
      return paintMap(mapCache.current.cells, w, h, ringProf, slice, l1, gain);
    },
    [panels, ringProf, slice, l1, gain],
  );

  const g = sel !== null ? groups[sel] : undefined;
  const range = g ? twoThetaRangeForD(g.d, exp.lambdaMin, exp.lambdaMax) : undefined;
  const seeing = useMemo(() => (g ? new Set(panelsSeeing(g.d, info, exp.lambdaMin, exp.lambdaMax)) : undefined), [g, info, exp.lambdaMin, exp.lambdaMax]);
  const ringNow = g && ringsOn && lambdaNom / (2 * g.d) <= 1 ? (2 * Math.asin(lambdaNom / (2 * g.d)) * 180) / Math.PI : undefined;
  const rings = useMemo<MapRing[]>(() => (!ringsOn && range ? [range.min, range.max].filter((t) => t > 0.5 && t < 179.5).map((t) => ({ twoTheta: t, emphasis: true })) : []), [ringsOn, range?.min, range?.max]);
  // The selected reflection's ring in this slice, ray-traced onto the panels (independent of the images).
  const traces = useMemo(() => (ringsOn && g ? ringTrace(panels, l1, slice, g.d, 720).map((t) => t.points) : undefined), [ringsOn, g, panels, l1, slice]);
  const lines = useMemo<CoverageLine[]>(() => groups.map((x) => ({ d: x.d, weight: x.sumF2, label: x.families.map((f) => `(${hklText(f.hkl)})`).join(" + ") })), [groups]);
  const seen = dRangeAt(pa.twoThetaCenter, exp.lambdaMin, exp.lambdaMax);
  const pickPanel = (i: number) => onExp({ ...exp, panel: i });
  const label = (x: (typeof groups)[number]) => x.families.map((f) => `(${hklText(f.hkl)})`).join(" + ");
  const angleLegend = (
    <span className="lambda-legend">
      2θ 0° <span className="lambda-ramp" style={{ background: ANGLE_RAMP_CSS }} /> 180°
    </span>
  );
  const intensityLegend = (
    <span className="lambda-legend">
      0 <span className="lambda-ramp" style={{ background: INTENSITY_RAMP_CSS }} /> slice max <span className="dim-note">(√ scale)</span>
    </span>
  );
  const legend = ringsOn ? intensityLegend : angleLegend;

  return (
    <div className="ui-stack">
      <div className="ui-grid ui-grid--split">
        <Card
          title="Detectors"
          meta={g ? `${seeing!.size} of ${panels.length} panels see ${label(g)}` : ringsOn ? (mono ? `elastic powder rings at λ = ${fmt(lambda0, 4)} Å` : `powder rings at t = ${fmt(tof, 0)} µs`) : `${panels.length} panels · coloured by 2θ`}
          info={
            ringsOn && mono
              ? "Elastic Debye–Scherrer rings at the incident wavelength λ = √(81.804/Ei): each ring is one d-spacing at 2θ = 2 asin(λ/2d), wherever it crosses a panel. Intensity per unit solid angle ∝ Σ|F|²/sin³θ (the CW powder Lorentz factor per unit ring length), each line a Gaussian of FWHM √((Δd/d)² + (ΔE/2E)²) in d. Click a panel for its details."
              : ringsOn
              ? "Debye–Scherrer rings on the panels in a time-of-flight slice. At time t an element with flight path L = L1 + L2 records λ = t/(252.778·L) and so d = λ/(2 sinθ); each ring is one d-spacing, and the rings move outwards as t grows. Intensity per unit solid angle ∝ Σ|F|²·d⁴·sinθ (GSAS-II TOF Lorentz factor, incident spectrum normalised out), each line a Gaussian of FWHM √((Δd/d)² + (Δt/t)²) in d. Play sweeps t through the band. Click a panel to simulate its pattern."
              : "Lab frame, metres: sample at the origin, beam along +z (orange), up +y. Panels from the Mantid instrument definition, coloured by the 2θ of their centre. Select a reflection (in the coverage chart or the pattern) to see which panels record it; click a panel to simulate its pattern."
          }
          className="viewer-card"
          actions={<Segmented label="Panel colouring" value={display} onChange={setDisplay} options={[{ value: "rings", label: "Powder rings" }, { value: "angle", label: "2θ" }]} />}
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
              {...(panelImages ? { panelImages } : {})}
              {...(traces ? { traces } : {})}
              {...(seeing ? { highlight: seeing } : {})}
              selectedPanel={panel}
              onPanelClick={pickPanel}
              summary={`${instrument.goniometer.label}: ${panels.length} panels, 2θ ${fmt(Math.min(...info.map((a) => a.twoThetaMin)), 1)}–${fmt(Math.max(...info.map((a) => a.twoThetaMax)), 1)}°`}
              legend={legend}
            />
          </Suspense>
          {ringsOn && mono && (
            <p className="selection-note">
              Elastic line: <span className="sym">E</span>
              <sub>i</sub> = {Number(exp.eiMeV.toPrecision(6))} meV, <span className="sym">λ</span> = {fmt(lambda0, 4)} Å; the rings do not move with time-of-flight.
            </p>
          )}
          {ringsOn && !mono && (
            <div className="ring-controls">
              <button type="button" className="ui-pill" onClick={() => setPlaying((v) => !v)} aria-pressed={playing}>
                {playing ? "Pause" : "Play"}
              </button>
              <span className="ui-control-label">TOF</span>
              <input
                type="range"
                className="ui-range"
                min={tMin}
                max={tMax}
                step={(tMax - tMin) / 2000}
                value={tof}
                aria-label="Time-of-flight slice"
                onChange={(e) => {
                  setPlaying(false);
                  setTof(Number(e.target.value));
                }}
              />
              <span>
                {fmt(tof, 0)} µs · <span className="sym">λ</span> {fmt(tof / (NEUTRON_MASS_OVER_H * lMax), 3)}–{fmt(tof / (NEUTRON_MASS_OVER_H * lMin), 3)} Å
              </span>
            </div>
          )}
          {g && range && (
            <p className="selection-note">
              <b>{label(g)}</b> d {fmt(g.d, 5)} Å · diffracts at 2θ {fmt(range.min, 1)}–{fmt(range.max, 1)}° for λ {lam(exp.lambdaMin)}–{lam(exp.lambdaMax)} Å · seen by {seeing!.size} of {panels.length} panels
              {ringsOn && <span className="dim">{ringNow !== undefined ? (mono ? ` · its ring is at 2θ = ${fmt(ringNow, 2)}°` : ` · in this slice its ring is at 2θ ≈ ${fmt(ringNow, 1)}° (L = ${fmt(lNom, 2)} m)`) : mono ? " · no ring (λ > 2d)" : " · no ring in this slice (λ > 2d)"}</span>}
            </p>
          )}
        </Card>

        <div className="ui-stack">
          {setup(
            <>
              <div className="form-row">
                <span className="ui-control-label">
                  Δ<span className="sym">d</span>/<span className="sym">d</span>
                </span>
                <UnitField label="Relative resolution (FWHM)" value={Number((100 * exp.dOverD).toPrecision(6))} unit="%" min={0.01} max={20} width="4.5ch" onCommit={(v) => onExp({ ...exp, dOverD: v / 100 })} />
              </div>
              {ringsOn && !mono && (
                <div className="form-row">
                  <span className="ui-control-label">
                    Slice Δ<span className="sym">t</span>/<span className="sym">t</span>
                  </span>
                  <UnitField label="Time slice width (relative)" value={Number((100 * sliceWidth).toPrecision(6))} unit="%" min={0.01} max={20} width="4.5ch" onCommit={(v) => setSliceWidth(v / 100)} />
                </div>
              )}
            </>,
          )}
          <Card
            title="Selected panel"
            meta={panels[panel]!.name}
            info={
              mono
                ? "Geometry of the selected panel; the elastic pattern below covers every panel."
                : "The simulated pattern treats the panel as one bank at its centre: DIFC = 252.778·(L1 + L2)·2 sinθ µs/Å (no DIFA, ZERO). Real banks are calibrated, and their resolution varies with angle; Δd/d sets a constant Gaussian width."
            }
          >
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
              {mono ? (
                <>
                  <div>
                    <dt>Elastic TOF</dt>
                    <dd>
                      {fmt(NEUTRON_MASS_OVER_H * (l1 + pa.l2) * lambda0, 0)} <small>µs</small>
                    </dd>
                  </div>
                  <div>
                    <dt>d range</dt>
                    <dd>
                      {fmt(lambda0 / (2 * Math.sin((pa.twoThetaMax * Math.PI) / 360)), 3)}–{fmt(lambda0 / (2 * Math.sin((pa.twoThetaMin * Math.PI) / 360)), 2)} <small>Å</small>
                    </dd>
                  </div>
                  <div>
                    <dt>Rings</dt>
                    <dd>{peaks.filter((x) => x.twoTheta! >= pa.twoThetaMin && x.twoTheta! <= pa.twoThetaMax).length}</dd>
                  </div>
                </>
              ) : (
                <>
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
                </>
              )}
            </dl>
            <p className="empty-note">
              {mono
                ? `Elastic neutrons reach this panel ${fmt(NEUTRON_MASS_OVER_H * (l1 + pa.l2) * lambda0, 0)} µs after leaving the moderator (L1 + L2 at its centre).`
                : `TOF window ${fmt(bank.difc * seen.dMin, 0)}–${fmt(bank.difc * seen.dMax, 0)} µs at the panel centre.`}
            </p>
          </Card>
        </div>
      </div>

      <Card
        title="Detector map"
        meta={ringsOn ? (g ? "red: the selected reflection's ring, ray-traced" : mono ? `elastic powder rings at λ = ${fmt(lambda0, 4)} Å` : `powder rings at t = ${fmt(tof, 0)} µs`) : g ? "bold curves: where the selected reflection can land" : "unrolled about the vertical axis"}
        info={
          ringsOn
            ? "Panels projected onto a cylinder around the sample (γ horizontal angle from the beam, ν elevation), painted with the powder rings of the current time-of-flight slice. Dashed curves are cones of constant 2θ. The red curve is the selected reflection's ring traced independently by ray casting (solving t = 252.778·(L1 + L2)·2d·sinθ along each azimuth); it should run along a bright ring. Click a panel to simulate its pattern."
            : "Panels projected onto a cylinder around the sample (γ horizontal angle from the beam, ν elevation), coloured by 2θ. Dashed curves are cones of constant 2θ. With a reflection selected, the bold cones bound the 2θ range where it diffracts for the band, and only the panels that record it stay bright. Click a panel to simulate its pattern."
        }
      >
        <DetectorMap panels={panels} panelColors={colorsCss} {...(seeing ? { highlight: seeing } : {})} selectedPanel={panel} onPanelClick={pickPanel} lambdaMin={exp.lambdaMin} lambdaMax={exp.lambdaMax} rings={rings} {...(ringsOn ? { raster } : {})} {...(traces ? { traces } : {})} />
        <p className="plot-hint">{legend}</p>
      </Card>

      <Card
        title={mono ? "Elastic powder pattern" : `Simulated pattern · ${panels[panel]!.name}`}
        meta={
          mono
            ? `λ ${fmt(lambda0, 4)} Å · 2θ ${fmt(covered[0]?.[0] ?? 0, 1)}–${fmt(covered.at(-1)?.[1] ?? 0, 1)}° · zero in detector gaps`
            : `2θ ${fmt(pa.twoThetaCenter, 2)}° · DIFC ${fmt(bank.difc, 1)} µs/Å · Δd/d ${Number((100 * exp.dOverD).toPrecision(6))} %`
        }
        info={
          mono
            ? "Elastic intensity per unit solid angle against 2θ over all panels, as a chopper spectrometer records it at the elastic line: I = Σ|F|²/(sin²θ cosθ) (CW powder Lorentz factor, no polarization for neutrons), each peak a Gaussian of FWHM 2·tanθ·√((Δd/d)² + (ΔE/2E)²); zero where no panel covers 2θ. Click a peak to select its reflection everywhere on the page."
            : "Neutron TOF pattern of the selected panel treated as one bank at its centre angle: I = Σ|F|²·sinθ·d⁴ (GSAS-II TOF Lorentz factor, incident spectrum normalised out), Gaussian peaks of constant Δd/d on a logarithmic TOF grid. Click a peak to select its reflection everywhere on the page."
        }
        actions={mono ? undefined : <Segmented label="Axis" value={axis} onChange={setAxis} options={[{ value: "tof", label: "TOF" }, { value: "d", label: "d" }]} />}
      >
        {peaks.length ? (
          <PowderPlot
            peaks={peaks}
            profile={profile}
            axis={mono ? "twoTheta" : axis}
            selected={peakSel >= 0 ? peakSel : null}
            onSelect={(i) => setSel(i === null ? null : (groupOfD.get(peaks[i]!.d) ?? null))}
            showSticks={false}
            marker={ringsOn && !mono ? (axis === "tof" ? tof : tof / bank.difc) : undefined}
          />
        ) : (
          <p className="empty-note">{mono ? "No reflection lands on the detectors at this Ei (or above d_min)." : `No reflections fall in this panel's d range (${fmt(seen.dMin, 3)}–${fmt(seen.dMax, 2)} Å) above d_min.`}</p>
        )}
      </Card>
      <Card
        title="d coverage"
        meta={`λ ${lam(exp.lambdaMin)}–${lam(exp.lambdaMax)} Å`}
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
          sliceLambda={ringsOn ? lambdaNom : undefined}
        />
      </Card>
    </div>
  );
}
