/**
 * Masks and the sample environment's shadows (core/instrument/acceptance.ts): what the detectors record besides
 * their geometry. Masks are kept per detector array and shadows per instrument; every simulation page records
 * through them.
 */
import { useMemo, useRef, useState } from "react";
import { idMaskBitmaps, maskedPixelCount, parseIdRanges, parseMantidMask, type MaskSettings, type ShadowShape } from "../core/instrument/acceptance.ts";
import type { DetectorPanel } from "../core/instrument/detectors.ts";
import type { GoniometerModel } from "../core/ub/goniometer.ts";
import { Card, UnitField } from "./components.tsx";
import { masksOf, shadowsOf, withMasks, withShadows, type ExperimentState } from "./experimentState.ts";
import { fmt } from "./format.ts";

const NEW_SHADOW: Record<ShadowShape["kind"], ShadowShape> = {
  opening: { kind: "opening", halfAngle: 15 },
  sector: { kind: "sector", gamma: 90, halfWidth: 5 },
  box: { kind: "box", gammaMin: -20, gammaMax: 20, nuMin: -10, nuMax: 10 },
};

const SHADOW_NAME: Record<ShadowShape["kind"], string> = { opening: "Opening", sector: "Leg", box: "Box" };

export function AcceptanceCard({ exp, onExp, geometry, panels, goniometer }: { exp: ExperimentState; onExp: (e: ExperimentState) => void; geometry: readonly DetectorPanel[]; panels: readonly DetectorPanel[]; goniometer: GoniometerModel }) {
  const masks = masksOf(exp);
  const shadows = shadowsOf(exp);
  const setMasks = (m: Partial<MaskSettings>) => onExp(withMasks(exp, { ...masks, ...m }));
  const setShadow = (k: number, s: ShadowShape | null) => onExp(withShadows(exp, s ? shadows.map((x, i) => (i === k ? s : x)) : shadows.filter((_, i) => i !== k)));
  const tubes = geometry.every((p) => p.kind === "tube-pack");
  const rectangles = geometry.every((p) => p.kind === "rectangular");
  const maxRows = Math.floor((Math.min(...geometry.map((p) => p.nRows)) - 1) / 2);
  const maxCols = Math.floor((Math.min(...geometry.map((p) => p.nCols)) - 1) / 2);
  const count = maskedPixelCount(panels);
  const off = new Set(masks.panelsOff);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const loadMask = async (f: File) => {
    try {
      const file = parseMantidMask(await f.text(), f.name);
      if (!file.detids && !file.components.length) throw new Error(`${f.name} masks nothing.`);
      setFileError(null);
      onExp(withMasks(exp, { ...masks, file }));
    } catch (e) {
      setFileError((e as Error).message);
    }
  };
  // What the file masks on these detectors, and what it names that they lack.
  const fileStats = useMemo(() => {
    if (!masks.file) return undefined;
    const ids = idMaskBitmaps(geometry, parseIdRanges(masks.file.detids));
    const names = new Set(geometry.map((p) => p.name));
    return { matched: ids.matched, unmatched: ids.unmatched, missingComponents: masks.file.components.filter((c) => !names.has(c)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed when the file or the detectors change
  }, [geometry, masks.file?.detids, masks.file?.components.join(",")]);
  const summary = [count.pixels ? `${fmt((100 * count.pixels) / count.total, 1)} % of pixels masked` : "", shadows.length ? `${shadows.length} shadow${shadows.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ") || "none";

  const frame = (s: ShadowShape, k: number) => (
    <select
      className="ui-select"
      aria-label={`Shadow ${k + 1}: frame`}
      value={s.turnsWith === undefined ? "lab" : String(s.turnsWith)}
      onChange={(e) => {
        const { turnsWith: _, ...rest } = s;
        setShadow(k, e.target.value === "lab" ? (rest as ShadowShape) : { ...s, turnsWith: Number(e.target.value) });
      }}
    >
      <option value="lab">fixed in the lab</option>
      {goniometer.axes.map((ax, i) => (
        <option key={i} value={i}>
          turns with {ax.name}
        </option>
      ))}
    </select>
  );

  return (
    <Card
      title="Masks and shadows"
      meta={summary}
      info={
        <>
          What every simulation page records through, besides the detector geometry. <b>Masks</b> (kept for this detector array) drop the pixels at the ends of the tubes or the edges of the panels, whole panels, and the detector IDs and components of a Mantid mask file (SaveMask XML; IDs are mapped to pixels with the instrument definition's numbering); a masked pixel still stops the scattered ray, so nothing behind it is recorded. <b>Shadows</b> (kept for this instrument) are directions the sample environment blocks, in the angles of the detector map: γ, the horizontal angle from the beam, and ν, the elevation. An <i>opening</i> keeps |ν| within its half-angle (a cryostat or magnet window); a <i>leg</i> blocks γ ± a half-width at every ν; a <i>box</i> blocks a γ range × a ν range. A shadow is fixed in the lab, or turns with the goniometer stage the environment is mounted on (and the stages outside it); at zero angles the two agree. The detector map hatches masked pixels and veils the shadows at the current setting.
        </>
      }
    >
      <div className="form-rows">
        <div className="form-row">
          <span className="ui-control-label">{tubes ? "Tube ends" : rectangles ? "Top, bottom" : "Ends (rows)"}</span>
          <span className="supercell">
            <UnitField label={tubes ? "Pixels masked at each end of the tubes" : "Pixel rows masked at the top and bottom of each panel"} value={masks.edgeRows} unit="px" min={0} max={maxRows} width="4ch" onCommit={(v) => setMasks({ edgeRows: Math.floor(v) })} />
            <span className="dim-note">{tubes ? "at each end" : "rows each"}</span>
          </span>
        </div>
        <div className="form-row">
          <span className="ui-control-label">{tubes ? "Side tubes" : "Sides"}</span>
          <span className="supercell">
            <UnitField label={tubes ? "Tubes masked at each side of a pack" : "Pixel columns masked at each side of a panel"} value={masks.edgeCols} unit={tubes ? "tubes" : "px"} min={0} max={maxCols} width="4ch" onCommit={(v) => setMasks({ edgeCols: Math.floor(v) })} />
            <span className="dim-note">{tubes ? "at each side of a pack" : "columns each"}</span>
          </span>
        </div>
        <div className="form-row">
          <span className="ui-control-label">Panels off</span>
          <span className="supercell">
            {masks.panelsOff.map((name) => (
              <span key={name} className="ui-chip">
                {name}
                <button type="button" className="chip-x" aria-label={`Switch ${name} back on`} onClick={() => setMasks({ panelsOff: masks.panelsOff.filter((n) => n !== name) })}>
                  ×
                </button>
              </span>
            ))}
            <select className="ui-select" aria-label="Switch off a panel" value="" onChange={(e) => e.target.value && setMasks({ panelsOff: [...masks.panelsOff, e.target.value] })}>
              <option value="">{masks.panelsOff.length ? "Another…" : "Switch one off…"}</option>
              {geometry
                .filter((p) => !off.has(p.name))
                .map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
            </select>
          </span>
        </div>
        <div className="form-row">
          <span className="ui-control-label">Mask file</span>
          <span className="supercell">
            {masks.file ? (
              <span className="ui-chip" title={`${masks.file.detids.length > 120 ? `${masks.file.detids.slice(0, 120)}…` : masks.file.detids}${masks.file.components.length ? ` · components: ${masks.file.components.join(", ")}` : ""}`}>
                {masks.file.name}
                <button
                  type="button"
                  className="chip-x"
                  aria-label={`Remove the mask file ${masks.file.name}`}
                  onClick={() => {
                    const { file: _, ...rest } = masks;
                    onExp(withMasks(exp, rest));
                  }}
                >
                  ×
                </button>
              </span>
            ) : null}
            <button type="button" className="ui-pill" onClick={() => fileInput.current?.click()}>
              {masks.file ? "Replace…" : "Load a Mantid mask…"}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".xml,text/xml,application/xml"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void loadMask(f);
              }}
            />
          </span>
        </div>
        {fileError && <p className="warn-note">{fileError}</p>}
        {fileStats && (
          <p className={fileStats.unmatched || fileStats.missingComponents.length ? "warn-note" : "dim-note"}>
            {masks.file!.name}: {fileStats.matched.toLocaleString()} detector IDs on these detectors
            {masks.file!.components.length ? `, ${masks.file!.components.length - fileStats.missingComponents.length} of ${masks.file!.components.length} components` : ""}
            {fileStats.unmatched ? `; ${fileStats.unmatched.toLocaleString()} ${fileStats.unmatched === 1 ? "ID is" : "IDs are"} not (monitors, or a mask for another detector configuration)` : ""}
            {fileStats.missingComponents.length ? `; no panel named ${fileStats.missingComponents.slice(0, 5).join(", ")}${fileStats.missingComponents.length > 5 ? "…" : ""}` : ""}.
          </p>
        )}
        <p className="dim-note">
          {count.pixels ? `${count.pixels.toLocaleString()} of ${count.total.toLocaleString()} pixels masked${count.panelsOff ? `, ${count.panelsOff} panel${count.panelsOff > 1 ? "s" : ""} off` : ""}.` : "No pixels masked."}
        </p>

        {shadows.map((s, k) => (
          <div key={k} className="form-row shadow-row">
            <span className="ui-control-label">{SHADOW_NAME[s.kind]}</span>
            <span className="supercell">
              {s.kind === "opening" && (
                <>
                  <span className="dim-note">|ν| ≤</span>
                  <UnitField label={`Shadow ${k + 1}: opening half-angle`} value={s.halfAngle} unit="°" min={0} max={90} width="4ch" onCommit={(v) => setShadow(k, { ...s, halfAngle: v })} />
                </>
              )}
              {s.kind === "sector" && (
                <>
                  <span className="dim-note">γ</span>
                  <UnitField label={`Shadow ${k + 1}: leg angle γ`} value={s.gamma} unit="°" min={-360} max={360} width="4.5ch" onCommit={(v) => setShadow(k, { ...s, gamma: v })} />
                  <span className="dim-note">±</span>
                  <UnitField label={`Shadow ${k + 1}: leg half-width`} value={s.halfWidth} unit="°" min={0} max={180} width="3.5ch" onCommit={(v) => setShadow(k, { ...s, halfWidth: v })} />
                </>
              )}
              {s.kind === "box" && (
                <>
                  <span className="dim-note">γ</span>
                  <UnitField label={`Shadow ${k + 1}: γ from`} value={s.gammaMin} unit="°" min={-360} max={360} width="4.5ch" onCommit={(v) => setShadow(k, { ...s, gammaMin: v })} />
                  <span className="dim-note">to</span>
                  <UnitField label={`Shadow ${k + 1}: γ to`} value={s.gammaMax} unit="°" min={-360} max={720} width="4.5ch" onCommit={(v) => setShadow(k, { ...s, gammaMax: v })} />
                  <span className="dim-note">ν</span>
                  <UnitField label={`Shadow ${k + 1}: ν from`} value={s.nuMin} unit="°" min={-90} max={90} width="3.5ch" onCommit={(v) => setShadow(k, { ...s, nuMin: v })} />
                  <span className="dim-note">to</span>
                  <UnitField label={`Shadow ${k + 1}: ν to`} value={s.nuMax} unit="°" min={-90} max={90} width="3.5ch" onCommit={(v) => setShadow(k, { ...s, nuMax: v })} />
                </>
              )}
              {frame(s, k)}
            </span>
            <button type="button" className="ui-pill" aria-label={`Remove shadow ${k + 1}`} onClick={() => setShadow(k, null)}>
              Remove
            </button>
          </div>
        ))}
        <div className="form-row">
          <span className="ui-control-label">Add a shadow</span>
          <span className="supercell">
            {(["opening", "sector", "box"] as const).map((kind) => (
              <button key={kind} type="button" className="ui-pill" onClick={() => onExp(withShadows(exp, [...shadows, NEW_SHADOW[kind]]))}>
                {SHADOW_NAME[kind]}
              </button>
            ))}
          </span>
        </div>
      </div>
    </Card>
  );
}
