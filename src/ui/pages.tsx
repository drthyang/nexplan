import { useMemo, useState } from "react";
import type { CalcSuccess } from "../app/compute.ts";
import type { PowderAxis } from "../core/diffraction/powder.ts";
import type { Diagnostic } from "../io/cif/structure.ts";
import { Card, Chip, Segmented, TierChip, UnitField } from "./components.tsx";
import { downloadText, exact, fmt, hklText, withSu } from "./format.ts";
import { PowderPlot } from "./PowderPlot.tsx";

const SEVERITY_TONE: Record<Diagnostic["severity"], "danger" | "warn" | "accent" | undefined> = {
  error: "danger",
  warning: "warn",
  assumption: "accent",
  info: undefined,
};

export function StatusCard({ result }: { result: CalcSuccess }) {
  const order = { error: 0, warning: 1, assumption: 2, info: 3 } as const;
  const diags = [...result.diagnostics].sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = (s: Diagnostic["severity"]) => diags.filter((d) => d.severity === s).length;
  return (
    <Card
      title="Calculation status"
      info="Every assumption, default and table tier used by this result. Exports record the same list."
      actions={
        <button
          type="button"
          className="ui-pill"
          onClick={() =>
            downloadText(
              `${result.blockName}-provenance.json`,
              JSON.stringify({ provenance: result.provenance, diagnostics: result.diagnostics, tiers: result.tiers }, null, 2),
              "application/json",
            )
          }
        >
          Provenance JSON
        </button>
      }
    >
      <div className="ui-micro" style={{ marginBottom: "0.35rem" }}>
        Scattering data used
      </div>
      <ul className="ui-issues" style={{ marginBottom: "0.9rem" }}>
        {result.tiers.map((t) => (
          <li key={t.source}>
            <TierChip tier={t.tier} />
            <span className="mono">{t.source}</span>
          </li>
        ))}
      </ul>
      <div className="ui-micro" style={{ marginBottom: "0.35rem" }}>
        Notes · {counts("warning")} warning{counts("warning") === 1 ? "" : "s"} · {counts("assumption")} assumption{counts("assumption") === 1 ? "" : "s"}
      </div>
      {diags.length === 0 ? (
        <p style={{ margin: 0, fontSize: "var(--fs-80)", color: "var(--muted)" }}>No warnings or assumptions.</p>
      ) : (
        <ul className="ui-issues">
          {diags.map((d, i) => (
            <li key={i}>
              <Chip tone={SEVERITY_TONE[d.severity]}>{d.severity}</Chip>
              <span>
                {d.message}
                {d.line ? <span style={{ color: "var(--subtle)" }}> (line {d.line})</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function StructurePage({ result }: { result: CalcSuccess }) {
  const s = result.structure;
  const su = s.cellSu;
  return (
    <div className="ui-grid ui-grid--split">
      <div className="ui-stack">
        <Card title={s.name} meta={s.formula} info="As read from the selected CIF data block. Values in parentheses are the file's standard uncertainties.">
          <dl className="ui-stats">
            <div><dt><span className="sym">a</span></dt><dd>{withSu(s.cell.a, su.a)} <small>Å</small></dd></div>
            <div><dt><span className="sym">b</span></dt><dd>{withSu(s.cell.b, su.b)} <small>Å</small></dd></div>
            <div><dt><span className="sym">c</span></dt><dd>{withSu(s.cell.c, su.c)} <small>Å</small></dd></div>
            <div><dt><span className="sym">α</span></dt><dd>{withSu(s.cell.alpha, su.alpha, 3)}°</dd></div>
            <div><dt><span className="sym">β</span></dt><dd>{withSu(s.cell.beta, su.beta, 3)}°</dd></div>
            <div><dt><span className="sym">γ</span></dt><dd>{withSu(s.cell.gamma, su.gamma, 3)}°</dd></div>
            <div><dt>Volume</dt><dd>{fmt(s.volume, 3)} <small>Å³</small></dd></div>
            <div><dt>Space group</dt><dd>{s.setting ?? "unlisted"}{s.settingNumber ? <small> (No. {s.settingNumber})</small> : null}</dd></div>
            <div><dt>Operations</dt><dd>{s.opCount} <small>from {s.symmetrySource}</small></dd></div>
            <div><dt>Data block</dt><dd className="mono">{result.blockName}</dd></div>
            {s.temperatureK !== undefined && <div><dt>Temperature</dt><dd>{s.temperatureK} <small>K</small></dd></div>}
            {s.codId && <div><dt>COD</dt><dd><a href={`https://www.crystallography.net/cod/${s.codId}.html`} target="_blank" rel="noreferrer">{s.codId}</a></dd></div>}
          </dl>
        </Card>
        <Card title="Atom sites" meta={`${s.sites.length} sites · ${s.content.map(([k, n]) => `${k}${Number(n.toFixed(3))}`).join(" ")} per cell`} flush>
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th className="left">Label</th>
                  <th className="left">Species</th>
                  <th>x</th>
                  <th>y</th>
                  <th>z</th>
                  <th>Occ.</th>
                  <th>B (Å²)</th>
                  <th>Mult.</th>
                  <th className="left">Scattering</th>
                </tr>
              </thead>
              <tbody>
                {s.sites.map((r) => (
                  <tr key={r.label}>
                    <th>{r.label}</th>
                    <td className="left">{r.species}{r.typeSymbol && r.typeSymbol !== r.species ? <span style={{ color: "var(--subtle)" }}> ({r.typeSymbol})</span> : null}</td>
                    <td>{fmt(r.x, 5)}</td>
                    <td>{fmt(r.y, 5)}</td>
                    <td>{fmt(r.z, 5)}</td>
                    <td>{fmt(r.occupancy, 4)}</td>
                    <td>{fmt(r.bIso, 3)}</td>
                    <td>{r.multiplicity}</td>
                    <td className="left">{r.amplitudeSource}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="ui-fold">
            <summary>Symmetry operations ({s.opCount})</summary>
            <div className="ui-fold__body">
              {s.hall && (
                <p style={{ margin: "0 0 0.5rem", fontSize: "var(--fs-80)" }}>
                  Hall symbol <span className="mono">{s.hall}</span>
                </p>
              )}
              <ul className="ops-list">
                {s.ops.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </div>
          </details>
        </Card>
      </div>
      <StatusCard result={result} />
    </div>
  );
}

const CLASS_NAME = ["present", "systematic", "accidental"] as const;

/** Phase in degrees; amplitudes real to rounding (|Im| ≤ 1e-10 |F|) show exactly 0 or 180. */
function phaseDeg(re: number, im: number): string {
  const mod = Math.hypot(re, im);
  if (Math.abs(im) <= 1e-10 * mod) return re >= 0 ? "0" : "180";
  const p = (Math.atan2(im, re) * 180) / Math.PI;
  return p.toFixed(2);
}

export function ReflectionsPage({ result, wavelength, radiation }: { result: CalcSuccess; wavelength: number; radiation: "xray" | "neutron" }) {
  const r = result.reflections;
  const [hideAbsent, setHideAbsent] = useState(true);
  const [limit, setLimit] = useState(500);
  const rows = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < r.h.length; i++) if (!hideAbsent || r.cls[i] === 0) out.push(i);
    return out;
  }, [r, hideAbsent]);
  const counts = useMemo(() => {
    const c = [0, 0, 0];
    for (let i = 0; i < r.cls.length; i++) c[r.cls[i]!]!++;
    return c;
  }, [r]);
  const unit = radiation === "xray" ? "e" : "fm";
  const exportCsv = () => {
    const lines = [`# ScatterPlan reflections; ${result.provenance.radiation}; lambda=${wavelength} A; input sha256 ${result.provenance.inputSha256}`, `h,k,l,d_A,two_theta_deg,Q_invA,ReF_${unit},ImF_${unit},F2_${unit}2,class`];
    for (let i = 0; i < r.h.length; i++) {
      const x = wavelength / (2 * r.d[i]!);
      const tt = x <= 1 ? (2 * Math.asin(x) * 180) / Math.PI : NaN;
      lines.push([r.h[i], r.k[i], r.l[i], exact(r.d[i]!), exact(tt), exact((2 * Math.PI) / r.d[i]!), exact(r.re[i]!), exact(r.im[i]!), exact(r.f2[i]!), CLASS_NAME[r.cls[i]!]].join(","));
    }
    downloadText(`${result.blockName}-reflections.csv`, lines.join("\n") + "\n", "text/csv");
  };
  return (
    <Card
      title="Reflections"
      meta={`${r.h.length.toLocaleString()} signed hkl · ${counts[0]!.toLocaleString()} present · ${counts[1]!.toLocaleString()} systematic · ${counts[2]!.toLocaleString()} accidental`}
      info={`Every signed hkl with d ≥ d_min. "Systematic" absences follow from the space-group operations; "accidental" means |F| is numerically zero although symmetry allows it. ${result.friedelMerged ? "Amplitudes are real, so I(h) = I(−h)." : "Complex amplitudes: I(h) and I(−h) differ."}`}
      actions={
        <>
          <label className="ui-control" style={{ fontSize: "var(--fs-80)" }}>
            <input type="checkbox" checked={hideAbsent} onChange={(e) => setHideAbsent(e.target.checked)} /> Hide absences
          </label>
          <button type="button" className="ui-pill" onClick={exportCsv}>
            CSV (all)
          </button>
        </>
      }
      flush
    >
      <div className="ui-table-wrap">
        <table className="ui-table">
          <thead>
            <tr>
              <th>h</th>
              <th>k</th>
              <th>l</th>
              <th>d (Å)</th>
              <th>2θ (°)</th>
              <th>Q (Å⁻¹)</th>
              <th>|F| ({unit})</th>
              <th>φ (°)</th>
              <th>|F|²</th>
              <th className="left">Class</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((i) => {
              const x = wavelength / (2 * r.d[i]!);
              const absent = r.cls[i] !== 0;
              return (
                <tr key={i} className={absent ? "is-absent" : undefined}>
                  <td>{r.h[i]}</td>
                  <td>{r.k[i]}</td>
                  <td>{r.l[i]}</td>
                  <td>{fmt(r.d[i]!, 5)}</td>
                  <td>{x <= 1 ? fmt((2 * Math.asin(x) * 180) / Math.PI, 3) : "—"}</td>
                  <td>{fmt((2 * Math.PI) / r.d[i]!, 4)}</td>
                  <td>{absent ? "0" : fmt(Math.sqrt(r.f2[i]!), 4)}</td>
                  <td>{absent ? "—" : phaseDeg(r.re[i]!, r.im[i]!)}</td>
                  <td>{absent ? "0" : r.f2[i]!.toPrecision(6)}</td>
                  <td className="left dim">{CLASS_NAME[r.cls[i]!]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <div style={{ padding: "0.6rem 0.9rem", borderTop: "1px solid var(--border)", fontSize: "var(--fs-80)", display: "flex", gap: "0.6rem", alignItems: "center" }}>
          Showing {limit.toLocaleString()} of {rows.length.toLocaleString()} rows.
          <button type="button" className="ui-pill" onClick={() => setLimit((n) => n * 4)}>
            Show more
          </button>
          <span style={{ color: "var(--subtle)" }}>The CSV always has every row at full precision.</span>
        </div>
      )}
    </Card>
  );
}

export function PowderPage({
  result,
  axis,
  fwhm,
  eta,
  onAxis,
  onFwhm,
  onEta,
  radiation,
  wavelength,
}: {
  result: CalcSuccess;
  axis: PowderAxis;
  fwhm: number;
  eta: number;
  onAxis: (a: PowderAxis) => void;
  onFwhm: (v: number) => void;
  onEta: (v: number) => void;
  radiation: "xray" | "neutron";
  wavelength: number;
}) {
  const peaks = result.peaks;
  const iMax = Math.max(1e-300, ...peaks.map((p) => p.intensity));
  const fwhmUnit = axis === "twoTheta" ? "°" : axis === "d" ? "Å" : "Å⁻¹";
  const exportPeaks = () => {
    const lines = [
      `# ScatterPlan powder peaks; ${result.provenance.radiation}; lambda=${wavelength} A; Lorentz 1/(sin^2 th cos th); polarization ${radiation === "xray" ? JSON.stringify(result.provenance.settings.polarization) : "none"}`,
      "d_A,two_theta_deg,Q_invA,sumF2,LP,intensity,families",
      ...peaks.map((p) => [exact(p.d), exact(p.twoTheta), exact(p.q), exact(p.sumF2), exact(p.lp), exact(p.intensity), `"${p.families.map((f) => `(${f.hkl.join(" ")})x${f.multiplicity}`).join(" + ")}"`].join(",")),
    ];
    downloadText(`${result.blockName}-powder-peaks.csv`, lines.join("\n") + "\n", "text/csv");
  };
  const exportProfile = () => {
    const xs = result.profile.x;
    const ys = result.profile.y;
    const lines = [`# ScatterPlan profile; axis ${axis}; pseudo-Voigt FWHM ${fwhm} ${fwhmUnit}, eta ${eta}; unit-area peaks x integrated intensity`, `${axis},intensity`];
    for (let i = 0; i < xs.length; i++) lines.push(`${exact(xs[i]!)},${exact(ys[i]!)}`);
    downloadText(`${result.blockName}-powder-profile.csv`, lines.join("\n") + "\n", "text/csv");
  };
  return (
    <div className="ui-stack">
      <Card
        title="Powder pattern"
        meta={`${peaks.length} peaks · λ = ${wavelength} Å · ${radiation === "xray" ? "X-ray" : "neutron"} CW`}
        info="Intensity = Σ|F|² over every signed hkl at the same d, times the CW powder Lorentz factor 1/(sin²θ cosθ) and, for X-rays, the chosen polarization factor. No absorption, texture or extinction. Peaks are unit-area pseudo-Voigts on the chosen axis."
        actions={
          <>
            <Segmented
              label="Axis"
              value={axis}
              onChange={onAxis}
              options={[
                { value: "twoTheta", label: "2θ" },
                { value: "d", label: "d" },
                { value: "q", label: "Q" },
              ]}
            />
            <span className="ui-control">
              <span className="ui-control-label">FWHM</span>
              <UnitField label="Peak FWHM" value={fwhm} unit={fwhmUnit} min={1e-6} onCommit={onFwhm} width="3.6rem" />
            </span>
            <span className="ui-control">
              <span className="ui-control-label"><span className="sym">η</span></span>
              <UnitField label="Lorentzian fraction" value={eta} unit="" min={0} max={1} onCommit={onEta} width="2.8rem" />
            </span>
            <button type="button" className="ui-pill" onClick={exportPeaks}>
              Peaks CSV
            </button>
            <button type="button" className="ui-pill" onClick={exportProfile}>
              Profile CSV
            </button>
          </>
        }
      >
        {peaks.length ? <PowderPlot peaks={peaks} profile={result.profile} axis={axis} /> : <p>No accessible reflections at this wavelength and d_min.</p>}
      </Card>
      <Card title="Peaks" meta="ordered by decreasing d" flush>
        <div className="ui-table-wrap" style={{ maxHeight: "24rem" }}>
          <table className="ui-table">
            <thead>
              <tr>
                <th className="left">hkl × multiplicity</th>
                <th>d (Å)</th>
                <th>2θ (°)</th>
                <th>Q (Å⁻¹)</th>
                <th>Σ|F|²</th>
                <th>LP</th>
                <th>I (rel.)</th>
              </tr>
            </thead>
            <tbody>
              {peaks.map((p, i) => (
                <tr key={i}>
                  <th>{p.families.map((f) => `(${hklText(f.hkl)})×${f.multiplicity}`).join(" + ")}</th>
                  <td>{fmt(p.d, 5)}</td>
                  <td>{fmt(p.twoTheta, 3)}</td>
                  <td>{fmt(p.q, 4)}</td>
                  <td>{p.sumF2.toPrecision(5)}</td>
                  <td>{p.lp.toPrecision(4)}</td>
                  <td>{fmt((100 * p.intensity) / iMax, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
