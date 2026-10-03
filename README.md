# NEXPLAN · Neutron Experiment Planner

**Plan neutron diffraction experiments in your browser, from a CIF file to the detectors, with scattering tables
you can audit.**

Load a CIF file. NEXPLAN lists every reflection with its d, Q and complex structure factor, flags systematic and
accidental absences, and draws neutron (or X-ray) powder patterns. It orients the crystal from a UB matrix and
simulates the measurement on SNS instruments. Nothing is uploaded and there is nothing to install; the session
(structure, orientation, plan) is kept in your browser so a reload resumes it, and "Start over" clears it. Plans
export as CSV with their provenance.

Status: **public beta.** The scattering tables are cross-checked against independent sources but are not yet
certified against the printed literature.

## What it does now

- **CIF 1.1 reader.**
  - Full grammar: quotes, semicolon fields, multi-line loops, standard uncertainties, `.` vs `?`.
  - Block selection.
  - Ion and isotope type symbols.
  - U_eq from anisotropic ADPs.
  - Every default and assumption is listed in the status card.
- **Symmetry from all 564 gemmi settings.**
  - Origin choices, rhombohedral/hexagonal axes and monoclinic cell choices are never guessed.
  - Operations are parsed exactly.
  - Absences come from the operations and are tested against gemmi for every setting.
- **Structure factors.**
  - X-ray f0 from Waasmaier & Kirfel (1995), including ions.
  - Neutron b from Sears (1992), natural elements and isotopes, complex for absorbers. The sign convention is
    derived in [CONVENTIONS](docs/CONVENTIONS.md#5-scattering-amplitudes-and-the-sign-of-complex-b).
  - Results match gemmi to 1e-8, phases included.
- **Powder patterns.**
  - Intensity is an explicit sum over signed reflections.
  - Constant wavelength (CW Lorentz and named X-ray polarization models) or neutron time-of-flight at one bank.
  - Unit-area peaks on 2θ, TOF, d or Q.
  - Full-precision CSV export with provenance.
- **UB matrix.**
  - ISAW/Mantid UB files in and out; lattice and orientation from the UB, matched to the CIF setting.
  - Re-indexing for another cell (supercell, primitive cell or a standard ITA transformation), exported as an
    ISAW UB or as the equivalent Mantid TransformHKL call; a 3D reciprocal-space view with the Ewald spheres for a
    wavelength band.

## Pages

The pages follow the work: **Sample** (what the crystal is), **Setup** (how it sits in the beam), **Instrument**
(the detectors and what lands on them) and **Simulation** (what a measurement records). The instrument in the header sets the beam, goniometer and detectors for every page:
a generic X-ray or neutron beam, or an SNS instrument with its detector geometry from the Mantid instrument
definition (always neutron scattering).

- **Sample**
  - *Structure*: cell, symmetry, sites, the scattering lengths used and their sources, a 3D view, and the
    neutron scattering power against a reference material (V, diamond, Si, CeO₂, corundum or a demo structure):
    coherent, incoherent and absorption cross-sections per
    unit volume, attenuation length, and Bragg line strengths, with an optional TOF weighting (not a counting time).
  - *Reflections*: every signed hkl with d, Q and complex F, folded into symmetry families, absences flagged.
- **Setup**
  - *Orientation*: the UB matrix (ISAW/Mantid files in and out, matched to the CIF setting, re-indexing for another cell) and
    the selected instrument's goniometer, with a 3D reciprocal-space view and the Ewald spheres of the band.
- **Instrument**
  - *Detectors*: the instrument's detector array in 3D and unrolled. Single crystals: the spots at the current
    setting, or the exact coverage of a chosen reflection over the goniometer ranges, coloured by wavelength (as in
    NeuXtalViz), and the reflections on each panel with pixel, λ and time of flight. Powders: Debye–Scherrer rings on
    the panels in a time-of-flight slice (play sweeps the band), or at Ei for the chopper spectrometers.
- **Simulation**
  - *Powder*: the pattern for the generic beam (CW or one TOF bank), or for an SNS instrument the pattern of any
    panel (elastic 2θ for ARCS, SEQUOIA, CNCS) and the 2θ–d coverage of the detector array.
  - *Single crystal*: the measurement plan as each instrument is run (TOPAZ: a list of about ten chosen
    orientations, built from wanted reflections with "suggest settings" (a greedy search over the goniometer, within
    limits you can set, that places the wanted peaks near mid band and away from panel edges first, then completeness,
    then redundancy) or "find a setting" for one reflection; CORELLI: rotation scans in 3°
    steps, optionally interleaved; ARCS, SEQUOIA, CNCS: ψ scans with exact Bragg crossings), its symmetry-family
    completeness, and reciprocal-space slices shaded by what the plan records.

Instruments: TOPAZ (cryogenic and ambient goniometers), CORELLI, NOMAD, POWGEN, ARCS, SEQUOIA, CNCS. The detector
geometry loads only when a simulation page is opened.

## Data you can check

Every table is generated from pinned upstream files (URL, commit and SHA-256 in
[`data-sources/sources.json`](data-sources/sources.json)) and cross-checked row by row. The reports:

- [X-ray f0, Waasmaier & Kirfel 1995](docs/data-verification/XRAY_WK1995.md): 209/209 rows crosschecked.
- [Neutron b, Sears 1992](docs/data-verification/NEUTRON_SEARS1992.md): 324 crosschecked, with 6 discrepant rows
  listed for checking against the print.
- [MATERIA's tables](docs/data-verification/MATERIA_TABLES.md): findings include a wrong In value, dropped imaginary
  parts, and transcription errors found in DABAX, cctbx/gemmi and GSAS-II.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173/nexplan/
npm test           # unit, gemmi-reference and analytic tests
npm run typecheck
```

Data pipeline (development only):

```bash
npm run data:fetch   # download pinned sources, verify SHA-256
npm run data:build   # regenerate src/data/*.json and docs/data-verification/*.md
npm run data:check   # fail if generated files are stale (CI)
```

Python references (gemmi, pinned) are generated with `uv`. Their outputs are committed, so tests need only Node:

```bash
uv run --no-project --with gemmi==0.7.3 python scripts/data/gen_space_groups.py
uv run --no-project --with gemmi==0.7.3 python scripts/data/gen_reference_sf.py
```

The audited MATERIA modules live in `src/materia/`, copied from `drthyang/web-refinement` at a pinned commit. Do not
edit them there: fix MATERIA, bump the commit in `src/materia/UPSTREAM.json`, then run `npm run materia:sync`.

## Family

NEXPLAN shares its design system with [MATERIA](https://drthyang.github.io/web-refinement/), NEBULA3D and the
RMCProfile Workbench.

## License

[GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html), the same as MATERIA, whose
code it includes. Bundled demo CIFs are from the Crystallography Open Database (public domain).
