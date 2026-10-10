# Third-party notices

NEXPLAN is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). It builds on the work listed
here. Parts derived from other projects keep their own licences, and this file reproduces the notices those licences
require.

## Code ported from other projects

### Mantid PyChop (GPL-3.0-or-later)

`src/core/instrument/pychop.ts` is a TypeScript port of the chopper-spectrometer resolution model in Mantid's PyChop
([mantidproject/mantid](https://github.com/mantidproject/mantid) at commit `67c2f43`, `scripts/pychop`: `Chop.py`,
`Instruments.py`, `MulpyRep.py`, and the parameters of `arcs.yaml`, `sequoia.yaml` and `cncs.yaml`). That file stays
under the GNU General Public License v3.0 or later and is combined with NEXPLAN's AGPL-3.0 code as section 13 of the
GPL v3 permits. `scripts/data/gen_pychop_reference.py` runs PyChop itself, fetched at that commit and not included
here, to make `fixtures/pychop-resolution.json`.

```text
Mantid Repository : https://github.com/mantidproject/mantid

Copyright © 2018 ISIS Rutherford Appleton Laboratory UKRI,
  NScD Oak Ridge National Laboratory, European Spallation Source,
  Institut Laue - Langevin & CSNS, Institute of High Energy Physics, CAS
SPDX - License - Identifier: GPL - 3.0 +
```

The GPL v3 text: <https://www.gnu.org/licenses/gpl-3.0.html>. PyChop's authors, as its sources credit them: CHOP by
T. G. Perring; the Python version by R. A. Ewings, after a Matlab version by J. W. Taylor; MulpyRep by D. J. Voneshen,
after R. I. Bewley.

### MATERIA (AGPL-3.0-only)

`src/materia/` is copied unchanged from MATERIA ([drthyang/web-refinement](https://github.com/drthyang/web-refinement),
same author, same licence) at the commit pinned in `src/materia/UPSTREAM.json`.

## Data

- **Detector geometry**: `src/data/instruments.json` holds panel positions, sizes and pixel and detector-ID numbering
  extracted from the Mantid instrument definitions of TOPAZ, CORELLI, NOMAD, POWGEN, ARCS, SEQUOIA and CNCS
  (GPL-3.0-or-later, commit `67c2f43`, copyright as above). Only these numbers are kept, with their source; no
  definition file is included.
- **Neutron scattering lengths**: Sears, V. F. (1992), *Neutron News* 3(3), 26–37, as transcribed on the NIST Center
  for Neutron Research web page (a US Government work), in `src/data/neutron-sears1992.json`.
- **X-ray form factors**: Waasmaier, D. & Kirfel, A. (1995), *Acta Cryst.* A51, 416–431, coefficients from the DABAX
  library (ESRF), cross-checked against cctbx, in `src/data/xray-f0-wk1995.json`.
- **Space-group settings and reference values** generated with gemmi 0.7.3 (MPL-2.0; Wojdyr, M. (2022), *J. Open
  Source Softw.* 7(73), 4200): `src/data/space-groups.json` and `fixtures/*gemmi*.json`. Only gemmi's output is
  included, not its code.
- **Crystal structures**: CIF files from the Crystallography Open Database (CC0), in `fixtures/cif/`, each with its
  original publication. COD: Gražulis, S. et al. (2009), *J. Appl. Cryst.* 42, 726–729; Gražulis, S. et al. (2012),
  *Nucleic Acids Res.* 40, D420–D427.
- **ORNL instrument data**: NOMAD's measured resolution per bank (ORNL NOMAD overview, 2014), the NOMAD 2023A and
  POWGEN 2026B GSAS-II instrument parameter files (neutrons.ornl.gov) and POWGEN characterisation files (Mantid test
  data): numerical parameters, cited where they are used in `src/core/ub/instrumentCatalog.ts`.
- **NeXus Viewer Laue presets**: the generators of its symmetry presets (neutron-nexus-viewer `js/symmetry.js`, same
  author, AGPL-3.0-or-later), in `src/core/symmetry/laue.ts`, so that `laue_symmetry` can name the matching preset.
- **Instrument settings**: goniometer axes and motor logs, and wavelength bands, checked against the instrument
  configurations of ORNL garnet-tools (`4eb3206`, BSD-3-Clause) and NeuXtalViz (`655afa3`, GPL-3.0); cited in
  `src/core/ub/instrumentCatalog.ts` and `instruments.ts`. Only these facts are used, not their code.
- **Fetched for tests only**, never committed or redistributed: Mantid's TOPAZ_3007 test data and ORNL garnet-tools'
  `corelli_YAG_ub.mat` (BSD-3-Clause).

## Methods

- **NeuXtalViz** (Morgan, Z. et al. (2026), "NeuXtalViz: Interactive Three-Dimensional Visualization and Analysis for
  Single-Crystal Neutron Diffraction", arXiv:2606.25414;
  [neutrons/NeuXtalViz-tools](https://github.com/neutrons/NeuXtalViz-tools), GPL-3.0): the stepped sweep behind *Find a
  setting* (`reflectionCoverage` in `src/core/instrument/simulate.ts`) follows the "individual peak" planner of
  NeuXtalViz. The implementation is NEXPLAN's own; no NeuXtalViz code is included.
- Formulas from the literature are cited where they are used and listed in
  [CONVENTIONS §12](docs/CONVENTIONS.md#12-references).

## Packages in the web app

The built site bundles React, React DOM and scheduler (MIT, © Facebook, Inc. and its affiliates) and three.js
(MIT, © the three.js authors). Their licence headers are kept in the built files, and the full texts are in each
package's `LICENSE` under `node_modules`. The fonts, Inter and JetBrains Mono (SIL Open Font License 1.1), are served
by Google Fonts.
