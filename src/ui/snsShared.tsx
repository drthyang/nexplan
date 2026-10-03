/**
 * Shared pieces of the simulation pages (Detectors, instrument Powder, Single
 * crystal): the selected SNS instrument with its geometry, observations at
 * the current goniometer setting, and small UI parts.
 */
import { useEffect, useMemo, useState } from "react";
import { mulMat, mulVec } from "@materia/core/math/mat3";
import type { CalcSuccess } from "../app/compute.ts";
import { tofFromWavelength } from "../core/diffraction/tof.ts";
import { rayHit, type DetectorHit } from "../core/instrument/detectors.ts";
import { panelAngles } from "../core/instrument/simulate.ts";
import { goniometerMatrix, laueCondition } from "../core/ub/goniometer.ts";
import { CATALOG_GROUPS } from "../core/ub/instrumentCatalog.ts";
import type { InstrumentPreset } from "../core/ub/instruments.ts";
import { SNS_INSTRUMENTS } from "../core/ub/instrumentsSns.ts";
import type { GoniometerModel } from "../core/ub/goniometer.ts";
import { UnitField } from "./components.tsx";
import { chooseInstrument, limitedGoniometer, sampleKind, withLimits, type ExperimentState } from "./experimentState.ts";
import { fmt } from "./format.ts";
import { presentReflections, useViewUB, type UbState } from "./ubShared.ts";

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

/** The selected SNS instrument with detectors, or undefined for the generic beam. */
export function useSnsInstrument(exp: ExperimentState) {
  const catalog: InstrumentPreset | undefined = SNS_INSTRUMENTS.find((i) => i.id === exp.instrumentId);
  // The user's goniometer limits replace the catalog ranges everywhere the goniometer is used.
  const limits = exp.limits[exp.instrumentId];
  const instrument = useMemo(() => catalog && { ...catalog, goniometer: limitedGoniometer(catalog.goniometer, limits) }, [catalog, limits]);
  const panels = useMemo(() => instrument?.detectors ?? [], [instrument]);
  const info = useMemo(() => panels.map(panelAngles), [panels]);
  return { instrument, catalogGoniometer: catalog?.goniometer, panels, info, l1: instrument?.l1 ?? 0, sample: sampleKind(exp) };
}

export interface Observed {
  readonly index: number;
  readonly lambda: number;
  readonly twoTheta: number;
  readonly azimuth: number;
  readonly hit: DetectorHit;
}

/** Reflections (strongest present) and what the detectors record at the current goniometer setting. */
export function useObservations(result: CalcSuccess, ub: UbState, exp: ExperimentState, instrument: InstrumentPreset) {
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
      const hit = rayHit(panels, s.kf);
      if (!hit) return;
      status[i] = 2;
      obs.push({ index: i, lambda: s.lambda, twoTheta: s.twoTheta, azimuth: s.azimuth, hit });
    });
    return { status, lambdas, obs, inBand: status.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) };
  }, [R, viewUB, points, panels, exp.lambdaMin, exp.lambdaMax]);
  const tofOf = (o: Observed) => tofFromWavelength((instrument.l1 ?? 0) + o.hit.l2, o.lambda);
  return { viewUB, fileUB, points, R, sim, tofOf };
}

/** The "detectors reach below d_min" note, with a one-click fix. */
export function DMinNote({ result, info, lambdaMin, onDMin }: { result: CalcSuccess; info: readonly { twoThetaMax: number }[]; lambdaMin: number; onDMin: (d: number) => void }) {
  if (!info.length) return null;
  const reach = lambdaMin / (2 * Math.sin((Math.max(...info.map((a) => a.twoThetaMax)) * Math.PI) / 360));
  const dMin = result.provenance.dMin;
  const suggest = Math.max(0.3, Math.ceil(reach * 100) / 100);
  if (!(reach < dMin - 1e-9)) return null;
  return (
    <p className="warn-note">
      The detectors reach d = {fmt(reach, 3)} Å; reflections are calculated down to d_min = {dMin} Å only.{" "}
      {suggest < dMin && (
        <button type="button" className="ui-pill" onClick={() => onDMin(suggest)}>
          Use d_min = {suggest} Å
        </button>
      )}
    </p>
  );
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

/** h k l entry: commits on Enter or blur; flags indices that are not among the simulated reflections. */
export function HklField({ value, onPick }: { value: readonly number[] | null; onPick: (text: string) => boolean }) {
  const shown = value ? value.join(" ") : "";
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(shown);
    setBad(false);
  }, [shown]);
  const commit = () => {
    if (text.trim() === "" || text === shown) return;
    setBad(!onPick(text));
  };
  return (
    <span className={`ui-unit-field${bad ? " is-invalid" : ""}`} title={bad ? "Not a present reflection with d ≥ d_min (or not among the 6000 strongest)" : "Miller indices, e.g. 4 0 0"}>
      <input className="ui-unit-field__input" aria-label="Reflection h k l" placeholder="h k l" value={text} style={{ width: "7ch" }} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      <span className="ui-unit-field__unit">hkl</span>
    </span>
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
