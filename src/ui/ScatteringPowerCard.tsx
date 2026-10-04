/**
 * Neutron scattering power of the sample against a reference material
 * (src/core/scattering/power.ts): macroscopic cross-sections per unit volume
 * and Bragg line strengths j|F|²/v_c². No flux, detector or counting-time
 * assumptions: everything is per unit volume of material.
 */
import { useEffect, useMemo, useState } from "react";
import type { CalcInput, CalcSuccess } from "../app/compute.ts";
import { braggStrengths, braggSummary, LAMBDA_2200, scatteringPower, type BraggLine, type BraggWeight, type ScatteringPower } from "../core/scattering/power.ts";
import { calculateIsolated } from "../workers/client.ts";
import { Card, Segmented, UnitField } from "./components.tsx";
import { DEMO_REFERENCES, REFERENCES, STANDARDS } from "./standards.ts";
import { fmt } from "./format.ts";
import { typeScale, useMeasuredWidth } from "./useMeasuredWidth.ts";

interface Material {
  readonly name: string;
  readonly power: ScatteringPower;
  /** Neutron Bragg lines, when the calculation was a neutron one. */
  readonly lines?: readonly BraggLine[];
}

function materialOf(result: CalcSuccess, lambda: number): Material {
  const s = result.structure;
  const power = scatteringPower(
    s.sites.map((x) => ({ label: x.label, multiplicity: x.multiplicity, occupancy: x.occupancy, xs: x.neutronXs })),
    s.volume,
    lambda,
  );
  const neutron = result.provenance.settings.radiation === "neutron";
  return { name: s.name || result.blockName, power, ...(neutron ? { lines: braggStrengths(result.groups, s.volume) } : {}) };
}

const sig = (x: number, n = 4) => (Number.isFinite(x) ? Number(x.toPrecision(n)).toString() : "—");
const WEIGHTS: Record<BraggWeight, { label: string; formula: string; unit: string }> = {
  tof: { label: "TOF (×d⁴)", formula: "j|F|²d⁴/v_c²", unit: "fm²/Å²" },
  strength: { label: "None", formula: "j|F|²/v_c²", unit: "fm²/Å⁶" },
};

const ratio = (a: number, b: number) => (b > 0 && Number.isFinite(a / b) ? `×${sig(a / b, 3)}` : "—");

export function ScatteringPowerCard({ result }: { result: CalcSuccess }) {
  const [refId, setRefId] = useState<string>("si");
  const [pinned, setPinned] = useState<{ name: string; result: CalcSuccess } | null>(null);
  const [lambda, setLambda] = useState(LAMBDA_2200);
  const [win, setWin] = useState<[number, number]>([1, 4]);
  const [weight, setWeight] = useState<BraggWeight>("tof");
  const W = WEIGHTS[weight];
  const [refResult, setRefResult] = useState<{ id: string; dMin: number; result: CalcSuccess } | { id: string; dMin: number; error: string } | null>(null);
  const dMin = result.provenance.dMin;

  // The reference is calculated with neutrons and the sample's d_min, on its own worker.
  useEffect(() => {
    if (refId === "pinned") return;
    const material = REFERENCES.find((d) => d.id === refId);
    if (!material || (refResult && refResult.id === refId && refResult.dMin === dMin)) return;
    let alive = true;
    const settings = result.provenance.settings;
    const input = (cifText: string): CalcInput => ({
      cifText,
      fileName: material.file,
      radiation: "neutron",
      wavelength: 1.5,
      dMin,
      polarization: { kind: "unpolarized" },
      profile: { axis: "d", fwhm: 0.002, eta: 0.5 },
      neutronMode: "cw",
      tof: settings.tof,
    });
    void material
      .load()
      .then((text) => calculateIsolated(input(text)))
      .then(
        (r) => alive && setRefResult(r.ok ? { id: refId, dMin, result: r } : { id: refId, dMin, error: r.message }),
        (e: unknown) => alive && setRefResult({ id: refId, dMin, error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refId, dMin]);

  const sample = useMemo(() => materialOf(result, lambda), [result, lambda]);
  const ref = useMemo<Material | { error: string } | undefined>(() => {
    if (refId === "pinned") return pinned ? { ...materialOf(pinned.result, lambda), name: pinned.name } : undefined;
    if (!refResult || refResult.id !== refId) return undefined;
    return "error" in refResult ? { error: refResult.error } : materialOf(refResult.result, lambda);
  }, [refId, pinned, refResult, lambda]);
  const refOk = ref && !("error" in ref) ? ref : undefined;

  const sSum = sample.lines ? braggSummary(sample.lines, win[0], win[1], weight) : undefined;
  const rSum = refOk?.lines ? braggSummary(refOk.lines, win[0], win[1], weight) : undefined;
  const rows: [string, string, number, number | undefined, string][] = [
    ["Coherent Σ_coh", "cm⁻¹", sample.power.coh, refOk?.power.coh, "Bragg and diffuse coherent scattering per unit volume."],
    ["Incoherent Σ_inc", "cm⁻¹", sample.power.inc, refOk?.power.inc, "Flat background per unit volume (hydrogen dominates it)."],
    [`Absorption Σ_abs at ${sig(lambda)} Å`, "cm⁻¹", sample.power.abs, refOk?.power.abs, "Scaled from 2200 m/s by the 1/v law."],
    ["Total attenuation", "cm⁻¹", sample.power.total, refOk?.power.total, "Σ_coh + Σ_inc + Σ_abs."],
    ["1/e attenuation length", "cm", sample.power.attenuationLength, refOk?.power.attenuationLength, "Thickness that transmits 1/e of the beam."],
    ["Atoms per Å³", "", sample.power.density, refOk?.power.density, "Number density of the full crystal."],
  ];

  return (
    <Card
      title="Neutron scattering power"
      meta={refOk ? `${sample.name} against ${refOk.name}` : "against a reference material"}
      info="Per unit volume of material, from the cell contents and the Sears (1992) cross-sections: Σ = (1/v_c)·Σ m·o·σ, in cm⁻¹ (1 barn/Å³ = 1 cm⁻¹). The Bragg line strength j|F|²/v_c² (fm²/Å⁶) is the sample-dependent factor of a line's integrated intensity per unit volume; flux, Lorentz and detector factors depend only on d, so at similar d the ratio of strengths is the ratio of line intensities for equal sample volumes. TOF weighting multiplies by d⁴, the Lorentz factor λ⁴/sin²θ at a fixed detector angle, so lines rank as in a measured TOF pattern apart from the source spectrum. A powder's packing fraction scales all values equally. These compare materials; they are not counting times."
      actions={
        <>
          <span className="ui-control">
            <span className="ui-control-label">Reference</span>
            <select className="ui-select" aria-label="Reference material" value={refId} onChange={(e) => setRefId(e.target.value)}>
              <optgroup label="Standards">
                {STANDARDS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Demo structures">
                {DEMO_REFERENCES.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
              {pinned && <option value="pinned">{pinned.name} (kept)</option>}
            </select>
          </span>
          <button
            type="button"
            className="ui-pill"
            title="Keep the current structure as the reference, then load another"
            onClick={() => {
              setPinned({ name: sample.name, result });
              setRefId("pinned");
            }}
          >
            Keep this as reference
          </button>
        </>
      }
    >
      {ref && "error" in ref && <p className="error-note">The reference could not be calculated: {ref.error}</p>}
      {sample.power.missing.length > 0 && <p className="warn-note">No tabulated cross-section for {sample.power.missing.join(", ")}; left out of the totals.</p>}
      {sample.power.resonant.length > 0 && <p className="warn-note">{sample.power.resonant.join(", ")}: resonant absorber; absorption away from 1.798 Å does not follow the 1/v law.</p>}
      <div className="power-grid">
        <div>
          <div className="power-scroll">
          <table className="ui-table power-table">
            <thead>
              <tr>
                <th className="left">Per unit volume</th>
                <th>Sample</th>
                <th>{refOk ? refOk.name : "Reference"}</th>
                <th>Ratio</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([name, unit, a, b, title]) => (
                <tr key={name} title={title}>
                  <th className="left">
                    {name} {unit && <small className="dim-note">{unit}</small>}
                  </th>
                  <td>{sig(a)}</td>
                  <td>{b === undefined ? "…" : sig(b)}</td>
                  <td>{b === undefined ? "" : ratio(a, b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="form-row" style={{ marginTop: "0.6rem" }}>
            <span className="ui-control-label">
              <span className="sym">λ</span> for absorption
            </span>
            <UnitField label="Wavelength for absorption" value={Number(lambda.toPrecision(5))} unit="Å" min={0.05} max={20} width="6ch" onCommit={setLambda} />
          </div>
        </div>
        <div>
          {!sample.lines ? (
            <p className="empty-note">Bragg line strengths need the neutron calculation: choose Neutron in the bar (or an SNS instrument).</p>
          ) : (
            <>
              <div className="power-scroll">
              <table className="ui-table power-table">
                <thead>
                  <tr>
                    <th className="left">
                      Lines, {sig(win[0], 3)} ≤ d ≤ {sig(win[1], 3)} Å
                    </th>
                    <th>Sample</th>
                    <th>{refOk ? refOk.name : "Reference"}</th>
                    <th>Ratio</th>
                  </tr>
                </thead>
                <tbody>
                  <tr title={`The strongest line in the window, ${W.formula} (${W.unit})`}>
                    <th className="left">
                      Strongest line <small className="dim-note">{W.unit}</small>
                    </th>
                    <td>{sSum?.strongest ? <LineCell line={sSum.strongest} weight={weight} /> : "—"}</td>
                    <td>{rSum?.strongest ? <LineCell line={rSum.strongest} weight={weight} /> : refOk ? "—" : "…"}</td>
                    <td>{sSum?.strongest && rSum?.strongest ? ratio(sSum.strongest[weight], rSum.strongest[weight]) : ""}</td>
                  </tr>
                  <tr title={`Summed ${W.formula} of all lines in the window (${W.unit})`}>
                    <th className="left">
                      Summed <small className="dim-note">{W.unit}</small>
                    </th>
                    <td>{sSum ? sig(sSum.sum, 3) : "—"}</td>
                    <td>{rSum ? sig(rSum.sum, 3) : refOk ? "—" : "…"}</td>
                    <td>{sSum && rSum ? ratio(sSum.sum, rSum.sum) : ""}</td>
                  </tr>
                  <tr>
                    <th className="left">Lines</th>
                    <td>{sSum?.count ?? "—"}</td>
                    <td>{rSum?.count ?? (refOk ? "—" : "…")}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
              </div>
              <div className="form-row" style={{ marginTop: "0.6rem" }}>
                <span className="ui-control-label">Weight</span>
                <Segmented label="Line weighting" value={weight} onChange={setWeight} options={(["tof", "strength"] as const).map((w) => ({ value: w, label: WEIGHTS[w].label }))} />
              </div>
              <div className="form-row" style={{ marginTop: "0.4rem" }}>
                <span className="ui-control-label">d window</span>
                <span className="supercell">
                  <UnitField label="Window minimum d" value={win[0]} unit="Å" min={0.05} width="4ch" onCommit={(v) => setWin([Math.min(v, win[1]), win[1]])} />
                  <span className="dim-note">to</span>
                  <UnitField label="Window maximum d" value={win[1]} unit="Å" min={0.1} width="4ch" onCommit={(v) => setWin([win[0], Math.max(v, win[0])])} />
                </span>
              </div>
            </>
          )}
        </div>
      </div>
      {sample.lines && <LineMirror sample={sample.lines} reference={refOk?.lines} sampleName={sample.name} refName={refOk?.name ?? "reference"} window={win} dMin={dMin} weight={weight} />}
      <p className="plot-hint">
        Reference: {refId === "pinned" ? `${pinned?.name ?? ""}, kept from this session.` : REFERENCES.find((d) => d.id === refId)?.source}
      </p>
      <p className="plot-hint">Per unit volume of material; equal sample volumes and similar d assumed for the line ratios. Not a counting time: flux, detector efficiency and background vary by instrument.</p>
    </Card>
  );
}

/** Line strengths against d: the sample above the axis, the reference mirrored below, on one scale. */
function LineMirror({ sample, reference, sampleName, refName, window: win, dMin, weight }: { sample: readonly BraggLine[]; reference?: readonly BraggLine[] | undefined; sampleName: string; refName: string; window: [number, number]; dMin: number; weight: BraggWeight }) {
  const { ref: wrapRef, width } = useMeasuredWidth(700, 320);
  const dHi = Math.min(6, Math.max(win[1] * 1.15, ...sample.map((l) => l.d), ...(reference ?? []).map((l) => l.d)));
  const dLo = Math.max(0.05, dMin * 0.95);
  const max = Math.max(1e-300, ...sample.filter((l) => l.d >= dLo).map((l) => l[weight]), ...(reference ?? []).filter((l) => l.d >= dLo).map((l) => l[weight]));
  const H = Math.round(220 * typeScale());
  const m = { l: 12, r: 12, t: 16, b: 34 };
  const W = width - m.l - m.r;
  const mid = m.t + (H - m.t - m.b) / 2;
  const half = (H - m.t - m.b) / 2;
  const sx = (d: number) => m.l + ((d - dLo) / (dHi - dLo)) * W;
  const ticks: number[] = [];
  const step = dHi - dLo > 3 ? 1 : 0.5;
  for (let t = Math.ceil(dLo / step) * step; t <= dHi + 1e-9; t += step) ticks.push(Number(t.toFixed(3)));
  return (
    <div ref={wrapRef} className="plot-wrap" style={{ marginTop: "0.75rem" }}>
      <svg className="plot" width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label="Bragg line strengths of the sample and the reference against d">
        <rect className="power-window" x={sx(Math.max(dLo, win[0]))} y={m.t} width={Math.max(0, sx(Math.min(dHi, win[1])) - sx(Math.max(dLo, win[0])))} height={2 * half} />
        {ticks.map((t) => (
          <g key={t}>
            <line className="plot-grid-line" x1={sx(t)} x2={sx(t)} y1={m.t} y2={m.t + 2 * half} />
            <text className="plot-tick" x={sx(t)} y={H - m.b + 16} textAnchor="middle">
              {t}
            </text>
          </g>
        ))}
        <line className="plot-frame" x1={m.l} x2={m.l + W} y1={mid} y2={mid} />
        {sample
          .filter((l) => l.d >= dLo && l.d <= dHi)
          .map((l, i) => (
            <line key={`s${i}`} className="power-stick" x1={sx(l.d)} x2={sx(l.d)} y1={mid} y2={mid - (l[weight] / max) * half}>
              <title>{`${sampleName} ${l.label}  d ${fmt(l.d, 4)} Å: ${sig(l[weight], 3)} ${WEIGHTS[weight].unit}`}</title>
            </line>
          ))}
        {(reference ?? [])
          .filter((l) => l.d >= dLo && l.d <= dHi)
          .map((l, i) => (
            <line key={`r${i}`} className="power-stick is-ref" x1={sx(l.d)} x2={sx(l.d)} y1={mid} y2={mid + (l[weight] / max) * half}>
              <title>{`${refName} ${l.label}  d ${fmt(l.d, 4)} Å: ${sig(l[weight], 3)} ${WEIGHTS[weight].unit}`}</title>
            </line>
          ))}
        <text className="power-key" x={m.l + 6} y={m.t + 12}>
          ▲ {sampleName}
        </text>
        <text className="power-key is-ref" x={m.l + 6} y={m.t + 2 * half - 4}>
          ▼ {refName}
        </text>
        <text className="axis-label" x={m.l + W / 2} y={H - 4} textAnchor="middle">
          d (Å) · {WEIGHTS[weight].formula}, one scale
        </text>
      </svg>
    </div>
  );
}

function LineCell({ line, weight }: { line: BraggLine; weight: BraggWeight }) {
  return (
    <span title={line.label}>
      {sig(line[weight], 3)} <small className="dim-note">@ {fmt(line.d, 3)} Å</small>
    </span>
  );
}
