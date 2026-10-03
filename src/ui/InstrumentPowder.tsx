/**
 * Powder page for an SNS instrument (Simulation): the pattern one panel
 * records (time of flight at its centre angle, DIFC from L1 + L2), or the
 * elastic 2θ pattern over all panels for a chopper spectrometer, with the
 * 2θ–d coverage of the whole detector array.
 */
import { useEffect, useMemo, useState } from "react";
import { cwPeaks } from "../core/diffraction/powder.ts";
import { synthesizeTof, tofFromWavelength, tofPeaks, type TofBank } from "../core/diffraction/tof.ts";
import { elasticPattern } from "../core/instrument/powderRings.ts";
import { coveredTwoTheta, dRangeAt, panelDifc } from "../core/instrument/simulate.ts";
import { angleCss } from "../views/colormaps.ts";
import { Card, Segmented } from "./components.tsx";
import { CoverageChart, type CoverageLine } from "./CoverageChart.tsx";
import { fmt, hklText } from "./format.ts";
import { PowderPlot } from "./PowderPlot.tsx";
import { DMinNote, defaultPanel, InstrumentRequired, lam, usePowderGroups, useSnsInstrument, type SimPageProps } from "./snsShared.tsx";

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
  const peaks = useMemo(
    () =>
      !bank
        ? []
        : mono
          ? cwPeaks(groups, { wavelength: lambda0, lorentz: true, polarization: { kind: "none" } }).filter((p) => covered.some(([a, b]) => p.twoTheta! >= a && p.twoTheta! <= b))
          : tofPeaks(groups, bank),
    [mono, groups, bank, lambda0, covered],
  );
  const profile = useMemo(
    () => (!bank ? { x: new Float64Array(), y: new Float64Array() } : mono ? elasticPattern(peaks, Math.hypot(exp.dOverD, exp.eRes / 2), covered) : synthesizeTof(peaks, bank, { kind: "gaussian", dOverD: exp.dOverD }, axis)),
    [mono, peaks, bank, exp.dOverD, exp.eRes, covered, axis],
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
  const pickPanel = (i: number) => onExp({ ...exp, panel: i });

  return (
    <div className="ui-stack">
      <Card
        title={mono ? `Elastic powder pattern · ${instrument.goniometer.label}` : `Powder pattern · ${instrument.goniometer.label} ${panels[panel]!.name}`}
        meta={
          mono
            ? `λ ${fmt(lambda0, 4)} Å · 2θ ${fmt(covered[0]?.[0] ?? 0, 1)}–${fmt(covered.at(-1)?.[1] ?? 0, 1)}° · zero in detector gaps`
            : `2θ ${fmt(pa.twoThetaCenter, 2)}° · DIFC ${fmt(bank.difc, 1)} µs/Å · Δd/d ${Number((100 * exp.dOverD).toPrecision(6))} %`
        }
        info={
          mono
            ? "Elastic intensity per unit solid angle against 2θ over all panels, as a chopper spectrometer records it at the elastic line: I = Σ|F|²/(sin²θ cosθ) (CW powder Lorentz factor, no polarization for neutrons), each peak a Gaussian of FWHM 2·tanθ·√((Δd/d)² + (ΔE/2E)²); zero where no panel covers 2θ. Click a peak to select it in the coverage chart."
            : "Neutron TOF pattern of the selected panel treated as one bank at its centre angle: DIFC = 252.778·(L1 + L2)·2 sinθ µs/Å (no DIFA, ZERO; real banks are calibrated). I = Σ|F|²·sinθ·d⁴ (GSAS-II TOF Lorentz factor, incident spectrum normalised out), Gaussian peaks of constant Δd/d on a logarithmic TOF grid. Pick another panel below, in the coverage strip, or on the Detectors page."
        }
        actions={mono ? undefined : <Segmented label="Axis" value={axis} onChange={setAxis} options={[{ value: "tof", label: "TOF" }, { value: "d", label: "d" }]} />}
      >
        {peaks.length ? (
          <PowderPlot peaks={peaks} profile={profile} axis={mono ? "twoTheta" : axis} selected={peakSel >= 0 ? peakSel : null} onSelect={(i) => setSel(i === null ? null : (groupOfD.get(peaks[i]!.d) ?? null))} showSticks={false} />
        ) : (
          <p className="empty-note">{mono ? "No reflection lands on the detectors at this Ei (or above d_min)." : `No reflections fall in this panel's d range (${fmt(seen.dMin, 3)}–${fmt(seen.dMax, 2)} Å) above d_min.`}</p>
        )}
        <p className="plot-hint">Click a peak or tick to select it · drag to zoom · double-click to reset</p>
      </Card>

      <div className="ui-grid ui-grid--split">
        <Card
          title="d coverage"
          meta={`λ ${lam(exp.lambdaMin)}–${lam(exp.lambdaMax)} Å`}
          info="A detector at 2θ records d from λmin/(2 sinθ) to λmax/(2 sinθ): the shaded band, darker where panels are. Each reflection is a line over the 2θ range where it diffracts, darker when stronger (Σ|F|² over its equivalents). The strip below the axis shows each panel's 2θ span in its colour. Click a line to select a reflection, a panel in the strip to simulate it."
        >
          <CoverageChart lambdaMin={exp.lambdaMin} lambdaMax={exp.lambdaMax} panels={info} panelColors={colorsCss} lines={lines} selected={sel} onSelect={setSel} selectedPanel={panel} onPanelPick={pickPanel} dFloor={result.provenance.dMin} />
        </Card>
        <div className="ui-stack">
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
        </div>
      </div>
    </div>
  );
}
