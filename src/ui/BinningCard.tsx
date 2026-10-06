/**
 * Suggested histogram binning for the plan on the Single-crystal page: the HKL range it records along chosen axes and
 * a bin size per axis from the instrument's Q resolution, plus an energy-transfer axis for chopper spectrometers,
 * written out as Mantid MDNorm parameters (core/instrument/binning.ts).
 */
import { useEffect, useMemo, useState } from "react";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { determinant, transpose } from "@materia/core/math/mat3";
import type { Shadows } from "../core/instrument/acceptance.ts";
import { blockedAt } from "../core/instrument/acceptance.ts";
import { energyBinning, mdnormBinning, niceStep, suggestBinning, type Binning } from "../core/instrument/binning.ts";
import type { DetectorPanel } from "../core/instrument/detectors.ts";
import { kOfEnergy, panelSamples, type Beam } from "../core/instrument/hklRange.ts";
import { energyResolution } from "../core/instrument/pychop.ts";
import { directCovariance, FWHM_PER_SIGMA, GARNET_RESOLUTION, whiteBeamCovariance } from "../core/instrument/qResolution.ts";
import { goniometerMatrix, type GoniometerModel } from "../core/ub/goniometer.ts";
import { Card, Segmented, UnitField } from "./components.tsx";
import { binningOf, catalogEntry, chopperOf, DGS_DEFAULT_CHOPPER, dgsOf, withDgs, type ExperimentState } from "./experimentState.ts";
import { fmt } from "./format.ts";

const AXIS_NAMES = ["Q₁", "Q₂", "Q₃"];
const vecText = (v: readonly number[]) => v.map((x) => Number(x.toFixed(4))).join(" ");
const parseVec = (t: string): number[] | undefined => {
  const v = t.trim().split(/[\s,]+/).map(Number);
  return v.length === 3 && v.every(Number.isFinite) ? v : undefined;
};

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? NaN;

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
  const geometry = catalogEntry(exp.instrumentId)?.geometry;
  const white = geometry === "TOPAZ" || geometry === "CORELLI" ? GARNET_RESOLUTION[geometry] : undefined;
  const dgsId = DGS_DEFAULT_CHOPPER[exp.instrumentId] ? exp.instrumentId : undefined;
  const dgs = dgsId ? dgsOf(exp) : undefined;
  const ei = exp.eiMeV;
  const eMin = dgs?.eMin ?? Number((-0.2 * ei).toPrecision(4));
  const eMax = dgs?.eMax ?? Number((0.95 * ei).toPrecision(4));
  // The chopper set in the header; with a custom ΔE/E there is no PyChop resolution to bin by.
  const chopper = chopperOf(exp);
  const elastic = chopper ? energyResolution(chopper, ei, 0) : undefined;
  const atMax = chopper ? energyResolution(chopper, ei, Math.min(eMax, 0.999 * ei)) : undefined;
  const W = useMemo<Mat3>(() => transpose(b.axes as unknown as Mat3), [b.axes]);
  const singular = Math.abs(determinant(W)) < 1e-9;

  // Pixel and flight-path sizes for the chopper-spectrometer estimate: typical (median) over the panels.
  const pixel = useMemo(() => {
    const live = panels.filter((p) => !p.off);
    return { w: median(live.map((p) => p.width / p.nCols)), h: median(live.map((p) => p.height / p.nRows)), l2: median(live.map((p) => Math.hypot(...p.center))) };
  }, [panels]);

  const key = JSON.stringify([exp.instrumentId, settings, UB, b, dMin, dgs, ei, eMin, eMax, exp.lambdaMin, exp.lambdaMax, shadows?.shapes]);
  const [result, setResult] = useState<{ key: string; value: Binning | undefined; error?: string } | null>(null);
  useEffect(() => {
    if (singular || !settings.length || (!white && !chopper)) return;
    let alive = true;
    const t = setTimeout(() => {
      try {
        const Rs = settings.map((a) => goniometerMatrix(model, a));
        const blocked = settings.map((a) => blockedAt(shadows, a));
        const samples = panelSamples(panels, 6);
        const mosaic = (b.mosaicDeg * Math.PI) / 180 / FWHM_PER_SIGMA;
        let beam: Beam;
        let cov: (u: Vec3, at: number) => Mat3 | undefined;
        if (white) {
          beam = { kind: "white", lambdaMin: exp.lambdaMin, lambdaMax: exp.lambdaMax };
          cov = (u, lambda) => whiteBeamCovariance(u, lambda, white, mosaic);
        } else {
          beam = { kind: "direct", eiMeV: ei, eMin, eMax: Math.min(eMax, 0.999 * ei) };
          const sample = dgs!.sampleMm / 1000;
          const outH = Math.hypot(pixel.w, sample) / Math.sqrt(12) / pixel.l2;
          const outV = Math.hypot(pixel.h, sample) / Math.sqrt(12) / pixel.l2;
          const incident = dgs!.divergenceMrad / 1000 / FWHM_PER_SIGMA;
          const ki = 2 * Math.PI * kOfEnergy(ei);
          cov = (u, e) => {
            const fwhmE = energyResolution(chopper!, ei, e);
            if (fwhmE === undefined || !(e < ei)) return undefined;
            return directCovariance(u, ki, 2 * Math.PI * kOfEnergy(ei - e), fwhmE / FWHM_PER_SIGMA, outH, outV, incident, mosaic);
          };
        }
        const value = suggestBinning(Rs, blocked, samples, beam, UB, W, cov, b.perFwhmQ, { qMax: 1 / dMin });
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
  const energy = chopper && elastic !== undefined ? energyBinning(elastic, eMin, eMax, b.perFwhmE) : undefined;
  // A slice integrates one axis over a slab two (median) FWHM thick about its centre.
  const slab = b.slab && bins ? { ...b.slab, thickness: niceStep(2 * bins.axes[b.slab.axis as 0 | 1 | 2].fwhm50) } : undefined;
  // Mantid's default Q convention labels the reflection NEXPLAN calls h as −h with the same UB: mdnormBinning mirrors.
  const inelastic = b.qConvention !== "crystallography";
  const binning = (i: number) => mdnormBinning(bins!.axes[i as 0 | 1 | 2], inelastic ? "inelastic" : "crystallography", slab?.axis === i ? slab : undefined);
  const total = bins ? bins.axes.reduce((n, a, i) => n * (slab?.axis === i ? 1 : a.bins), 1) * (energy?.bins ?? 1) : 0;

  const call = bins
    ? [
        `# NEXPLAN binning suggestion: ${catalogEntry(exp.instrumentId)?.label ?? exp.instrumentId}, ${settings.length} setting${settings.length > 1 ? "s" : ""}, d >= ${dMin} A; bin = FWHM/${b.perFwhmQ} (sharpest quarter)${energy ? `, dE bin = FWHM(0)/${b.perFwhmE}` : ""}`,
        inelastic
          ? `# For Q.convention = "Inelastic" (Mantid's default), which labels NEXPLAN's (h k l) as (-h -k -l): limits mirrored`
          : `# For Q.convention = "Crystallography": indices as NEXPLAN's (h k l)`,
        `MDNorm(InputWorkspace="data", ${white ? 'SolidAngleWorkspace="sa", FluxWorkspace="flux"' : 'SolidAngleWorkspace="sa"'},`,
        `       QDimension0="${b.axes[0]!.join(",")}", QDimension1="${b.axes[1]!.join(",")}", QDimension2="${b.axes[2]!.join(",")}",`,
        ...bins.axes.map((_, i) => `       Dimension${i}Name="QDimension${i}", Dimension${i}Binning="${binning(i)}",`),
        ...(energy ? [`       Dimension3Name="DeltaE", Dimension3Binning="${energy.min},${energy.step},${energy.max}",`] : []),
        `       OutputWorkspace="result", OutputDataWorkspace="dataMD", OutputNormalizationWorkspace="normMD")`,
      ].join("\n")
    : "";

  const status = singular
    ? "The three axes are coplanar: choose independent ones."
    : !white && !chopper
      ? "No resolution to bin by: TOPAZ and CORELLI use ORNL's Q model, the chopper spectrometers a chopper setting chosen in the header."
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
      meta={white ? "Q bins from ORNL's resolution model (garnet-tools)" : chopper ? "ΔE from PyChop · Q bins estimated" : "not available for this instrument"}
      info={
        <>
          The histogram this plan fills, for Mantid's MDNorm (or BinMD, garnet): along each projection axis, the range of h it records down to d_min (masks and shadows included) and a bin of the resolution FWHM over the bins per FWHM, taken from the sharpest quarter of what it records and rounded to the nearest of 1, 2, 2.5 or 5 × 10ⁿ; the range is rounded out to whole bins. A slice integrates one axis over a slab two median FWHM thick.{" "}
          {white ? (
            <>
              <b>Q resolution</b>: the Stoica–Forsyth model ORNL's garnet-tools fits to measured peak shapes (neutrons/garnet-tools @ 4eb3206; not published). Incident divergence dominates it and is the least documented input. Real peaks are wider: add the sample's mosaic (the transverse width grows as Q·η). ORNL's own default bin is 0.1 r.l.u.
            </>
          ) : (
            <>
              <b>Energy</b>: Mantid PyChop's resolution for the chopper setting (its ARCS and SEQUOIA parameters tuned to ORNL vanadium data, Mantid PR #38591), at the elastic line; it narrows with energy transfer. The range defaults to −0.2 to 0.95 Ei (SNS autoreduction). <b>Q</b>: no published resolution exists for these instruments; the estimate takes the pixel and sample sizes over L2, the energy spread along k_f, and an incident divergence if you give one.
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
          <span className="ui-control-label">Histogram</span>
          <span className="supercell">
            <Segmented
              label="Volume or slice"
              value={b.slab ? "slice" : "volume"}
              onChange={(v) => {
                if (v === "slice") setB({ slab: { axis: 2, centre: 0 } });
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
            {b.slab && (
              <>
                <select className="ui-select" aria-label="Axis integrated over the slab" value={b.slab.axis} onChange={(e) => setB({ slab: { ...b.slab!, axis: Number(e.target.value) } })}>
                  {AXIS_NAMES.map((n, i) => (
                    <option key={i} value={i}>
                      integrate {n}
                    </option>
                  ))}
                </select>
                <span className="dim-note">at</span>
                <UnitField label="Slab centre" value={b.slab.centre} unit="r.l.u." min={-1000} max={1000} width="4ch" onCommit={(v) => setB({ slab: { ...b.slab!, centre: v } })} />
              </>
            )}
          </span>
        </div>
        <div className="form-row">
          <span className="ui-control-label">Bins per FWHM</span>
          <span className="supercell">
            <Segmented label="Q bins per resolution FWHM" value={String(b.perFwhmQ)} onChange={(v) => setB({ perFwhmQ: Number(v) })} options={["2", "3", "4"].map((v) => ({ value: v, label: `Q ${v}` }))} />
            {chopper && <Segmented label="Energy bins per resolution FWHM" value={String(b.perFwhmE)} onChange={(v) => setB({ perFwhmE: Number(v) })} options={["2", "3", "4"].map((v) => ({ value: v, label: `E ${v}` }))} />}
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
        <div className="form-row">
          <span className="ui-control-label">Sample mosaic</span>
          <UnitField label="Sample mosaic, FWHM" value={b.mosaicDeg} unit="° FWHM" min={0} max={20} width="4ch" onCommit={(v) => setB({ mosaicDeg: v })} />
        </div>
        {dgsId && dgs && (
          <>
            <div className="form-row">
              <span className="ui-control-label">Energy transfer</span>
              <span className="supercell">
                <UnitField label="Energy transfer from" value={eMin} unit="meV" min={-10 * ei} max={ei} width="5ch" onCommit={(v) => onExp(withDgs(exp, { ...dgs, eMin: v }))} />
                <span className="dim-note">to</span>
                <UnitField label="Energy transfer to" value={eMax} unit="meV" min={-10 * ei} max={ei} width="5ch" onCommit={(v) => onExp(withDgs(exp, { ...dgs, eMax: v }))} />
              </span>
            </div>
            <div className="form-row">
              <span className="ui-control-label">Q estimate</span>
              <span className="supercell">
                <UnitField label="Sample size" value={dgs.sampleMm} unit="mm sample" min={0} max={100} width="3.5ch" onCommit={(v) => onExp(withDgs(exp, { ...dgs, sampleMm: v }))} />
                <UnitField label="Incident divergence, FWHM" value={dgs.divergenceMrad} unit="mrad divergence" min={0} max={200} width="3.5ch" onCommit={(v) => onExp(withDgs(exp, { ...dgs, divergenceMrad: v }))} />
              </span>
            </div>
            <p className={chopper && elastic === undefined ? "warn-note" : "dim-note"}>
              {!chopper
                ? "With a custom ΔE/E there is no energy resolution to bin by: choose a chopper setting in the header."
                : elastic === undefined
                  ? `This chopper does not transmit ${fmt(ei, 4)} meV at ${dgs.frequency} Hz (PyChop): choose another package or frequency in the header.`
                  : `Energy resolution (PyChop, ${dgs.chopper} at ${dgs.frequency} Hz, set in the header): ${fmt(elastic, 3)} meV FWHM at the elastic line (${fmt((100 * elastic) / ei, 2)} % of Ei)${atMax !== undefined ? `, ${fmt(atMax, 3)} meV at ${fmt(Math.min(eMax, 0.999 * ei), 3)} meV transfer` : ""}.`}
            </p>
          </>
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
                    <th>Bin</th>
                    <th>Bins</th>
                    <th title="FWHM along this axis: the sharpest quarter of what the plan records, and the median">FWHM (sharpest ¼ · median)</th>
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
                            integrated (2 × median FWHM)
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
                      <td>
                        {fmt(a.fwhm25, 3)} · {fmt(a.fwhm50, 3)} r.l.u.
                      </td>
                    </tr>
                  ))}
                  {energy && (
                    <tr>
                      <th className="left">ΔE (meV)</th>
                      <td>{energy.min}</td>
                      <td>{energy.max}</td>
                      <td>{energy.step}</td>
                      <td>{energy.bins.toLocaleString()}</td>
                      <td>
                        {fmt(elastic!, 3)}
                        {atMax !== undefined ? ` → ${fmt(atMax, 3)}` : ""} meV
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className={total > 2e8 ? "warn-note" : "dim-note"}>
              Within d ≥ {dMin} Å: {total.toLocaleString()} bins in all (about {fmt((total * 16) / 2 ** 30, total * 16 > 2 ** 30 ? 1 : 2)} GiB for MDNorm's data and normalization histograms){total > 2e8 ? ": narrow the ranges or use fewer bins per FWHM" : ""}. Q reaches {fmt(bins.extent.qMax, 3)} Å⁻¹.
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
