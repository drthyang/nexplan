/**
 * Detectors page (Instrument): the selected SNS instrument's detector geometry
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
import { byHkl, byNumber, byText, SortTh, useSort } from "./sortable.tsx";
import { flightPathRange, paintAcceptanceMap, paintLambdaMap, paintLambdaPanels, paintMap, paintPanels, panelGrids } from "./ringImages.ts";
import { AcceptanceCard } from "./AcceptanceCard.tsx";
import type { Shadows } from "../core/instrument/acceptance.ts";
import type { Blocked, DetectorPanel } from "../core/instrument/detectors.ts";
import { DMinNote, DOverDField, defaultPanel, findHkl, GoniometerLimits, HklField, HklNotice, InstrumentRequired, lam, useHklPick, useObservations, usePowderGroups, useSnsInstrument, type SimPageProps } from "./snsShared.tsx";
import { familyMembers, orientationText, planeOf, PRESENT_CAP } from "./ubShared.ts";
import { PLANE_PRESETS, planeGeometry, planeTrace, zoneAxis } from "../core/ub/mount.ts";
import type { GoniometerModel } from "../core/ub/goniometer.ts";
import { GoniometerControls } from "./UbPage.tsx";

const InstrumentView = lazy(() => import("../views/InstrumentView.tsx").then((m) => ({ default: m.InstrumentView })));

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

type ObsKey = "hkl" | "d" | "lam" | "tof" | "tth" | "az" | "panel" | "col" | "row" | "f2";

interface ModeProps extends SimPageProps {
  readonly instrument: InstrumentPreset;
  /** Panels with the user's masks; `geometry` without them. */
  readonly panels: NonNullable<InstrumentPreset["detectors"]>;
  readonly geometry: readonly DetectorPanel[];
  readonly info: readonly PanelAngles[];
  readonly l1: number;
  readonly catalogGoniometer: GoniometerModel;
  /** The sample environment's shadows, and the directions they block at the current setting. */
  readonly shadows: Shadows | undefined;
  readonly blocked: Blocked | undefined;
}

/** The detector map's overlay of masked pixels and shadows (ringImages.ts paintAcceptanceMap), with the geometry raster cached. */
function useAcceptanceOverlay(geometry: readonly DetectorPanel[], panels: readonly DetectorPanel[], blocked: Blocked | undefined, theme: "light" | "dark") {
  const cache = useRef<{ key: string; of: readonly DetectorPanel[]; cells: ReturnType<typeof mapCells> } | null>(null);
  return useCallback(
    (w: number, h: number, nuMax: number) => {
      if (!blocked && !panels.some((p) => p.off || p.mask)) return undefined;
      const key = `${w}x${h}x${nuMax}`;
      if (cache.current?.key !== key || cache.current.of !== geometry) cache.current = { key, of: geometry, cells: mapCells(geometry, w, h, nuMax) };
      return paintAcceptanceMap(cache.current.cells, panels, w, h, nuMax, blocked, theme);
    },
    [geometry, panels, blocked, theme],
  );
}

/** Panels that record anything: all of them, or undefined when none is switched off (for the views' highlight). */
const panelsOn = (panels: readonly DetectorPanel[]) => (panels.some((p) => p.off) ? new Set(panels.flatMap((p, i) => (p.off ? [] : [i]))) : undefined);

export function DetectorsPage(props: SimPageProps) {
  const sns = useSnsInstrument(props.exp);
  if (!sns.instrument)
    return (
      <InstrumentRequired exp={props.exp} onExp={props.onExp} need="any" title="Choose an instrument">
        The Detectors page shows a real SNS detector array (from the Mantid instrument definition) with the spots, coverage or powder rings of this structure. Pick an instrument here or in the header.
      </InstrumentRequired>
    );
  const mode: ModeProps = { ...props, instrument: sns.instrument, catalogGoniometer: sns.catalogGoniometer!, panels: sns.panels, geometry: sns.geometry, info: sns.info, l1: sns.l1, shadows: sns.shadows, blocked: sns.blocked };
  const key = `${sns.instrument.id}-${sns.sample}`;
  return sns.sample === "powder" ? <PowderDetectors key={key} {...mode} /> : <CrystalDetectors key={key} {...mode} />;
}

/* ------------------------------------------------------------------ single crystal */

function CrystalDetectors({ result, theme, ub, exp, onExp, onDMin, onOpenOrientation, instrument, catalogGoniometer, panels, geometry, info, shadows, blocked }: ModeProps) {
  const { viewUB, fileUB, points, sim, tofOf, R } = useObservations(result, ub, exp, instrument, blocked);
  // The scattering plane (Orientation page): where it is at this setting, and where its reflections land.
  const plane = planeOf(ub);
  const [showPlane, setShowPlane] = useState(true);
  const planeGeo = useMemo(() => (plane ? planeGeometry(viewUB, R, plane) : undefined), [plane, viewUB, R]);
  const planeName = plane ? (PLANE_PRESETS.find((p) => p.plane.u.every((x, i) => x === plane.u[i]) && p.plane.v.every((x, i) => x === plane.v[i]))?.label ?? `u (${hklText(plane.u)}), v (${hklText(plane.v)})`) : "";
  const plane3d = useMemo(() => (plane && planeGeo && showPlane ? { normal: planeGeo.normal, uDir: planeGeo.uDir, vDir: planeGeo.vDir, uLabel: `(${hklText(plane.u)})`, vLabel: `(${hklText(plane.v)})` } : undefined), [plane, planeGeo, showPlane]);
  const planeDirs = useMemo(() => (planeGeo && showPlane ? planeTrace(planeGeo.normal) : undefined), [planeGeo, showPlane]);
  const [selected, setSelected] = useState<number | null>(null);
  const [panelFilter, setPanelFilter] = useState<number | null>(null);
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
  const hkl = useHklPick(result, (text) => findHkl(points, text), setSelected, selected, PRESENT_CAP);
  // What the coverage is for: a listed reflection, or a typed one the list leaves out (forbidden, |F| ≈ 0,
  // past the cap, below d_min), simulated on request: its position needs no |F|.
  const target = useMemo((): { h: Vec3; d: number; family?: number | undefined } | undefined => (hkl.probe ? { h: hkl.probe.hkl as unknown as Vec3, d: hkl.probe.d!, family: hkl.probe.family } : sel ? { h: sel.h as Vec3, d: sel.d, family: sel.family } : undefined), [hkl.probe, sel]);
  const targetKey = target ? target.h.join(" ") : null;

  // Reflection coverage: every detector pixel the selected reflection (or its equivalents) can reach
  // as the free goniometer axes sweep their ranges, coloured by λ, solved exactly per pixel (coverage.ts).
  const [show, setShow] = useState<"spots" | "coverage">("spots");
  const [equivalents, setEquivalents] = useState(false);
  // Tagged with the reflection list and selection it was computed for, so a stale result is never shown.
  type Coverage = ({ solver: CoverageSolver; lambdas: Float32Array[]; targets: number } | { error: string }) & { readonly of: typeof points; readonly key: string };
  const [coverageState, setCoverage] = useState<Coverage | null>(null);
  const coverage = coverageState && coverageState.of === points && coverageState.key === targetKey && show === "coverage" ? coverageState : null;
  const [covBusy, setCovBusy] = useState(false);
  const grids = useMemo(() => panelGrids(panels), [panels]);
  useEffect(() => {
    if (show !== "coverage" || !target || targetKey === null) {
      setCoverage(null);
      setCovBusy(false);
      return;
    }
    let alive = true;
    setCovBusy(true);
    const t = setTimeout(() => {
      // Equivalents of a listed reflection from the list; of a typed one from the calculation (absent ones too).
      const hs: Vec3[] = !equivalents
        ? [target.h]
        : !hkl.probe
          ? points.filter((p) => p.family === target.family).map((p) => p.h as Vec3)
          : target.family !== undefined
            ? (familyMembers(result, target.family) as Vec3[])
            : [target.h];
      try {
        const solver = coverageSolver(instrument.goniometer, viewUB, hs, exp.lambdaMin, exp.lambdaMax, shadows);
        const lambdas = coveragePanelLambdas(panels, grids, solver);
        if (alive) setCoverage({ solver, lambdas, targets: hs.length, of: points, key: targetKey });
      } catch (e) {
        if (alive) setCoverage({ error: (e as Error).message, of: points, key: targetKey });
      }
      if (alive) setCovBusy(false);
    }, 30);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, target, equivalents, points, instrument, viewUB, panels, grids, exp.lambdaMin, exp.lambdaMax, shadows]);
  const covOn = coverage !== null && "lambdas" in coverage && target !== undefined;
  const covImages = useMemo(() => (covOn ? paintLambdaPanels(grids, (coverage as { lambdas: Float32Array[] }).lambdas, exp.lambdaMin, exp.lambdaMax) : undefined), [covOn, coverage, grids, exp.lambdaMin, exp.lambdaMax]);
  const mapCache = useRef<{ key: string; of: readonly DetectorPanel[]; cells: ReturnType<typeof mapCells> } | null>(null);
  const covRaster = useCallback(
    (w: number, h: number, nuMax: number) => {
      if (!coverage || !("solver" in coverage)) return undefined;
      const key = `${w}x${h}x${nuMax}`;
      // Masked cells drop out here; the solver handles the shadows (those on a stage depend on its angles).
      if (mapCache.current?.key !== key || mapCache.current.of !== panels) mapCache.current = { key, of: panels, cells: mapCells(panels, w, h, nuMax) };
      const panelOf = mapCache.current.cells.panel;
      return paintLambdaMap(panelOf, coverageMapLambdas(panelOf, w, h, nuMax, coverage.solver), w, h, exp.lambdaMin, exp.lambdaMax);
    },
    [coverage, panels, exp.lambdaMin, exp.lambdaMax],
  );
  // Bragg window: a spacing d lands only at 2 asin(λmin/2d) ≤ 2θ ≤ 2 asin(min(1, λmax/2d)), whatever the orientation.
  const covWindow = covOn ? twoThetaRangeForD(target!.d, exp.lambdaMin, exp.lambdaMax) : undefined;
  const covRings = useMemo<MapRing[]>(() => (covWindow ? [covWindow.min, covWindow.max].filter((t) => t > 0.5 && t < 179.5).map((t) => ({ twoTheta: t, emphasis: true })) : []), [covWindow?.min, covWindow?.max]);
  const covStats = useMemo(() => {
    if (!covOn) return undefined;
    const lamArr = (coverage as { lambdas: Float32Array[] }).lambdas;
    const reached = lamArr.filter((l) => l.some((v) => !Number.isNaN(v))).length;
    let cells = 0;
    let inWindow = 0;
    // The window counts every pixel inside it, masked or shadowed too, so the fraction shows what they cost.
    grids.forEach((g, k) => {
      const tt = panelCells(geometry[k]!, g.nx, g.ny).twoTheta;
      tt.forEach((t, c) => {
        if (covWindow && t >= covWindow.min && t <= covWindow.max) inWindow++;
        if (!Number.isNaN(lamArr[k]![c]!)) cells++;
      });
    });
    return { reached, fraction: inWindow ? cells / inWindow : 0 };
  }, [covOn, coverage, grids, geometry, covWindow]);
  const sweep = free.map(({ ax }) => `${ax.name} ${ax.min}–${Math.min(ax.max, ax.min + 360)}°`).join(", ");
  // Reaching no panel leaves the map blank: said as a warning, not in the dim status line.
  const covNone = !covBusy && coverage !== null && covStats !== undefined && covStats.reached === 0;
  const covStatus =
    !target
      ? "Select a reflection (type hkl, or pick it in the table, map or 3D view) to see everywhere it can be recorded."
      : covBusy
        ? "Calculating…"
        : coverage && "error" in coverage
          ? coverage.error
          : coverage && covStats
            ? covNone
              ? `(${hklText(target.h)}) d ${fmt(target.d, 4)} Å${coverage.targets > 1 ? ` + ${coverage.targets - 1} equivalents` : ""} reaches no detector pixel for ${sweep} in the λ band ${lam(exp.lambdaMin)}–${lam(exp.lambdaMax)} Å, so nothing is drawn.`
              : `(${hklText(target.h)}) d ${fmt(target.d, 4)} Å${coverage.targets > 1 ? ` + ${coverage.targets - 1} equivalents` : ""}: reachable on ${covStats.reached} of ${panels.length} panels, ${fmt(100 * covStats.fraction, 1)} % of the detector pixels inside its Bragg window 2θ ${fmt(covWindow?.min ?? NaN, 1)}–${fmt(covWindow?.max ?? NaN, 1)}° · solved exactly for ${sweep}`
            : "";
  const togglePanel = (i: number) => setPanelFilter((p) => (p === i ? null : i));
  const overlay = useAcceptanceOverlay(geometry, panels, blocked, theme);
  const on = useMemo(() => panelsOn(panels), [panels]);
  const [sort, onSort] = useSort<ObsKey>({ key: "f2", dir: "desc" }, { d: "desc", f2: "desc" });
  const sortProps = { sort, onSort };
  const shownObs = useMemo(() => sim.obs.filter((o) => panelFilter === null || o.hit.panel === panelFilter), [sim, panelFilter]);
  const rows = useMemo(() => {
    const { key, dir } = sort;
    const list = shownObs.slice();
    if (key === "hkl") list.sort((a, b) => byHkl(points[a.index]!.h, points[b.index]!.h, dir));
    else if (key === "panel") list.sort((a, b) => byText(a.hit.name, b.hit.name, dir));
    else {
      const value = (o: (typeof list)[number]) => {
        switch (key) {
          case "d":
            return points[o.index]!.d;
          case "lam":
            return o.lambda;
          case "tof":
            return tofOf(o);
          case "tth":
            return o.twoTheta;
          case "az":
            return o.azimuth;
          case "col":
            return o.hit.col;
          case "row":
            return o.hit.row;
          default:
            return points[o.index]!.f2;
        }
      };
      const v = new Map(list.map((o) => [o, value(o)]));
      list.sort((a, b) => byNumber(v.get(a)!, v.get(b)!, dir));
    }
    return list.slice(0, 400);
  }, [shownObs, points, sort, tofOf]);
  const lambdaLegend = (
    <span className="lambda-legend">
      λ {lam(exp.lambdaMin)} Å <span className="lambda-ramp" style={{ background: LAMBDA_RAMP_CSS }} /> {lam(exp.lambdaMax)} Å
    </span>
  );

  return (
    <div className="ui-stack">
      <div className="ui-grid ui-grid--split">
        <Card
          title={`${instrument.goniometer.label} detectors`}
          meta={`${sim.obs.length.toLocaleString()} of ${points.length.toLocaleString()} reflections on the detectors`}
          info={
            instrument.incident
              ? "Lab frame, metres: sample at the origin, beam along +z (orange), up +y. Panels from the Mantid instrument definition. With a monochromatic beam only reflections within the elastic band (Δλ/λ = ΔE/2E) of the Ewald sphere diffract at one setting; each spot is where its scattered ray hits a panel. Rotate ψ (or run the scan on the Single-crystal page) to bring others in. Click a spot to select the reflection, a panel to filter the table to it."
              : "Lab frame, metres: sample at the origin, beam along +z (orange), up +y. Panels from the Mantid instrument definition; each spot is where a reflection's scattered ray hits a panel, coloured by its Laue wavelength. Click a spot to select the reflection, a panel to filter the table to it. The reciprocal-space picture (Ewald spheres, reflections that miss the panels) is on the Orientation page."
          }
          className="viewer-card"
        >
          <Suspense fallback={<p className="empty-note">Loading the 3D view…</p>}>
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
              {...(on ? { highlight: on } : {})}
              legend={lambdaLegend}
              {...(covImages ? { panelImages: covImages, summary: `coverage of (${hklText(target!.h)})${equivalents ? " and equivalents" : ""} over the goniometer range` } : {})}
              plane={plane3d}
            />
          </Suspense>
          <div className="ring-controls">
            <Segmented
              label="Show on the detectors"
              value={show}
              onChange={(v) => {
                setShow(v);
                hkl.clear();
              }}
              options={[
                { value: "spots", label: "Spots now" },
                { value: "coverage", label: "Coverage" },
              ]}
            />
            {plane && (
              <label className="ui-check" title="The scattering plane chosen on the Orientation page: a disc at the sample with its u and v directions, and on the detector map the dashed curve along which its reflections are scattered">
                <input type="checkbox" checked={showPlane} onChange={(e) => setShowPlane(e.target.checked)} /> Scattering plane
              </label>
            )}
            {show === "coverage" && (
              <>
                <HklField {...hkl.field(sel ? sel.h : null)} />
                <label className="ui-check">
                  <input type="checkbox" checked={equivalents} onChange={(e) => setEquivalents(e.target.checked)} /> Equivalents
                </label>
              </>
            )}
          </div>
          {show === "coverage" && <HklNotice miss={hkl.miss} onDMin={onDMin} simulated />}
          {show === "coverage" && <p className={covNone ? "selection-note warn-note" : "selection-note dim-note"}>{covStatus}</p>}
          {sel && show !== "coverage" && (
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
              <GoniometerLimits catalog={catalogGoniometer} exp={exp} onExp={onExp} />
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
              Orientation {orientationText(ub, !!fileUB)}.{" "}
              <button type="button" className="ui-link" onClick={onOpenOrientation}>
                {fileUB ? "Change it on the Orientation page" : "Load an orientation on the Orientation page"}
              </button>
              . The {points.length.toLocaleString()} strongest present reflections with d ≥ d_min are simulated.
            </p>
            {plane && planeGeo && (
              <p className="dim-note" style={{ margin: "0.4rem 0 0" }}>
                Scattering plane {planeName}, zone axis [{hklText(zoneAxis(plane))}]: {fmt(planeGeo.tiltDeg, 1)}° from horizontal, the beam {planeGeo.beamDeg < 0.05 ? "in it" : `${fmt(planeGeo.beamDeg, 1)}° out of it`}. Its reflections are scattered along the dashed violet curve on the detector map.
              </p>
            )}
            <DMinNote result={result} info={info} lambdaMin={exp.lambdaMin} onDMin={onDMin} />
          </Card>
          <AcceptanceCard exp={exp} onExp={onExp} geometry={geometry} panels={panels} goniometer={instrument.goniometer} />
        </div>
      </div>

      <Card
        title="Detector map"
        meta={covOn ? `coverage of (${hklText(target!.h)})${equivalents ? " and equivalents" : ""}, coloured by λ` : panelFilter !== null ? `${panels[panelFilter]!.name} selected · click it again to clear` : `${panels.length} panels unrolled about the vertical axis`}
        info={
          covOn
            ? "Every detector pixel the selected reflection (and its symmetry equivalents, if ticked) can reach as the free goniometer axes sweep their full ranges, coloured by the wavelength it is recorded at (λ = 2d sinθ at that pixel); grey where it never lands. Turned by one axis, a reflection reaches only a thin curve, so the coverage is drawn widened (about 5 px here, 3 % of a panel in the 3D view) with a dark edge; the panel and pixel counts use the exact pixels. Solved exactly per pixel: the pixel fixes the direction of q, and the goniometer angles that turn the reflection onto it are found in closed form and checked against the axis ranges. The red curves bound the Bragg window, 2 asin(λmin/2d) ≤ 2θ ≤ 2 asin(min(1, λmax/2d)): small-d reflections can reach most panels, large-d ones only a few at low angle. γ is the horizontal angle from the beam (positive towards +x), ν the elevation."
            : "Every panel projected onto a cylinder around the sample with its axis vertical: γ is the horizontal angle from the beam (positive towards +x), ν the elevation. Dashed curves are cones of constant 2θ (Debye–Scherrer rings). Hover a spot or panel for details; click a spot to select it, a panel to filter the table."
        }
      >
        <DetectorMap {...(covOn ? { raster: covRaster, rings: covRings } : {})} overlay={overlay} planeTrace={planeDirs} panels={panels} spots={covOn ? [] : mapSpots} lambdaMin={exp.lambdaMin} lambdaMax={exp.lambdaMax} selected={selected} onSelect={setSelected} selectedPanel={covOn ? null : (selObs?.hit.panel ?? panelFilter)} onPanelClick={togglePanel} />
        <p className="plot-hint">{lambdaLegend}</p>
      </Card>

      <Card
        title="Reflections on the detectors"
        info="At the current goniometer setting. TOF is the moderator-to-detector flight time t = 252.778 µs/(m·Å) × (L1 + L2) × λ, with L2 to the pixel the spot hits: the relation Mantid uses between TOF and wavelength, with no emission-time offset. Strongest first; click a column header to sort by it, again to reverse."
        meta={`${shownObs.length.toLocaleString()}${panelFilter !== null ? ` on ${panels[panelFilter]!.name}` : ""}${shownObs.length > 400 ? " · first 400 in this order" : ""}`}
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
                <SortTh id="hkl" {...sortProps} left>
                  hkl
                </SortTh>
                <SortTh id="d" {...sortProps}>
                  d (Å)
                </SortTh>
                <SortTh id="lam" {...sortProps}>
                  λ (Å)
                </SortTh>
                <SortTh id="tof" {...sortProps}>
                  TOF (µs)
                </SortTh>
                <SortTh id="tth" {...sortProps}>
                  2θ (°)
                </SortTh>
                <SortTh id="az" {...sortProps}>
                  azimuth (°)
                </SortTh>
                <SortTh id="panel" {...sortProps} left>
                  Panel
                </SortTh>
                <SortTh id="col" {...sortProps}>
                  col
                </SortTh>
                <SortTh id="row" {...sortProps}>
                  row
                </SortTh>
                <SortTh id="f2" {...sortProps}>
                  |F|²
                </SortTh>
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

function PowderDetectors({ result, theme, exp, onExp, onDMin, instrument, panels, geometry, info, l1, blocked }: ModeProps) {
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
  // The sample stays put, so the environment's shadows are those at the current setting.
  const grids = useMemo(() => panelGrids(panels, blocked), [panels, blocked]);
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
  const mapCache = useRef<{ key: string; of: readonly DetectorPanel[]; blocked: Blocked | undefined; cells: ReturnType<typeof mapCells> } | null>(null);
  const raster = useCallback(
    (w: number, h: number, nuMax: number) => {
      const key = `${w}x${h}x${nuMax}`;
      if (mapCache.current?.key !== key || mapCache.current.of !== panels || mapCache.current.blocked !== blocked) mapCache.current = { key, of: panels, blocked, cells: mapCells(panels, w, h, nuMax, blocked) };
      return paintMap(mapCache.current.cells, w, h, ringProf, slice, l1, gain);
    },
    [panels, blocked, ringProf, slice, l1, gain],
  );
  const overlay = useAcceptanceOverlay(geometry, panels, blocked, theme);

  const findRing = (text: string) => {
    const v = text.trim().split(/[\s,]+/).map(Number);
    if (v.length !== 3 || v.some((x) => !Number.isInteger(x))) return undefined;
    // Any hkl: its spacing from the cell picks the d-group (equivalents and overlaps share one ring).
    const q = mulVec(cellUB, v as unknown as Vec3);
    const d = 1 / Math.hypot(...q);
    const i = groups.findIndex((gr) => Math.abs(gr.d - d) <= 1e-6 * d);
    return i < 0 ? undefined : i;
  };
  const hkl = useHklPick(result, findRing, setSel, sel);
  // A typed hkl with no ring in the pattern (forbidden, |F| ≈ 0, below d_min) is drawn where its ring would be.
  const probeRing = useMemo<(typeof groups)[number] | undefined>(() => (hkl.probe ? { d: hkl.probe.d!, q: (2 * Math.PI) / hkl.probe.d!, sumF2: 0, families: [{ hkl: hkl.probe.hkl!, multiplicity: 1, f2: 0 }] } : undefined), [hkl.probe]);
  const g = probeRing ?? (sel !== null ? groups[sel] : undefined);
  const range = g ? twoThetaRangeForD(g.d, exp.lambdaMin, exp.lambdaMax) : undefined;
  const on = useMemo(() => panelsOn(panels), [panels]);
  const seeing = useMemo(() => (g ? new Set(panelsSeeing(g.d, info, exp.lambdaMin, exp.lambdaMax).filter((i) => !panels[i]!.off)) : on), [g, info, exp.lambdaMin, exp.lambdaMax, panels, on]);
  const ringNow = g && ringsOn && lambdaNom / (2 * g.d) <= 1 ? (2 * Math.asin(lambdaNom / (2 * g.d)) * 180) / Math.PI : undefined;
  const rings = useMemo<MapRing[]>(() => (!ringsOn && range ? [range.min, range.max].filter((t) => t > 0.5 && t < 179.5).map((t) => ({ twoTheta: t, emphasis: true })) : []), [ringsOn, range?.min, range?.max]);
  // The selected reflection's ring in this slice, ray-traced onto the panels (independent of the images).
  const traces = useMemo(() => (ringsOn && g ? ringTrace(panels, l1, slice, g.d, 720, blocked).map((t) => t.points) : undefined), [ringsOn, g, panels, l1, slice, blocked]);
  const pickPanel = (i: number) => onExp({ ...exp, panel: i });
  const label = (x: (typeof groups)[number]) => x.families.map((f) => `(${hklText(f.hkl)})`).join(" + ");
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
              <HklField {...hkl.field(g ? g.families[0]!.hkl : null)} />
              {g && (
                <button
                  type="button"
                  className="ui-pill"
                  onClick={() => {
                    setSel(null);
                    hkl.clear();
                  }}
                >
                  Clear
                </button>
              )}
            </span>
          </div>
          <HklNotice miss={hkl.miss} onDMin={onDMin} simulated />
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
            {ringsOn && (
              <div className="form-rows" style={{ marginTop: "0.6rem" }}>
                {!mono && (
                  <div className="form-row">
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
                <DOverDField exp={exp} onExp={onExp} row />
              </div>
            )}
            <DMinNote result={result} info={info} lambdaMin={exp.lambdaMin} onDMin={onDMin} />
          </Card>
          <AcceptanceCard exp={exp} onExp={onExp} geometry={geometry} panels={panels} goniometer={instrument.goniometer} />
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
        <DetectorMap panels={panels} panelColors={colorsCss} {...(seeing ? { highlight: seeing } : {})} selectedPanel={panel} onPanelClick={pickPanel} lambdaMin={exp.lambdaMin} lambdaMax={exp.lambdaMax} rings={rings} {...(ringsOn ? { raster } : {})} overlay={overlay} {...(traces ? { traces } : {})} />
        <p className="plot-hint">{legend}</p>
      </Card>
    </div>
  );
}
