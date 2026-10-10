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
import { applyMasks, shadowTest, type MaskSettings, type ShadowShape } from "../core/instrument/acceptance.ts";
import { rayHit, type DetectorPanel } from "../core/instrument/detectors.ts";
import { goniometerMatrix, laueCondition } from "../core/ub/goniometer.ts";
import { UNIVERSAL } from "../core/ub/instruments.ts";
import type { GoniometerModel } from "../core/ub/goniometer.ts";
import { axisAngle, directBasisInSample, latticeFromUB, nearestIndices, orientationFromUB, transformUB } from "../core/ub/ub.ts";
import { formatIsawUB, IsawParseError, parseIsawUB } from "../io/isaw.ts";
import { BASIS_PRESETS, hklTransformText, linearText, parseRatio, ratioText, supercell } from "../core/ub/basis.ts";
import { Card, cx, Segmented, UnitField } from "./components.tsx";
import { downloadText, fmt, hklText } from "./format.ts";
import { byHkl, byNumber, byText, SortTh, useSort } from "./sortable.tsx";
import type { GonioState } from "./experimentState.ts";
import { planeOf, presentReflections, type UbState } from "./ubShared.ts";
import { useViewUB } from "./useViewUB.ts";
import { mountable, PLANE_PRESETS, planeGeometry, setUBCall, zoneAxis, type ScatteringPlane } from "../core/ub/mount.ts";

export type { UbState } from "./ubShared.ts";

const ReciprocalView = lazy(() => import("../views/ReciprocalView.tsx").then((m) => ({ default: m.ReciprocalView })));

type BandKey = "hkl" | "d" | "lam" | "tth" | "az" | "panel" | "f2";

const OLD_AXES = ["a", "b", "c"] as const;
const NEW_AXES = ["a′", "b′", "c′"] as const;
const NEW_INDICES = ["h′", "k′", "l′"] as const;

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const isIdentity = (P: Mat3) => P.every((r, i) => r.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < 1e-12));

/** The UB's axes in the CIF's, the columns of P: "(2 a, 2 b, 2 c)". */
const axesText = (P: Mat3) => `(${[0, 1, 2].map((j) => linearText([P[0]![j]!, P[1]![j]!, P[2]![j]!], OLD_AXES)).join(", ")})`;

/** "2 × 2 × 2" when P is a plain diagonal of positive multiples. */
const multiplesText = (P: Mat3) =>
  P.every((r, i) => r.every((v, j) => (i === j ? v > 0 : Math.abs(v) < 1e-12))) ? [0, 1, 2].map((i) => ratioText(P[i]![i]!)).join(" × ") : undefined;

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
  /** Catalog id: its detector geometry is loaded on demand for the 3D view. */
  readonly id: string;
  readonly name: string;
  readonly goniometer: GoniometerModel;
  readonly angles: readonly number[];
  readonly onAngles: (a: number[]) => void;
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  /** The detector masks and sample-environment shadows the simulation pages use (acceptance.ts). */
  readonly masks: MaskSettings;
  readonly shadows: readonly ShadowShape[];
}

export function UbPage({ result, theme, ub, onUb, gonio, onGonio, instrument }: { result: CalcSuccess; theme: "light" | "dark"; ub: UbState; onUb: (u: UbState) => void; gonio: GonioState; onGonio: (g: GonioState) => void; instrument?: OrientationInstrument | undefined }) {
  const model = instrument?.goniometer ?? UNIVERSAL;
  const angles = instrument?.angles ?? gonio.angles;
  const lambdaMin = instrument?.lambdaMin ?? gonio.lambdaMin;
  const lambdaMax = instrument?.lambdaMax ?? gonio.lambdaMax;
  const cifCell = result.structure.cell;
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // The 3D Laue construction is opt-in (it is for understanding the frames, not for planning); remembered per browser.
  const [explore, setExploreState] = useState(() => {
    try {
      return localStorage.getItem("nexplan-explore-3d") === "open";
    } catch {
      return false;
    }
  });
  const setExplore = (open: boolean) => {
    setExploreState(open);
    try {
      localStorage.setItem("nexplan-explore-3d", open ? "open" : "closed");
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
  };
  const [loadError, setLoadError] = useState<string | null>(null);
  const [P, setP] = useState<Mat3>(IDENTITY);
  const [cell, setCell] = useState<[number, number, number]>([1, 1, 1]);
  // The cell-multiple fields follow P when P is a diagonal of positive multiples (2 for a supercell, 1/2 for a smaller cell).
  const diagonal = P.every((r, i) => r.every((v, j) => (i === j ? v > 0 : v === 0)));
  const shownCell: [number, number, number] = diagonal ? [P[0]![0]!, P[1]![1]!, P[2]![2]!] : cell;
  const applyCell = (c: [number, number, number]) => {
    setCell(c);
    setP(supercell(...c));
  };

  const { viewUB, match, matches, fileUB } = useViewUB(result, ub);
  // Re-indexing starts from the CIF cell, or from the file's own cell when the two differ.
  const [reindexFrom, setReindexFrom] = useState<"cif" | "file">("cif");
  const fileCellDiffers = !!fileUB && !!match && !isIdentity(match.P);
  const baseUB = fileCellDiffers && reindexFrom === "file" ? fileUB : viewUB;
  const orient = useMemo(() => orientationFromUB(viewUB), [viewUB]);
  const R = useMemo(() => goniometerMatrix(model, angles), [model, angles]);
  const points = useMemo(() => presentReflections(result), [result]);
  useEffect(() => setSelected(null), [points]);

  // An SNS instrument's detectors, loaded (from the lazy instrument chunk) only when the 3D view is open.
  const [panels, setPanels] = useState<{ id: string; list: readonly DetectorPanel[] } | null>(null);
  const instrumentId = instrument?.id;
  useEffect(() => {
    if (!explore || !instrumentId || panels?.id === instrumentId) return;
    let alive = true;
    void import("../core/ub/instrumentsSns.ts").then((m) => {
      const list = m.SNS_INSTRUMENTS.find((i) => i.id === instrumentId)?.detectors;
      if (alive && list) setPanels({ id: instrumentId, list });
    });
    return () => {
      alive = false;
    };
  }, [explore, instrumentId, panels]);
  const masks = instrument?.masks;
  const detectors = useMemo(() => (panels && panels.id === instrumentId ? (masks ? applyMasks(panels.list, masks) : panels.list) : undefined), [panels, instrumentId, masks]);
  const shadows = instrument?.shadows;
  const blocked = useMemo(() => (detectors && shadows ? shadowTest(shadows, model, angles) : undefined), [detectors, shadows, model, angles]);

  // Status per reflection: 2 diffracts onto a detector (or, without detectors, in the band), 1 in the band but misses every panel.
  const laue = useMemo(() => {
    const status = new Uint8Array(points.length);
    const lambdas = new Float64Array(points.length);
    const rows: { i: number; lambda: number; twoTheta: number; azimuth: number; panel?: string }[] = [];
    const RUB = mulMat(R, viewUB);
    points.forEach((p, i) => {
      const s = laueCondition(mulVec(RUB, p.h));
      lambdas[i] = s.lambda;
      if (!(s.lambda >= lambdaMin && s.lambda <= lambdaMax)) return;
      const hit = detectors ? rayHit(detectors, s.kf, blocked) : undefined;
      status[i] = detectors && !hit ? 1 : 2;
      rows.push({ i, lambda: s.lambda, twoTheta: s.twoTheta, azimuth: s.azimuth, ...(hit ? { panel: hit.name } : {}) });
    });
    return { status, lambdas, rows, onDetectors: detectors ? rows.filter((r) => r.panel).length : undefined };
  }, [points, R, viewUB, lambdaMin, lambdaMax, detectors, blocked]);
  const [bandSort, onBandSort] = useSort<BandKey>({ key: "f2", dir: "desc" }, { d: "desc", f2: "desc" }, (k) => k !== "panel" || !!detectors);
  const bandRows = useMemo(() => {
    const { key, dir } = bandSort;
    const rows = laue.rows.slice();
    if (key === "hkl") return rows.sort((a, b) => byHkl(points[a.i]!.h, points[b.i]!.h, dir));
    if (key === "panel") return rows.sort((a, b) => byText(a.panel, b.panel, dir));
    const value = (r: (typeof rows)[number]) => (key === "d" ? points[r.i]!.d : key === "lam" ? r.lambda : key === "tth" ? r.twoTheta : key === "az" ? r.azimuth : points[r.i]!.f2);
    return rows.sort((a, b) => byNumber(value(a), value(b), dir));
  }, [laue, points, bandSort]);

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
      onUb({ UB: parsed.UB, fileName: f.name, warnings: parsed.warnings, ...(ub.plane ? { plane: ub.plane } : {}) });
    } catch (e) {
      setLoadError(e instanceof IsawParseError ? e.message : `Could not read ${f.name}: ${(e as Error).message}`);
    }
  };

  const fileLattice = fileUB ? latticeFromUB(fileUB) : undefined;
  const aa = axisAngle(orient.U);
  const transformed = useMemo(() => {
    try {
      return { UB: transformUB(baseUB, P), det: determinant(P) };
    } catch (e) {
      return { error: (e as Error).message, det: 0 };
    }
  }, [baseUB, P]);
  const sel = selected !== null ? points[selected] : undefined;
  // Indices to convert: typed, or the reflection picked in the 3D view or its table.
  const [tryText, setTryText] = useState("1 0 0");
  useEffect(() => {
    if (sel) setTryText(sel.h.join(" "));
  }, [sel]);
  const tryH = useMemo(() => {
    const v = tryText.trim().split(/[\s,]+/).map(Number);
    return v.length === 3 && v.every((x) => Number.isFinite(x)) ? (v as unknown as Vec3) : undefined;
  }, [tryText]);
  const selSpot = sel ? laueCondition(mulVec(R, mulVec(viewUB, sel.h))) : undefined;

  return (
    <div className="ui-stack">
      <div className="ui-grid ui-grid--split">
          <Card
            title="UB matrix"
            meta={ub.fileName ?? (planeOf(ub) ? `the CIF cell mounted in u (${hklText(planeOf(ub)!.u)}), v (${hklText(planeOf(ub)!.v)}) · Mantid SetUB` : "from the CIF cell, U = I")}
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
                  <button type="button" className="ui-pill" onClick={() => onUb({ warnings: [], ...(ub.plane ? { plane: ub.plane } : {}) })}>
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
                  isIdentity(match.P) ? (
                    <p className="ok-note">The UB cell matches the CIF cell (metric misfit {(100 * match.misfit).toFixed(2)} %).</p>
                  ) : (
                    <p className="warn-note">
                      {match.volumeRatio > 1 + 1e-9
                        ? `The UB is for a ${multiplesText(match.P) ? `${multiplesText(match.P)} supercell` : `supercell, ${ratioText(match.volumeRatio)} times the volume,`} of the CIF cell`
                        : match.volumeRatio < 1 - 1e-9
                          ? `The UB is for a ${multiplesText(match.P) ? `${multiplesText(match.P)} cell` : `smaller cell, ${ratioText(match.volumeRatio)} of the volume,`} of the CIF cell`
                          : "The UB is for the CIF cell in another setting"}
                      : its axes are {axesText(match.P)} in the CIF&apos;s (h_UB = Pᵀ·h_CIF, misfit {(100 * match.misfit).toFixed(2)} %). The matrix above, the views and Export ISAW use the UB in the CIF cell, UB·Pᵀ.
                    </p>
                  )
                ) : (
                  <p className="error-note">The UB cell does not match the CIF cell, a supercell of it or a smaller cell of it (within 2 %). The views use the UB as loaded, so CIF indices may not correspond to the UB&apos;s. Re-index below to change its cell.</p>
                )}
                {matches.length > 1 && match && (
                  <label className="form-row" style={{ marginTop: "0.5rem" }}>
                    <span className="ui-control-label">Cell choice</span>
                    <select className="ui-select" aria-label="Cell choice" value={matches.indexOf(match)} onChange={(e) => onUb({ ...ub, choice: matches[Number(e.target.value)]!.P })}>
                      {matches.map((m, i) => (
                        <option key={i} value={i}>
                          UB axes {axesText(m.P)} · misfit {(100 * m.misfit).toFixed(2)} %
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {matches.length > 1 && (
                  <p className="dim-note">{matches.length} choices fit and are not related by the CIF&apos;s symmetry, so each labels the reflections differently. The best fit is first.</p>
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
            <dl className="ui-stats ui-stats--three" style={{ marginTop: "0.75rem" }} title="Directions of the crystal along the beam and the vertical at this goniometer setting">
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
            <p className="empty-note">Lab frame: beam +z, up +y. q_lab = R·UB·h{instrument ? `, R from the ${instrument.name} goniometer.` : " with R = R_y(ω)·R_z(χ)·R_y(φ) (Mantid Universal)."}</p>
          </Card>
      </div>

        <PlaneCard plane={planeOf(ub)} onPlane={(plane) => {
          const { plane: _, ...rest } = ub;
          onUb(plane ? { ...rest, plane } : rest);
        }} viewUB={viewUB} R={R} fromFile={!!fileUB} cell={cifCell} goniometerName={instrument?.name} />

        <Card
          title="Re-index for another cell"
          meta="change of basis · the views stay in the CIF cell"
          info="ITA convention (a′, b′, c′) = (a, b, c)·P. Each new axis and its index use the same coefficients (a′ = a + b goes with h′ = h + k), i.e. h′ = Pᵀ·h and UB′ = UB·P⁻ᵀ, so every reflection keeps its q. The three rows are Mantid TransformHKL's HKLTransform, M = Pᵀ (h′ = M·h, UB′ = UB·M⁻¹; Mantid requires det > 0). Standard transformations from ITA Vol. A, 5th ed. (2002), Table 5.1.3.1 (H. Arnold). Coefficients take integers, decimals or fractions such as 1/2 or −1/3."
          actions={
            <button type="button" className="ui-pill" onClick={() => setP(IDENTITY)}>
              Reset
            </button>
          }
        >
          <div className="reindex-grid">
            <div>
          <p className="card-lead">
            Writes the UB for a different unit cell of the same crystal: a supercell to index superlattice or magnetic peaks, a smaller cell (1/2 × 1/2 × 1/2 of a doubled cell), the primitive cell, or another program&apos;s setting. Reflections stay where they are in reciprocal space; only their indices change.
          </p>
          <div className="form-rows">
            {fileCellDiffers && (
              <div className="form-row">
                <span className="ui-control-label">Start from</span>
                <Segmented
                  label="Cell to re-index from"
                  value={reindexFrom}
                  onChange={setReindexFrom}
                  options={[
                    { value: "cif", label: "CIF cell" },
                    { value: "file", label: `UB file's cell ${axesText(match!.P)}` },
                  ]}
                />
              </div>
            )}
            <div className="form-row">
              <span className="ui-control-label">Cell multiples</span>
              <span className={diagonal ? "supercell" : "supercell is-dim"} title={diagonal ? "Whole numbers for a supercell, fractions such as 1/2 for a smaller cell" : "P is not a plain multiple of the axes; typing here replaces it with one"}>
                {(["a", "b", "c"] as const).map((axis, k) => (
                  <span key={axis} className="supercell">
                    {k > 0 && <span className="dim-note">×</span>}
                    <RatioCell label={`Multiple of ${axis}`} positive value={shownCell[k]!} onCommit={(v) => applyCell(shownCell.map((n, j) => (j === k ? v : n)) as [number, number, number])} />
                  </span>
                ))}
              </span>
            </div>
            <label className="form-row">
              <span className="ui-control-label">Standard</span>
              <select
                className="ui-select"
                aria-label="Standard transformation"
                value={BASIS_PRESETS.find((b) => b.P.every((r, i) => r.every((v, j) => Math.abs(v - P[i]![j]!) < 1e-12)))?.id ?? ""}
                onChange={(e) => {
                  const b = BASIS_PRESETS.find((x) => x.id === e.target.value);
                  if (b) setP(b.P);
                }}
              >
                <option value="">Choose a transformation…</option>
                {BASIS_PRESETS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="basis-editor" role="group" aria-label="New axes in terms of the old axes">
            {[0, 1, 2].map((j) => (
              <div key={j} className="basis-row">
                <span className="basis-lhs">
                  <span className="sym">{NEW_AXES[j]}</span> =
                </span>
                {[0, 1, 2].map((i) => (
                  <span key={i} className="basis-term">
                    <RatioCell label={`${NEW_AXES[j]}: coefficient of ${OLD_AXES[i]}`} value={P[i]![j]!} onCommit={(n) => setP(P.map((r, a) => r.map((x, b) => (a === i && b === j ? n : x))) as unknown as Mat3)} />
                    <span className="sym">{OLD_AXES[i]}</span>
                  </span>
                ))}
                <span className="basis-index" title="New index in terms of the old ones (same coefficients)">
                  {NEW_INDICES[j]} = {linearText([P[0]![j]!, P[1]![j]!, P[2]![j]!], ["h", "k", "l"])}
                </span>
              </div>
            ))}
          </div>
            </div>
            <div>
          {"error" in transformed ? (
            <p className="error-note">{transformed.error}</p>
          ) : (
            <>
              <dl className="ui-stats ui-stats--three" style={{ marginTop: "0.75rem" }}>
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
              <p className={transformed.det <= 0 ? "error-note" : "empty-note"} style={{ marginTop: "0.6rem" }}>
                Volume ×{fmt(transformed.det, 3)} (det P)
                {transformed.det < 0
                  ? ": this swaps the handedness of the axes, which Mantid rejects (U must be a proper rotation). Negate one new axis."
                  : transformed.det > 1 + 1e-9
                    ? ": a supercell. Every old reflection keeps whole indices, and the new cell adds positions between them for superlattice peaks."
                    : transformed.det < 1 - 1e-9
                      ? ": a smaller cell. Old reflections with fractional new indices are not lattice points of the new cell (for centred → primitive, exactly those the centring forbids)."
                      : "."}
              </p>
              <div className="form-row reindex-try">
                <span className="ui-control-label">Indices</span>
                <span className="ui-controls ui-controls--inline">
                  <span className={cx("ui-unit-field", tryText.trim() !== "" && !tryH && "is-invalid")}>
                    <input className="ui-unit-field__input" aria-label="Old indices h k l" placeholder="h k l" value={tryText} style={{ width: "8ch" }} onChange={(e) => setTryText(e.target.value)} />
                    <span className="ui-unit-field__unit">hkl</span>
                  </span>
                  <span className="dim-note">becomes</span>
                  <b className="mono">{tryH ? `(${hklText(mulVec(transpose(P), tryH).map((v) => Number(v.toFixed(4))) as unknown as Vec3)})′` : "(h′ k′ l′)"}</b>
                </span>
              </div>
              <div className="basis-out">
                <button type="button" className="ui-btn-brand" disabled={transformed.det <= 0} onClick={() => downloadText(`${result.blockName}-transformed.mat`, formatIsawUB(transformed.UB!))}>
                  Export UB′ (ISAW)
                </button>
                <span className="basis-mantid" title="The same change in Mantid, applied to a peaks workspace that holds this UB">
                  <code>TransformHKL(PeaksWorkspace="peaks", HKLTransform="{hklTransformText(P)}")</code>
                  <button type="button" className="ui-pill" disabled={transformed.det <= 0} onClick={() => void navigator.clipboard?.writeText(`TransformHKL(PeaksWorkspace="peaks", HKLTransform="${hklTransformText(P)}")`)}>
                    Copy
                  </button>
                </span>
              </div>
            </>
          )}
            </div>
          </div>
        </Card>

      <Card
        title="Reciprocal space in 3D"
        meta={explore ? undefined : "hidden"}
        actions={
          <button type="button" className="ui-pill" aria-expanded={explore} onClick={() => setExplore(!explore)}>
            {explore ? "Hide" : "Show the 3D view"}
          </button>
        }
      >
        <p className="explore-lead">The Laue construction at this goniometer setting: lattice points, the Ewald spheres of the band, and the lab and sample frames, with the reflections in the band. For checking the UB and the frames; the Detectors page shows what the instrument records.</p>
      </Card>
      {explore && (
          <div className="ui-grid ui-grid--split">
        <Card
          title="Laue construction"
          meta={`${points.length.toLocaleString()} reflections · ${laue.rows.length.toLocaleString()} in the λ band`}
          info="Laue (white-beam / TOF) Ewald construction in 1/Å without 2π. Points are reciprocal-lattice nodes q = UB·h sized by |F|²; a point is coloured by the wavelength at which it diffracts when that lies in the band and, with an SNS instrument, its scattered ray hits a panel. Tan points diffract in the band but miss every panel; grey points do not diffract in the band. The two spheres are the Ewald spheres for λmin and λmax: everything between them diffracts. Click a point to draw its k_i, k_f and q. Drag to rotate, scroll to zoom."
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
              hasDetectors={detectors !== undefined}
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
        <Card
          title="Reflections in the band"
          meta={`${laue.rows.length.toLocaleString()} at this goniometer setting${laue.onDetectors !== undefined ? `, ${laue.onDetectors.toLocaleString()} on the detectors` : ""}${laue.rows.length > 400 ? " · first 400 in this order" : ""}`}
          info="Strongest first. Click a column header to sort by it, again to reverse; reflections that miss every panel go last by panel."
          flush
        >
          <div className="ui-table-wrap" style={{ maxHeight: "22rem" }}>
            <table className="ui-table">
              <thead>
                <tr>
                  <SortTh id="hkl" sort={bandSort} onSort={onBandSort} left>
                    hkl
                  </SortTh>
                  <SortTh id="d" sort={bandSort} onSort={onBandSort}>
                    d (Å)
                  </SortTh>
                  <SortTh id="lam" sort={bandSort} onSort={onBandSort}>
                    λ (Å)
                  </SortTh>
                  <SortTh id="tth" sort={bandSort} onSort={onBandSort}>
                    2θ (°)
                  </SortTh>
                  <SortTh id="az" sort={bandSort} onSort={onBandSort}>
                    azimuth (°)
                  </SortTh>
                  {detectors && (
                    <SortTh id="panel" sort={bandSort} onSort={onBandSort} left>
                      Panel
                    </SortTh>
                  )}
                  <SortTh id="f2" sort={bandSort} onSort={onBandSort}>
                    |F|²
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {bandRows
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
                        {detectors && <td className={cx("left", !row.panel && "dim-note")}>{row.panel ?? "misses"}</td>}
                        <td>{p.f2.toPrecision(5)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </Card>

          </div>
      )}
    </div>
  );
}

/** One entry of P: keeps what is typed and commits on Enter or blur (integers, decimals or fractions; > 0 if `positive`). */
function RatioCell({ label, value, onCommit, positive = false }: { label: string; value: number; onCommit: (v: number) => void; positive?: boolean }) {
  const shown = ratioText(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const raw = parseRatio(text);
  const parsed = raw !== undefined && (!positive || raw > 0) ? raw : undefined;
  const commit = () => {
    if (parsed === undefined) return setText(shown);
    if (Math.abs(parsed - value) > 1e-15) onCommit(parsed);
    else setText(shown);
  };
  return (
    <input
      className={`p-cell${parsed === undefined ? " is-invalid" : ""}`}
      inputMode="text"
      aria-label={label}
      title="An integer, decimal or fraction (e.g. 1/2, −1/3)"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setText(shown);
      }}
    />
  );
}

/**
 * The scattering plane: two reciprocal vectors u, v. Without a UB file they set the mount (Mantid SetUB: u along the
 * beam and v horizontal with every goniometer angle at zero); with one, the card shows where the file's UB puts the
 * plane. Either way it reports the zone axis and, at the current setting, the plane's tilt and its angle to the beam.
 */
function PlaneCard({ plane, onPlane, viewUB, R, fromFile, cell, goniometerName }: { plane: ScatteringPlane | undefined; onPlane: (p: ScatteringPlane | undefined) => void; viewUB: Mat3; R: Mat3; fromFile: boolean; cell: CalcSuccess["structure"]["cell"]; goniometerName?: string | undefined }) {
  const preset = plane ? PLANE_PRESETS.find((p) => p.plane.u.every((x, i) => x === plane.u[i]) && p.plane.v.every((x, i) => x === plane.v[i])) : undefined;
  const geo = useMemo(() => (plane ? planeGeometry(viewUB, R, plane) : undefined), [plane, viewUB, R]);
  const zone = plane ? zoneAxis(plane) : undefined;
  const call = plane && !fromFile ? setUBCall(cell, plane) : "";
  // Refused (the field reverts) when u and v are parallel in this cell, by Mantid's own test.
  const setVec = (which: "u" | "v", vec: Vec3): boolean => {
    const next = { ...(plane ?? PLANE_PRESETS[0]!.plane), [which]: vec };
    if (!mountable(cell, next)) return false;
    onPlane(next);
    return true;
  };
  return (
    <Card
      title="Scattering plane"
      meta={!plane ? (fromFile ? "choose one to see where the UB puts it" : "none: U = I with the CIF cell") : fromFile ? "where the loaded UB puts it" : "sets the mount (Mantid SetUB)"}
      info="The plane spanned by two reciprocal-lattice vectors u and v, as a crystal is mounted to measure, say, (H K 0) or (H H L). Without a UB file it sets the orientation the way Mantid's SetUB does with u and v (also MSlice and Horace): with every goniometer angle at zero, u lies along the beam, v in the horizontal plane, and u × v points up. On a goniometer whose free axis is vertical (TOPAZ cryogenic, CORELLI, the ψ stage of a chopper spectrometer) the plane then stays horizontal as the crystal turns, about the plane's zone axis [uvw] = u × v (Weiss zone law). Where a goniometer has a fixed tilt at zero (TOPAZ ambient, χ = 135°), the plane is tilted by it. With a UB file loaded the plane is only shown: the tilt and beam angle say where the loaded orientation puts it. The Detectors page draws the plane at the sample and, on the detector map, the curve along which its reflections are scattered."
    >
      <div className="form-rows">
        <div className="form-row">
          <span className="ui-control-label">Plane</span>
          <span className="supercell">
            <select
              className="ui-select"
              aria-label="Scattering plane"
              value={!plane ? "" : (preset?.id ?? "custom")}
              onChange={(e) => {
                if (e.target.value === "") return onPlane(undefined);
                const p = PLANE_PRESETS.find((x) => x.id === e.target.value);
                if (p) onPlane(p.plane);
              }}
            >
              <option value="">{fromFile ? "None" : "None (U = I)"}</option>
              {PLANE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              {plane && !preset && <option value="custom">Custom</option>}
            </select>
            {plane && (
              <>
                <span className="dim-note">u</span>
                <VecField label="u: along the beam at zero angles" value={plane.u} onCommit={(v) => setVec("u", v)} />
                <span className="dim-note">v</span>
                <VecField label="v: horizontal at zero angles" value={plane.v} onCommit={(v) => setVec("v", v)} />
              </>
            )}
          </span>
        </div>
      </div>
      {plane && geo && zone && (
        <>
          <dl className="ui-stats ui-stats--three" style={{ marginTop: "0.75rem" }}>
            <div>
              <dt>Zone axis (normal)</dt>
              <dd>[{hklText(zone)}]</dd>
            </div>
            <div>
              <dt>Tilt from horizontal</dt>
              <dd>
                {fmt(geo.tiltDeg, 1)}° <small>{goniometerName ? "at this setting" : "at these angles"}</small>
              </dd>
            </div>
            <div>
              <dt>Beam to plane</dt>
              <dd>
                {fmt(geo.beamDeg, 1)}° <small>{geo.beamDeg < 0.05 ? "the beam lies in it" : "out of the plane"}</small>
              </dd>
            </div>
          </dl>
          {call && (
            <div className="mantid-call" style={{ marginTop: "0.6rem" }}>
              <pre>{call}</pre>
              <button type="button" className="ui-pill" onClick={() => void navigator.clipboard?.writeText(call)}>
                Copy
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** Three numbers (r.l.u.), committed on Enter or blur. */
function VecField({ label, value, onCommit }: { label: string; value: readonly number[]; onCommit: (v: Vec3) => boolean }) {
  const shown = value.join(" ");
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const v = text.trim().split(/[\s,]+/).map(Number);
  const ok = v.length === 3 && v.every(Number.isFinite) && v.some((x) => x !== 0);
  const commit = () => {
    if (ok && v.join(" ") !== shown) {
      if (!onCommit(v as unknown as Vec3)) setText(shown);
    } else if (!ok) setText(shown);
  };
  return (
    <span className={`ui-unit-field${ok ? "" : " is-invalid"}`} title={label}>
      <input className="ui-unit-field__input" aria-label={label} value={text} style={{ width: `${Math.max(6, text.length + 1)}ch` }} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      <span className="ui-unit-field__unit">hkl</span>
    </span>
  );
}
