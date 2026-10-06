/**
 * Powder page for an SNS instrument (Simulation): the pattern of a focused bank
 * as the data are reduced (NOMAD, POWGEN; src/core/instrument/focus.ts), or of
 * one panel (time of flight at its centre angle, DIFC from L1 + L2), or the
 * elastic 2θ pattern over all panels for a chopper spectrometer, with the
 * 2θ–d coverage of the whole detector array.
 */
import { useEffect, useMemo, useState } from "react";
import { cwPeaks } from "../core/diffraction/powder.ts";
import { backToBackFwhm, backToBackValidFrom, synthesizeTof, tofFromWavelength, tofPeaks, type TofBank, type TofShape } from "../core/diffraction/tof.ts";
import { focusedBank, focusedPeaks, focusedTofBank, recordsD } from "../core/instrument/focus.ts";
import type { ChopperFrame } from "../core/ub/instruments.ts";
import { elasticPattern } from "../core/instrument/powderRings.ts";
import { coveredTwoTheta, dRangeAt, panelDifc } from "../core/instrument/simulate.ts";
import { angleCss } from "../views/colormaps.ts";
import { Card, Segmented } from "./components.tsx";
import { CoverageChart, type CoverageLine } from "./CoverageChart.tsx";
import { downloadText, exact, fmt, hklText } from "./format.ts";
import { PowderPlot } from "./PowderPlot.tsx";
import { AcceptanceNote, DOverDField, defaultPanel, InstrumentRequired, lam, LOWEST_SUGGESTED_DMIN, suggestDMin, usePowderGroups, useSnsInstrument, type SimPageProps } from "./snsShared.tsx";

/** GSAS-II TOF profile of a POWGEN frame, held at the shortest d where the fitted parameters are physical. */
function frameShape(pr: NonNullable<ChopperFrame["profile"]>): Extract<TofShape, { kind: "backToBack" }> {
  const base = { kind: "backToBack" as const, alpha1: pr.alpha, beta0: pr.beta0, beta1: pr.beta1, betaq: pr.betaq, sig0: pr.sig0, sig1: pr.sig1, sig2: pr.sig2, sigq: pr.sigq };
  const validFrom = backToBackValidFrom(base);
  return { ...base, ...(validFrom !== undefined ? { validFrom } : {}) };
}

/** FWHM in d (Å) of a line at d for a TOF peak shape on a bank of the given DIFC. */
const fwhmInD = (shape: TofShape, difc: number, d: number) => (shape.kind === "gaussian" ? shape.dOverD * d : backToBackFwhm(shape, d) / difc);

export function InstrumentPowder(props: SimPageProps) {
  const { result, exp, onExp, onDMin } = props;
  // Panels carry the user's masks; the sample stays put, so the environment's shadows are those at the current setting.
  const { instrument, panels, info, l1, blocked, shadows } = useSnsInstrument(exp);
  const { groups, groupOfD } = usePowderGroups(result);
  const [sel, setSel] = useState<number | null>(null);
  const [axis, setAxis] = useState<"tof" | "d" | "q">("tof");
  useEffect(() => setSel(null), [groups]);
  const colorsCss = useMemo(() => info.map((a, i) => (panels[i]?.off ? "var(--border-strong)" : angleCss(a.twoThetaCenter))), [info, panels]);
  const covered = useMemo(() => coveredTwoTheta(info.filter((_, i) => !panels[i]?.off)), [info, panels]);
  const panel = exp.panel !== null && exp.panel < panels.length ? exp.panel : panels.length ? defaultPanel(info.map((a, i) => (panels[i]!.off ? { twoThetaCenter: Infinity } : a))) : 0;
  const panelOff = panels[panel]?.off === true;
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
        return {
          spec,
          idx,
          missing,
          bank: focusedBank(spec.name, idx.map((i) => panels[i]!), l1, exp.lambdaMin, exp.lambdaMax, {
            ...(spec.twoThetaDeg !== undefined ? { twoThetaDeg: spec.twoThetaDeg } : {}),
            ...(spec.l2 !== undefined ? { l2: spec.l2 } : {}),
            ...(spec.difc !== undefined ? { difc: spec.difc } : {}),
            ...(blocked ? { blocked } : {}),
          }),
        };
      }).filter((f) => f.idx.length > 0 && f.bank.omega > 0), // a bank masked or shadowed throughout records nothing
    [specs, panels, l1, exp.lambdaMin, exp.lambdaMax, blocked],
  );
  const byBank = focused.length > 0 && exp.powderView === "bank";
  const bankIndex = exp.bank !== null && exp.bank < focused.length ? exp.bank : focused.reduce((best, f, i) => (Math.abs(f.bank.twoThetaDeg - 90) < Math.abs(focused[best]!.bank.twoThetaDeg - 90) ? i : best), 0);
  const fb = byBank ? focused[bankIndex] : undefined;
  // The focused axis ends a little past the longest calculated spacing, not at the bank's (possibly far larger) d limit.
  const longestD = useMemo(() => Math.max(0, ...groups.map((g) => g.d)), [groups]);
  const drawBank = useMemo(() => (fb ? focusedTofBank(fb.bank, longestD > 0 ? { dMax: longestD * 1.15 } : {}) : bank), [fb, bank, longestD]);
  const peaks = useMemo(
    () =>
      !bank || (panelOff && !mono && !fb)
        ? []
        : mono
          ? cwPeaks(groups, { wavelength: lambda0, lorentz: true, polarization: { kind: "none" } }).filter((p) => covered.some(([a, b]) => p.twoTheta! >= a && p.twoTheta! <= b))
          : fb
            ? focusedPeaks(groups, fb.bank, exp.lambdaMin, exp.lambdaMax)
            : tofPeaks(groups, bank),
    [mono, groups, bank, lambda0, covered, fb, exp.lambdaMin, exp.lambdaMax, panelOff],
  );
  // Peak widths from the instrument where published: NOMAD's measured Δd/d per bank, or the GSAS-II
  // profile of POWGEN's chosen frame (d-dependent, back-to-back exponentials ⊗ Gaussian).
  const frame = instrument?.frames?.list.find((f) => Math.abs(f.lambdaMin - exp.lambdaMin) < 1e-6 && Math.abs(f.lambdaMax - exp.lambdaMax) < 1e-6);
  const instrumentWidth = useMemo((): { shape: TofShape; label: string; detail: string } | undefined => {
    if (!fb) return undefined;
    if (fb.spec.dOverD !== undefined)
      return { shape: { kind: "gaussian", dOverD: fb.spec.dOverD }, label: `Δd/d ${Number((100 * fb.spec.dOverD).toPrecision(3))} % (measured)`, detail: `Gaussian peaks of the bank's measured FWHM Δd/d = ${fb.spec.dOverD}` };
    const pr = frame?.profile;
    if (!pr) return undefined;
    const shape = frameShape(pr);
    const validFrom = shape.validFrom;
    const rel = (d: number) => backToBackFwhm(shape, d) / (fb.bank.difc * d);
    const d1 = Math.max(validFrom ?? 0, 0.5);
    return {
      shape,
      label: `Δd/d ${fmt(100 * rel(d1), 2)} % at ${d1} Å to ${fmt(100 * rel(4), 2)} % at 4 Å (${frame!.centre} Å frame)`,
      detail: `GSAS-II TOF profile of the ${frame!.centre} Å frame, ${pr.file}${validFrom !== undefined ? `; below ${fmt(validFrom, 3)} Å the fitted parameters are unphysical and those at ${fmt(validFrom, 3)} Å are used` : ""}`,
    };
  }, [fb, frame]);
  const widthFromInstrument = exp.peakWidth === "instrument" && instrumentWidth !== undefined;
  const tofShape: TofShape = widthFromInstrument ? instrumentWidth!.shape : { kind: "gaussian", dOverD: exp.dOverD };
  const widthLabel = widthFromInstrument ? instrumentWidth!.label : `Δd/d ${Number((100 * exp.dOverD).toPrecision(6))} %`;
  const profile = useMemo(
    () => (!bank || !drawBank ? { x: new Float64Array(), y: new Float64Array() } : mono ? elasticPattern(peaks, Math.hypot(exp.dOverD, exp.eRes / 2), covered) : synthesizeTof(peaks, drawBank, tofShape, axis)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mono, peaks, bank, drawBank, exp.dOverD, exp.eRes, covered, axis, widthFromInstrument, instrumentWidth],
  );
  const lines = useMemo<CoverageLine[]>(() => groups.map((x) => ({ d: x.d, weight: x.sumF2, label: x.families.map((f) => `(${hklText(f.hkl)})`).join(" + ") })), [groups]);
  const panelOrder = useMemo(() => info.map((a, i) => ({ a, i })).sort((x, y) => x.a.twoThetaCenter - y.a.twoThetaCenter), [info]);
  // For a selected line: its width here, whether the nearest line is at least one FWHM away (separated), and the
  // sharpest bank (NOMAD) or POWGEN frame that records it, with the widths in use.
  const selNote = useMemo(() => {
    if (sel === null || mono || !bank) return null;
    const g = groups[sel];
    if (!g) return null;
    const name = (x: { families: readonly { hkl: readonly number[] }[] }) => x.families.map((f) => `(${hklText(f.hkl)})`).join(" + ");
    const parts = [`${name(g)} at d ${fmt(g.d, 4)} Å`];
    const difcHere = fb ? fb.bank.difc : bank.difc;
    if (!peaks.some((q) => q.d === g.d)) parts.push(fb ? "not recorded by this bank" : "not recorded by this panel");
    else {
      const w = fwhmInD(tofShape, difcHere, g.d);
      parts.push(`FWHM ${fmt((100 * w) / g.d, 2)} % here`);
      let near: (typeof peaks)[number] | undefined;
      for (const q of peaks) if (q.d !== g.d && (!near || Math.abs(q.d - g.d) < Math.abs(near.d - g.d))) near = q;
      if (near) {
        const sep = Math.abs(near.d - g.d);
        parts.push(`nearest line ${name(near)} ${fmt((100 * sep) / g.d, 2)} % away: ${sep >= w ? "separated (≥ 1 FWHM)" : `overlapping (${fmt(sep / w, 2)} FWHM)`}`);
      }
    }
    if (byBank && focused.length > 1) {
      const options = focused
        .filter((f) => recordsD(f.bank, g.d, exp.lambdaMin, exp.lambdaMax))
        .map((f) => ({ label: f.spec.name, rel: exp.peakWidth === "instrument" && f.spec.dOverD !== undefined ? f.spec.dOverD : exp.dOverD }));
      const best = options.reduce<(typeof options)[number] | undefined>((b, o) => (!b || o.rel < b.rel ? o : b), undefined);
      if (best) parts.push(`sharpest bank recording it: ${best.label} (${fmt(100 * best.rel, 2)} %)`);
    } else if (byBank && exp.peakWidth === "instrument" && instrument?.frames) {
      const options = instrument.frames.list
        .filter((f) => f.profile && g.d >= f.dMin && g.d <= f.dMax)
        .map((f) => ({ label: `${f.centre} Å`, rel: fwhmInD(frameShape(f.profile!), difcHere, g.d) / g.d }));
      const best = options.reduce<(typeof options)[number] | undefined>((b, o) => (!b || o.rel < b.rel ? o : b), undefined);
      if (best) parts.push(`sharpest POWGEN frame for it: ${best.label} (${fmt(100 * best.rel, 2)} %)`);
    }
    return parts.join(" · ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, mono, groups, peaks, fb, bank, tofShape, byBank, focused, exp.peakWidth, exp.dOverD, exp.lambdaMin, exp.lambdaMax, instrument]);

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
          : axis === "d"
            ? { from: reach, to: calcDMin }
            : { from: (2 * Math.PI) / calcDMin, to: (2 * Math.PI) / reach }
      : undefined;
  // In the bank view a panel picks the bank it belongs to (or switches to that panel when it is in none).
  const pickPanel = (i: number) => {
    if (byBank) {
      const k = focused.findIndex((f) => f.idx.includes(i));
      onExp(k >= 0 ? { ...exp, bank: k } : { ...exp, panel: i, powderView: "panel" });
    } else onExp({ ...exp, panel: i });
  };

  // ---------------------------------------------------------------- export (peaks and profile, with what they were computed for)
  const what = mono
    ? `${instrument.goniometer.label} elastic powder pattern; lambda ${lambda0} A; 2theta ${fmt(covered[0]?.[0] ?? 0, 2)}-${fmt(covered.at(-1)?.[1] ?? 0, 2)} deg (zero in detector gaps); intensity per solid angle sumF2/(sin^2 th cos th)`
    : fb
      ? `${instrument.goniometer.label} ${fb.spec.name} focused (${fb.idx.length} panels: ${fb.spec.panels.join(" ")}); effective 2theta ${fb.bank.twoThetaDeg} deg, L1 ${l1} m, L2 ${fb.bank.l2} m, DIFC ${exact(fb.bank.difc)} us/A; I = sumF2*d^4*sin(th_f) at the effective angle (vanadium-normalised: angle and solid angle cancel cell by cell), lines recorded by some cell`
      : `${instrument.goniometer.label} ${panels[panel]!.name} as one bank at 2theta ${exact(pa.twoThetaCenter)} deg, L1+L2 ${exact(l1 + pa.l2)} m, DIFC ${exact(bank.difc)} us/A; I = sumF2*sin(th)*d^4`;
  const provenance = `# NEXPLAN; ${result.structure.name || result.blockName} (data_${result.blockName}), input sha256 ${result.provenance.inputSha256}; lambda band ${exp.lambdaMin}-${exp.lambdaMax} A; d_min ${calcDMin} A; dd/d ${exp.dOverD}`;
  const exportPeaks = () => {
    const lines = [
      provenance,
      `# ${what}`,
      // A focused bank's line is recorded by many cells at different wavelengths: its TOF is a coordinate on the
      // focused DIFC (as in Mantid's focused output), and no single λ applies.
      `d_A,${mono ? "two_theta_deg" : fb ? "tof_us_on_focused_difc" : "tof_us,lambda_A"},sumF2,lorentz,intensity,families`,
      ...peaks.map((pk) => [exact(pk.d), ...(mono ? [exact(pk.twoTheta!)] : fb ? [exact(pk.tof!)] : [exact(pk.tof!), exact(pk.lambda!)]), exact(pk.sumF2), exact(pk.lp), exact(pk.intensity), `"${pk.families.map((f) => `(${f.hkl.join(" ")})x${f.multiplicity}`).join(" + ")}"`].join(",")),
    ];
    downloadText(`${result.blockName}-${instrument.id}-${fb ? fb.spec.name.replace(/\W+/g, "") : mono ? "elastic" : panels[panel]!.name}-peaks.csv`, lines.join("\n") + "\n", "text/csv");
  };
  const exportProfile = () => {
    const unit = mono ? "two_theta_deg" : axis === "tof" ? "tof_us" : axis === "d" ? "d_A" : "Q_invA";
    const shapeText = mono ? `Gaussian peaks of FWHM dd/d combined with dE/2E` : widthFromInstrument ? instrumentWidth!.detail : `Gaussian peaks of FWHM dd/d = ${exp.dOverD}`;
    const lines = [provenance, `# ${what}; ${shapeText}; area-normalised x intensity`, `${unit},intensity`];
    for (let i = 0; i < profile.x.length; i++) lines.push(`${exact(profile.x[i]!)},${exact(profile.y[i]!)}`);
    downloadText(`${result.blockName}-${instrument.id}-${fb ? fb.spec.name.replace(/\W+/g, "") : mono ? "elastic" : panels[panel]!.name}-profile.csv`, lines.join("\n") + "\n", "text/csv");
  };

  return (
    <div className="ui-stack">
      <Card
        title={mono ? `Elastic powder pattern · ${instrument.goniometer.label}` : fb ? `Powder pattern · ${instrument.goniometer.label} ${fb.spec.name}` : `Powder pattern · ${instrument.goniometer.label} ${panels[panel]!.name}`}
        meta={
          mono
            ? `λ ${fmt(lambda0, 4)} Å · 2θ ${fmt(covered[0]?.[0] ?? 0, 1)}–${fmt(covered.at(-1)?.[1] ?? 0, 1)}° · zero in detector gaps`
            : fb
              ? `focused, ${fb.idx.length} panels · 2θ ${fmt(fb.bank.twoThetaDeg, 1)}° (${fmt(fb.bank.twoThetaMin, 0)}–${fmt(fb.bank.twoThetaMax, 0)}°) · DIFC ${fmt(fb.bank.difc, 1)} µs/Å · ${widthLabel}`
              : `2θ ${fmt(pa.twoThetaCenter, 2)}° · DIFC ${fmt(bank.difc, 1)} µs/Å · Δd/d ${Number((100 * exp.dOverD).toPrecision(6))} %`
        }
        info={
          mono
            ? "Elastic intensity per unit solid angle against 2θ over all panels, as a chopper spectrometer records it at the elastic line: I = Σ|F|²/(sin²θ cosθ) (CW powder Lorentz factor, no polarization for neutrons), each peak a Gaussian of FWHM 2·tanθ·√((Δd/d)² + (ΔE/2E)²); zero where no panel covers 2θ. Click a peak to select it in the coverage chart."
            : fb
              ? "Neutron TOF pattern of a focused bank, as the data are reduced: the bank's panels are split into cells, each recording d from λmin/(2 sinθ) to λmax/(2 sinθ) at its own angle; after focusing and vanadium normalisation the angle, solid angle and incident spectrum cancel cell by cell, so a line at d has I = Σ|F|²·d⁴·sinθ_f on the focused TOF axis (the GSAS-II TOF Lorentz factor at the effective angle θ_f), wherever some cell records it. Drawn on the bank's calibrated DIFC where ORNL publishes one, else DIFC = 252.778·(L1 + L2)·2 sinθ µs/Å with the effective 2θ and L2 (no DIFA, ZERO). Peak widths: the instrument's published resolution (NOMAD's measured Δd/d per bank; POWGEN's GSAS-II profile for the chosen frame, which widens with d), or a constant Δd/d set beside them."
              : "Neutron TOF pattern of the selected panel treated as one bank at its centre angle: DIFC = 252.778·(L1 + L2)·2 sinθ µs/Å (no DIFA, ZERO; real banks are calibrated). I = Σ|F|²·sinθ·d⁴ (GSAS-II TOF Lorentz factor, incident spectrum normalised out), Gaussian peaks of constant Δd/d on a logarithmic TOF grid. Pick another panel below, in the coverage strip, or on the Detectors page."
        }
        actions={
          <>
            {!mono && focused.length > 0 && <Segmented label="Pattern of" value={exp.powderView} onChange={(v) => onExp({ ...exp, powderView: v })} options={[{ value: "bank", label: "Focused bank" }, { value: "panel", label: "One panel" }]} />}
            {!mono && instrumentWidth && (
              <span title={`Peak widths: ${instrumentWidth.detail}, or a constant Δd/d`}>
                <Segmented label="Peak widths" value={exp.peakWidth} onChange={(v) => onExp({ ...exp, peakWidth: v })} options={[{ value: "instrument", label: "Instrument" }, { value: "fixed", label: "Δd/d" }]} />
              </span>
            )}
            {!widthFromInstrument && <DOverDField exp={exp} onExp={onExp} />}
            {!mono && <Segmented label="Axis" value={axis} onChange={setAxis} options={[{ value: "tof", label: "TOF" }, { value: "d", label: "d" }, { value: "q", label: "Q" }]} />}
          </>
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
            shade={cutoff ? { ...cutoff, label: !mono && axis === "q" ? `Q > ${fmt((2 * Math.PI) / calcDMin, 3)} Å⁻¹: not calculated` : `d < ${calcDMin} Å: not calculated` } : undefined}
          />
        ) : (
          <p className="empty-note">{mono ? "No reflection lands on the detectors at this Ei (or above d_min)." : fb ? `No reflections fall in this bank's d range (${fmt(fb.bank.dMin, 3)}–${fmt(fb.bank.dMax, 2)} Å) above d_min.` : panelOff ? `${panels[panel]!.name} is switched off (Masks and shadows, on the Detectors page).` : `No reflections fall in this panel's d range (${fmt(seen.dMin, 3)}–${fmt(seen.dMax, 2)} Å) above d_min.`}</p>
        )}
        {selNote && <p className="selection-note">{selNote}</p>}
        <div className="plot-footer">
          <p className="plot-hint">Click a peak or tick to select it · drag to zoom · double-click to reset</p>
          {peaks.length > 0 && (
            <span className="ui-controls ui-controls--inline">
              <button type="button" className="ui-pill" onClick={exportPeaks} title="Every line with d, position, Σ|F|², Lorentz factor, intensity and hkl, with what it was computed for">
                Peaks CSV
              </button>
              <button type="button" className="ui-pill" onClick={exportProfile} title="The drawn pattern on its axis, with what it was computed for">
                Profile CSV
              </button>
            </span>
          )}
        </div>
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
              <AcceptanceNote panels={panels} shadows={shadows} />
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
            <AcceptanceNote panels={panels} shadows={shadows} />
          </Card>
          )}
        </div>
      </div>
    </div>
  );
}
