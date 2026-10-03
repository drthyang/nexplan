/**
 * Detectors page (Simulation): the selected SNS instrument's detector geometry
 * (src/core/instrument/simulate.ts) with what lands on it.
 *
 *  - Single crystal: spots where reflections land at the current goniometer
 *    setting (coloured by Laue wavelength), or the exact coverage of one
 *    reflection over the goniometer ranges (coverage.ts); 3D and reciprocal
 *    views, the unrolled detector map, and the reflections on the panels.
 *  - Powder (sample fixed): Debye–Scherrer rings on the panels in a
 *    time-of-flight slice, or at the incident wavelength for chopper
 *    spectrometers (powderRings.ts); panels coloured by 2θ.
 * The rotation scan and reciprocal slices are on the Single-crystal page, the
 * patterns on the Powder page.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NEUTRON_MASS_OVER_H, tofFromWavelength } from "../core/diffraction/tof.ts";
import { coverageMapLambdas, coveragePanelLambdas, coverageSolver, type CoverageSolver } from "../core/instrument/coverage.ts";
import { mapCells, panelCells, ringProfile, ringTrace, type RingSlice } from "../core/instrument/powderRings.ts";
import { dRangeAt, panelDifc, panelsSeeing, twoThetaRangeForD, type PanelAngles } from "../core/instrument/simulate.ts";
import type { InstrumentPreset } from "../core/ub/instruments.ts";
import { ubFromU } from "../core/ub/ub.ts";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulVec } from "@materia/core/math/mat3";
import { ANGLE_RAMP_CSS, angleCss, angleHex, INTENSITY_RAMP_CSS, LAMBDA_RAMP_CSS } from "../views/colormaps.ts";
import { Card, Segmented } from "./components.tsx";
import { DetectorMap, type MapRing, type MapSpot } from "./DetectorMap.tsx";
import { fmt, hklText } from "./format.ts";
import { flightPathRange, paintLambdaMap, paintLambdaPanels, paintMap, paintPanels, panelGrids } from "./ringImages.ts";
import { DMinNote, defaultPanel, findHkl, HklField, InstrumentRequired, lam, useObservations, usePowderGroups, useSnsInstrument, type SimPageProps } from "./snsShared.tsx";
import { GoniometerControls } from "./UbPage.tsx";

const InstrumentView = lazy(() => import("../views/InstrumentView.tsx").then((m) => ({ default: m.InstrumentView })));
const ReciprocalView = lazy(() => import("../views/ReciprocalView.tsx").then((m) => ({ default: m.ReciprocalView })));

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

interface ModeProps extends SimPageProps {
  readonly instrument: InstrumentPreset;
  readonly panels: NonNullable<InstrumentPreset["detectors"]>;
  readonly info: readonly PanelAngles[];
  readonly l1: number;
}

export function DetectorsPage(props: SimPageProps) {
  const sns = useSnsInstrument(props.exp);
  if (!sns.instrument)
    return (
      <InstrumentRequired exp={props.exp} onExp={props.onExp} need="any" title="Choose an instrument">
        The Detectors page shows a real SNS detector array (from the Mantid instrument definition) with the spots, coverage or powder rings of this structure. Pick an instrument here or in the header.
      </InstrumentRequired>
    );
  const mode: ModeProps = { ...props, instrument: sns.instrument, panels: sns.panels, info: sns.info, l1: sns.l1 };
  const key = `${sns.instrument.id}-${sns.sample}`;
  return sns.sample === "powder" ? <PowderDetectors key={key} {...mode} /> : <CrystalDetectors key={key} {...mode} />;
}

/* ------------------------------------------------------------------ single crystal */

function CrystalDetectors({ result, theme, ub, exp, onExp, onDMin, onOpenOrientation, instrument, panels, info }: ModeProps) {
  const { viewUB, fileUB, points, R, sim, tofOf } = useObservations(result, ub, exp, instrument);
  const [selected, setSelected] = useState<number | null>(null);
  const [panelFilter, setPanelFilter] = useState<number | null>(null);
  const [view, setView] = useState<"detectors" | "reciprocal">("detectors");
  useEffect(() => {
    setSelected(null);
    setPanelFilter(null);
  }, [points]);
  const axes = instrument.goniometer.axes;
  const free = axes.map((ax, i) => ({ ax, i })).filter(({ ax }) => ax.fixed === undefined);
  const families = useMemo(() => new Set(points.map((p) => p.family)).size, [points]);
  const familiesNow = useMemo(() => new Set(sim.obs.map((o) => points[o.index]!.family)).size, [sim, points]);
  const panelsHit = useMemo(() => new Set(sim.obs.map((o) => o.hit.panel)).size, [sim]);

  const spots3d = useMemo(() => sim.obs.map((o) => ({ index: o.index, position: o.hit.position, lambda: o.lambda, panel: o.hit.panel })), [sim]);
  const mapSpots = useMemo<MapSpot[]>(
    () => sim.obs.map((o) => ({ index: o.index, dir: o.hit.position, lambda: o.lambda, label: `(${hklText(points[o.index]!.h)}) λ ${fmt(o.lambda, 3)} Å · TOF ${fmt(tofOf(o), 0)} µs · ${o.hit.name} col ${fmt(o.hit.col, 0)} row ${fmt(o.hit.row, 0)}` })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sim, points],
  );
  const selObs = sim.obs.find((o) => o.index === selected);
  const sel = selected !== null ? points[selected] : undefined;

  // Reflection coverage: every detector pixel the selected reflection (or its equivalents) can reach
  // as the free goniometer axes sweep their ranges, coloured by λ, solved exactly per pixel (coverage.ts).
  const [show, setShow] = useState<"spots" | "coverage">("spots");
  const [equivalents, setEquivalents] = useState(false);
  // Tagged with the reflection list and selection it was computed for, so a stale result is never shown.
  type Coverage = ({ solver: CoverageSolver; lambdas: Float32Array[]; targets: number } | { error: string }) & { readonly of: typeof points; readonly index: number };
  const [coverageState, setCoverage] = useState<Coverage | null>(null);
  const coverage = coverageState && coverageState.of === points && coverageState.index === selected && show === "coverage" ? coverageState : null;
  const [covBusy, setCovBusy] = useState(false);
  const grids = useMemo(() => panelGrids(panels), [panels]);
  useEffect(() => {
    if (show !== "coverage" || selected === null) {
      setCoverage(null);
      setCovBusy(false);
      return;
    }
    let alive = true;
    setCovBusy(true);
    const t = setTimeout(() => {
      const target = points[selected]!;
      const targets = equivalents ? points.filter((p) => p.family === target.family) : [target];
      try {
        const solver = coverageSolver(instrument.goniometer, viewUB, targets.map((p) => p.h), exp.lambdaMin, exp.lambdaMax);
        const lambdas = coveragePanelLambdas(panels, grids, solver);
        if (alive) setCoverage({ solver, lambdas, targets: targets.length, of: points, index: selected });
      } catch (e) {
        if (alive) setCoverage({ error: (e as Error).message, of: points, index: selected });
      }
      if (alive) setCovBusy(false);
    }, 30);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [show, selected, equivalents, points, instrument, viewUB, panels, grids, exp.lambdaMin, exp.lambdaMax]);
  const covOn = coverage !== null && "lambdas" in coverage && selected !== null;
  const covImages = useMemo(() => (covOn ? paintLambdaPanels(grids, (coverage as { lambdas: Float32Array[] }).lambdas, exp.lambdaMin, exp.lambdaMax) : undefined), [covOn, coverage, grids, exp.lambdaMin, exp.lambdaMax]);
  const mapCache = useRef<{ key: string; cells: ReturnType<typeof mapCells> } | null>(null);
  const covRaster = useCallback(
    (w: number, h: number, nuMax: number) => {
      if (!coverage || !("solver" in coverage)) return undefined;
      const key = `${w}x${h}x${nuMax}`;
      if (mapCache.current?.key !== key) mapCache.current = { key, cells: mapCells(panels, w, h, nuMax) };
      const panelOf = mapCache.current.cells.panel;
      return paintLambdaMap(panelOf, coverageMapLambdas(panelOf, w, h, nuMax, coverage.solver), w, h, exp.lambdaMin, exp.lambdaMax);
    },
    [coverage, panels, exp.lambdaMin, exp.lambdaMax],
  );
  // Bragg window: a spacing d lands only at 2 asin(λmin/2d) ≤ 2θ ≤ 2 asin(min(1, λmax/2d)), whatever the orientation.
  const covWindow = covOn ? twoThetaRangeForD(points[selected!]!.d, exp.lambdaMin, exp.lambdaMax) : undefined;
  const covRings = useMemo<MapRing[]>(() => (covWindow ? [covWindow.min, covWindow.max].filter((t) => t > 0.5 && t < 179.5).map((t) => ({ twoTheta: t, emphasis: true })) : []), [covWindow?.min, covWindow?.max]);
  const covStats = useMemo(() => {
    if (!covOn) return undefined;
    const lamArr = (coverage as { lambdas: Float32Array[] }).lambdas;
    const reached = lamArr.filter((l) => l.some((v) => !Number.isNaN(v))).length;
    let cells = 0;
    let inWindow = 0;
    grids.forEach((g, k) => {
      const tt = panelCells(panels[k]!, g.nx, g.ny).twoTheta;
      tt.forEach((t, c) => {
        if (covWindow && t >= covWindow.min && t <= covWindow.max) inWindow++;
        if (!Number.isNaN(lamArr[k]![c]!)) cells++;
      });
    });
    return { reached, fraction: inWindow ? cells / inWindow : 0 };
  }, [covOn, coverage, grids, panels, covWindow]);
  const sweep = free.map(({ ax }) => `${ax.name} ${ax.min}–${Math.min(ax.max, ax.min + 360)}°`).join(", ");
  const covStatus =
    selected === null
      ? "Select a reflection (type hkl, or pick it in the table, map or 3D view) to see everywhere it can be recorded."
      : covBusy
        ? "Calculating…"
        : coverage && "error" in coverage
          ? coverage.error
          : coverage && covStats
            ? `(${hklText(points[selected]!.h)}) d ${fmt(points[selected]!.d, 4)} Å${coverage.targets > 1 ? ` + ${coverage.targets - 1} equivalents` : ""}: reachable on ${covStats.reached} of ${panels.length} panels, ${fmt(100 * covStats.fraction, 1)} % of the detector pixels inside its Bragg window 2θ ${fmt(covWindow?.min ?? NaN, 1)}–${fmt(covWindow?.max ?? NaN, 1)}° · solved exactly for ${sweep}`
            : "";
  const pickHkl = (text: string) => {
    const i = findHkl(points, text);
    if (i === undefined) return false;
    setSelected(i);
    return true;
  };
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
          title={view === "detectors" ? `${instrument.goniometer.label} detectors` : "Reciprocal space"}
          meta={`${sim.obs.length.toLocaleString()} of ${points.length.toLocaleString()} reflections on the detectors`}
          info={
            view === "detectors"
              ? instrument.incident
                ? "Lab frame, metres: sample at the origin, beam along +z (orange), up +y. Panels from the Mantid instrument definition. With a monochromatic beam only reflections within the elastic band (Δλ/λ = ΔE/2E) of the Ewald sphere diffract at one setting; each spot is where its scattered ray hits a panel. Rotate ψ (or run the scan on the Single-crystal page) to bring others in. Click a spot to select the reflection, a panel to filter the table to it."
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
                spots={covOn ? [] : spots3d}
                lambdaMin={exp.lambdaMin}
                lambdaMax={exp.lambdaMax}
                selected={selected}
                onSelect={setSelected}
                theme={theme}
                fileStem={result.blockName}
                instrumentName={instrument.goniometer.label}
                selectedPanel={covOn ? null : (selObs?.hit.panel ?? panelFilter)}
                onPanelClick={togglePanel}
                legend={lambdaLegend}
                {...(covImages ? { panelImages: covImages, summary: `coverage of (${hklText(points[selected!]!.h)})${equivalents ? " and equivalents" : ""} over the goniometer range` } : {})}
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
          {view === "detectors" && (
            <div className="ring-controls">
              <Segmented label="Show on the detectors" value={show} onChange={setShow} options={[{ value: "spots", label: "Spots now" }, { value: "coverage", label: "Coverage" }]} />
              {show === "coverage" && (
                <>
                  <HklField value={sel ? sel.h : null} onPick={pickHkl} />
                  <label className="ui-check">
                    <input type="checkbox" checked={equivalents} onChange={(e) => setEquivalents(e.target.checked)} /> Equivalents
                  </label>
                </>
              )}
            </div>
          )}
          {view === "detectors" && show === "coverage" && <p className="selection-note dim-note">{covStatus}</p>}
          {sel && !(view === "detectors" && show === "coverage") && (
            <p className="selection-note">
              <b>({hklText(sel.h)})</b> d {fmt(sel.d, 4)} Å · |F|² {sel.f2.toPrecision(4)} ·{" "}
              {selObs
                ? `λ ${fmt(selObs.lambda, 4)} Å, TOF ${fmt(tofOf(selObs), 1)} µs, 2θ ${fmt(selObs.twoTheta, 2)}°, azimuth ${fmt(selObs.azimuth, 1)}° → ${selObs.hit.name}, col ${fmt(selObs.hit.col, 1)}, row ${fmt(selObs.hit.row, 1)}, L2 ${fmt(selObs.hit.l2, 4)} m`
                : sim.status[selected!] === 1
                  ? `diffracts at λ ${fmt(sim.lambdas[selected!]!, 4)} Å but misses every panel`
                  : "does not diffract in the band at this setting"}
            </p>
          )}
        </Card>

        <div className="ui-stack">
          <Card title="Goniometer" meta={instrument.label} info={`${instrument.goniometer.note} ${instrument.source}`}>
            <div className="form-rows">
              <GoniometerControls axes={axes} angles={exp.angles} onAngles={(angles) => onExp({ ...exp, angles })} />
            </div>
            <dl className="ui-stats ui-stats--three" style={{ marginTop: "0.6rem" }}>
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
              {fileUB ? `Orientation from ${ub.fileName ?? "the loaded UB"}. ` : "No UB loaded: U = I with the CIF cell. "}
              <button type="button" className="ui-link" onClick={onOpenOrientation}>
                {fileUB ? "Change it on the Orientation page" : "Load an orientation on the Orientation page"}
              </button>
              . The {points.length.toLocaleString()} strongest present reflections with d ≥ d_min are simulated.
            </p>
            <DMinNote result={result} info={info} lambdaMin={exp.lambdaMin} onDMin={onDMin} />
          </Card>
        </div>
      </div>

      <Card
        title="Detector map"
        meta={covOn ? `coverage of (${hklText(points[selected!]!.h)})${equivalents ? " and equivalents" : ""}, coloured by λ` : panelFilter !== null ? `${panels[panelFilter]!.name} selected · click it again to clear` : `${panels.length} panels unrolled about the vertical axis`}
        info={
          covOn
            ? "Every detector pixel the selected reflection (and its symmetry equivalents, if ticked) can reach as the free goniometer axes sweep their full ranges, coloured by the wavelength it is recorded at (λ = 2d sinθ at that pixel); grey where it never lands. Solved exactly per pixel: the pixel fixes the direction of q, and the goniometer angles that turn the reflection onto it are found in closed form and checked against the axis ranges. The red curves bound the Bragg window, 2 asin(λmin/2d) ≤ 2θ ≤ 2 asin(min(1, λmax/2d)): small-d reflections can reach most panels, large-d ones only a few at low angle. γ is the horizontal angle from the beam (positive towards +x), ν the elevation."
            : "Every panel projected onto a cylinder around the sample with its axis vertical: γ is the horizontal angle from the beam (positive towards +x), ν the elevation. Dashed curves are cones of constant 2θ (Debye–Scherrer rings). Hover a spot or panel for details; click a spot to select it, a panel to filter the table."
        }
      >
        <DetectorMap {...(covOn ? { raster: covRaster, rings: covRings } : {})} panels={panels} spots={covOn ? [] : mapSpots} lambdaMin={exp.lambdaMin} lambdaMax={exp.lambdaMax} selected={selected} onSelect={setSelected} selectedPanel={covOn ? null : (selObs?.hit.panel ?? panelFilter)} onPanelClick={togglePanel} />
        <p className="plot-hint">{lambdaLegend}</p>
      </Card>

      <Card
        title="Reflections on the detectors"
        info="At the current goniometer setting. TOF is the moderator-to-detector flight time t = 252.778 µs/(m·Å) × (L1 + L2) × λ, with L2 to the pixel the spot hits: the relation Mantid uses between TOF and wavelength, with no emission-time offset."
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
                <th>TOF (µs)</th>
                <th>2θ (°)</th>
                <th>azimuth (°)</th>
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
                    <td>{fmt(tofOf(o), 0)}</td>
                    <td>{fmt(o.twoTheta, 2)}</td>
                    <td>{fmt(o.azimuth, 1)}</td>
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
  );
}

/* ------------------------------------------------------------------ powder */

function PowderDetectors({ result, theme, exp, onExp, onDMin, instrument, panels, info, l1 }: ModeProps) {
  const colorsHex = useMemo(() => info.map((a) => angleHex(a.twoThetaCenter)), [info]);
  const colorsCss = useMemo(() => info.map((a) => angleCss(a.twoThetaCenter)), [info]);
  const { groups } = usePowderGroups(result);
  const cellUB = useMemo(() => ubFromU(IDENTITY, result.structure.cell), [result]);
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => setSel(null), [groups]);
  const panel = exp.panel !== null && exp.panel < panels.length ? exp.panel : defaultPanel(info);
  const pa = info[panel]!;
  const mono = instrument.incident;
  const lambda0 = (exp.lambdaMin + exp.lambdaMax) / 2;

  // Powder rings in a time-of-flight slice: an element with flight path L sees λ = t/(K·L);
  // at the incident wavelength for chopper spectrometers.
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
  const ringProf = useMemo(() => ringProfile(groups, mono ? "fixed" : "tof", Math.hypot(exp.dOverD, mono ? exp.eRes / 2 : sliceWidth)), [groups, mono, exp.dOverD, exp.eRes, sliceWidth]);
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
  const pickPanel = (i: number) => onExp({ ...exp, panel: i });
  const label = (x: (typeof groups)[number]) => x.families.map((f) => `(${hklText(f.hkl)})`).join(" + ");
  const pickHkl = (text: string) => {
    const v = text.trim().split(/[\s,]+/).map(Number);
    if (v.length !== 3 || v.some((x) => !Number.isInteger(x))) return false;
    // Any hkl: its spacing from the cell picks the d-group (equivalents and overlaps share one ring).
    const q = mulVec(cellUB, v as unknown as Vec3);
    const d = 1 / Math.hypot(...q);
    const i = groups.findIndex((gr) => Math.abs(gr.d - d) <= 1e-6 * d);
    if (i < 0) return false;
    setSel(i);
    return true;
  };
  const seen = dRangeAt(pa.twoThetaCenter, exp.lambdaMin, exp.lambdaMax);
  const difc = panelDifc(panels[panel]!, l1);
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
          title={`${instrument.goniometer.label} detectors`}
          meta={g ? `${seeing!.size} of ${panels.length} panels see ${label(g)}` : ringsOn ? (mono ? `elastic powder rings at λ = ${fmt(lambda0, 4)} Å` : `powder rings at t = ${fmt(tof, 0)} µs`) : `${panels.length} panels · coloured by 2θ`}
          info={
            ringsOn && mono
              ? "Elastic Debye–Scherrer rings at the incident wavelength λ = √(81.804/Ei): each ring is one d-spacing at 2θ = 2 asin(λ/2d), wherever it crosses a panel. Intensity per unit solid angle ∝ Σ|F|²/sin³θ (the CW powder Lorentz factor per unit ring length), each line a Gaussian of FWHM √((Δd/d)² + (ΔE/2E)²) in d. Click a panel for its details."
              : ringsOn
                ? "Debye–Scherrer rings on the panels in a time-of-flight slice. At time t an element with flight path L = L1 + L2 records λ = t/(252.778·L) and so d = λ/(2 sinθ); each ring is one d-spacing, and the rings move outwards as t grows. Intensity per unit solid angle ∝ Σ|F|²·d⁴·sinθ (GSAS-II TOF Lorentz factor, incident spectrum normalised out), each line a Gaussian of FWHM √((Δd/d)² + (Δt/t)²) in d. Play sweeps t through the band. Click a panel to pick it for the Powder page."
                : "Lab frame, metres: sample at the origin, beam along +z (orange), up +y. Panels from the Mantid instrument definition, coloured by the 2θ of their centre. Type an hkl to see which panels record it; click a panel to pick it for the Powder page."
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
          <div className="ring-controls">
            {ringsOn && !mono && (
              <>
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
              </>
            )}
            {ringsOn && mono && (
              <span>
                Elastic line: <span className="sym">E</span>
                <sub>i</sub> = {Number(exp.eiMeV.toPrecision(6))} meV, <span className="sym">λ</span> = {fmt(lambda0, 4)} Å
              </span>
            )}
            <span className="ring-controls__end">
              <HklField value={g ? g.families[0]!.hkl : null} onPick={pickHkl} />
              {g && (
                <button type="button" className="ui-pill" onClick={() => setSel(null)}>
                  Clear
                </button>
              )}
            </span>
          </div>
          {g && range && (
            <p className="selection-note">
              <b>{label(g)}</b> d {fmt(g.d, 5)} Å · diffracts at 2θ {fmt(range.min, 1)}–{fmt(range.max, 1)}° for λ {lam(exp.lambdaMin)}–{lam(exp.lambdaMax)} Å · seen by {seeing!.size} of {panels.length} panels
              {ringsOn && <span className="dim">{ringNow !== undefined ? (mono ? ` · its ring is at 2θ = ${fmt(ringNow, 2)}°` : ` · in this slice its ring is at 2θ ≈ ${fmt(ringNow, 1)}° (L = ${fmt(lNom, 2)} m)`) : mono ? " · no ring (λ > 2d)" : " · no ring in this slice (λ > 2d)"}</span>}
            </p>
          )}
        </Card>

        <div className="ui-stack">
          <Card title="Selected panel" meta={panels[panel]!.name} info={`Click a panel in the 3D view or the map to pick it; its pattern is on the Powder page. ${instrument.source}`}>
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
                      {fmt(tofFromWavelength(l1 + pa.l2, lambda0), 0)} <small>µs</small>
                    </dd>
                  </div>
                  <div>
                    <dt>d range</dt>
                    <dd>
                      {fmt(lambda0 / (2 * Math.sin((pa.twoThetaMax * Math.PI) / 360)), 3)}–{fmt(lambda0 / (2 * Math.sin((pa.twoThetaMin * Math.PI) / 360)), 2)} <small>Å</small>
                    </dd>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <dt>DIFC</dt>
                    <dd>
                      {fmt(difc, 1)} <small>µs/Å</small>
                    </dd>
                  </div>
                  <div>
                    <dt>d range</dt>
                    <dd>
                      {fmt(seen.dMin, 3)}–{fmt(seen.dMax, 2)} <small>Å</small>
                    </dd>
                  </div>
                </>
              )}
            </dl>
            {ringsOn && !mono && (
              <div className="form-row" style={{ marginTop: "0.6rem" }}>
                <span className="ui-control-label">
                  Slice Δ<span className="sym">t</span>/<span className="sym">t</span>
                </span>
                <input
                  className="ui-range"
                  type="range"
                  min={0.1}
                  max={5}
                  step={0.1}
                  value={100 * sliceWidth}
                  aria-label="Time slice width (relative)"
                  onChange={(e) => setSliceWidth(Number(e.target.value) / 100)}
                />
                <span className="dim-note">{fmt(100 * sliceWidth, 1)} %</span>
              </div>
            )}
            <DMinNote result={result} info={info} lambdaMin={exp.lambdaMin} onDMin={onDMin} />
          </Card>
        </div>
      </div>

      <Card
        title="Detector map"
        meta={ringsOn ? (g ? "red: the selected reflection's ring, ray-traced" : mono ? `elastic powder rings at λ = ${fmt(lambda0, 4)} Å` : `powder rings at t = ${fmt(tof, 0)} µs`) : g ? "bold curves: where the selected reflection can land" : "unrolled about the vertical axis"}
        info={
          ringsOn
            ? "Panels projected onto a cylinder around the sample (γ horizontal angle from the beam, ν elevation), painted with the powder rings of the current slice. Dashed curves are cones of constant 2θ. The red curve is the selected reflection's ring traced independently by ray casting (solving t = 252.778·(L1 + L2)·2d·sinθ along each azimuth); it runs along a bright ring. Click a panel to pick it."
            : "Panels projected onto a cylinder around the sample (γ horizontal angle from the beam, ν elevation), coloured by 2θ. Dashed curves are cones of constant 2θ. With a reflection selected, the bold cones bound the 2θ range where it diffracts for the band, and only the panels that record it stay bright. Click a panel to pick it."
        }
      >
        <DetectorMap panels={panels} panelColors={colorsCss} {...(seeing ? { highlight: seeing } : {})} selectedPanel={panel} onPanelClick={pickPanel} lambdaMin={exp.lambdaMin} lambdaMax={exp.lambdaMax} rings={rings} {...(ringsOn ? { raster } : {})} {...(traces ? { traces } : {})} />
        <p className="plot-hint">{legend}</p>
      </Card>
    </div>
  );
}
