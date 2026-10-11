/**
 * Shared pieces of the simulation pages (Detectors, instrument Powder, Single
 * crystal): the selected SNS instrument with its geometry, observations at
 * the current goniometer setting, and small UI parts.
 */
import { useEffect, useMemo, useState } from "react";
import { mulMat, mulVec } from "@materia/core/math/mat3";
import type { CalcSuccess } from "../app/compute.ts";
import { tofFromWavelength } from "../core/diffraction/tof.ts";
import { applyMasks, blockedAt, maskedPixelCount, type Shadows } from "../core/instrument/acceptance.ts";
import { rayHit, type Blocked, type DetectorHit, type DetectorPanel } from "../core/instrument/detectors.ts";
import { panelAngles } from "../core/instrument/simulate.ts";
import { goniometerMatrix, laueCondition } from "../core/ub/goniometer.ts";
import { CATALOG_GROUPS } from "../core/ub/instrumentCatalog.ts";
import type { InstrumentPreset } from "../core/ub/instruments.ts";
import { SNS_INSTRUMENTS } from "../core/ub/instrumentsSns.ts";
import type { GoniometerModel } from "../core/ub/goniometer.ts";
import { UnitField } from "./components.tsx";
import { chooseInstrument, limitedGoniometer, masksOf, sampleKind, shadowsOf, withLimits, type ExperimentState } from "./experimentState.ts";
import { fmt } from "./format.ts";
import { hklMiss, presentReflections, simulatable, type HklMiss, type UbState } from "./ubShared.ts";
import { useViewUB } from "./useViewUB.ts";

export interface SimPageProps {
  readonly result: CalcSuccess;
  readonly theme: "light" | "dark";
  readonly ub: UbState;
  readonly exp: ExperimentState;
  readonly onExp: (e: ExperimentState) => void;
  readonly onDMin: (d: number) => void;
  /** Switch to the Orientation page (to load a UB). */
  readonly onOpenOrientation: () => void;
}

/** Wavelengths for display: four significant figures. */
export const lam = (x: number) => Number(x.toPrecision(4));

/**
 * The selected SNS instrument with detectors, or undefined for the generic beam. Its detectors carry the user's
 * masks (acceptance.ts), so every page records through them; `geometry` is the panels without masks. `shadows`
 * are the sample environment's, and `blocked` the directions they block at the current goniometer setting.
 */
export function useSnsInstrument(exp: ExperimentState) {
  const catalog: InstrumentPreset | undefined = SNS_INSTRUMENTS.find((i) => i.id === exp.instrumentId);
  // The user's goniometer limits replace the catalog ranges everywhere the goniometer is used.
  const limits = exp.limits[exp.instrumentId];
  const masks = masksOf(exp);
  const maskKey = JSON.stringify(masks);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- masks is rebuilt each render; maskKey is its value
  const masked = useMemo(() => (catalog?.detectors ? applyMasks(catalog.detectors, masks) : undefined), [catalog, maskKey]);
  const instrument = useMemo(() => catalog && { ...catalog, goniometer: limitedGoniometer(catalog.goniometer, limits), ...(masked ? { detectors: masked } : {}) }, [catalog, limits, masked]);
  const panels = useMemo(() => instrument?.detectors ?? [], [instrument]);
  const info = useMemo(() => panels.map(panelAngles), [panels]);
  const shapes = shadowsOf(exp);
  const shadowKey = JSON.stringify(shapes);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- shapes is rebuilt each render; shadowKey is its value
  const shadows = useMemo<Shadows | undefined>(() => (instrument && shapes.length ? { shapes, model: instrument.goniometer } : undefined), [instrument, shadowKey]);
  const blocked = useMemo(() => blockedAt(shadows, exp.angles), [shadows, exp.angles]);
  return { instrument, catalogGoniometer: catalog?.goniometer, geometry: catalog?.detectors ?? [], panels, info, l1: instrument?.l1 ?? 0, sample: sampleKind(exp), shadows, blocked };
}

export interface Observed {
  readonly index: number;
  readonly lambda: number;
  readonly twoTheta: number;
  readonly azimuth: number;
  readonly hit: DetectorHit;
}

/** Reflections (strongest present) and what the detectors record at the current goniometer setting (`blocked`: the shadows there). */
export function useObservations(result: CalcSuccess, ub: UbState, exp: ExperimentState, instrument: InstrumentPreset, blocked?: Blocked) {
  const { viewUB, fileUB } = useViewUB(result, ub);
  const points = useMemo(() => presentReflections(result), [result]);
  const panels = instrument.detectors ?? [];
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
      const hit = rayHit(panels, s.kf, blocked);
      if (!hit) return;
      status[i] = 2;
      obs.push({ index: i, lambda: s.lambda, twoTheta: s.twoTheta, azimuth: s.azimuth, hit });
    });
    return { status, lambdas, obs, inBand: status.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) };
  }, [R, viewUB, points, panels, exp.lambdaMin, exp.lambdaMax, blocked]);
  const tofOf = (o: Observed) => tofFromWavelength((instrument.l1 ?? 0) + o.hit.l2, o.lambda);
  return { viewUB, fileUB, points, R, sim, tofOf };
}

/** The lowest d_min offered by one click: the reflection list grows as 1/d³ (type a lower value in the bar if needed). */
export const LOWEST_SUGGESTED_DMIN = 0.3;

/** d_min to cover a reach: rounded down to 0.01 Å, but not below LOWEST_SUGGESTED_DMIN. */
export const suggestDMin = (reach: number) => Math.max(LOWEST_SUGGESTED_DMIN, Math.floor(reach * 100) / 100);

/** The "detectors reach below d_min" note, with a one-click fix. */
export function DMinNote({ result, info, lambdaMin, onDMin }: { result: CalcSuccess; info: readonly { twoThetaMax: number }[]; lambdaMin: number; onDMin: (d: number) => void }) {
  if (!info.length) return null;
  const reach = lambdaMin / (2 * Math.sin((Math.max(...info.map((a) => a.twoThetaMax)) * Math.PI) / 360));
  const dMin = result.provenance.dMin;
  const suggest = suggestDMin(reach);
  if (!(reach < dMin - 1e-9)) return null;
  return (
    <p className="warn-note">
      The detectors reach d = {fmt(reach, 3)} Å; reflections are calculated down to d_min = {dMin} Å only.{" "}
      {suggest < dMin && (
        <button type="button" className="ui-pill" title={suggest > reach ? `${LOWEST_SUGGESTED_DMIN} Å is the lowest offered here: the reflection list grows as 1/d³. Type a lower d_min in the bar if you need it.` : undefined} onClick={() => onDMin(suggest)}>
          Use d_min = {suggest} Å
        </button>
      )}
    </p>
  );
}

/**
 * Δd/d (FWHM) of simulated powder lines and rings, shown on the powder views where it sets the widths: inline
 * among a card's actions, or as a row of a card's form (`row`).
 */
export function DOverDField({ exp, onExp, row = false }: { exp: ExperimentState; onExp: (e: ExperimentState) => void; row?: boolean }) {
  return (
    <span className={row ? "form-row" : "ui-control"} title="Relative resolution (FWHM) of the simulated powder lines. Real banks vary with angle and are calibrated.">
      <span className="ui-control-label">
        Δ<span className="sym">d</span>/<span className="sym">d</span>
      </span>
      <UnitField label="Relative resolution Δd/d (FWHM)" value={Number((100 * exp.dOverD).toPrecision(6))} unit="%" min={0.01} max={20} width="4ch" onCommit={(v) => onExp({ ...exp, dOverD: v / 100 })} />
    </span>
  );
}

/** On the simulation pages other than Detectors: the masks and shadows in effect, which are set on the Detectors page. */
export function AcceptanceNote({ panels, shadows }: { panels: readonly DetectorPanel[]; shadows: Shadows | undefined }) {
  const c = maskedPixelCount(panels);
  if (!c.pixels && !shadows) return null;
  const parts = [c.pixels ? `${fmt((100 * c.pixels) / c.total, 1)} % of the pixels masked${c.panelsOff ? ` (${c.panelsOff} panel${c.panelsOff > 1 ? "s" : ""} off)` : ""}` : "", shadows ? `${shadows.shapes.length} sample-environment shadow${shadows.shapes.length > 1 ? "s" : ""}` : ""].filter(Boolean);
  return <p className="dim-note">Recorded through {parts.join(" and ")}, set under Masks and shadows on the Detectors page.</p>;
}

/** Shown on a simulation page that needs an instrument (or a kind of instrument) the header does not have. */
export function InstrumentRequired({ exp, onExp, need, title, children }: { exp: ExperimentState; onExp: (e: ExperimentState) => void; need: "any" | "single-crystal"; title: string; children: React.ReactNode }) {
  const groups = CATALOG_GROUPS.map((g) => ({ ...g, list: g.list.filter((i) => need === "any" || i.modes?.includes("single-crystal")) })).filter((g) => g.list.length);
  return (
    <div className="ui-card empty-state">
      <h2>{title}</h2>
      <p>{children}</p>
      {groups.map((g) => (
        <div key={g.label} className="empty-state__row">
          <span className="ui-control-label">{g.label}</span>
          {g.list.map((i) => (
            <button key={i.id} type="button" className="ui-btn-brand" onClick={() => onExp(chooseInstrument(exp, i.id))}>
              {i.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * h k l entry: commits on Enter or blur. `invalid` is the reason the last entry was not selected
 * (useHklPick), which outlines the field; the page shows the same reason in an HklNotice.
 */
export function HklField({ value, onPick, invalid }: { value: readonly number[] | null; onPick: (text: string) => void; invalid?: string | undefined }) {
  const shown = value ? value.join(" ") : "";
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (text.trim() === "" || text === shown) return;
    onPick(text);
  };
  return (
    <span className={`ui-unit-field${invalid ? " is-invalid" : ""}`} title={invalid ?? "Miller indices, e.g. 4 0 0"}>
      <input className="ui-unit-field__input" aria-label="Reflection h k l" aria-invalid={invalid ? true : undefined} placeholder="h k l" value={text} style={{ width: `${Math.max(7, text.length + 1)}ch` }} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      <span className="ui-unit-field__unit">hkl</span>
    </span>
  );
}

/**
 * Selection by typed hkl. One the page lists is selected; any other (forbidden, |F| ≈ 0, past the cap,
 * below d_min) becomes the probe, simulated on its own (nothing listed is selected) while HklNotice says
 * what it is: the field outline alone says nothing, and touch screens show no tooltips. A selection made
 * elsewhere ends it; a new calculation retries the hkl, which may now be listed or have a new reason.
 */
export function useHklPick(result: CalcSuccess, find: (text: string) => number | undefined, select: (i: number | null) => void, current: number | null, cap?: number) {
  const [miss, setMiss] = useState<HklMiss | null>(null);
  const pick = (text: string) => {
    const i = find(text);
    if (i !== undefined) {
      setMiss(null);
      select(i);
      return;
    }
    const m = hklMiss(result, text, cap);
    setMiss(m);
    if (simulatable(m)) select(null);
  };
  // The reset to none that follows a new calculation is not a selection: it must not end the retried notice.
  useEffect(() => {
    if (current !== null) setMiss(null);
  }, [current]);
  useEffect(() => {
    if (miss?.hkl) pick(miss.hkl.join(" "));
    // Only a new calculation retries the hkl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  const probe = miss && simulatable(miss) ? miss : null;
  /** HklField props: the field keeps the hkl a notice is about, outlined only when it is not a reflection. */
  const field = (selected: readonly number[] | null) => ({ value: miss?.hkl ?? selected, onPick: pick, invalid: miss && !simulatable(miss) ? miss.message : undefined });
  return { pick, miss, probe, clear: () => setMiss(null), field };
}

/**
 * What a typed hkl is (forbidden, |F| ≈ 0, past the cap, below d_min) and, where the page simulates it
 * (`simulated`), that it is shown anyway; below d_min, the d_min that calculates its |F|.
 */
export function HklNotice({ miss, onDMin, simulated = false }: { miss: HklMiss | null; onDMin: (dMin: number) => void; simulated?: boolean }) {
  if (!miss) return null;
  const shown = simulated && simulatable(miss);
  const why = !shown
    ? ""
    : miss.kind === "systematic" || miss.kind === "accidental"
      ? " Simulated as asked: such a peak can come from an unreported phase, lower symmetry or multiple scattering."
      : miss.kind === "dmin"
        ? " Its position is simulated."
        : " Simulated on its own, as asked.";
  const d = miss.kind === "dmin" ? miss.d : undefined;
  const to = d !== undefined ? suggestDMin(d) : undefined;
  return (
    <p className="warn-note" role="alert">
      {miss.message}
      {why}{" "}
      {d !== undefined &&
        to !== undefined &&
        (to <= d ? (
          <button type="button" className="ui-pill" title="Recalculate down to this d_min: the reflection is then listed with its |F|" onClick={() => onDMin(to)}>
            Calculate down to {to} Å
          </button>
        ) : (
          `${LOWEST_SUGGESTED_DMIN} Å is the lowest offered here (the list grows as 1/d³): type a d_min of at most ${fmt(Math.floor(d * 1000) / 1000, 3)} Å in the bar to calculate it.`
        ))}
    </p>
  );
}

/** Find a reflection by "h k l" text among `points`. */
export function findHkl(points: readonly { readonly h: readonly number[] }[], text: string): number | undefined {
  const v = text.trim().split(/[\s,]+/).map(Number);
  if (v.length !== 3 || v.some((x) => !Number.isInteger(x))) return undefined;
  const i = points.findIndex((p) => p.h[0] === v[0] && p.h[1] === v[1] && p.h[2] === v[2]);
  return i < 0 ? undefined : i;
}

/** The present d-groups (Σ|F|² > 0) used by the powder simulations, with a d → group lookup. */
export function usePowderGroups(result: CalcSuccess) {
  const groups = useMemo(() => {
    const max = Math.max(0, ...result.groups.map((g) => g.sumF2));
    return result.groups.filter((g) => g.sumF2 > 1e-9 * max);
  }, [result]);
  const groupOfD = useMemo(() => new Map(groups.map((g, i) => [g.d, i])), [groups]);
  return { groups, groupOfD };
}

/** The panel nearest 2θ = 90°: the default for single-panel patterns. */
export const defaultPanel = (info: readonly { twoThetaCenter: number }[]) => info.reduce((best, a, i) => (Math.abs(a.twoThetaCenter - 90) < Math.abs(info[best]!.twoThetaCenter - 90) ? i : best), 0);

/**
 * Limits of the free goniometer axes for the current instrument, which the
 * user can narrow (collisions, sample environment): the catalog range unless
 * changed. Every simulation, search and slider uses them.
 */
export function GoniometerLimits({ catalog, exp, onExp }: { catalog: GoniometerModel; exp: ExperimentState; onExp: (e: ExperimentState) => void }) {
  const lim = exp.limits[exp.instrumentId] ?? {};
  return (
    <>
      {catalog.axes.map((ax, i) => {
        if (ax.fixed !== undefined) return null;
        const [lo, hi] = lim[i] ?? [ax.min, ax.max];
        return (
          <div key={i} className="form-row limits-row">
            <span className="ui-control-label">
              <span className="sym">{ax.name}</span> limits
            </span>
            <span className="supercell">
              <UnitField label={`${ax.name} lower limit`} value={lo} unit="°" min={-360} max={720} width="4.5ch" onCommit={(v) => onExp(withLimits(exp, i, [v, hi]))} />
              <span className="dim-note">to</span>
              <UnitField label={`${ax.name} upper limit`} value={hi} unit="°" min={-360} max={720} width="4.5ch" onCommit={(v) => onExp(withLimits(exp, i, [lo, v]))} />
              {lim[i] ? (
                <button type="button" className="ui-pill" title={`Back to the catalog range, ${ax.min}° to ${ax.max}°`} onClick={() => onExp(withLimits(exp, i, null))}>
                  Reset
                </button>
              ) : (
                <span className="dim-note">catalog range</span>
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}
