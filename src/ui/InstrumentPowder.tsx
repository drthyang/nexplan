/**
 * Powder page for an SNS instrument (Simulation): the pattern of a focused bank
 * as the data are reduced (NOMAD, POWGEN; src/core/instrument/focus.ts), or of
 * one panel (time of flight at its centre angle, DIFC from L1 + L2), or the
 * elastic 2θ pattern over all panels for a chopper spectrometer, with the
 * 2θ–d coverage of the whole detector array.
 */
import { useEffect, useMemo, useState } from "react";
import { cwPeaks } from "../core/diffraction/powder.ts";
import { synthesizeTof, tofFromWavelength, tofPeaks, type TofBank } from "../core/diffraction/tof.ts";
import { focusedBank, focusedPeaks, focusedTofBank } from "../core/instrument/focus.ts";
import { elasticPattern } from "../core/instrument/powderRings.ts";
import { coveredTwoTheta, dRangeAt, panelDifc } from "../core/instrument/simulate.ts";
import { angleCss } from "../views/colormaps.ts";
import { Card, Segmented } from "./components.tsx";
import { CoverageChart, type CoverageLine } from "./CoverageChart.tsx";
import { fmt, hklText } from "./format.ts";
import { PowderPlot } from "./PowderPlot.tsx";
import { DMinNote, defaultPanel, InstrumentRequired, lam, LOWEST_SUGGESTED_DMIN, suggestDMin, usePowderGroups, useSnsInstrument, type SimPageProps } from "./snsShared.tsx";

export function InstrumentPowder(props: SimPageProps) {
  const { result, exp, onExp, onDMin } = props;
  const { instrument, panels, info, l1 } = useSnsInstrument(exp);
  const { groups, groupOfD } = usePowderGroups(result);
  const [sel, setSel] = useState<number | null>(null);
  const [axis, setAxis] = useState<"tof" | "d">("tof");
  useEffect(() => setSel(null), [groups]);
  const colorsCss = useMemo(() => info.map((a) => angleCss(a.twoThetaCenter)), [info]);
  const covered = useMemo(() => coveredTwoTheta(info), [info]);
  const panel = exp.panel !== null && exp.panel < panels.length ? exp.panel : panels.length ? defaultPanel(info) : 0;
  const pa = info[panel];
  const mono = instrument?.incident;
  const lambda0 = (exp.lambdaMin + exp.lambdaMax) / 2;
  const bank: TofBank | undefined = useMemo(
    () => (pa && panels[panel] ? { twoThetaDeg: pa.twoThetaCenter, difc: panelDifc(panels[panel]!, l1), difa: 0, zero: 0, lambdaMin: exp.lambdaMin, lambdaMax: exp.lambdaMax } : undefined),
    [pa, panels, panel, l1, exp.lambdaMin, exp.lambdaMax],
  );
  // Focused banks (as the data are reduced), when the instrument defines them.
  const specs = useMemo(() => (mono ? [] : (instrument?.banks?.list ?? [])), [mono, instrument]);
  const focused = useMemo(
    () =>
      specs.map((spec) => {
        const idx = spec.panels.map((n) => panels.findIndex((q) => q.name === n)).filter((i) => i >= 0);
        const missing = spec.panels.filter((n) => !panels.some((q) => q.name === n));
        return { spec, idx, missing, bank: focusedBank(spec.name, idx.map((i) => panels[i]!), l1, exp.lambdaMin, exp.lambdaMax, { ...(spec.twoThetaDeg !== undefined ? { twoThetaDeg: spec.twoThetaDeg } : {}), ...(spec.l2 !== undefined ? { l2: spec.l2 } : {}) }) };
      }).filter((f) => f.idx.length > 0),
    [specs, panels, l1, exp.lambdaMin, exp.lambdaMax],
  );
  const byBank = focused.length > 0 && exp.powderView === "bank";
  const bankIndex = exp.bank !== null && exp.bank < focused.length ? exp.bank : focused.reduce((best, f, i) => (Math.abs(f.bank.twoThetaDeg - 90) < Math.abs(focused[best]!.bank.twoThetaDeg - 90) ? i : best), 0);
  const fb = byBank ? focused[bankIndex] : undefined;
  const drawBank = useMemo(() => (fb ? focusedTofBank(fb.bank) : bank), [fb, bank]);
  const peaks = useMemo(
    () =>
      !bank
        ? []
        : mono
          ? cwPeaks(groups, { wavelength: lambda0, lorentz: true, polarization: { kind: "none" } }).filter((p) => covered.some(([a, b]) => p.twoTheta! >= a && p.twoTheta! <= b))
          : fb
            ? focusedPeaks(groups, fb.bank, exp.lambdaMin, exp.lambdaMax)
            : tofPeaks(groups, bank),
    [mono, groups, bank, lambda0, covered, fb, exp.lambdaMin, exp.lambdaMax],
  );
  const profile = useMemo(
    () => (!bank || !drawBank ? { x: new Float64Array(), y: new Float64Array() } : mono ? elasticPattern(peaks, Math.hypot(exp.dOverD, exp.eRes / 2), covered) : synthesizeTof(peaks, drawBank, { kind: "gaussian", dOverD: exp.dOverD }, axis)),
    [mono, peaks, bank, drawBank, exp.dOverD, exp.eRes, covered, axis],
  );
  const lines = useMemo<CoverageLine[]>(() => groups.map((x) => ({ d: x.d, weight: x.sumF2, label: x.families.map((f) => `(${hklText(f.hkl)})`).join(" + ") })), [groups]);
  const panelOrder = useMemo(() => info.map((a, i) => ({ a, i })).sort((x, y) => x.a.twoThetaCenter - y.a.twoThetaCenter), [info]);

  if (!instrument || !bank || !pa)
    return (
      <InstrumentRequired exp={exp} onExp={onExp} need="any" title="Choose an instrument">
        The instrument powder pattern needs an SNS detector array.
      </InstrumentRequired>
    );

  const peakSel = sel !== null ? peaks.findIndex((p) => p.d === groups[sel]!.d) : -1;
  const seen = dRangeAt(pa.twoThetaCenter, exp.lambdaMin, exp.lambdaMax);
  // What the pattern cannot show because reflections stop at d_min: the shortest d this view records, and the shaded range.
  const calcDMin = result.provenance.dMin;
  const thetaMax = ((covered.at(-1)?.[1] ?? 180) * Math.PI) / 360;
  const reach = mono ? lambda0 / (2 * Math.sin(thetaMax)) : fb ? fb.bank.dMin : seen.dMin;
  const difcShown = fb ? fb.bank.difc : bank.difc;
  const cutoff =
    reach < calcDMin - 1e-9
      ? mono
        ? { from: (2 * Math.asin(Math.min(1, lambda0 / (2 * calcDMin))) * 180) / Math.PI, to: covered.at(-1)?.[1] ?? 180 }
        : axis === "tof"
          ? { from: difcShown * reach, to: difcShown * calcDMin }
          : { from: reach, to: calcDMin }
      : undefined;
  // In the bank view a panel picks the bank it belongs to (or switches to that panel when it is in none).
  const pickPanel = (i: number) => {
    if (byBank) {
      const k = focused.findIndex((f) => f.idx.includes(i));
      onExp(k >= 0 ? { ...exp, bank: k } : { ...exp, panel: i, powderView: "panel" });
    } else onExp({ ...exp, panel: i });
  };

  return (
    <div className="ui-stack">
      <Card
        title={mono ? `Elastic powder pattern · ${instrument.goniometer.label}` : fb ? `Powder pattern · ${instrument.goniometer.label} ${fb.spec.name}` : `Powder pattern · ${instrument.goniometer.label} ${panels[panel]!.name}`}
        meta={
          mono
            ? `λ ${fmt(lambda0, 4)} Å · 2θ ${fmt(covered[0]?.[0] ?? 0, 1)}–${fmt(covered.at(-1)?.[1] ?? 0, 1)}° · zero in detector gaps`
            : fb
              ? `focused, ${fb.idx.length} panels · 2θ ${fmt(fb.bank.twoThetaDeg, 1)}° (${fmt(fb.bank.twoThetaMin, 0)}–${fmt(fb.bank.twoThetaMax, 0)}°) · DIFC ${fmt(fb.bank.difc, 1)} µs/Å · Δd/d ${Number((100 * exp.dOverD).toPrecision(6))} %`
              : `2θ ${fmt(pa.twoThetaCenter, 2)}° · DIFC ${fmt(bank.difc, 1)} µs/Å · Δd/d ${Number((100 * exp.dOverD).toPrecision(6))} %`
        }
        info={
          mono
            ? "Elastic intensity per unit solid angle against 2θ over all panels, as a chopper spectrometer records it at the elastic line: I = Σ|F|²/(sin²θ cosθ) (CW powder Lorentz factor, no polarization for neutrons), each peak a Gaussian of FWHM 2·tanθ·√((Δd/d)² + (ΔE/2E)²); zero where no panel covers 2θ. Click a peak to select it in the coverage chart."
            : fb
              ? "Neutron TOF pattern of a focused bank, as the data are reduced: the bank's panels are split into cells, each recording d from λmin/(2 sinθ) to λmax/(2 sinθ) at its own angle; after focusing and vanadium normalisation a line at d has I = Σ|F|²·d⁴·⟨sinθ⟩(d), the mean over the cells that record d weighted by their solid angles. Drawn on the bank's DIFC = 252.778·(L1 + L2)·2 sinθ µs/Å with the effective 2θ and L2 (no DIFA, ZERO; real banks are calibrated), Gaussian peaks of constant Δd/d."
              : "Neutron TOF pattern of the selected panel treated as one bank at its centre angle: DIFC = 252.778·(L1 + L2)·2 sinθ µs/Å (no DIFA, ZERO; real banks are calibrated). I = Σ|F|²·sinθ·d⁴ (GSAS-II TOF Lorentz factor, incident spectrum normalised out), Gaussian peaks of constant Δd/d on a logarithmic TOF grid. Pick another panel below, in the coverage strip, or on the Detectors page."
        }
        actions={
          mono ? undefined : (
            <>
              {focused.length > 0 && <Segmented label="Pattern of" value={exp.powderView} onChange={(v) => onExp({ ...exp, powderView: v })} options={[{ value: "bank", label: "Focused bank" }, { value: "panel", label: "One panel" }]} />}
              <Segmented label="Axis" value={axis} onChange={setAxis} options={[{ value: "tof", label: "TOF" }, { value: "d", label: "d" }]} />
            </>
          )
        }
      >
        {cutoff && (
          <p className="warn-note">
            {mono ? "The detectors record" : fb ? "This bank records" : "This panel records"} d down to {fmt(reach, 3)} Å, but reflections are calculated down to d_min = {calcDMin} Å only (shaded).{" "}
            {suggestDMin(reach) < calcDMin && (
              <button type="button" className="ui-pill" title={suggestDMin(reach) > reach ? `${LOWEST_SUGGESTED_DMIN} Å is the lowest offered here: the reflection list grows as 1/d³. Type a lower d_min in the bar if you need it.` : undefined} onClick={() => onDMin(suggestDMin(reach))}>
                Calculate down to {suggestDMin(reach)} Å
              </button>
            )}
          </p>
        )}
        {peaks.length ? (
          <PowderPlot
            peaks={peaks}
            profile={profile}
            axis={mono ? "twoTheta" : axis}
            selected={peakSel >= 0 ? peakSel : null}
            onSelect={(i) => setSel(i === null ? null : (groupOfD.get(peaks[i]!.d) ?? null))}
            showSticks={false}
            shade={cutoff ? { ...cutoff, label: `d < ${calcDMin} Å: not calculated` } : undefined}
          />
        ) : (
          <p className="empty-note">{mono ? "No reflection lands on the detectors at this Ei (or above d_min)." : fb ? `No reflections fall in this bank's d range (${fmt(fb.bank.dMin, 3)}–${fmt(fb.bank.dMax, 2)} Å) above d_min.` : `No reflections fall in this panel's d range (${fmt(seen.dMin, 3)}–${fmt(seen.dMax, 2)} Å) above d_min.`}</p>
        )}
        <p className="plot-hint">Click a peak or tick to select it · drag to zoom · double-click to reset</p>
      </Card>

      <div className="ui-grid ui-grid--split">
        <Card
          title="d coverage"
          meta={`λ ${lam(exp.lambdaMin)}–${lam(exp.lambdaMax)} Å`}
          info="A detector at 2θ records d from λmin/(2 sinθ) to λmax/(2 sinθ): the shaded band, darker where panels are. Each reflection is a line over the 2θ range where it diffracts, darker when stronger (Σ|F|² over its equivalents). The strip below the axis shows each panel's 2θ span in its colour. Click a line to select a reflection, a panel in the strip to simulate it."
        >
          <CoverageChart lambdaMin={exp.lambdaMin} lambdaMax={exp.lambdaMax} panels={info} panelColors={colorsCss} lines={lines} selected={sel} onSelect={setSel} selectedPanel={panel} selectedPanels={fb ? new Set(fb.idx) : undefined} onPanelPick={pickPanel} dFloor={result.provenance.dMin} />
        </Card>
        <div className="ui-stack">
          {fb ? (
            <Card title="Focused bank" meta={`${fb.spec.name} · ${fb.idx.length} panels`} info={`The pattern above is for this bank. Groupings: ${instrument.banks!.source}`}>
              <div className="form-rows">
                <label className="form-row">
                  <span className="ui-control-label">Bank</span>
                  <select className="ui-select" aria-label="Focused bank" value={bankIndex} onChange={(e) => onExp({ ...exp, bank: Number(e.target.value) })}>
                    {focused.map((f, i) => (
                      <option key={f.spec.name} value={i}>
                        {f.spec.name} · 2θ {fmt(f.bank.twoThetaDeg, 1)}° · {f.idx.length} panels
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <dl className="ui-stats ui-stats--three" style={{ marginTop: "0.6rem" }}>
                <div>
                  <dt>2θ span</dt>
                  <dd>
                    {fmt(fb.bank.twoThetaMin, 1)}–{fmt(fb.bank.twoThetaMax, 1)}°
                  </dd>
                </div>
                <div>
                  <dt>Effective 2θ</dt>
                  <dd>
                    {fmt(fb.bank.twoThetaDeg, 2)}°{fb.spec.twoThetaDeg === undefined && <small> Ω-weighted</small>}
                  </dd>
                </div>
                <div>
                  <dt>L1 + L2</dt>
                  <dd>
                    {fmt(l1 + fb.bank.l2, 3)} <small>m</small>
                  </dd>
                </div>
                <div>
                  <dt>DIFC</dt>
                  <dd>
                    {fmt(fb.bank.difc, 1)} <small>µs/Å</small>
                  </dd>
                </div>
                <div>
                  <dt>d range</dt>
                  <dd>
                    {fmt(fb.bank.dMin, 3)}–{fmt(fb.bank.dMax, 2)} <small>Å</small>
                  </dd>
                </div>
                <div>
                  <dt>Solid angle</dt>
                  <dd>
                    {fmt(fb.bank.omega, 3)} <small>sr</small>
                  </dd>
                </div>
              </dl>
              {fb.missing.length > 0 && <p className="warn-note">Not in this instrument definition: {fb.missing.join(", ")}.</p>}
              <p className="empty-note">
                TOF window {fmt(fb.bank.difc * fb.bank.dMin, 0)}–{fmt(fb.bank.difc * fb.bank.dMax, 0)} µs on the focused DIFC · {peaks.length.toLocaleString()} peaks.
              </p>
              <DMinNote result={result} info={info} lambdaMin={exp.lambdaMin} onDMin={onDMin} />
            </Card>
          ) : (
          <Card title="Panel" meta={panels[panel]!.name} info={`The pattern above is for this panel. ${instrument.source}`}>
            <div className="form-rows">
              <label className="form-row">
                <span className="ui-control-label">Panel</span>
                <select className="ui-select" aria-label="Panel" value={panel} onChange={(e) => pickPanel(Number(e.target.value))}>
                  {panelOrder.map(({ a, i }) => (
                    <option key={i} value={i}>
                      {panels[i]!.name} · 2θ {fmt(a.twoThetaCenter, 1)}°
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <dl className="ui-stats ui-stats--three" style={{ marginTop: "0.6rem" }}>
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
                <div>
                  <dt>Elastic TOF</dt>
                  <dd>
                    {fmt(tofFromWavelength(l1 + pa.l2, lambda0), 0)} <small>µs</small>
                  </dd>
                </div>
              ) : (
                <div>
                  <dt>d range</dt>
                  <dd>
                    {fmt(seen.dMin, 3)}–{fmt(seen.dMax, 2)} <small>Å</small>
                  </dd>
                </div>
              )}
            </dl>
            {!mono && (
              <p className="empty-note">
                TOF window {fmt(bank.difc * seen.dMin, 0)}–{fmt(bank.difc * seen.dMax, 0)} µs at the panel centre · {peaks.length.toLocaleString()} peaks.
              </p>
            )}
            <DMinNote result={result} info={info} lambdaMin={exp.lambdaMin} onDMin={onDMin} />
          </Card>
          )}
        </div>
      </div>
    </div>
  );
}
