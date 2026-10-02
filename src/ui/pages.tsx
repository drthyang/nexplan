import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CalcSuccess } from "../app/compute.ts";
import type { PowderAxis } from "../core/diffraction/powder.ts";
import { tofFromD, type TofShape } from "../core/diffraction/tof.ts";
import type { Diagnostic } from "../io/cif/structure.ts";
import { Card, Chip, InfoBadge, Segmented, TierChip, UnitField } from "./components.tsx";
import { downloadText, exact, fmt, hklText, withSu } from "./format.ts";
import { PowderPlot } from "./PowderPlot.tsx";
import { toMateriaModel } from "./materiaModel.ts";

const CrystalView = lazy(() => import("../views/CrystalView.tsx").then((m) => ({ default: m.CrystalView })));

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

export function StructurePage({ result, radiation, theme, onXrayIon }: { result: CalcSuccess; radiation: "xray" | "neutron"; theme: "light" | "dark"; onXrayIon: (label: string, id: string | undefined) => void }) {
  const s = result.structure;
  const su = s.cellSu;
  const xray = radiation === "xray";
  const materiaModel = useMemo(() => toMateriaModel(result), [result]);
  return (
    <div className="ui-stack">
      <div className="ui-grid ui-grid--split">
        <Card title={s.name} meta={s.formula} info="Drag to rotate, scroll to zoom, right-drag to pan. Shared sites are drawn as occupancy wedges (grey = vacancy). Ported from the MATERIA viewer." className="viewer-card">
          <Suspense fallback={<p className="empty-note">Loading the 3D viewer…</p>}>
            <CrystalView structure={materiaModel} theme={theme} fileStem={result.blockName} />
          </Suspense>
        </Card>
        <div className="ui-stack">
        <Card title="Cell and symmetry" info="As read from the selected CIF data block. Values in parentheses are the file's standard uncertainties.">
          <dl className="ui-stats ui-stats--three">
            <div><dt><span className="sym">a</span></dt><dd>{withSu(s.cell.a, su.a)} <small>Å</small></dd></div>
            <div><dt><span className="sym">b</span></dt><dd>{withSu(s.cell.b, su.b)} <small>Å</small></dd></div>
            <div><dt><span className="sym">c</span></dt><dd>{withSu(s.cell.c, su.c)} <small>Å</small></dd></div>
            <div><dt><span className="sym">α</span></dt><dd>{withSu(s.cell.alpha, su.alpha, 3)}°</dd></div>
            <div><dt><span className="sym">β</span></dt><dd>{withSu(s.cell.beta, su.beta, 3)}°</dd></div>
            <div><dt><span className="sym">γ</span></dt><dd>{withSu(s.cell.gamma, su.gamma, 3)}°</dd></div>
          </dl>
          <dl className="ui-stats ui-stats--three" style={{ marginTop: "0.75rem" }}>
            <div><dt>Volume</dt><dd>{fmt(s.volume, 3)} <small>Å³</small></dd></div>
            <div><dt>Space group</dt><dd>{s.setting ?? "unlisted"}{s.settingNumber ? <small> (No. {s.settingNumber})</small> : null}</dd></div>
            <div><dt>Operations</dt><dd>{s.opCount} <small>from {s.symmetrySource}</small></dd></div>
            <div><dt>Data block</dt><dd className="mono">{result.blockName}</dd></div>
            {s.temperatureK !== undefined && <div><dt>Temperature</dt><dd>{s.temperatureK} <small>K</small></dd></div>}
            {s.codId && <div><dt>COD</dt><dd><a href={`https://www.crystallography.net/cod/${s.codId}.html`} target="_blank" rel="noreferrer">{s.codId}</a></dd></div>}
          </dl>
        </Card>
        <StatusCard result={result} />
        </div>
      </div>
        <Card
          title="Atom sites"
          meta={`${s.sites.length} sites · ${s.content.map(([k, n]) => `${k.replace(/\d*[+-]$/, "")}${Number(n.toFixed(3))}`).join(" ")} per cell`}
          info={xray ? "X-ray form factors are neutral-atom Waasmaier–Kirfel f0 by default. A site can be switched to one of the tabulated ions for its element; the choice is recorded in the status card and exports." : "Neutron scattering lengths are the Sears (1992) natural-element values unless the type symbol names an isotope (D, 2H, 57Fe…)."}
          flush
        >
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th className="left">Label</th>
                  <th className="left">Type symbol</th>
                  <th>x</th>
                  <th>y</th>
                  <th>z</th>
                  <th>Occ.</th>
                  <th>B (Å²)</th>
                  <th>Mult.</th>
                  <th className="left">{xray ? "X-ray f0" : "Neutron b"}</th>
                </tr>
              </thead>
              <tbody>
                {s.sites.map((r) => (
                  <tr key={r.label}>
                    <th>{r.label}</th>
                    <td className="left">{r.typeSymbol ?? <span className="dim">—</span>}</td>
                    <td>{fmt(r.x, 5)}</td>
                    <td>{fmt(r.y, 5)}</td>
                    <td>{fmt(r.z, 5)}</td>
                    <td>{fmt(r.occupancy, 4)}</td>
                    <td>{fmt(r.bIso, 3)}</td>
                    <td>{r.multiplicity}</td>
                    <td className="left">
                      {xray && r.xrayOptions.length > 1 ? (
                        <select
                          className="ui-select ui-select--inline"
                          aria-label={`X-ray form factor for ${r.label}`}
                          value={r.xrayFormFactor}
                          onChange={(e) => onXrayIon(r.label, e.target.value === r.xrayOptions[0] ? undefined : e.target.value)}
                        >
                          {r.xrayOptions.map((o, i) => (
                            <option key={o} value={o}>
                              {i === 0 ? `${o} (neutral)` : o}
                              {r.typeSymbol && i > 0 && o === r.species ? " · CIF charge" : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        r.amplitudeSource
                      )}
                    </td>
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
  );
}

const CLASS_NAME = ["present", "systematic", "accidental"] as const;

/** Phase in degrees; amplitudes real to rounding (|Im| ≤ 1e-10 |F|) show exactly 0 or 180. */
function phaseDeg(re: number, im: number): string {
  const mod = Math.hypot(re, im);
  if (Math.abs(im) <= 1e-10 * mod) return re >= 0 ? "0" : "180";
  return ((Math.atan2(im, re) * 180) / Math.PI).toFixed(2);
}

interface FamilyRow {
  readonly id: number;
  readonly members: number[];
}

export function ReflectionsPage({ result, wavelength, radiation }: { result: CalcSuccess; wavelength: number; radiation: "xray" | "neutron" }) {
  const r = result.reflections;
  const bank = result.bank;
  const [hideAbsent, setHideAbsent] = useState(true);
  const [fold, setFold] = useState(true);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [limit, setLimit] = useState(400);
  useEffect(() => setOpen(new Set()), [result]);

  /** Families in order of first appearance (reflections are sorted by decreasing d). */
  const families = useMemo<FamilyRow[]>(() => {
    const byId = new Map<number, FamilyRow>();
    const order: FamilyRow[] = [];
    for (let i = 0; i < r.h.length; i++) {
      if (hideAbsent && r.cls[i] !== 0) continue;
      const id = r.family[i]!;
      let f = byId.get(id);
      if (!f) {
        f = { id, members: [] };
        byId.set(id, f);
        order.push(f);
      }
      f.members.push(i);
    }
    return order;
  }, [r, hideAbsent]);
  const visibleCount = useMemo(() => families.reduce((s, f) => s + f.members.length, 0), [families]);
  const counts = useMemo(() => {
    const c = [0, 0, 0];
    for (let i = 0; i < r.cls.length; i++) c[r.cls[i]!]!++;
    return c;
  }, [r]);
  const unit = radiation === "xray" ? "e" : "fm";
  const sinT = bank ? Math.sin((bank.twoThetaDeg * Math.PI) / 360) : 0;

  /** Position columns: 2θ for CW; TOF and λ at the bank for TOF. */
  const positionCells = (i: number) => {
    const d = r.d[i]!;
    if (bank) {
      const lam = 2 * d * sinT;
      const inBand = lam >= bank.lambdaMin && lam <= bank.lambdaMax;
      return (
        <>
          <td className={inBand ? undefined : "dim"}>{fmt(tofFromD(bank, d), 1)}</td>
          <td className={inBand ? undefined : "dim"}>{fmt(lam, 4)}</td>
        </>
      );
    }
    const x = wavelength / (2 * d);
    return <td>{x <= 1 ? fmt((2 * Math.asin(x) * 180) / Math.PI, 3) : "—"}</td>;
  };

  const exportCsv = () => {
    const pos = bank ? "tof_us,lambda_A" : "two_theta_deg";
    const lines = [`# NEXPLAN reflections; ${result.provenance.radiation}; ${bank ? `TOF bank 2theta=${bank.twoThetaDeg} DIFC=${bank.difc}` : `lambda=${wavelength} A`}; input sha256 ${result.provenance.inputSha256}`, `h,k,l,family_h,family_k,family_l,d_A,${pos},Q_invA,ReF_${unit},ImF_${unit},F2_${unit}2,class`];
    for (let i = 0; i < r.h.length; i++) {
      const d = r.d[i]!;
      const f = r.family[i]!;
      let posCols: string[];
      if (bank) posCols = [exact(tofFromD(bank, d)), exact(2 * d * sinT)];
      else {
        const x = wavelength / (2 * d);
        posCols = [exact(x <= 1 ? (2 * Math.asin(x) * 180) / Math.PI : NaN)];
      }
      lines.push([r.h[i], r.k[i], r.l[i], r.familyRep[3 * f], r.familyRep[3 * f + 1], r.familyRep[3 * f + 2], exact(d), ...posCols, exact((2 * Math.PI) / d), exact(r.re[i]!), exact(r.im[i]!), exact(r.f2[i]!), CLASS_NAME[r.cls[i]!]].join(","));
    }
    downloadText(`${result.blockName}-reflections.csv`, lines.join("\n") + "\n", "text/csv");
  };

  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const memberRow = (i: number, nested: boolean) => {
    const absent = r.cls[i] !== 0;
    return (
      <tr key={`m${i}`} className={`${absent ? "is-absent " : ""}${nested ? "is-member" : ""}`}>
        <td className="left hkl">{nested ? <span className="member-indent" /> : null}{r.h[i]} {r.k[i]} {r.l[i]}</td>
        {fold ? <td /> : null}
        <td>{fmt(r.d[i]!, 5)}</td>
        {positionCells(i)}
        <td>{fmt((2 * Math.PI) / r.d[i]!, 4)}</td>
        <td>{absent ? "0" : fmt(Math.sqrt(r.f2[i]!), 4)}</td>
        <td>{absent ? "—" : phaseDeg(r.re[i]!, r.im[i]!)}</td>
        <td>{absent ? "0" : r.f2[i]!.toPrecision(6)}</td>
        <td className="left dim">{CLASS_NAME[r.cls[i]!]}</td>
      </tr>
    );
  };

  const rows: ReactNode[] = [];
  if (fold) {
    for (const f of families.slice(0, limit)) {
      const i = f.members[0]!;
      const absent = r.cls[i] !== 0;
      const isOpen = open.has(f.id);
      const rep = [r.familyRep[3 * f.id]!, r.familyRep[3 * f.id + 1]!, r.familyRep[3 * f.id + 2]!];
      rows.push(
        <tr key={`f${f.id}`} className={`is-clickable family-row${absent ? " is-absent" : ""}${isOpen ? " is-open" : ""}`} onClick={() => toggle(f.id)} aria-expanded={isOpen}>
          <td className="left hkl">
            <span className="caret">{isOpen ? "▾" : "▸"}</span>({hklText(rep)})
          </td>
          <td>{f.members.length}</td>
          <td>{fmt(r.d[i]!, 5)}</td>
          {positionCells(i)}
          <td>{fmt((2 * Math.PI) / r.d[i]!, 4)}</td>
          <td>{absent ? "0" : fmt(Math.sqrt(r.f2[i]!), 4)}</td>
          <td className="dim">{absent ? "—" : f.members.length > 1 ? "varies" : phaseDeg(r.re[i]!, r.im[i]!)}</td>
          <td>{absent ? "0" : (f.members.length * r.f2[i]!).toPrecision(6)}</td>
          <td className="left dim">{CLASS_NAME[r.cls[i]!]}</td>
        </tr>,
      );
      if (isOpen) for (const m of f.members) rows.push(memberRow(m, true));
    }
  } else {
    let n = 0;
    outer: for (const f of families) {
      for (const m of f.members) {
        if (n++ >= limit) break outer;
        rows.push(memberRow(m, false));
      }
    }
  }
  const total = fold ? families.length : visibleCount;

  return (
    <Card
      title="Reflections"
      meta={`${r.h.length.toLocaleString()} signed hkl in ${(r.familyRep.length / 3).toLocaleString()} families · ${counts[0]!.toLocaleString()} present · ${counts[1]!.toLocaleString()} systematic · ${counts[2]!.toLocaleString()} accidental`}
      info={`Every signed hkl with d ≥ d_min. Folded rows group symmetry-equivalent reflections (point-group orbits${result.friedelMerged ? ", Friedel mates included because all amplitudes are real" : "; Friedel mates are separate because amplitudes are complex"}); |F| is the same within a family and the phases differ. "Systematic" absences follow from the space-group operations; "accidental" means |F| is numerically zero although symmetry allows it.${bank ? " Greyed TOF and λ values lie outside the bank's wavelength band." : ""}`}
      actions={
        <>
          <label className="ui-control" style={{ fontSize: "var(--fs-80)" }}>
            <input type="checkbox" checked={fold} onChange={(e) => setFold(e.target.checked)} /> Fold equivalents
          </label>
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
      <div className="ui-table-wrap ui-table-wrap--tall">
        <table className="ui-table">
          <thead>
            <tr>
              <th className="left">{fold ? "Family" : "h k l"}</th>
              {fold && <th>m</th>}
              <th>d (Å)</th>
              {bank ? (
                <>
                  <th>TOF (µs)</th>
                  <th>λ (Å)</th>
                </>
              ) : (
                <th>2θ (°)</th>
              )}
              <th>Q (Å⁻¹)</th>
              <th>|F| ({unit})</th>
              <th>φ (°)</th>
              <th>{fold ? "m·|F|²" : "|F|²"}</th>
              <th className="left">Class</th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      {total > limit && (
        <div className="table-more">
          Showing {limit.toLocaleString()} of {total.toLocaleString()} {fold ? "families" : "rows"}.
          <button type="button" className="ui-pill" onClick={() => setLimit((n) => n * 4)}>
            Show more
          </button>
          <span>The CSV always has every signed reflection at full precision.</span>
        </div>
      )}
    </Card>
  );
}

export interface CwProfileSettings {
  readonly fwhm: number;
  readonly eta: number;
}

export function PowderPage({
  result,
  axis,
  onAxis,
  cwProfile,
  onCwProfile,
  tofShape,
  onTofShape,
}: {
  result: CalcSuccess;
  axis: PowderAxis;
  onAxis: (a: PowderAxis) => void;
  cwProfile: CwProfileSettings;
  onCwProfile: (p: CwProfileSettings) => void;
  tofShape: TofShape;
  onTofShape: (s: TofShape) => void;
}) {
  const peaks = result.peaks;
  const tof = result.powderMode === "tof";
  const [selected, setSelected] = useState<number | null>(null);
  const [showSticks, setShowSticks] = useState(false);
  useEffect(() => setSelected(null), [peaks]);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  useEffect(() => {
    if (selected !== null) rowRefs.current.get(selected)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const iMax = Math.max(1e-300, ...peaks.map((p) => p.intensity));
  const fwhmUnit = axis === "twoTheta" ? "°" : axis === "d" ? "Å" : "Å⁻¹";
  const settings = result.provenance.settings;
  const axisOptions = tof
    ? ([
        { value: "tof", label: "TOF" },
        { value: "d", label: "d" },
        { value: "q", label: "Q" },
      ] as const)
    : ([
        { value: "twoTheta", label: "2θ" },
        { value: "d", label: "d" },
        { value: "q", label: "Q" },
      ] as const);
  const shownAxis: PowderAxis = tof ? (axis === "twoTheta" ? "tof" : axis) : axis === "tof" ? "twoTheta" : axis;

  const exportPeaks = () => {
    const header = tof
      ? `# NEXPLAN TOF powder peaks; ${result.provenance.radiation}; bank 2theta=${result.bank!.twoThetaDeg} deg, DIFC=${result.bank!.difc} us/A, DIFA=${result.bank!.difa}, ZERO=${result.bank!.zero}; Lorentz sin(th)*d^4`
      : `# NEXPLAN powder peaks; ${result.provenance.radiation}; lambda=${settings.wavelength} A; Lorentz 1/(sin^2 th cos th); polarization ${settings.radiation === "xray" ? JSON.stringify(settings.polarization) : "none"}`;
    const lines = [
      header,
      `d_A,${tof ? "tof_us,lambda_A" : "two_theta_deg"},Q_invA,sumF2,lorentz_pol,intensity,families`,
      ...peaks.map((p) =>
        [exact(p.d), ...(tof ? [exact(p.tof!), exact(p.lambda)] : [exact(p.twoTheta!)]), exact(p.q), exact(p.sumF2), exact(p.lp), exact(p.intensity), `"${p.families.map((f) => `(${f.hkl.join(" ")})x${f.multiplicity}`).join(" + ")}"`].join(","),
      ),
    ];
    downloadText(`${result.blockName}-${tof ? "tof-" : ""}powder-peaks.csv`, lines.join("\n") + "\n", "text/csv");
  };
  const exportProfile = () => {
    const xs = result.profile.x;
    const ys = result.profile.y;
    const shape = tof ? JSON.stringify(tofShape) : `pseudo-Voigt FWHM ${cwProfile.fwhm} ${fwhmUnit}, eta ${cwProfile.eta}`;
    const lines = [`# NEXPLAN profile; axis ${shownAxis}; ${shape}; area-normalized peaks x integrated intensity`, `${shownAxis},intensity`];
    for (let i = 0; i < xs.length; i++) lines.push(`${exact(xs[i]!)},${exact(ys[i]!)}`);
    downloadText(`${result.blockName}-powder-profile.csv`, lines.join("\n") + "\n", "text/csv");
  };

  return (
    <div className="ui-stack">
      <Card
        title="Powder pattern"
        meta={
          tof
            ? `${peaks.length} peaks · TOF bank 2θ = ${result.bank!.twoThetaDeg}° · DIFC ${fmt(result.bank!.difc, 1)} µs/Å`
            : `${peaks.length} peaks · λ = ${settings.wavelength} Å · ${settings.radiation === "xray" ? "X-ray" : "neutron"} CW`
        }
        info={
          tof
            ? "TOF intensity = Σ|F|² over every signed hkl at the same d × sinθ·d⁴ (GSAS-II TOF Lorentz factor), for data normalized by the incident spectrum. t = ZERO + DIFC·d + DIFA·d². Peaks are unit-area shapes; switching to d or Q transforms the density, so areas are preserved. No absorption or extinction."
            : "Intensity = Σ|F|² over every signed hkl at the same d, times the CW powder Lorentz factor 1/(sin²θ cosθ) and, for X-rays, the chosen polarization factor. No absorption, texture or extinction. Peaks are unit-area pseudo-Voigts on the chosen axis."
        }
        actions={
          <>
            <Segmented label="Axis" value={shownAxis} onChange={onAxis} options={axisOptions} />
            {tof ? (
              <TofShapeControls shape={tofShape} onChange={onTofShape} />
            ) : (
              <>
                <span className="ui-control">
                  <span className="ui-control-label">FWHM</span>
                  <UnitField label="Peak FWHM" value={cwProfile.fwhm} unit={fwhmUnit} min={1e-6} onCommit={(fwhm) => onCwProfile({ ...cwProfile, fwhm })} width="4.2ch" />
                </span>
                <span className="ui-control">
                  <span className="ui-control-label">
                    <span className="sym">η</span>
                  </span>
                  <UnitField label="Lorentzian fraction" value={cwProfile.eta} unit="" min={0} max={1} onCommit={(eta) => onCwProfile({ ...cwProfile, eta })} width="3.4ch" />
                </span>
              </>
            )}
            <label className="ui-control" style={{ fontSize: "var(--fs-80)" }}>
              <input type="checkbox" checked={showSticks} onChange={(e) => setShowSticks(e.target.checked)} /> Sticks
            </label>
          </>
        }
      >
        {peaks.length ? (
          <PowderPlot peaks={peaks} profile={result.profile} axis={shownAxis} selected={selected} onSelect={setSelected} showSticks={showSticks} />
        ) : (
          <p>No accessible reflections for these settings.</p>
        )}
        <p className="plot-hint">Click a peak or tick to select it · drag to zoom · double-click to reset · ← → step through peaks</p>
      </Card>
      <Card
        title="Peaks"
        meta={`${peaks.length} · ordered by decreasing d`}
        actions={
          <>
            <button type="button" className="ui-pill" onClick={exportPeaks}>
              Peaks CSV
            </button>
            <button type="button" className="ui-pill" onClick={exportProfile}>
              Profile CSV
            </button>
          </>
        }
        flush
      >
        <div className="ui-table-wrap" style={{ maxHeight: "24rem" }}>
          <table className="ui-table">
            <thead>
              <tr>
                <th className="left">hkl × multiplicity</th>
                <th>d (Å)</th>
                {tof ? (
                  <>
                    <th>TOF (µs)</th>
                    <th>λ (Å)</th>
                  </>
                ) : (
                  <th>2θ (°)</th>
                )}
                <th>Q (Å⁻¹)</th>
                <th>Σ|F|²</th>
                <th>{tof ? "sinθ·d⁴" : "LP"}</th>
                <th>I (rel.)</th>
              </tr>
            </thead>
            <tbody>
              {peaks.map((p, i) => (
                <tr
                  key={i}
                  ref={(el) => {
                    if (el) rowRefs.current.set(i, el);
                    else rowRefs.current.delete(i);
                  }}
                  className={`is-clickable${i === selected ? " is-selected" : ""}`}
                  aria-selected={i === selected}
                  onClick={() => setSelected(i === selected ? null : i)}
                >
                  <th>{p.families.map((f) => `(${hklText(f.hkl)})×${f.multiplicity}`).join(" + ")}</th>
                  <td>{fmt(p.d, 5)}</td>
                  {tof ? (
                    <>
                      <td>{fmt(p.tof!, 1)}</td>
                      <td>{fmt(p.lambda, 4)}</td>
                    </>
                  ) : (
                    <td>{fmt(p.twoTheta!, 3)}</td>
                  )}
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

function TofShapeControls({ shape, onChange }: { shape: TofShape; onChange: (s: TofShape) => void }) {
  return (
    <>
      <Segmented
        label="TOF peak shape"
        value={shape.kind}
        onChange={(k) => onChange(k === "gaussian" ? { kind: "gaussian", dOverD: 0.003 } : { kind: "backToBack", alpha1: 1, beta0: 0.03, beta1: 0.007, sig0: 0, sig1: 60, sig2: 0 })}
        options={[
          { value: "gaussian", label: "Δd/d" },
          { value: "backToBack", label: "Back-to-back" },
        ]}
      />
      {shape.kind === "gaussian" ? (
        <span className="ui-control">
          <span className="ui-control-label">Δd/d</span>
          <UnitField label="Relative resolution Δd/d (FWHM)" value={shape.dOverD * 100} unit="%" min={1e-4} max={20} onCommit={(v) => onChange({ kind: "gaussian", dOverD: v / 100 })} width="4ch" />
        </span>
      ) : (
        <span className="ui-control">
          <span className="ui-control-label">
            α, β₀, β₁, σ₁²
            <InfoBadge>
              GSAS-II back-to-back exponentials ⊗ Gaussian: α = α₁/d, β = β₀ + β₁/d⁴, σ² = σ₀ + σ₁²·d² + σ₂·d⁴ (µs). Use the values from your instrument parameter file; the defaults are only typical of a ~20 m, 90° bank.
            </InfoBadge>
          </span>
          <UnitField label="alpha1" value={shape.alpha1} unit="" min={1e-6} onCommit={(v) => onChange({ ...shape, alpha1: v })} width="4ch" />
          <UnitField label="beta0" value={shape.beta0} unit="" min={1e-6} onCommit={(v) => onChange({ ...shape, beta0: v })} width="4ch" />
          <UnitField label="beta1" value={shape.beta1} unit="" min={0} onCommit={(v) => onChange({ ...shape, beta1: v })} width="4ch" />
          <UnitField label="sig1" value={shape.sig1} unit="µs²" min={0} onCommit={(v) => onChange({ ...shape, sig1: v })} width="4ch" />
        </span>
      )}
    </>
  );
}
