import { lazy, Suspense, useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { CalcInput, CalcResult, CalcSuccess, TofInput } from "../app/compute.ts";
import { APP_VERSION } from "../app/version.ts";
import type { Polarization, PowderAxis } from "../core/diffraction/powder.ts";
import { difcFromGeometry, type TofShape } from "../core/diffraction/tof.ts";
import { neutronEnergyMeV, neutronWavelengthA, xrayEnergyKeV, xrayWavelengthA } from "../core/physics/energy.ts";
import { calculate } from "../workers/client.ts";
import { Chip, cx, InfoBadge, Segmented, UnitField } from "./components.tsx";
import { DEMOS } from "./demos.ts";
import { CATALOG_GROUPS, GENERIC_INSTRUMENT } from "../core/ub/instrumentCatalog.ts";
import { catalogEntry, chooseInstrument, DEFAULT_EXPERIMENT, sampleKind, withEi, type ExperimentState } from "./experimentState.ts";
import { PowderPage, ReflectionsPage, StructurePage, type CwProfileSettings } from "./pages.tsx";
import { DEFAULT_GONIO, UbPage, type GonioState, type UbState } from "./UbPage.tsx";

type Tab = "structure" | "reflections" | "orientation" | "detectors" | "powder" | "crystal";

/** Pages, grouped as the work goes: what the sample is, how it is set up, what the instrument records. */
const TAB_GROUPS: readonly { readonly label: string; readonly tabs: readonly (readonly [Tab, string])[] }[] = [
  { label: "Sample", tabs: [["structure", "Structure"], ["reflections", "Reflections"]] },
  { label: "Setup", tabs: [["orientation", "Orientation"]] },
  { label: "Simulation", tabs: [["detectors", "Detectors"], ["powder", "Powder"], ["crystal", "Single crystal"]] },
];

/** Simulation pages, loaded with the SNS detector geometry only when one is opened. */
const DetectorsPage = lazy(() => import("./DetectorsPage.tsx").then((m) => ({ default: m.DetectorsPage })));
const InstrumentPowder = lazy(() => import("./InstrumentPowder.tsx").then((m) => ({ default: m.InstrumentPowder })));
const CrystalPage = lazy(() => import("./CrystalPage.tsx").then((m) => ({ default: m.CrystalPage })));
type Theme = "light" | "dark";
type Radiation = "xray" | "neutron";

const WAVELENGTHS: { label: string; value: number; radiation: Radiation }[] = [
  { label: "Cu Kα1", value: 1.540593, radiation: "xray" },
  { label: "Mo Kα1", value: 0.709317, radiation: "xray" },
  { label: "Ag Kα1", value: 0.5594075, radiation: "xray" },
  { label: "Co Kα1", value: 1.788965, radiation: "xray" },
  { label: "Thermal 1.5 Å", value: 1.5, radiation: "neutron" },
  { label: "2200 m/s, 1.798 Å", value: 1.798, radiation: "neutron" },
];

/** A generic 90° bank; not any instrument's calibration. */
const DEFAULT_TOF: TofInput = { twoThetaDeg: 90, flightPathM: 20, difa: 0, zero: 0, lambdaMin: 0.5, lambdaMax: 3.5, shape: { kind: "gaussian", dOverD: 0.003 } };

function readTheme(): Theme {
  try {
    // "scatterplan-theme" is the key used before the rename to NEXPLAN.
    return (localStorage.getItem("nexplan-theme") ?? localStorage.getItem("scatterplan-theme")) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const README = "https://github.com/drthyang/nexplan#readme";

export function App() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("nexplan-theme", theme);
    } catch {
      /* storage unavailable: theme still applies for this session */
    }
  }, [theme]);

  const [showNotice, setShowNotice] = useState(() => {
    try {
      return localStorage.getItem("nexplan-notice") !== "hidden";
    } catch {
      return true;
    }
  });
  const hideNotice = () => {
    setShowNotice(false);
    try {
      localStorage.setItem("nexplan-notice", "hidden");
    } catch {
      /* storage unavailable: hidden for this session only */
    }
  };

  const [tab, setTab] = useState<Tab>("structure");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [blockName, setBlockName] = useState<string | undefined>();
  const [chosenSetting, setChosenSetting] = useState<string | undefined>();
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [xrayIons, setXrayIons] = useState<Record<string, string>>({});
  const [radiation, setRadiation] = useState<Radiation>("neutron");
  const [neutronMode, setNeutronMode] = useState<"cw" | "tof">("cw");
  const [wavelength, setWavelength] = useState(1.5);
  const [tof, setTof] = useState<TofInput>(DEFAULT_TOF);
  const [dMin, setDMin] = useState(0.8);
  const [polarization, setPolarization] = useState<Polarization>({ kind: "unpolarized" });
  const [axis, setAxis] = useState<PowderAxis>("twoTheta");
  const [cwProfile, setCwProfile] = useState<CwProfileSettings>({ fwhm: 0.1, eta: 0.5 });
  const [ub, setUb] = useState<UbState>({ warnings: [] });
  const [gonio, setGonio] = useState<GonioState>(DEFAULT_GONIO);
  const [experiment, setExperiment] = useState<ExperimentState>(DEFAULT_EXPERIMENT);
  const [result, setResult] = useState<CalcResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const isTof = radiation === "neutron" && neutronMode === "tof";

  const loadText = useCallback((name: string, text: string) => {
    setFile({ name, text });
    setBlockName(undefined);
    setChosenSetting(undefined);
    setOverrides({});
    setXrayIons({});
    setTab("structure");
  }, []);

  const onFiles = useCallback(
    async (files: FileList | null) => {
      const f = files?.[0];
      if (!f) return;
      if (f.size > 20 * 1024 * 1024) {
        setResult({ ok: false, stage: "input", message: `${f.name} is ${(f.size / 1048576).toFixed(1)} MB; CIF files over 20 MB are not accepted.` });
        return;
      }
      loadText(f.name, await f.text());
    },
    [loadText],
  );

  // Recalculate (debounced) whenever an input changes. The worker drops stale runs.
  useEffect(() => {
    if (!file) return;
    const input: CalcInput = {
      cifText: file.text,
      fileName: file.name,
      ...(blockName ? { blockName } : {}),
      ...(chosenSetting ? { chosenSetting } : {}),
      ...(Object.keys(overrides).length ? { speciesOverrides: overrides } : {}),
      ...(Object.keys(xrayIons).length ? { xrayIons } : {}),
      radiation,
      wavelength,
      dMin,
      polarization,
      profile: { axis, fwhm: cwProfile.fwhm, eta: cwProfile.eta },
      neutronMode,
      tof,
    };
    const t = setTimeout(() => {
      setBusy(true);
      void calculate(input).then((r) => {
        if (r) {
          setResult(r);
          setBusy(false);
        }
      });
    }, 120);
    return () => clearTimeout(t);
  }, [file, blockName, chosenSetting, overrides, xrayIons, radiation, wavelength, dMin, polarization, axis, cwProfile, neutronMode, tof]);

  // Keep the CW FWHM sensible when switching axes.
  const changeAxis = (a: PowderAxis) => {
    setAxis(a);
    if (a !== "tof") setCwProfile((p) => ({ ...p, fwhm: a === "twoTheta" ? 0.1 : a === "d" ? 0.002 : 0.01 }));
  };
  const changeRadiation = (r: Radiation) => {
    setRadiation(r);
    setWavelength(r === "xray" ? 1.540593 : 1.5);
    if (r === "xray") {
      setNeutronMode("cw");
      if (axis === "tof") setAxis("twoTheta");
    }
  };
  const changeNeutronMode = (m: "cw" | "tof") => {
    setNeutronMode(m);
    setAxis(m === "tof" ? "tof" : "twoTheta");
  };

  // An SNS instrument in the header means neutron scattering with that instrument's beam.
  const entry = catalogEntry(experiment.instrumentId);
  const sns = entry !== undefined;
  useEffect(() => {
    if (sns && radiation !== "neutron") changeRadiation("neutron");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sns, radiation]);

  const ok: CalcSuccess | undefined = result?.ok ? result : undefined;
  // SNS simulations need the neutron calculation (the switch to neutrons above may still be running).
  const simReady = ok !== undefined && (!sns || ok.provenance.settings.radiation === "neutron");
  const simProps = ok ? { result: ok, theme, ub, exp: experiment, onExp: setExperiment, onDMin: setDMin, onOpenOrientation: () => setTab("orientation") } : undefined;
  const preset = WAVELENGTHS.find((w) => w.value === wavelength && w.radiation === radiation);
  const difc = tof.difcOverride ?? difcFromGeometry(tof.flightPathM, tof.twoThetaDeg);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void onFiles(e.dataTransfer.files);
  };

  return (
    <div className="app-container" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <main className="main-content">
        <header className="app-header">
          <div className="header-primary">
            <div className="brand-row">
              <div className="brand-mark" aria-hidden="true">
                {/* Ring and spot: the direct beam and one diffracted spot. */}
                <svg className="brand-mark-icon" viewBox="0 0 100 100">
                  <circle cx="36" cy="64" r="20" fill="none" stroke="currentColor" strokeWidth="12" />
                  <circle cx="76" cy="24" r="14" fill="currentColor" />
                </svg>
              </div>
              <div className="brand-copy">
                <h1 title="NEXPLAN · Neutron Experiment Planner">NEXPLAN</h1>
              </div>
              <span className="beta-pill">
                beta<span className="ver">v{APP_VERSION}</span>
              </span>
            </div>
            <nav className="page-tabs" aria-label="Pages">
              {TAB_GROUPS.map((g) => (
                <div key={g.label} className="tab-group" role="group" aria-label={g.label}>
                  <span className="tab-group__label">{g.label}</span>
                  <div className="ui-seg ui-seg--nav">
                    {g.tabs.map(([id, label]) => (
                      <button key={id} type="button" className={cx(tab === id && "is-active")} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </div>
          <div className="header-actions">
            <label className="instrument-pick" title="The instrument sets the beam, goniometer and detectors used on every page">
              <span className="ui-control-label">Instrument</span>
              <select className="ui-select" aria-label="Instrument" value={experiment.instrumentId} onChange={(e) => setExperiment(chooseInstrument(experiment, e.target.value))}>
                <option value={GENERIC_INSTRUMENT}>Generic beam</option>
                {CATALOG_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.list.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <select
              className="ui-select"
              aria-label="Load a demo structure"
              value=""
              onChange={(e) => {
                const d = DEMOS.find((x) => x.id === e.target.value);
                if (d) loadText(d.file, d.text);
              }}
            >
              <option value="">Demo structures…</option>
              {DEMOS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <button type="button" className="ui-btn-brand" onClick={() => fileInput.current?.click()}>
              Load CIF…
            </button>
            <input ref={fileInput} type="file" accept=".cif,.CIF,text/plain" hidden onChange={(e) => void onFiles(e.target.files)} />
            <button type="button" className="ui-icon-btn" aria-label={theme === "light" ? "Use dark theme" : "Use light theme"} title={theme === "light" ? "Dark theme" : "Light theme"} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
              {theme === "light" ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
              )}
            </button>
          </div>
        </header>
        {showNotice && (
          <div className="disclaimer" role="note">
            <span>
              <b>Public beta</b> · tables cross-checked, not yet certified; validate before publishing · files stay in your browser ·{" "}
              <a href={README} target="_blank" rel="noreferrer">Data provenance</a>
            </span>
            <button type="button" className="disclaimer__close" aria-label="Hide this notice" title="Hide this notice" onClick={hideNotice}>
              ×
            </button>
          </div>
        )}

        <div className="workspace">
          <section className="ui-page">
            <div className="ui-controls" aria-label="Calculation settings">
              {entry ? (
                <>
                  <span className="ui-control">
                    <span className="ui-control-label">Beam</span>
                    <Chip tone="accent" title={entry.source}>
                      Neutrons · {entry.label}
                    </Chip>
                    {(entry.modes?.length ?? 0) > 1 && (
                      <Segmented label="Sample" value={sampleKind(experiment)} onChange={(v) => setExperiment({ ...experiment, sample: v })} options={[{ value: "single-crystal", label: "Single crystal" }, { value: "powder", label: "Powder" }]} />
                    )}
                  </span>
                  {entry.incident ? (
                    <span className="ui-control">
                      <span className="ui-control-label">
                        <span className="sym">E</span>
                        <sub>i</sub>
                      </span>
                      <UnitField label="Incident energy" value={Number(experiment.eiMeV.toPrecision(6))} unit="meV" min={entry.incident.eiMin} max={entry.incident.eiMax} width="5ch" onCommit={(v) => setExperiment(withEi(experiment, v, experiment.eRes))} />
                      <span className="dim-note">
                        <span className="sym">λ</span> {Number(((experiment.lambdaMin + experiment.lambdaMax) / 2).toPrecision(5))} Å
                      </span>
                      <span className="ui-control-label">
                        Δ<span className="sym">E</span>/<span className="sym">E</span>
                      </span>
                      <UnitField label="Elastic resolution (FWHM)" value={Number((100 * experiment.eRes).toPrecision(6))} unit="%" min={0.01} max={50} width="4ch" onCommit={(v) => setExperiment(withEi(experiment, experiment.eiMeV, v / 100))} />
                    </span>
                  ) : (
                    <span className="ui-control">
                      <span className="ui-control-label">
                        <span className="sym">λ</span> band
                        <InfoBadge>The wavelength band reaching the sample (white beam, time of flight). Defaults from the instrument; POWGEN's depends on the chopper setting.</InfoBadge>
                      </span>
                      <UnitField label="Minimum wavelength" value={Number(experiment.lambdaMin.toPrecision(4))} unit="Å" min={0.05} width="5ch" onCommit={(v) => setExperiment({ ...experiment, lambdaMin: Math.min(v, experiment.lambdaMax - 0.01) })} />
                      <UnitField label="Maximum wavelength" value={Number(experiment.lambdaMax.toPrecision(4))} unit="Å" min={0.06} width="5ch" onCommit={(v) => setExperiment({ ...experiment, lambdaMax: Math.max(v, experiment.lambdaMin + 0.01) })} />
                    </span>
                  )}
                  <span className="ui-control">
                    <span className="ui-control-label">
                      Δ<span className="sym">d</span>/<span className="sym">d</span>
                      <InfoBadge>Relative resolution (FWHM) of simulated powder peaks and rings. Real banks vary with angle and are calibrated.</InfoBadge>
                    </span>
                    <UnitField label="Relative resolution (FWHM)" value={Number((100 * experiment.dOverD).toPrecision(6))} unit="%" min={0.01} max={20} width="4ch" onCommit={(v) => setExperiment({ ...experiment, dOverD: v / 100 })} />
                  </span>
                </>
              ) : (
                <>
                  <span className="ui-control">
                    <span className="ui-control-label">Radiation</span>
                    <Segmented label="Radiation" value={radiation} onChange={changeRadiation} options={[{ value: "xray", label: "X-ray" }, { value: "neutron", label: "Neutron" }]} />
                    {radiation === "neutron" && <Segmented label="Neutron mode" value={neutronMode} onChange={changeNeutronMode} options={[{ value: "cw", label: "CW" }, { value: "tof", label: "TOF" }]} />}
                  </span>
                  {!isTof ? (
                    <span className="ui-control">
                      <span className="ui-control-label">
                        <span className="sym">λ</span>
                      </span>
                      <UnitField label="Wavelength" value={Number(wavelength.toPrecision(7))} unit="Å" min={0.01} max={20} onCommit={setWavelength} />
                      <span className="ui-control-label">
                        <span className="sym">E</span>
                      </span>
                      {radiation === "xray" ? (
                        <UnitField label="Photon energy" value={Number(xrayEnergyKeV(wavelength).toPrecision(7))} unit="keV" min={0.62} max={1240} onCommit={(e) => setWavelength(xrayWavelengthA(e))} />
                      ) : (
                        <UnitField label="Neutron energy" value={Number(neutronEnergyMeV(wavelength).toPrecision(7))} unit="meV" min={0.2} max={1e6} onCommit={(e) => setWavelength(neutronWavelengthA(e))} />
                      )}
                      <select className="ui-select" aria-label="Wavelength preset" value={preset ? String(preset.value) : ""} onChange={(e) => e.target.value && setWavelength(Number(e.target.value))}>
                        <option value="">Custom</option>
                        {WAVELENGTHS.filter((w) => w.radiation === radiation).map((w) => (
                          <option key={w.label} value={w.value}>
                            {w.label}
                          </option>
                        ))}
                      </select>
                    </span>
                  ) : (
                    <>
                      <span className="ui-control">
                        <span className="ui-control-label">
                          Bank 2<span className="sym">θ</span>
                        </span>
                        <UnitField label="Bank scattering angle" value={tof.twoThetaDeg} unit="°" min={0.1} max={179.9} onCommit={(v) => setTof({ ...tof, twoThetaDeg: v })} width="5ch" />
                      </span>
                      <span className="ui-control">
                        <span className="ui-control-label">
                          <span className="sym">L</span>
                          <sub>1</sub>+<span className="sym">L</span>
                          <sub>2</sub>
                          <InfoBadge>Total flight path, moderator to sample to detector. DIFC = (m_n/h)·L·2sinθ = 252.778 µs/(m·Å)·L·2sinθ. Calibrated DIFC, DIFA and ZERO from an instrument file are more accurate than geometry.</InfoBadge>
                        </span>
                        <UnitField label="Total flight path" value={tof.flightPathM} unit="m" min={0.1} max={500} onCommit={(v) => setTof({ ...tof, flightPathM: v })} width="5ch" />
                        <Chip title="DIFC from the bank geometry">DIFC {difc.toFixed(1)} µs/Å</Chip>
                      </span>
                      <span className="ui-control">
                        <span className="ui-control-label">
                          <span className="sym">λ</span> band
                        </span>
                        <UnitField label="Minimum wavelength" value={tof.lambdaMin} unit="Å" min={0.01} onCommit={(v) => setTof({ ...tof, lambdaMin: v })} width="4.5ch" />
                        <UnitField label="Maximum wavelength" value={tof.lambdaMax} unit="Å" min={0.02} onCommit={(v) => setTof({ ...tof, lambdaMax: v })} width="4.5ch" />
                      </span>
                    </>
                  )}
                </>
              )}
              <span className="ui-control">
                <span className="ui-control-label">
                  <span className="sym">d</span>
                  <sub>min</sub>
                  <InfoBadge>Reflections with d ≥ d_min are listed. CW powder peaks also need d ≥ λ/2; a TOF bank sees d = λ/(2 sinθ) across its wavelength band. For X-rays d_min is held at ≥ 0.0833 Å, the limit of the Waasmaier–Kirfel fits (s ≤ 6 Å⁻¹).</InfoBadge>
                </span>
                <UnitField label="Minimum d-spacing" value={dMin} unit="Å" min={0.05} onCommit={setDMin} />
              </span>
              {radiation === "xray" && !sns && (
                <span className="ui-control">
                  <span className="ui-control-label">Polarization</span>
                  <select
                    className="ui-select"
                    aria-label="Polarization"
                    value={polarization.kind === "monochromator" ? `mono:${polarization.twoThetaMDeg}` : polarization.kind === "linear" ? `lin:${polarization.fraction}` : polarization.kind}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "unpolarized") setPolarization({ kind: "unpolarized" });
                      else if (v.startsWith("mono:")) setPolarization({ kind: "monochromator", twoThetaMDeg: Number(v.slice(5)) });
                      else if (v.startsWith("lin:")) setPolarization({ kind: "linear", fraction: Number(v.slice(4)) });
                    }}
                  >
                    <option value="unpolarized">Unpolarized lab source</option>
                    <option value="mono:26.6">Graphite monochromator (Cu, 2θM 26.6°)</option>
                    <option value="mono:12.1">Graphite monochromator (Mo, 2θM 12.1°)</option>
                    <option value="lin:0.95">Synchrotron, 95 % polarized ⟂ plane</option>
                    <option value="lin:1">Synchrotron, fully polarized ⟂ plane</option>
                  </select>
                </span>
              )}
              {busy && <span className="ui-chip ui-chip--accent">Calculating…</span>}
            </div>

            {!file && (
              <div className={cx("ui-dropzone", drag && "is-drag")} onDragEnter={() => setDrag(true)} onDragLeave={() => setDrag(false)}>
                <svg width="44" height="44" viewBox="0 0 100 100" aria-hidden="true">
                  <rect width="100" height="100" rx="22" fill="var(--accent-soft)" />
                  <circle cx="40" cy="60" r="13" fill="none" stroke="var(--accent)" strokeWidth="7" />
                  <circle cx="70" cy="30" r="8" fill="var(--accent)" />
                </svg>
                <h2>Neutron Experiment Planner</h2>
                <p>Start from a crystal structure (CIF 1.1). NEXPLAN calculates neutron and X-ray reflections, structure factors and powder patterns, orients the crystal from a UB matrix, and simulates the measurement on SNS instruments. Everything runs in this browser tab; nothing is uploaded.</p>
                <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", justifyContent: "center" }}>
                  <button type="button" className="ui-btn-primary" onClick={() => fileInput.current?.click()}>
                    Choose a CIF file
                  </button>
                  {DEMOS.slice(0, 2).map((d) => (
                    <button key={d.id} type="button" className="ui-btn-brand" onClick={() => loadText(d.file, d.text)}>
                      {d.label}
                    </button>
                  ))}
                </div>
                <small className="dropzone-hint">or drop a CIF file anywhere on this page</small>
              </div>
            )}
            {!file && (
              <ol className="workflow" aria-label="How NEXPLAN works">
                {(
                  [
                    ["Sample", "Load a CIF: cell, symmetry, sites and the scattering lengths used, each with its source; every reflection with d, Q and complex F."],
                    ["Setup", "Pick an SNS instrument in the header (or a generic X-ray or neutron beam), then load or build the UB matrix and set the goniometer."],
                    ["Simulation", "Spots, coverage and powder rings on the real detectors; powder patterns; orientation lists, rotation scans, completeness and reciprocal slices."],
                  ] as [string, string][]
                ).map(([title, text], i) => (
                  <li key={title}>
                    <span className="workflow__step">{i + 1}</span>
                    <b>{title}</b>
                    <span>{text}</span>
                  </li>
                ))}
              </ol>
            )}

            {file && result && !result.ok && (
              <Resolution
                result={result}
                onBlock={setBlockName}
                onSetting={setChosenSetting}
                onSpecies={(label, sp) => setOverrides((o) => ({ ...o, [label]: sp }))}
                onDMin={setDMin}
              />
            )}

            {ok && tab === "structure" && (
              <StructurePage
                result={ok}
                radiation={radiation}
                theme={theme}
                onXrayIon={(label, id) =>
                  setXrayIons((m) => {
                    const next = { ...m };
                    if (id === undefined) delete next[label];
                    else next[label] = id;
                    return next;
                  })
                }
              />
            )}
            {ok && tab === "reflections" && <ReflectionsPage result={ok} wavelength={wavelength} radiation={radiation} positions={!sns} />}
            {ok && tab === "orientation" && (
              <UbPage
                result={ok}
                theme={theme}
                ub={ub}
                onUb={setUb}
                gonio={gonio}
                onGonio={setGonio}
                instrument={entry ? { name: entry.label, goniometer: entry.goniometer, angles: experiment.angles, onAngles: (angles) => setExperiment({ ...experiment, angles }), lambdaMin: experiment.lambdaMin, lambdaMax: experiment.lambdaMax } : undefined}
              />
            )}
            {ok && tab === "powder" && !sns && (
              <PowderPage result={ok} axis={axis} onAxis={changeAxis} cwProfile={cwProfile} onCwProfile={setCwProfile} tofShape={tof.shape} onTofShape={(shape: TofShape) => setTof({ ...tof, shape })} />
            )}
            {simReady && (tab === "detectors" || tab === "crystal" || (tab === "powder" && sns)) && (
              <Suspense fallback={<p className="empty-note">Loading the detector geometry…</p>}>
                {tab === "detectors" && simProps && <DetectorsPage {...simProps} />}
                {tab === "powder" && simProps && <InstrumentPowder {...simProps} />}
                {tab === "crystal" && simProps && <CrystalPage {...simProps} />}
              </Suspense>
            )}

            <footer className="ui-footer">
              © 2026 Tsung-Han Yang · AGPLv3 · <a href={README} target="_blank" rel="noreferrer">About &amp; documentation</a>
            </footer>
          </section>
        </div>
      </main>
    </div>
  );
}

/** A failed calculation, with the control that resolves it. */
function Resolution({
  result,
  onBlock,
  onSetting,
  onSpecies,
  onDMin,
}: {
  result: Extract<CalcResult, { ok: false }>;
  onBlock: (b: string) => void;
  onSetting: (s: string) => void;
  onSpecies: (label: string, sp: string) => void;
  onDMin: (d: number) => void;
}) {
  const needsChoice = result.stage === "block" || (result.settingCandidates?.length ?? 0) > 0 || (result.ambiguousLabels?.length ?? 0) > 0;
  return (
    <div className={cx("ui-banner", needsChoice && "ui-banner--warn")} role="alert">
      <div>
        <strong>{needsChoice ? "Choice needed. " : "Cannot calculate. "}</strong>
        {result.message}
      </div>
      {result.stage === "block" && result.blocks && (
        <div className="ui-banner__row">
          {result.blocks
            .filter((b) => b.hasStructure)
            .map((b) => (
              <button key={b.name} type="button" className="ui-btn-brand" onClick={() => onBlock(b.name)}>
                data_{b.name}
                {b.phaseName ? ` · ${b.phaseName}` : ""}
                {b.symmetryText ? ` · ${b.symmetryText}` : ""}
              </button>
            ))}
        </div>
      )}
      {result.settingCandidates && result.settingCandidates.length > 0 && (
        <div className="ui-banner__row">
          <span className="ui-control-label">Setting</span>
          {result.settingCandidates.map((s) => (
            <button key={s} type="button" className="ui-btn-brand mono" onClick={() => onSetting(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {result.ambiguousLabels?.map((a) => (
        <div key={a.label} className="ui-banner__row">
          <span className="ui-control-label">Site {a.label}</span>
          {a.candidates.map((c) => (
            <button key={c} type="button" className="ui-btn-brand" onClick={() => onSpecies(a.label, c)}>
              {c}
            </button>
          ))}
        </div>
      ))}
      {result.stage === "limit" && result.suggestedDMin && (
        <div className="ui-banner__row">
          <button type="button" className="ui-btn-brand" onClick={() => onDMin(Number(result.suggestedDMin!.toFixed(3)))}>
            Use d_min = {result.suggestedDMin.toFixed(3)} Å
          </button>
        </div>
      )}
      {result.diagnostics && result.diagnostics.filter((d) => d.severity === "error").length > 0 && (
        <ul className="ui-issues">
          {result.diagnostics
            .filter((d) => d.severity === "error")
            .map((d, i) => (
              <li key={i}>
                <span className="ui-chip ui-chip--danger">error</span>
                <span>
                  {d.message}
                  {d.line ? ` (line ${d.line})` : ""}
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
