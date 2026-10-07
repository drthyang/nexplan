# Third-party notices

NEXPLAN is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). It builds on the work listed
here. Parts derived from other projects keep their own licences, and this file reproduces the notices those licences
require.

## Code ported from other projects

### garnet-tools (BSD-3-Clause)

`src/core/instrument/qResolution.ts` ports the single-crystal Q-resolution model and its fitted parameters from
ORNL's garnet-tools ([neutrons/garnet-tools](https://github.com/neutrons/garnet-tools) at commit `4eb3206`:
`src/garnet/reduction/resolution.py`, `src/garnet/config/instruments.py`). `scripts/data/gen_qres_reference.py` runs
garnet-tools' own code, fetched at that commit and not included here, to make `fixtures/qres-garnet.json`.

```text
BSD 3-Clause License

Copyright (c) 2024, Zachary Morgan

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

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
- **Fetched for tests only**, never committed or redistributed: Mantid's TOPAZ_3007 test data and garnet-tools'
  `corelli_YAG_ub.mat`.

## Methods

- **NeuXtalViz** (Morgan, Z. et al. (2026), "NeuXtalViz: Interactive Three-Dimensional Visualization and Analysis for
  Single-Crystal Neutron Diffraction", arXiv:2606.25414;
  [neutrons/NeuXtalViz-tools](https://github.com/neutrons/NeuXtalViz-tools), GPL-3.0): the stepped sweep behind *Find a setting* (`reflectionCoverage` in `src/core/instrument/simulate.ts`)
  follows the "individual peak" planner of NeuXtalViz. The implementation is NEXPLAN's own; no NeuXtalViz code is
  included.
- Formulas from the literature are cited where they are used and listed in
  [CONVENTIONS §12](docs/CONVENTIONS.md#12-references).

## Packages in the web app

The built site bundles React, React DOM and scheduler (MIT, © Facebook, Inc. and its affiliates) and three.js
(MIT, © the three.js authors). Their licence headers are kept in the built files, and the full texts are in each
package's `LICENSE` under `node_modules`. The fonts, Inter and JetBrains Mono (SIL Open Font License 1.1), are served
by Google Fonts.
