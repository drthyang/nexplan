/**
 * Suggested histogram binning for the plan on the Single-crystal page: the HKL range it records along chosen axes,
 * in round steps giving about 200–400 bins per axis (or a step chosen by hand), plus an energy-transfer axis for chopper spectrometers (1 % of Ei), written
 * out as Mantid MDNorm parameters (core/instrument/binning.ts).
 */
import { useEffect, useMemo, useState } from "react";
import type { Mat3 } from "@materia/core/math/types";
import { determinant, transpose } from "@materia/core/math/mat3";
import type { Shadows } from "../core/instrument/acceptance.ts";
import { blockedAt } from "../core/instrument/acceptance.ts";
import { DGS_DEFAULT_ENERGY, energyBinning, mdnormBinning, Q_STEPS, suggestBinning, type Binning } from "../core/instrument/binning.ts";
import type { DetectorPanel } from "../core/instrument/detectors.ts";
import { panelSamples, type Beam } from "../core/instrument/hklRange.ts";
import { goniometerMatrix, type GoniometerModel } from "../core/ub/goniometer.ts";
import { Card, Segmented, UnitField } from "./components.tsx";
import { binningOf, catalogEntry, DGS_DEFAULT_CHOPPER, dgsOf, withDgs, type ExperimentState } from "./experimentState.ts";
import { fmt } from "./format.ts";

const AXIS_NAMES = ["Q₁", "Q₂", "Q₃"];
const vecText = (v: readonly number[]) => v.map((x) => Number(x.toFixed(4))).join(" ");
const parseVec = (t: string): number[] | undefined => {
  const v = t.trim().split(/[\s,]+/).map(Number);
  return v.length === 3 && v.every(Number.isFinite) ? v : undefined;
};

export function BinningCard({
  exp,
  onExp,
  model,
  settings,
  UB,
  panels,
  shadows,
  calcDMin,
}: {
  exp: ExperimentState;
  onExp: (e: ExperimentState) => void;
  model: GoniometerModel;
  /** The plan's goniometer settings (angles). */
  settings: readonly (readonly number[])[];
  UB: Mat3;
  panels: readonly DetectorPanel[];
  shadows: Shadows | undefined;
  /** The calculation's d_min (Å): the default limit of the binned range. */
  calcDMin: number;
}) {
  const b = binningOf(exp);
  const dMin = b.dMin ?? calcDMin;
  const setB = (patch: Partial<typeof b>) => onExp({ ...exp, binning: { ...b, ...patch } });
  const dgsId = DGS_DEFAULT_CHOPPER[exp.instrumentId] ? exp.instrumentId : undefined;
  const dgs = dgsId ? dgsOf(exp) : undefined;
  const ei = exp.eiMeV;
  const eMin = dgs?.eMin ?? Number((DGS_DEFAULT_ENERGY.min * ei).toPrecision(4));
  const eMax = dgs?.eMax ?? Number((DGS_DEFAULT_ENERGY.max * ei).toPrecision(4));
  const W = useMemo<Mat3>(() => transpose(b.axes as unknown as Mat3), [b.axes]);
  const singular = Math.abs(determinant(W)) < 1e-9;

  const key = JSON.stringify([exp.instrumentId, settings, UB, b.axes, b.step, dMin, ei, eMin, eMax, exp.lambdaMin, exp.lambdaMax, shadows?.shapes]);
  const [result, setResult] = useState<{ key: string; value: Binning | undefined; error?: string } | null>(null);
  useEffect(() => {
    if (singular || !settings.length) return;
    let alive = true;
    const t = setTimeout(() => {
      try {
        const Rs = settings.map((a) => goniometerMatrix(model, a));
        const blocked = settings.map((a) => blockedAt(shadows, a));
        const beam: Beam = dgs ? { kind: "direct", eiMeV: ei, eMin, eMax: Math.min(eMax, 0.999 * ei) } : { kind: "white", lambdaMin: exp.lambdaMin, lambdaMax: exp.lambdaMax };
        const value = suggestBinning(Rs, blocked, panelSamples(panels, 6), beam, UB, W, b.step, { qMax: 1 / dMin });
        if (alive) setResult({ key, value });
      } catch (e) {
        if (alive) setResult({ key, value: undefined, error: (e as Error).message });
      }
    }, 60);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers the inputs
  }, [key, singular]);
  const current = result?.key === key ? result : null;
  const bins = current?.value;
  const energy = dgs ? energyBinning(ei, eMin, eMax) : undefined;
  const slab = b.slab;
  // Mantid's default Q convention labels the reflection NEXPLAN calls h as −h with the same UB: mdnormBinning mirrors.
  const inelastic = b.qConvention !== "crystallography";
  const binning = (i: number) => mdnormBinning(bins!.axes[i as 0 | 1 | 2], inelastic ? "inelastic" : "crystallography", slab?.axis === i ? slab : undefined);
  const total = bins ? bins.axes.reduce((n, a, i) => n * (slab?.axis === i ? 1 : a.bins), 1) * (energy?.bins ?? 1) : 0;

  const call = bins
    ? [
        `# NEXPLAN binning suggestion: ${catalogEntry(exp.instrumentId)?.label ?? exp.instrumentId}, ${settings.length} setting${settings.length > 1 ? "s" : ""}, d >= ${dMin} A; ${b.step ? `step ${b.step}` : "auto steps (about 200-400 bins per axis)"}${energy ? ", dE step 1 % of Ei" : ""}`,
        inelastic
          ? `# For Q.convention = "Inelastic" (Mantid's default), which labels NEXPLAN's (h k l) as (-h -k -l): limits mirrored`
          : `# For Q.convention = "Crystallography": indices as NEXPLAN's (h k l)`,
        `MDNorm(InputWorkspace="data", ${dgs ? 'SolidAngleWorkspace="sa"' : 'SolidAngleWorkspace="sa", FluxWorkspace="flux"'},`,
        `       QDimension0="${b.axes[0]!.join(",")}", QDimension1="${b.axes[1]!.join(",")}", QDimension2="${b.axes[2]!.join(",")}",`,
        ...bins.axes.map((_, i) => `       Dimension${i}Name="QDimension${i}", Dimension${i}Binning="${binning(i)}",`),
        ...(energy ? [`       Dimension3Name="DeltaE", Dimension3Binning="${energy.min},${energy.step},${energy.max}",`] : []),
        `       OutputWorkspace="result", OutputDataWorkspace="dataMD", OutputNormalizationWorkspace="normMD")`,
      ].join("\n")
    : "";

  const status = singular
    ? "The three axes are coplanar: choose independent ones."
    : !settings.length
      ? "Add settings to the plan (an orientation list, or a scan) to see what it records."
      : !current
        ? "Calculating…"
        : current.error
          ? current.error
          : !bins
            ? "The plan records nothing with these masks, shadows and band."
            : undefined;

  return (
    <Card
      title="Binning"
      meta={`recorded HKL range · ${b.step ? `step ${b.step} r.l.u.` : "about 200–400 bins per axis"}${dgs ? " · ΔE step 1 % of Ei" : ""}`}
      info={
        <>
          The histogram this plan fills, for Mantid&apos;s MDNorm (or BinMD): along each projection axis, the range of h it records down to d ≥ d_min (masks and shadows included), in bins of a round step (1, 2, 2.5, 4 or 5 × 10ⁿ r.l.u.): by default, per axis, the one that gives 201–401 bins (nearest 301), or one you choose for every axis. The bins are centred on zero, so integer hkl sit at bin centres when 1/step is an integer. A slice integrates one axis over a slab of the thickness you give. These are starting points: single-crystal volumes from TOPAZ and CORELLI are usually binned with about 200–400 bins per axis, and the best bin depends on how many counts the measurement collects, so try and adjust.
          {dgs && (
            <>
              {" "}
              <b>Energy transfer</b>: steps of 1 % of Ei over −0.5 Ei to 0.99 Ei by default, Mantid&apos;s default for direct-geometry reduction (DgsConvertToEnergyTransfer). Q bins for chopper spectrometers also depend on Ei (the recorded range grows with k_i); expect to try a few.
            </>
          )}
        </>
      }
    >
      <div className="form-rows">
        <div className="form-row">
          <span className="ui-control-label">Axes (r.l.u.)</span>
          <span className="supercell">
            {b.axes.map((v, i) => (
              <AxisField key={i} label={AXIS_NAMES[i]!} value={v} onCommit={(nv) => setB({ axes: b.axes.map((r, j) => (j === i ? nv : r)) })} />
            ))}
          </span>
        </div>
        <div className="form-row">
          <span className="ui-control-label">Range</span>
          <span className="supercell">
            <span className="dim-note">d ≥</span>
            <UnitField label="Bin down to d" value={dMin} unit="Å" min={0.05} max={100} width="4ch" onCommit={(v) => setB({ dMin: v })} />
            <span className="dim-note">(Q ≤ {fmt((2 * Math.PI) / dMin, 3)} Å⁻¹)</span>
            {b.dMin !== undefined && b.dMin !== calcDMin && (
              <button
                type="button"
                className="ui-pill"
                title={`Back to the calculation's d_min, ${calcDMin} Å`}
                onClick={() => {
                  const { dMin: _, ...rest } = b;
                  onExp({ ...exp, binning: rest });
                }}
              >
                Reset
              </button>
            )}
          </span>
        </div>
        <div className="form-row">
          <span className="ui-control-label">Step</span>
          <select
            className="ui-select"
            aria-label="Q step"
            value={b.step ?? ""}
            onChange={(e) => {
              const { step: _, ...rest } = b;
              onExp({ ...exp, binning: e.target.value ? { ...rest, step: Number(e.target.value) } : rest });
            }}
          >
            <option value="">Auto: about 200–400 bins per axis</option>
            {Q_STEPS.map((s) => (
              <option key={s} value={s}>
                {s} r.l.u.
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <span className="ui-control-label">Histogram</span>
          <span className="supercell">
            <Segmented
              label="Volume or slice"
              value={slab ? "slice" : "volume"}
              onChange={(v) => {
                if (v === "slice") setB({ slab: { axis: 2, centre: 0, thickness: 0.1 } });
                else {
                  const { slab: _, ...rest } = b;
                  onExp({ ...exp, binning: rest });
                }
              }}
              options={[
                { value: "volume", label: "3D volume" },
                { value: "slice", label: "Slice" },
              ]}
            />
            {slab && (
              <>
                <select className="ui-select" aria-label="Axis integrated over the slab" value={slab.axis} onChange={(e) => setB({ slab: { ...slab, axis: Number(e.target.value) } })}>
                  {AXIS_NAMES.map((n, i) => (
                    <option key={i} value={i}>
                      integrate {n}
                    </option>
                  ))}
                </select>
                <span className="dim-note">at</span>
                <UnitField label="Slab centre" value={slab.centre} unit="r.l.u." min={-1000} max={1000} width="4ch" onCommit={(v) => setB({ slab: { ...slab, centre: v } })} />
                <span className="dim-note">±</span>
                <UnitField label="Slab half-thickness" value={slab.thickness / 2} unit="r.l.u." min={1e-4} max={50} width="4ch" onCommit={(v) => setB({ slab: { ...slab, thickness: 2 * v } })} />
              </>
            )}
          </span>
        </div>
        <div className="form-row">
          <span className="ui-control-label">Mantid Q</span>
          <span className="supercell" title="Mantid's Q.convention when the data are converted to MD. NEXPLAN's indices are crystallographic (q = k_f − k_i, as ISAW peaks files); Mantid's default, Inelastic, labels the same reflection (−h −k −l) with the same UB, so the MDNorm limits are mirrored for it.">
            <Segmented
              label="Mantid Q convention"
              value={inelastic ? "inelastic" : "crystallography"}
              onChange={(v) => setB({ qConvention: v })}
              options={[
                { value: "inelastic", label: "Inelastic (default)" },
                { value: "crystallography", label: "Crystallography" },
              ]}
            />
          </span>
        </div>
        {dgsId && dgs && (
          <div className="form-row">
            <span className="ui-control-label">ΔE range</span>
            <span className="supercell">
              <UnitField label="Energy transfer from" value={eMin} unit="meV" min={-10 * ei} max={ei} width="5ch" onCommit={(v) => onExp(withDgs(exp, { ...dgs, eMin: v }))} />
              <span className="dim-note">to</span>
              <UnitField label="Energy transfer to" value={eMax} unit="meV" min={-10 * ei} max={ei} width="5ch" onCommit={(v) => onExp(withDgs(exp, { ...dgs, eMax: v }))} />
              <span className="dim-note">step {Number((DGS_DEFAULT_ENERGY.step * ei).toPrecision(4))} meV (1 % of Ei)</span>
            </span>
          </div>
        )}
      </div>

      {status ? (
        <p className="dim-note">{status}</p>
      ) : (
        bins && (
          <>
            <div className="ui-table-wrap">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="left">Axis</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Step</th>
                    <th>Bins</th>
                  </tr>
                </thead>
                <tbody>
                  {bins.axes.map((a, i) => (
                    <tr key={i}>
                      <th className="left">
                        {AXIS_NAMES[i]} [{vecText(b.axes[i]!)}]
                      </th>
                      {slab?.axis === i ? (
                        <>
                          <td>{Number((slab.centre - slab.thickness / 2).toFixed(6))}</td>
                          <td>{Number((slab.centre + slab.thickness / 2).toFixed(6))}</td>
                          <td colSpan={2} className="left dim-note">
                            integrated
                          </td>
                        </>
                      ) : (
                        <>
                          <td>{a.min}</td>
                          <td>{a.max}</td>
                          <td>{a.step}</td>
                          <td>{a.bins.toLocaleString()}</td>
                        </>
                      )}
                    </tr>
                  ))}
                  {energy && (
                    <tr>
                      <th className="left">ΔE (meV)</th>
                      <td>{energy.min}</td>
                      <td>{energy.max}</td>
                      <td>{energy.step}</td>
                      <td>{energy.bins.toLocaleString()}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className={total > 2e8 ? "warn-note" : "dim-note"}>
              Within d ≥ {dMin} Å: {total.toLocaleString()} bins in all (about {fmt((total * 16) / 2 ** 30, total * 16 > 2 ** 30 ? 1 : 2)} GiB for MDNorm&apos;s data and normalization histograms){total > 2e8 ? ": use a slice, narrower ranges or fewer bins" : ""}. Q reaches {fmt(bins.extent.qMax, 3)} Å⁻¹.
            </p>
            <div className="mantid-call">
              <pre>{call}</pre>
              <button type="button" className="ui-pill" onClick={() => void navigator.clipboard?.writeText(call)}>
                Copy
              </button>
            </div>
          </>
        )
      )}
    </Card>
  );
}

function AxisField({ label, value, onCommit }: { label: string; value: readonly number[]; onCommit: (v: number[]) => void }) {
  const [text, setText] = useState(vecText(value));
  useEffect(() => setText(vecText(value)), [value]);
  const parsed = parseVec(text);
  const commit = () => {
    if (parsed && vecText(parsed) !== vecText(value)) onCommit(parsed);
  };
  return (
    <span className={`ui-unit-field${parsed ? "" : " is-invalid"}`} title="Three numbers in r.l.u., e.g. 1 1 0">
      <input
        className="ui-unit-field__input"
        aria-label={`Projection axis ${label}`}
        value={text}
        style={{ width: `${Math.max(6, text.length + 1)}ch` }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <span className="ui-unit-field__unit">{label}</span>
    </span>
  );
}
