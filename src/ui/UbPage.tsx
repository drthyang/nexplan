import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { determinant, mulVec, transpose } from "@materia/core/math/mat3";
import type { CalcSuccess } from "../app/compute.ts";
import { goniometerMatrix, laueCondition } from "../core/ub/goniometer.ts";
import { INSTRUMENTS } from "../core/ub/instruments.ts";
import { axisAngle, directBasisInSample, findBasisMatch, latticeFromUB, nearestIndices, orientationFromUB, transformUB, ubFromU, type BasisMatch } from "../core/ub/ub.ts";
import { formatIsawUB, IsawParseError, parseIsawUB } from "../io/isaw.ts";
import { Card, Chip, Segmented, UnitField } from "./components.tsx";
import { downloadText, fmt, hklText } from "./format.ts";

const ReciprocalView = lazy(() => import("../views/ReciprocalView.tsx").then((m) => ({ default: m.ReciprocalView })));

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export interface UbState {
  /** UB as loaded or built (Mantid sample frame, q = UB·h, 1/Å, no 2π). */
  readonly UB?: Mat3;
  readonly fileName?: string;
  readonly warnings: readonly string[];
}

export interface GonioState {
  readonly instrumentId: string;
  readonly angles: readonly number[];
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  readonly frame: "lab" | "sample";
  readonly showEwald: boolean;
}

export const DEFAULT_GONIO: GonioState = { instrumentId: "topaz-cryo", angles: [0, 0, 0], lambdaMin: 0.4, lambdaMax: 3.5, frame: "lab", showEwald: true };

const MAX_POINTS = 6000;

function MatrixBlock({ M, digits = 6 }: { M: Mat3; digits?: number }) {
  return (
    <table className="ui-table matrix">
      <tbody>
        {M.map((row, i) => (
          <tr key={i}>
            {row.map((v, j) => (
              <td key={j}>{v.toFixed(digits)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UbPage({ result, theme, ub, onUb, gonio, onGonio }: { result: CalcSuccess; theme: "light" | "dark"; ub: UbState; onUb: (u: UbState) => void; gonio: GonioState; onGonio: (g: GonioState) => void }) {
  const cifCell = result.structure.cell;
  const instrument = INSTRUMENTS.find((i) => i.id === gonio.instrumentId) ?? INSTRUMENTS[0]!;
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [P, setP] = useState<Mat3>(IDENTITY);

  // UB used for the view: the loaded UB mapped to the CIF setting, or U = I with the CIF cell.
  const fileUB = ub.UB;
  const match: BasisMatch | undefined = useMemo(() => (fileUB ? findBasisMatch(cifCell, fileUB) : undefined), [fileUB, cifCell]);
  const viewUB: Mat3 = fileUB ? (match ? match.ubForCif : fileUB) : ubFromU(IDENTITY, cifCell);
  const orient = useMemo(() => orientationFromUB(viewUB), [viewUB]);
  const R = useMemo(() => goniometerMatrix(instrument.goniometer, gonio.angles), [instrument, gonio.angles]);

  // Present reflections, strongest first if there are too many to draw.
  const points = useMemo(() => {
    const r = result.reflections;
    const idx: number[] = [];
    for (let i = 0; i < r.h.length; i++) if (r.cls[i] === 0) idx.push(i);
    idx.sort((a, b) => r.f2[b]! - r.f2[a]!);
    return idx.slice(0, MAX_POINTS).map((i) => ({ h: [r.h[i]!, r.k[i]!, r.l[i]!] as Vec3, f2: r.f2[i]!, d: r.d[i]! }));
  }, [result]);
  useEffect(() => setSelected(null), [points]);

  const inBand = useMemo(() => {
    const rows: { i: number; lambda: number; twoTheta: number; azimuth: number }[] = [];
    points.forEach((p, i) => {
      const s = laueCondition(mulVec(R, mulVec(viewUB, p.h)));
      if (s.lambda >= gonio.lambdaMin && s.lambda <= gonio.lambdaMax) rows.push({ i, lambda: s.lambda, twoTheta: s.twoTheta, azimuth: s.azimuth });
    });
    return rows;
  }, [points, R, viewUB, gonio.lambdaMin, gonio.lambdaMax]);

  // What points along the beam and up, in the crystal, at this goniometer setting.
  const RUB = useMemo(() => {
    const M = [0, 1, 2].map((i) => [0, 1, 2].map((j) => R[i]![0]! * viewUB[0]![j]! + R[i]![1]! * viewUB[1]![j]! + R[i]![2]! * viewUB[2]![j]!)) as unknown as Mat3;
    return M;
  }, [R, viewUB]);
  const along = useMemo(() => {
    const A = directBasisInSample(RUB);
    return {
      beamHkl: nearestIndices(RUB, [0, 0, 1]),
      beamUvw: nearestIndices(A, [0, 0, 1]),
      upHkl: nearestIndices(RUB, [0, 1, 0]),
      upUvw: nearestIndices(A, [0, 1, 0]),
    };
  }, [RUB]);

  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    setLoadError(null);
    try {
      const parsed = parseIsawUB(await f.text());
      onUb({ UB: parsed.UB, fileName: f.name, warnings: parsed.warnings });
    } catch (e) {
      setLoadError(e instanceof IsawParseError ? e.message : `Could not read ${f.name}: ${(e as Error).message}`);
    }
  };

  const fileLattice = fileUB ? latticeFromUB(fileUB) : undefined;
  const aa = axisAngle(orient.U);
  const transformed = useMemo(() => {
    try {
      return { UB: transformUB(viewUB, P), det: determinant(P) };
    } catch (e) {
      return { error: (e as Error).message, det: 0 };
    }
  }, [viewUB, P]);
  const sel = selected !== null ? points[selected] : undefined;
  const selSpot = sel ? laueCondition(mulVec(R, mulVec(viewUB, sel.h))) : undefined;

  return (
    <div className="ui-stack">
      <div className="ui-grid ui-grid--split">
        <Card
          title="Reciprocal space"
          meta={`${points.length.toLocaleString()} reflections · ${inBand.length.toLocaleString()} in the λ band`}
          info="Laue (white-beam / TOF) Ewald construction in 1/Å without 2π. Points are reciprocal-lattice nodes q = UB·h sized by |F|²; a point is coloured by the wavelength at which it diffracts when that lies in the band. The two spheres are the Ewald spheres for λmin and λmax: everything between them diffracts. Click a point to draw its k_i, k_f and q. Drag to rotate, scroll to zoom."
          className="viewer-card"
          actions={
            <>
              <Segmented label="Frame" value={gonio.frame} onChange={(frame) => onGonio({ ...gonio, frame })} options={[{ value: "lab", label: "Lab frame" }, { value: "sample", label: "Sample frame" }]} />
              <label className="ui-check" style={{ fontSize: "var(--fs-80)" }}>
                <input type="checkbox" checked={gonio.showEwald} onChange={(e) => onGonio({ ...gonio, showEwald: e.target.checked })} /> Ewald spheres
              </label>
            </>
          }
        >
          <Suspense fallback={<p className="empty-note">Loading the 3D view…</p>}>
            <ReciprocalView
              UB={viewUB}
              R={R}
              qSign={1}
              lambdaMin={gonio.lambdaMin}
              lambdaMax={gonio.lambdaMax}
              points={points}
              frame={gonio.frame}
              selected={selected}
              onSelect={setSelected}
              theme={theme}
              showEwald={gonio.showEwald}
              fileStem={result.blockName}
            />
          </Suspense>
          {sel && (
            <p className="selection-note">
              <b>({hklText(sel.h)})</b> d {fmt(sel.d, 4)} Å · |F|² {sel.f2.toPrecision(4)} ·{" "}
              {selSpot && Number.isFinite(selSpot.lambda) ? `λ ${fmt(selSpot.lambda, 4)} Å, 2θ ${fmt(selSpot.twoTheta, 2)}°, azimuth ${fmt(selSpot.azimuth, 1)}°${selSpot.lambda < gonio.lambdaMin || selSpot.lambda > gonio.lambdaMax ? " (outside the band)" : ""}` : "cannot diffract at this setting (q points along the beam)"}
              <span className="dim"> · Mantid's default Inelastic convention labels this reflection ({hklText([-sel.h[0], -sel.h[1], -sel.h[2]])}).</span>
            </p>
          )}
        </Card>

        <div className="ui-stack">
          <Card title="Goniometer" info={`${instrument.goniometer.note} Sources: ${instrument.source}`}>
            <div className="form-rows">
              <label className="form-row">
                <span className="ui-control-label">Instrument</span>
                <select
                  className="ui-select"
                  value={instrument.id}
                  onChange={(e) => {
                    const ins = INSTRUMENTS.find((i) => i.id === e.target.value)!;
                    onGonio({ ...gonio, instrumentId: ins.id, angles: ins.goniometer.axes.map(() => 0), lambdaMin: ins.lambdaMin, lambdaMax: ins.lambdaMax });
                  }}
                >
                  {INSTRUMENTS.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </label>
              {instrument.goniometer.axes.map((ax, i) =>
                ax.fixed !== undefined ? (
                  <div key={ax.name} className="form-row">
                    <span className="ui-control-label">
                      <span className="sym">{ax.name}</span>
                    </span>
                    <Chip>fixed at {ax.fixed}°</Chip>
                  </div>
                ) : (
                  <label key={ax.name} className="form-row">
                    <span className="ui-control-label">
                      <span className="sym">{ax.name}</span>
                    </span>
                    <input
                      type="range"
                      className="ui-range"
                      min={ax.min}
                      max={ax.max}
                      step={0.5}
                      value={gonio.angles[i] ?? 0}
                      onChange={(e) => onGonio({ ...gonio, angles: gonio.angles.map((v, j) => (j === i ? Number(e.target.value) : v)) })}
                      aria-label={`${ax.name} angle`}
                    />
                    <UnitField
                      label={`${ax.name} angle`}
                      value={gonio.angles[i] ?? 0}
                      unit="°"
                      min={ax.min}
                      max={ax.max}
                      width="5ch"
                      onCommit={(v) => onGonio({ ...gonio, angles: gonio.angles.map((x, j) => (j === i ? v : x)) })}
                    />
                  </label>
                ),
              )}
              <div className="form-row">
                <span className="ui-control-label">
                  <span className="sym">λ</span> band
                </span>
                <UnitField label="Minimum wavelength" value={gonio.lambdaMin} unit="Å" min={0.05} width="4.5ch" onCommit={(v) => onGonio({ ...gonio, lambdaMin: v })} />
                <UnitField label="Maximum wavelength" value={gonio.lambdaMax} unit="Å" min={0.06} width="4.5ch" onCommit={(v) => onGonio({ ...gonio, lambdaMax: v })} />
              </div>
            </div>
            <p className="empty-note">
              Lab frame: beam +z, up +y. q_lab = R·UB·h, R = {instrument.goniometer.axes.map((a) => `R(${a.name})`).join("·")}. Detector coverage is not modelled yet: every reflection in the band is shown.
            </p>
          </Card>

          <Card
            title="UB matrix"
            meta={ub.fileName ?? "from the CIF cell, U = I"}
            info="q = UB·h in Mantid's sample frame (1/Å, no 2π), as Mantid stores it and ISAW files carry it (transposed, IPNS axes). For the crystallographic indices used here q is k_f − k_i (checked against Mantid's TOPAZ_3007 peaks)."
            actions={
              <>
                <button type="button" className="ui-pill" onClick={() => fileInput.current?.click()}>
                  Load ISAW UB…
                </button>
                <button type="button" className="ui-pill" onClick={() => downloadText(`${result.blockName}${fileUB ? "" : "-default"}.mat`, formatIsawUB(viewUB))}>
                  Export ISAW
                </button>
                {fileUB && (
                  <button type="button" className="ui-pill" onClick={() => onUb({ warnings: [] })}>
                    Clear
                  </button>
                )}
                <input ref={fileInput} type="file" accept=".mat,.ub,.txt" hidden onChange={(e) => void loadFile(e.target.files?.[0])} />
              </>
            }
          >
            {loadError && <p className="error-note">{loadError}</p>}
            {ub.warnings.map((w) => (
              <p key={w} className="warn-note">
                {w}
              </p>
            ))}
            <MatrixBlock M={viewUB} />
            {fileUB && fileLattice && (
              <>
                <table className="ui-table" style={{ marginTop: "0.6rem" }}>
                  <thead>
                    <tr>
                      <th className="left" />
                      <th>a</th>
                      <th>b</th>
                      <th>c</th>
                      <th>α</th>
                      <th>β</th>
                      <th>γ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th>UB file</th>
                      {[fileLattice.a, fileLattice.b, fileLattice.c, fileLattice.alpha, fileLattice.beta, fileLattice.gamma].map((v, i) => (
                        <td key={i}>{fmt(v, i < 3 ? 4 : 3)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>CIF</th>
                      {[cifCell.a, cifCell.b, cifCell.c, cifCell.alpha, cifCell.beta, cifCell.gamma].map((v, i) => (
                        <td key={i}>{fmt(v, i < 3 ? 4 : 3)}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
                {match ? (
                  match.P.every((r, i) => r.every((v, j) => v === (i === j ? 1 : 0))) ? (
                    <p className="ok-note">The UB cell matches the CIF cell (metric misfit {(100 * match.misfit).toFixed(2)} %).</p>
                  ) : (
                    <p className="warn-note">
                      The UB is in a different setting. Mapped with P = [{match.P.map((r) => r.join(" ")).join("; ")}] (h_UB = Pᵀ·h_CIF, misfit {(100 * match.misfit).toFixed(2)} %); the view uses UB·Pᵀ so CIF indices land where the UB puts them.
                    </p>
                  )
                ) : (
                  <p className="error-note">The UB cell does not match the CIF cell by any simple change of axes (within 2 %). The view uses the UB as loaded, so CIF indices may not correspond to the UB's.</p>
                )}
              </>
            )}
            <dl className="ui-stats ui-stats--three" style={{ marginTop: "0.75rem" }}>
              <div>
                <dt>det UB</dt>
                <dd>{orient.detUB.toExponential(4)}</dd>
              </div>
              <div>
                <dt>|UᵀU − I|</dt>
                <dd>{orient.orthogonalityError.toExponential(1)}</dd>
              </div>
              <div>
                <dt>U rotation</dt>
                <dd>
                  {fmt(aa.angleDeg, 2)}° <small>about [{aa.axis.map((v) => v.toFixed(3)).join(", ")}]</small>
                </dd>
              </div>
              <div>
                <dt>Along beam</dt>
                <dd>
                  ({hklText(along.beamHkl.indices)}) <small>{fmt(along.beamHkl.angleDeg, 1)}° off</small>
                </dd>
              </div>
              <div>
                <dt>Along beam, real</dt>
                <dd>
                  [{hklText(along.beamUvw.indices)}] <small>{fmt(along.beamUvw.angleDeg, 1)}° off</small>
                </dd>
              </div>
              <div>
                <dt>Vertical</dt>
                <dd>
                  ({hklText(along.upHkl.indices)}) <small>[{hklText(along.upUvw.indices)}]</small>
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>

      <div className="ui-grid ui-grid--split">
        <Card title="Reflections in the band" meta={`${inBand.length.toLocaleString()} at this goniometer setting · strongest first`} flush>
          <div className="ui-table-wrap" style={{ maxHeight: "22rem" }}>
            <table className="ui-table">
              <thead>
                <tr>
                  <th className="left">hkl</th>
                  <th>d (Å)</th>
                  <th>λ (Å)</th>
                  <th>2θ (°)</th>
                  <th>azimuth (°)</th>
                  <th>|F|²</th>
                </tr>
              </thead>
              <tbody>
                {inBand
                  .slice()
                  .sort((a, b) => points[b.i]!.f2 - points[a.i]!.f2)
                  .slice(0, 400)
                  .map((row) => {
                    const p = points[row.i]!;
                    return (
                      <tr key={row.i} className={`is-clickable${row.i === selected ? " is-selected" : ""}`} onClick={() => setSelected(row.i === selected ? null : row.i)}>
                        <th>({hklText(p.h)})</th>
                        <td>{fmt(p.d, 4)}</td>
                        <td>{fmt(row.lambda, 4)}</td>
                        <td>{fmt(row.twoTheta, 2)}</td>
                        <td>{fmt(row.azimuth, 1)}</td>
                        <td>{p.f2.toPrecision(5)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="Change of basis"
          info="ITA convention (a′, b′, c′) = (a, b, c)·P: h′ = Pᵀ·h and UB′ = UB·P⁻ᵀ, so every reflection keeps its q. Integer P with |det P| > 1 makes a supercell. Export the result for Mantid or ISAW; the view keeps the CIF setting."
          actions={
            <>
              <button type="button" className="ui-pill" onClick={() => setP(IDENTITY)}>
                Identity
              </button>
              <button type="button" className="ui-pill" onClick={() => setP([[0, 1, 0], [0, 0, 1], [1, 0, 0]])} title="(a′, b′, c′) = (c, a, b)">
                Cycle axes
              </button>
              <button type="button" className="ui-pill" onClick={() => setP([[2, 0, 0], [0, 2, 0], [0, 0, 2]])}>
                2×2×2
              </button>
            </>
          }
        >
          <div className="p-matrix">
            {P.map((row, i) =>
              row.map((v, j) => (
                <input
                  key={`${i}${j}`}
                  className="p-cell"
                  inputMode="decimal"
                  aria-label={`P row ${i + 1} column ${j + 1}`}
                  value={String(v)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) return;
                    setP(P.map((r, a) => r.map((x, b) => (a === i && b === j ? n : x))) as unknown as Mat3);
                  }}
                />
              )),
            )}
          </div>
          {"error" in transformed ? (
            <p className="error-note">{transformed.error}</p>
          ) : (
            <>
              <p className="empty-note" style={{ marginTop: "0.6rem" }}>
                det P = {fmt(transformed.det, 3)}
                {transformed.det < 0 ? " — changes handedness; Mantid will reject it (U must be a proper rotation)." : Math.abs(transformed.det - 1) > 1e-9 ? ` — a ${Math.abs(transformed.det) > 1 ? "supercell" : "sub-cell"} of volume ×${fmt(Math.abs(transformed.det), 3)}.` : ""}
              </p>
              <dl className="ui-stats ui-stats--three">
                {(() => {
                  const l = latticeFromUB(transformed.UB!);
                  return (
                    <>
                      <div><dt><span className="sym">a′</span></dt><dd>{fmt(l.a, 4)} <small>Å</small></dd></div>
                      <div><dt><span className="sym">b′</span></dt><dd>{fmt(l.b, 4)} <small>Å</small></dd></div>
                      <div><dt><span className="sym">c′</span></dt><dd>{fmt(l.c, 4)} <small>Å</small></dd></div>
                      <div><dt><span className="sym">α′</span></dt><dd>{fmt(l.alpha, 3)}°</dd></div>
                      <div><dt><span className="sym">β′</span></dt><dd>{fmt(l.beta, 3)}°</dd></div>
                      <div><dt><span className="sym">γ′</span></dt><dd>{fmt(l.gamma, 3)}°</dd></div>
                    </>
                  );
                })()}
              </dl>
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem", flexWrap: "wrap" }}>
                <button type="button" className="ui-btn-brand" disabled={transformed.det <= 0} onClick={() => downloadText(`${result.blockName}-transformed.mat`, formatIsawUB(transformed.UB!))}>
                  Export UB′ (ISAW)
                </button>
                {sel && (
                  <span className="empty-note" style={{ margin: 0 }}>
                    Selected ({hklText(sel.h)}) → ({hklText(mulVec(transpose(P), sel.h).map((v) => Number(v.toFixed(4))) as unknown as Vec3)})′
                  </span>
                )}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

