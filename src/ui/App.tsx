import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { CalcInput, CalcResult, CalcSuccess } from "../app/compute.ts";
import { APP_VERSION } from "../app/version.ts";
import type { Polarization, PowderAxis } from "../core/diffraction/powder.ts";
import { calculate } from "../workers/client.ts";
import { cx, InfoBadge, Segmented, UnitField } from "./components.tsx";
import { DEMOS } from "./demos.ts";
import { PowderPage, ReflectionsPage, StructurePage } from "./pages.tsx";

type Tab = "structure" | "reflections" | "powder" | "ub" | "planning";
type Theme = "light" | "dark";

const WAVELENGTHS: { label: string; value: number; radiation: "xray" | "neutron" | "any" }[] = [
  { label: "Cu Kα1", value: 1.540593, radiation: "xray" },
  { label: "Mo Kα1", value: 0.709317, radiation: "xray" },
  { label: "Ag Kα1", value: 0.5594075, radiation: "xray" },
  { label: "Co Kα1", value: 1.788965, radiation: "xray" },
  { label: "Thermal 1.5 Å", value: 1.5, radiation: "neutron" },
  { label: "2200 m/s, 1.798 Å", value: 1.798, radiation: "neutron" },
];

function readTheme(): Theme {
  try {
    return localStorage.getItem("scatterplan-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const README = "https://github.com/drthyang/scatterplan#readme";

export function App() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("scatterplan-theme", theme);
    } catch {
      /* storage unavailable: theme still applies for this session */
    }
  }, [theme]);

  const [tab, setTab] = useState<Tab>("structure");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [blockName, setBlockName] = useState<string | undefined>();
  const [chosenSetting, setChosenSetting] = useState<string | undefined>();
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [radiation, setRadiation] = useState<"xray" | "neutron">("xray");
  const [wavelength, setWavelength] = useState(1.540593);
  const [dMin, setDMin] = useState(0.8);
  const [polarization, setPolarization] = useState<Polarization>({ kind: "unpolarized" });
  const [ionFallback, setIonFallback] = useState<"error" | "neutral">("error");
  const [axis, setAxis] = useState<PowderAxis>("twoTheta");
  const [fwhm, setFwhm] = useState(0.1);
  const [eta, setEta] = useState(0.5);
  const [result, setResult] = useState<CalcResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadText = useCallback((name: string, text: string) => {
    setFile({ name, text });
    setBlockName(undefined);
    setChosenSetting(undefined);
    setOverrides({});
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
      radiation,
      wavelength,
      dMin,
      polarization,
      ionFallback,
      profile: { axis, fwhm, eta },
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
  }, [file, blockName, chosenSetting, overrides, radiation, wavelength, dMin, polarization, ionFallback, axis, fwhm, eta]);

  // Keep the FWHM sensible when switching axes.
  const changeAxis = (a: PowderAxis) => {
    setAxis(a);
    setFwhm(a === "twoTheta" ? 0.1 : a === "d" ? 0.002 : 0.01);
  };
  const changeRadiation = (r: "xray" | "neutron") => {
    setRadiation(r);
    setWavelength(r === "xray" ? 1.540593 : 1.5);
  };

  const ok: CalcSuccess | undefined = result?.ok ? result : undefined;
  const preset = WAVELENGTHS.find((w) => w.value === wavelength && (w.radiation === radiation || w.radiation === "any"));

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
                <svg className="brand-mark-icon" viewBox="0 0 100 100">
                  <g fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round">
                    <path d="M28 72 A 24 24 0 0 1 72 72" />
                    <path d="M12 76 A 40 40 0 0 1 88 76" />
                  </g>
                  <circle cx="50" cy="74" r="8" fill="currentColor" />
                </svg>
              </div>
              <div className="brand-copy">
                <h1>
                  ScatterPlan<span>Workbench</span>
                </h1>
              </div>
              <span className="beta-pill">
                beta<span className="ver">v{APP_VERSION}</span>
              </span>
            </div>
            <nav className="ui-seg ui-seg--nav page-tabs" aria-label="Pages">
              {(
                [
                  ["structure", "Structure"],
                  ["reflections", "Reflections"],
                  ["powder", "Powder"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" className={cx(tab === id && "is-active")} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
              <button type="button" disabled title="UB matrix tools: milestone M3">
                UB matrix<span className="soon">soon</span>
              </button>
              <button type="button" disabled title="Experiment planning: milestone M4">
                Planning<span className="soon">soon</span>
              </button>
            </nav>
          </div>
          <div className="header-actions">
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
        <div className="disclaimer" role="note">
          Public beta. Scattering tables are cross-checked against independent sources but not yet certified against the printed literature; validate results before publication.
          Files stay in your browser. <a href={README} target="_blank" rel="noreferrer">Data provenance</a>
        </div>

        <div className="workspace">
          <section className="ui-page">
            <div className="ui-controls" aria-label="Calculation settings">
              <span className="ui-control">
                <span className="ui-control-label">Radiation</span>
                <Segmented label="Radiation" value={radiation} onChange={changeRadiation} options={[{ value: "xray", label: "X-ray" }, { value: "neutron", label: "Neutron" }]} />
              </span>
              <span className="ui-control">
                <span className="ui-control-label"><span className="sym">λ</span></span>
                <UnitField label="Wavelength" value={wavelength} unit="Å" min={0.01} max={20} onCommit={setWavelength} />
                <select className="ui-select" aria-label="Wavelength preset" value={preset ? String(preset.value) : ""} onChange={(e) => e.target.value && setWavelength(Number(e.target.value))}>
                  <option value="">Custom</option>
                  {WAVELENGTHS.filter((w) => w.radiation === radiation || w.radiation === "any").map((w) => (
                    <option key={w.label} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </span>
              <span className="ui-control">
                <span className="ui-control-label">
                  <span className="sym">d</span><sub>min</sub>
                  <InfoBadge>Reflections with d ≥ d_min are listed. Powder peaks additionally need d ≥ λ/2. For X-rays d_min is held at ≥ 0.0833 Å, the limit of the Waasmaier–Kirfel fits (s ≤ 6 Å⁻¹).</InfoBadge>
                </span>
                <UnitField label="Minimum d-spacing" value={dMin} unit="Å" min={0.05} onCommit={setDMin} />
              </span>
              {radiation === "xray" && (
                <>
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
                  <span className="ui-control">
                    <span className="ui-control-label">
                      Ions
                      <InfoBadge>Ionic form factors are used when the CIF type symbol names a charge (Fe3+, O2-). If the table has no row for that ion, the default stops with an error; the alternative uses the neutral atom and records it.</InfoBadge>
                    </span>
                    <select className="ui-select" aria-label="Missing ion handling" value={ionFallback} onChange={(e) => setIonFallback(e.target.value as "error" | "neutral")}>
                      <option value="error">Require tabulated ion</option>
                      <option value="neutral">Use neutral atom if missing</option>
                    </select>
                  </span>
                </>
              )}
              {busy && <span className="ui-chip ui-chip--accent">Calculating…</span>}
            </div>

            {!file && (
              <div className={cx("ui-dropzone", drag && "is-drag")} onDragEnter={() => setDrag(true)} onDragLeave={() => setDrag(false)}>
                <svg width="44" height="44" viewBox="0 0 100 100" aria-hidden="true">
                  <rect width="100" height="100" rx="22" fill="var(--accent-soft)" />
                  <g fill="none" stroke="var(--accent)" strokeWidth="7" strokeLinecap="round">
                    <path d="M28 72 A 24 24 0 0 1 72 72" />
                    <path d="M12 76 A 40 40 0 0 1 88 76" />
                  </g>
                  <circle cx="50" cy="74" r="7" fill="var(--accent)" />
                </svg>
                <h2>Drop a CIF file here</h2>
                <p>
                  ScatterPlan reads CIF 1.1 structures and calculates X-ray and neutron reflections, structure factors and powder patterns. Everything runs in this browser tab; nothing is uploaded.
                </p>
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
              </div>
            )}

            {file && result && !result.ok && (
              <Resolution
                result={result}
                onBlock={setBlockName}
                onSetting={setChosenSetting}
                onSpecies={(label, sp) => setOverrides((o) => ({ ...o, [label]: sp }))}
                onDMin={setDMin}
                onIonFallback={() => setIonFallback("neutral")}
              />
            )}

            {ok && tab === "structure" && <StructurePage result={ok} />}
            {ok && tab === "reflections" && <ReflectionsPage result={ok} wavelength={wavelength} radiation={radiation} />}
            {ok && tab === "powder" && <PowderPage result={ok} axis={axis} fwhm={fwhm} eta={eta} onAxis={changeAxis} onFwhm={setFwhm} onEta={setEta} radiation={radiation} wavelength={wavelength} />}

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
  onIonFallback,
}: {
  result: Extract<CalcResult, { ok: false }>;
  onBlock: (b: string) => void;
  onSetting: (s: string) => void;
  onSpecies: (label: string, sp: string) => void;
  onDMin: (d: number) => void;
  onIonFallback: () => void;
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
      {result.stage === "scattering" && /Waasmaier–Kirfel X-ray form factor for [A-Z][a-z]?\d+[+-]/.test(result.message) && (
        <div className="ui-banner__row">
          <button type="button" className="ui-btn-brand" onClick={onIonFallback}>
            Use the neutral atom for missing ions
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
