# ScatterPlan Workbench

**X-ray and neutron diffraction calculations that run in your browser, with scattering tables you can audit.**

Load a CIF file. ScatterPlan lists every reflection with its d, Q and complex structure factor, flags systematic
and accidental absences, and draws the powder pattern. Nothing is uploaded and there is nothing to install.

Status: **public beta (M1–M2 of [the plan](docs/PLAN.md)).** The scattering tables are cross-checked against
independent sources but are not yet certified against the printed literature. UB-matrix tools (M3) and experiment
planning (M4) come next.

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
  - CW Lorentz and named polarization models.
  - Unit-area pseudo-Voigt peaks on 2θ, d or Q.
  - Full-precision CSV export with provenance.

## Experimental features

An **Experiment** page simulates neutron measurements on the detector geometry of SNS instruments, taken from the
Mantid instrument definitions. It always uses neutron scattering and is compiled in only for testing.

- **Single crystal** (TOPAZ cryogenic and ambient goniometers, CORELLI): the goniometer turns the crystal.
  - Spots on a 3D detector view and an unrolled detector map.
  - Reflection coverage, as in NeuXtalViz: everywhere a chosen reflection (and its equivalents) can be recorded over
    the goniometer range, coloured by wavelength.
  - Rotation scans with symmetry-family completeness.
  - The reflections on each panel, with pixel coordinates and time of flight.
- **Powder** (NOMAD, POWGEN; the sample is fixed):
  - Debye–Scherrer rings painted on the panels for a time-of-flight slice, with a play control that sweeps through
    the band.
  - A 2θ–d coverage chart for the wavelength band.
  - The panels that record each reflection.
  - A simulated TOF pattern for any panel.
- **Chopper spectrometers** (ARCS, SEQUOIA, CNCS), elastic scattering at a chosen Ei:
  - Single crystals on a vertical rotation ψ, with exact rotation scans.
  - Powders, with fixed elastic rings on the detectors and an elastic 2θ pattern.

The page is on in the dev server and in an experimental build:

```bash
npm run build:experimental   # writes dist-experimental/
```

Regular builds (`npm run build`, the Pages deploy) leave them out entirely.

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
npm run dev        # http://localhost:5173/scatterplan/
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

ScatterPlan shares its design system with [MATERIA](https://drthyang.github.io/web-refinement/), NEBULA3D and the
RMCProfile Workbench.

## License

[GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html), the same as MATERIA, whose
code it includes. Bundled demo CIFs are from the Crystallography Open Database (public domain).
