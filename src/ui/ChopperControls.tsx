/**
 * A chopper spectrometer's chopper in the header: a Fermi package or CNCS mode and its frequency, which set the
 * elastic width ΔE/E from PyChop (core/instrument/pychop.ts), or a ΔE/E typed by hand ("Custom").
 */
import { CNCS_SLOTS, energyResolution, FERMI_PACKAGES, FREQUENCIES, type FermiInstrument } from "../core/instrument/pychop.ts";
import { InfoBadge, UnitField } from "./components.tsx";
import { chopperOf, CUSTOM_CHOPPER, dgsOf, withDgs, withEi, type ExperimentState } from "./experimentState.ts";

export function ChopperControls({ exp, onExp }: { exp: ExperimentState; onExp: (e: ExperimentState) => void }) {
  const id = exp.instrumentId;
  const d = dgsOf(exp);
  const chopper = chopperOf(exp);
  const fwhm = chopper ? energyResolution(chopper, exp.eiMeV, 0) : undefined;
  const choices = id === "cncs" ? Object.keys(CNCS_SLOTS).map((m) => [m, m, `CNCS ${m} (double-disk slot ${CNCS_SLOTS[m as keyof typeof CNCS_SLOTS]} mm)`] as const) : Object.entries(FERMI_PACKAGES[id as FermiInstrument]).map(([k, p]) => [k, k.replace(/-AST$/, ""), `${k}: ${p.label}`] as const);
  return (
    <>
      <span className="ui-control-label">
        Chopper
        <InfoBadge>
          The chopper setting gives the elastic width ΔE/E through Mantid PyChop's resolution model (its ARCS and SEQUOIA parameters tuned to ORNL vanadium data, Mantid PR #38591), and with it the wavelength band of the simulation. Custom: type ΔE/E instead.
        </InfoBadge>
      </span>
      <select className="ui-select" aria-label="Chopper setting" value={d.chopper} onChange={(e) => onExp(withDgs(exp, { ...d, chopper: e.target.value }))}>
        {choices.map(([value, label, title]) => (
          <option key={value} value={value} title={title}>
            {label}
          </option>
        ))}
        <option value={CUSTOM_CHOPPER}>Custom ΔE/E</option>
      </select>
      {chopper ? (
        <>
          <select className="ui-select" aria-label="Chopper frequency" value={d.frequency} onChange={(e) => onExp(withDgs(exp, { ...d, frequency: Number(e.target.value) }))}>
            {FREQUENCIES[id === "cncs" ? "cncs" : (id as FermiInstrument)].map((f) => (
              <option key={f} value={f}>
                {f} Hz
              </option>
            ))}
          </select>
          {fwhm !== undefined ? (
            <span className="dim-note" title="Elastic energy resolution (FWHM) from PyChop">
              Δ<span className="sym">E</span> {Number(fwhm.toPrecision(3))} meV ({Number((100 * exp.eRes).toPrecision(3))} %)
            </span>
          ) : (
            <span className="warn-inline" title="PyChop: this chopper does not transmit at this Ei and frequency">
              no transmission at this Ei
            </span>
          )}
        </>
      ) : (
        <>
          <span className="ui-control-label">
            Δ<span className="sym">E</span>/<span className="sym">E</span>
          </span>
          <UnitField label="Elastic resolution (FWHM)" value={Number((100 * exp.eRes).toPrecision(6))} unit="%" min={0.01} max={50} width="4ch" onCommit={(v) => onExp(withEi(exp, exp.eiMeV, v / 100))} />
        </>
      )}
    </>
  );
}
