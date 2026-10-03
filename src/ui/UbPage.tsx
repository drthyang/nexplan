/**
 * UB matrix page: orientation only. UB import/export and checks, change of
 * basis, and the reciprocal-space (Ewald/Laue) view with a generic Eulerian
 * goniometer. Instrument presets and detector simulations live on the
 * Instrument page.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { determinant, mulMat, mulVec, transpose } from "@materia/core/math/mat3";
import type { CalcSuccess } from "../app/compute.ts";
import { goniometerMatrix, laueCondition } from "../core/ub/goniometer.ts";
import { UNIVERSAL } from "../core/ub/instruments.ts";
import type { GoniometerModel } from "../core/ub/goniometer.ts";
import { axisAngle, directBasisInSample, latticeFromUB, nearestIndices, orientationFromUB, transformUB } from "../core/ub/ub.ts";
import { formatIsawUB, IsawParseError, parseIsawUB } from "../io/isaw.ts";
import { Card, Segmented, UnitField } from "./components.tsx";
import { downloadText, fmt, hklText } from "./format.ts";
import { presentReflections, useViewUB, type UbState } from "./ubShared.ts";

export type { UbState } from "./ubShared.ts";

const ReciprocalView = lazy(() => import("../views/ReciprocalView.tsx").then((m) => ({ default: m.ReciprocalView })));

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export interface GonioState {
  readonly angles: readonly number[];
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  readonly frame: "lab" | "sample";
  readonly showEwald: boolean;
}

export const DEFAULT_GONIO: GonioState = { angles: [0, 0, 0], lambdaMin: 0.4, lambdaMax: 3.5, frame: "lab", showEwald: true };

export function MatrixBlock({ M, digits = 6 }: { M: Mat3; digits?: number }) {
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

/** Goniometer sliders + numeric fields for a model (fixed axes shown as chips). */
export function GoniometerControls({ axes, angles, onAngles }: { axes: readonly { name: string; min: number; max: number; fixed?: number }[]; angles: readonly number[]; onAngles: (a: number[]) => void }) {
  return (
    <>
      {axes.map((ax, i) =>
        ax.fixed !== undefined ? (
          <div key={ax.name} className="form-row">
            <span className="ui-control-label">
              <span className="sym">{ax.name}</span>
            </span>
            <span className="ui-chip">fixed at {ax.fixed}°</span>
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
              value={angles[i] ?? 0}
              onChange={(e) => onAngles(axes.map((_, j) => (j === i ? Number(e.target.value) : (angles[j] ?? 0))))}
              aria-label={`${ax.name} angle`}
            />
            <UnitField label={`${ax.name} angle`} value={angles[i] ?? 0} unit="°" min={ax.min} max={ax.max} width="5ch" onCommit={(v) => onAngles(axes.map((_, j) => (j === i ? v : (angles[j] ?? 0))))} />
          </label>
        ),
      )}
    </>
  );
}

/** An SNS instrument's goniometer and band, overriding the generic Eulerian goniometer. */
export interface OrientationInstrument {
  readonly name: string;
  readonly goniometer: GoniometerModel;
  readonly angles: readonly number[];
  readonly onAngles: (a: number[]) => void;
  readonly lambdaMin: number;
  readonly lambdaMax: number;
}

export function UbPage({ result, theme, ub, onUb, gonio, onGonio, instrument }: { result: CalcSuccess; theme: "light" | "dark"; ub: UbState; onUb: (u: UbState) => void; gonio: GonioState; onGonio: (g: GonioState) => void; instrument?: OrientationInstrument | undefined }) {
  const model = instrument?.goniometer ?? UNIVERSAL;
  const angles = instrument?.angles ?? gonio.angles;
  const lambdaMin = instrument?.lambdaMin ?? gonio.lambdaMin;
  const lambdaMax = instrument?.lambdaMax ?? gonio.lambdaMax;
  const cifCell = result.structure.cell;
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [P, setP] = useState<Mat3>(IDENTITY);

  const { viewUB, match, fileUB } = useViewUB(result, ub);
  const orient = useMemo(() => orientationFromUB(viewUB), [viewUB]);
  const R = useMemo(() => goniometerMatrix(model, angles), [model, angles]);
  const points = useMemo(() => presentReflections(result), [result]);
  useEffect(() => setSelected(null), [points]);

  const laue = useMemo(() => {
    const status = new Uint8Array(points.length);
    const lambdas = new Float64Array(points.length);
    const rows: { i: number; lambda: number; twoTheta: number; azimuth: number }[] = [];
    const RUB = mulMat(R, viewUB);
    points.forEach((p, i) => {
      const s = laueCondition(mulVec(RUB, p.h));
      lambdas[i] = s.lambda;
      if (!(s.lambda >= lambdaMin && s.lambda <= lambdaMax)) return;
      status[i] = 2;
      rows.push({ i, lambda: s.lambda, twoTheta: s.twoTheta, azimuth: s.azimuth });
    });
    return { status, lambdas, rows };
  }, [points, R, viewUB, lambdaMin, lambdaMax]);

  const along = useMemo(() => {
    const RUB = mulMat(R, viewUB);
    const A = directBasisInSample(RUB);
    return { beamHkl: nearestIndices(RUB, [0, 0, 1]), beamUvw: nearestIndices(A, [0, 0, 1]), upHkl: nearestIndices(RUB, [0, 1, 0]), upUvw: nearestIndices(A, [0, 1, 0]) };
  }, [R, viewUB]);

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
          meta={`${points.length.toLocaleString()} reflections · ${laue.rows.length.toLocaleString()} in the λ band`}
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
              lambdaMin={lambdaMin}
              lambdaMax={lambdaMax}
              points={points}
              frame={gonio.frame}
              selected={selected}
              onSelect={setSelected}
              theme={theme}
              showEwald={gonio.showEwald}
              fileStem={result.blockName}
              status={laue.status}
              lambdas={laue.lambdas}
              hasDetectors={false}
            />
          </Suspense>
          {sel && (
            <p className="selection-note">
              <b>({hklText(sel.h)})</b> d {fmt(sel.d, 4)} Å · |F|² {sel.f2.toPrecision(4)} ·{" "}
              {selSpot && Number.isFinite(selSpot.lambda) ? `λ ${fmt(selSpot.lambda, 4)} Å, 2θ ${fmt(selSpot.twoTheta, 2)}°, azimuth ${fmt(selSpot.azimuth, 1)}°${selSpot.lambda < lambdaMin || selSpot.lambda > lambdaMax ? " (outside the band)" : ""}` : "cannot diffract at this setting (q points along the beam)"}
              <span className="dim"> · Mantid's default Inelastic convention labels this reflection ({hklText([-sel.h[0], -sel.h[1], -sel.h[2]])}).</span>
            </p>
          )}
        </Card>

        <div className="ui-stack">
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
                      The UB is in a different setting. Mapped with P = [{match.P.map((r) => r.join(" ")).join("; ")}] (h_UB = Pᵀ·h_CIF, misfit {(100 * match.misfit).toFixed(2)} %); the views use UB·Pᵀ so CIF indices land where the UB puts them.
                    </p>
                  )
                ) : (
                  <p className="error-note">The UB cell does not match the CIF cell by any simple change of axes (within 2 %). The views use the UB as loaded, so CIF indices may not correspond to the UB's.</p>
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

          <Card
            title="Goniometer"
            meta={instrument ? instrument.name : "generic Eulerian (choose an instrument in the header)"}
            info={instrument ? model.note : `${UNIVERSAL.note} Choose an SNS instrument in the header to use its goniometer, band and detectors.`}
          >
            <div className="form-rows">
              <GoniometerControls axes={model.axes} angles={angles} onAngles={(a) => (instrument ? instrument.onAngles(a) : onGonio({ ...gonio, angles: a }))} />
              {instrument ? (
                <div className="form-row">
                  <span className="ui-control-label">
                    <span className="sym">λ</span> band
                  </span>
                  <span className="dim-note">
                    {Number(lambdaMin.toPrecision(4))}–{Number(lambdaMax.toPrecision(4))} Å, set in the bar above
                  </span>
                </div>
              ) : (
              <div className="form-row">
                <span className="ui-control-label">
                  <span className="sym">λ</span> band
                </span>
                <UnitField label="Minimum wavelength" value={gonio.lambdaMin} unit="Å" min={0.05} width="4.5ch" onCommit={(v) => onGonio({ ...gonio, lambdaMin: v })} />
                <UnitField label="Maximum wavelength" value={gonio.lambdaMax} unit="Å" min={0.06} width="4.5ch" onCommit={(v) => onGonio({ ...gonio, lambdaMax: v })} />
              </div>
              )}
            </div>
            <p className="empty-note">Lab frame: beam +z, up +y. q_lab = R·UB·h{instrument ? `, R from the ${instrument.name} goniometer.` : " with R = R_y(ω)·R_z(χ)·R_y(φ) (Mantid Universal)."}</p>
          </Card>
        </div>
      </div>

      <div className="ui-grid ui-grid--split">
        <Card title="Reflections in the band" meta={`${laue.rows.length.toLocaleString()} at this goniometer setting · strongest first`} flush>
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
                {laue.rows
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
          info="ITA convention (a′, b′, c′) = (a, b, c)·P: h′ = Pᵀ·h and UB′ = UB·P⁻ᵀ, so every reflection keeps its q. Integer P with |det P| > 1 makes a supercell. Export the result for Mantid or ISAW; the views keep the CIF setting."
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
