# NEXPLAN: scientific implementation and validation plan

Revision 2 · 2026-10-02 · supersedes the 2026-10-02 draft.
Status: a personal toolkit, public at `https://drthyang.github.io/nexplan/` since 2026-10-05. The M0–M4 deliverables are built; the M5
research release waits on print certification of the scattering tables. Nothing is certified for research use.

## 0. What changed from the draft, and why

| Draft | Revision | Reason |
|---|---|---|
| Build the scientific core from scratch. | Build on **MATERIA** (`web-refinement`). Copy its audited modules into `src/materia/` pinned to a commit, and replace or extend the parts that fail this plan's requirements (§3). | MATERIA already has the lattice math, symmetry operations, structure factors and peak profiles. Re-deriving them duplicates work. An audit found specific gaps (§3.2), and those are what get new code. |
| M0 blocks all coding until every table row is certified against print. | Rows carry a **verification tier** (§5.1). Code proceeds in parallel. The app shows each row's tier, and "validated mode" accepts only certified rows. | Certification against paywalled print is a human task, and it should not serialize engineering. Tiers keep the gate without blocking. |
| "Independently verify every row against published tables." | Defined per dataset: what is authoritative, which transcriptions are independent, and which physical identities each row must satisfy (§5.2–5.3). Implemented in `scripts/data/build-tables.ts`. | "Independent" was undefined. For WK1995 the authoritative object is the authors' electronic file. For Sears 1992 it is the printed table, and every web copy descends from one NIST manual entry. |
| X-ray baseline: Waasmaier–Kirfel. | Unchanged. MATERIA's Cromer–Mann (ITC) table stays available for matched comparisons with GSAS-II and FullProf, which use it. | WK covers ions and s ≤ 6 Å⁻¹. CM covers s ≤ 2 Å⁻¹ and is what the reference packages use. |
| "Document the complex scattering-length sign." | Derived and fixed (§4, item 7): F uses **conj(b_Sears)**. | Using Sears' printed b in F = Σ b·exp(+2πi h·x) swaps I(h) and I(−h) for absorbing nuclei. |
| "Mathematically safe hkl bounds." | Stated: \|h_i\| ≤ \|a_i\|/d_min, per axis (§7). | h_i = a_i · g and \|g\| ≤ 1/d_min. This is exact for any cell. |
| Absences from a "verified symmetry reference". | Computed from the operations: h is absent iff some (R, t) has hR = h and h·t ∉ ℤ. Tables only verify the result (§7). | Needs no lookup table, works for any setting, and is already in MATERIA (`isReflectionAbsent`). |
| Powder: "explicit sum or families, never both". | **Explicit sum over the full signed list is the default.** Families are used only for labels (§7). | It needs no multiplicity or Laue-class logic, so a symmetry bug cannot change intensities. |
| UI unspecified. | Match the MATERIA / NEBULA3D / RMCProfile Workbench design system (§11). | User requirement. |
| — | Deployment origin `https://drthyang.github.io/nexplan/`; license AGPL-3.0-only (§13). | COD CORS must be tested at the real origin. Copied MATERIA code is AGPL. |

## Progress (2026-10-05)

| Item | State |
|---|---|
| Conventions frozen (`docs/CONVENTIONS.md`) | done |
| Source registry, pinned and hashed; NIST snapshot | done |
| WK1995 X-ray table + report | done: 209/209 crosschecked; print audit pending |
| Sears 1992 neutron table + report | done: 324 crosschecked, 6 discrepant, 6 unresolved; print audit pending |
| MATERIA table audit | done (`docs/data-verification/MATERIA_TABLES.md`); fixed in MATERIA (web-refinement PR #27) and re-audited at `93eac17`: 88 of 89 neutron rows equal Sears 1992, complex parts included; Hf kept at 7.77 on purpose |
| MATERIA module copy with pin and check | done (23 files at `93eac17`, `npm run materia:check`) |
| Space groups, all 564 gemmi settings; absences vs gemmi | done |
| CIF 1.1 reader, block selection, species, U_eq | done |
| Expansion, signed reflections, complex F (vs gemmi 1e-8) | done |
| Powder sticks, LP, profiles, exports | done |
| UI matching the MATERIA / NEBULA3D / RMCProfile design system | done; aligned split layouts |
| Neutron TOF powder (one bank, GSAS-II position/Lorentz/back-to-back) | done |
| Interactive reflection ticks linked to the peaks table and peak details | done |
| Folded reflection families; per-site X-ray ion opt-in (neutral default); energy ↔ λ | done |
| Structure viewer (ported from MATERIA, RMCProfile export/theming) | done |
| UB workbench: ISAW I/O, lattice/orientation, setting match, basis change, TOPAZ cryo/ambient + Universal goniometers, 3D Laue view | done; validated on Mantid TOPAZ_3007 peaks |
| Re-indexing: any integer supercell, primitive cell or ITA transformation (fractional P); exported as a UB or as Mantid's TransformHKL call | done |
| Detector geometry from Mantid IDFs (TOPAZ, CORELLI, NOMAD, POWGEN, ARCS, SEQUOIA, CNCS) + real-space instrument view | done; pixel mapping validated on TOPAZ_3007 |
| Instrument page: single crystal (3D detectors, unrolled detector map, rotation scan with family completeness, reflections on panels) and powder (sample fixed: 2θ–d coverage, panels per reflection, per-panel TOF pattern) | done; UB page is now orientation-only |
| CI and Pages workflows | done; every push to `main` fetches the pinned sources, runs CI and deploys `https://drthyang.github.io/nexplan/` |
| Anisotropic Debye–Waller, anomalous X-ray terms | not started; anisotropic ADPs enter as U_eq |
| Powder rings on the detectors (TOF slices, ray-traced check); ARCS, SEQUOIA, CNCS (elastic, exact monochromatic scans); Instrument page neutron-only | done |
| Pages grouped Sample · Setup · Instrument · Simulation; instrument chosen in the header; Detectors, Powder (per panel) and Single-crystal pages; exact per-pixel coverage; orientation lists (TOPAZ), interleaved scans (CORELLI); reciprocal slices with plan coverage | done |
| TOPAZ planner: wanted reflections, Find a setting, Suggest settings (Full coverage or Fewest settings, greedy, fine-tuned off the grid), user goniometer limits, plan CSV export with provenance | done |
| Focused banks as the data are reduced (NOMAD six, POWGEN one); powder export per bank; TOF, d and Q axes; warning where d_min cuts the pattern, with a one-click fix | done |
| Calibrated banks | partly: NOMAD banks 0–4 use calibrated DIFC (ORNL 2023A GSAS-II file, its banks 1–5), POWGEN's DIFC comes from the characterisation file's effective L2 and 2θ; NOMAD bank 5 and the other instruments use geometric DIFC |
| Instrument peak widths: NOMAD measured Δd/d per bank; POWGEN GSAS-II profile for each of seven standard chopper frames; resolved-line check (≥ 1 FWHM apart) | done; POWGEN 0.8 Å frame within 25 % of the LaB₆ widths in Huq et al. (2019) |
| Forbidden reflections (absent, \|F\| ≈ 0 or below d_min) simulated, wanted and planned on request, with a notice | done |
| Scattering power against a reference material (V, diamond, Si, CeO₂, corundum or a demo structure) | done; relative, no counting time |
| Consistency with Mantid: constants, DIFC and TOF, E ↔ λ, B matrix, goniometer, Laue wavelength | done (`docs/data-verification/MANTID_CONSISTENCY.md`) |
| Session kept across reloads; layouts for phones, tablets and 1080p–4K monitors; sortable reflection tables | done |
| License: AGPL-3.0-only, full text in `LICENSE` | done |
| Detector masks (edge pixels, panels, Mantid mask files by detector ID) and sample-environment shadows (lab or stage frame), in every hit test | done; gaps between the tubes of a pack are not modelled |
| Counting time (flux) | not started |
| Mount: scattering plane from u, v (Mantid SetUB) sets U without a UB file; plane drawn at the sample, its tilt and beam angle, and the detector curve where its reflections land | done (2026-10-07); tested against Mantid's SetUB example and by diffracting in-plane reflections |
| Binning: recorded HKL range along chosen axes, as MDNorm parameters | done; practical bins (a round step giving about 200–400 bins per axis; energy steps of 1 % of Ei, Mantid's DGS default) since 2026-10-07, replacing resolution-sized bins; limits for Mantid's default Q convention or the crystallographic one |
| Code review of the formulas against the literature and pinned upstream code (2026-10-06; not the domain-expert review of M5) | done: corrections and their tests in CONVENTIONS §13 (focused banks, TOF on Q, exact coverage, MDNorm Q convention, centring completion, coincident images, smaller ones); references in CONVENTIONS §12 |
| UI review (2026-10-06) | done: pages in three groups (Sample · Setup · Simulation); Δd/d set where it acts (powder views) rather than in the bar; one d_min note per page; structure viewer without the light and finish knobs |

## 1. Product objective

An installation-free static web application for X-ray and neutron diffraction calculations, reciprocal-space
inspection, UB manipulation and experiment-accessibility planning. Uploaded structures and orientation files are
processed only in the browser. No calculation server, account, Python runtime or Mantid installation is needed.

Scientific readiness means validated calculations within a declared model and input domain. It does not mean
error-free software, exact measured intensities, or certainty beyond the underlying data. Every release claim links
to published validation evidence.

## 2. Scope and release boundaries

| Capability | Initial supported behavior | Explicit boundary |
|---|---|---|
| Database discovery | COD search URL builder and external lookup, then local upload. Direct COD import only after the deployed-origin CORS gate passes. | No backend, proxy or embedded credentials. No automatic phase selection. |
| CIF import | CIF 1.1. User selects the data block. Reads lattice, atom sites, symmetry, occupancies, isotropic ADPs, su values and type symbols with charge. | CIF 2.0, DDLm-only names, superspace and magnetic CIFs are rejected with a message. Ambiguous symmetry blocks the calculation. |
| Reflections | Full signed hkl list with d, Q, absence class and complex F. Unscaled \|F\|². | No absolute count prediction. |
| X-ray scattering | Non-resonant WK1995 f0 for neutral atoms and tabulated ions. Optional ITC Cromer–Mann for matched comparisons. | No anomalous terms initially. Ions only from an explicit type symbol or user choice. |
| Neutron scattering | Coherent nuclear b (Sears 1992) for natural elements and named isotopes, complex where tabulated. | No magnetic intensity. Complex b is valid near 2200 m/s only and is labeled as such. |
| Powder | CW: Lorentz(-polarization) for named geometries, unit-area pseudo-Voigt, 2θ/d/Q axes. Neutron TOF at one bank: DIFC/DIFA/ZERO, sinθ·d⁴, Δd/d Gaussian or GSAS-II back-to-back, TOF/d/Q axes. | No refinement, texture, absorption, incident-spectrum or resonance-energy modelling. |
| UB tools | ISAW import and export, validation, axis and basis changes, integer supercells. | No guessing unknown matrix formats or frames. |
| Single-crystal display | Reciprocal lattice, arbitrary planes, finite-thickness slices. | Not a detector image until detector geometry exists. |
| Planning | Wavelength or band, rotations, detectors, accessible reflections. | Each instrument adapter is validated separately. |

The plotting and RMC scripts in `rmc-toolkits` are not the diffraction engine; their plotting ideas may be reused.

## 3. Architecture and the MATERIA foundation

TypeScript + React + Vite, as in MATERIA and NEBULA3D. The scientific core does not depend on the UI, plotting, file
dialogs or browser state.

```text
src/materia/   copied MATERIA modules, unmodified except import paths; UPSTREAM.json pins commit + per-file sha256
src/core/      NEXPLAN science: species, complex SF, signed reflections, powder, UB, transforms, geometry
src/io/        CIF 1.1 tokenizer/reader, ISAW UB, explicit matrix adapters
src/data/      generated, versioned scattering and symmetry tables + manifest.json
src/workers/   reflection enumeration and simulation workers
src/ui/        layout, panels, provenance/status, design tokens shared with MATERIA/NEBULA3D
src/views/     powder and reciprocal-space visualization
scripts/data/  dev-only: fetch pinned sources, build tables, cross-check, write reports
data-sources/  sources.json (URLs, sha256, license notes); snapshots/ for unpinnable pages
fixtures/      redistributable inputs and frozen reference outputs
docs/          PLAN, CONVENTIONS, data-verification/ reports, VALIDATION, LIMITATIONS
```

Float64 throughout the core; WebGL precision is for display only. Workers run with cancellation, explicit resource
limits and progress reporting. Errors are explicit: a limit stops with a message and is never truncated silently.
Scattering data and dependencies are bundled and pinned. Python, gemmi and Mantid may run in development and CI to
generate reference fixtures, never on the user's machine.

### 3.1 What is reused from MATERIA (pinned at `93eac17`)

| Module | Use | Verification required before use |
|---|---|---|
| `core/math/*` | Vec3/Mat3/complex/linear algebra | Unit tests: inverse, determinant, complex ops |
| `core/crystal/unitCell` | metric G, G*, d, Q = 2π/d, volume | Analytic triclinic cases vs an independent metric implementation (rel. 1e-12) |
| `core/crystal/symmetry` | `isReflectionAbsent` as an independent cross-check in the tests, and the 3D viewer's cell expansion; the core uses its own exact implementations (`src/core/symmetry`) | Absences vs gemmi for all 230 groups; multiplicities vs ITA |
| `core/diffraction/profile` | unit-area Gaussian, Lorentzian, pseudo-Voigt, TCH | Area = 1 within 1e-6 by quadrature |
| `core/diffraction/intensity` `lorentzPolarization` | CW Debye–Scherrer L and X-ray polarization | Formula vs ITC Vol. C §6.2.5; add monochromator term |
| `core/scattering/cromerMannData` | ITC CM coefficients (comparison mode only) | Done: `docs/data-verification/MATERIA_TABLES.md` |

### 3.2 What is replaced, and why (from the 2026-10-02 audit)

| MATERIA behavior | Consequence | NEXPLAN replacement |
|---|---|---|
| Line-based CIF reader. Drops su values and semicolon fields, has no block selection, strips ion charges, resolves `FE1` → F. | Wrong species, silently. | New CIF 1.1 tokenizer and reader (`src/io/cif`). |
| 230 space groups, one setting each; **origin choice 1** for the 24 two-origin groups. | A CIF that gives only an H-M symbol with origin-2 coordinates expands to the wrong structure. | Table of all gemmi settings (origin choices, :R/:H, Hall symbols). Ambiguous symbols are an error. |
| Unknown H-M symbol falls back to P1. | Silent wrong symmetry. | Hard error naming the symbol. |
| Reflection list capped at 12 000, truncated in loop order. | Missing reflections, silently. | Signed enumerator with a d-ordered explicit limit and an error. |
| `ScatteringTable.factor` returns a real number. | No complex b; Gd neutron intensities several-fold too low. | Complex per-species amplitude provider (`src/core/scattering`). |
| Neutron table: In = 2.08 fm (should be 4.065); Pu/Cm use isotope values; imaginary parts dropped; Au labeled Sears but is Rauch 2003. | Wrong neutron \|F\|² for In, Gd, Sm, Cd, B, Eu, Dy compounds. | `src/data/neutron-sears1992.json` with tiers. Fixed in MATERIA too (PR #27). |

MATERIA fixed all six in web-refinement PR #27 (merged 2026-10-02); NEXPLAN's table audit, re-run at `93eac17`,
confirms the tables. PR #32 closes gaps #27 left in the CIF reader, isotope input and symbol-less export. NEXPLAN
keeps its own implementations.

Changes that would also fix MATERIA are made upstream in MATERIA first when practical. `npm run materia:sync`
re-copies the pinned files and fails if any copied file was edited locally.

## 4. Scientific conventions (frozen; full text in `docs/CONVENTIONS.md`)

1. Lengths in Å, reciprocal lengths in Å⁻¹. Angles are displayed in degrees and computed in radians.
2. The direct basis A has the lattice vectors as columns; r = A·x.
3. The crystallographic reciprocal basis is C = A⁻ᵀ, without 2π; g = C·h, d = 1/|g|, Q = 2π·g.
   Orthogonalization for UB work follows Busing & Levy (1967): B has a* along x. MATERIA's
   `orthogonalizationMatrix` puts a along x and is used only for real-space display.
4. UB maps a column hkl to g in the sample frame (no 2π). The laboratory rotation R acts separately:
   Q_lab = 2π·R·UB·h. Sample rotations multiply UB on the left; basis changes multiply it on the right.
5. Detector geometry uses Q = k_out − k_in with |k| = 2π/λ. Adapters translate other conventions explicitly.
   Mantid's `Q.convention` is configurable (default "Inelastic", Q = k_i − k_f). The value used for fixtures is
   pinned and verified.
6. Structure-factor phase is exp(+2πi h·x) (ITC Vol. B).
7. **Complex scattering lengths.** Sears (1992) prints b = b′ − i b″, with b″ ≥ 0 for absorbers. That is the
   physics convention: time dependence exp(−iωt), and Im of the scattering amplitude positive by the optical
   theorem. The crystallographic convention, F = Σ f exp(+2πi h·x) with f″ > 0, is the complex conjugate of the
   physics convention. So the neutron term in F is **conj(b) = b′ + i b″**. Tables store b exactly as printed; the
   structure factor conjugates. Tests enforce that every absorbing nucleus gets a positive imaginary amplitude (the
   sign of X-ray f″), that |F(h)|² equals the physics-convention amplitude, and that the printed b would give I(−h).
   (There are no anomalous X-ray terms yet to compare Bijvoet differences with.)
8. Elastic Bragg condition λ ≤ 2d. Inaccessible reflections are rejected; arcsine inputs are clamped only for
   documented round-off (|x| − 1 < 1e-12).
9. X-ray f in electrons; neutron b in fm. Raw \|F\|² from the two are never compared on a common absolute scale.
10. F(000) is excluded from reflection lists (it is not computed).
11. B_iso = 8π²U_iso, T = exp(−B s²), s = sinθ/λ = 1/(2d).

Basis change, with column vectors and A_new = A_old·P, matching ITA (a′, b′, c′) = (a, b, c)P:
x_new = P⁻¹(x_old − p), h_new = Pᵀh_old, UB_new = UB_old·P⁻ᵀ, G_new = PᵀG_old·P.
These preserve UB_new·h_new = UB_old·h_old.

## 5. Scattering tables: data assurance

### 5.1 Verification tiers

| Tier | Meaning | App behavior |
|---|---|---|
| `certified` | Crosschecked, and a named reviewer has checked the row against the printed publication in a reviewed commit. | Allowed in validated mode. |
| `crosschecked` | Independent transcriptions agree exactly, and the row passes every physical identity in §5.2–5.3. | Used and labeled "crosschecked, not certified". |
| `discrepant` | A transcription or identity check failed. Listed in a report with the evidence. | Used only after explicit user acknowledgement, with a warning. |
| `unresolved` / `unavailable` | Identity ambiguous (e.g. an element row that is really a single radioisotope), or no value. | Blocked, with an error naming the species. |

Coefficients are never repaired by hand. A correction is a documented override with its evidence, applied by the
generator.

### 5.2 X-ray: Waasmaier & Kirfel (1995)

f0(s) = Σ₁⁵ aᵢ exp(−bᵢ s²) + c, for 0 ≤ s ≤ 6 Å⁻¹. Outside this domain the evaluator throws.

- **Authoritative object:** the authors' electronic `sfac.dat`. Its original ftp host is gone.
- **Production copy:** DABAX `f0_WaasKirf.dat` from `https://ftp.esrf.fr/pub/scisoft/DabaxFiles/`. The `xop/` path
  in the draft returns 404.
- **Independent reformat:** cctbx `wk1995.cpp` (1995, verified 2001).
- **Checks per row:**
  - all 11 coefficients identical as canonical decimals;
  - |f0(0) − (Z − q)| ≤ 0.05 e (reported, never enforced by editing);
  - within 0.25 e of an ITC Cromer–Mann transcription for s ≤ 1.5 (mislabel screen);
  - for ions, |f_ion − f_neutral| ≤ 0.25 e for 2 ≤ s ≤ 6.
- **Result (2026-10-02):** 209/209 crosschecked. Largest |f0(0) − N| is 0.038 e. Pseudo-species `Cval` and `Siva` are
  excluded. O1− is a fit to Rez et al. (1994), not to ITC, and is labeled as such. Y3+ is in cctbx but missing from
  DABAX.
- **Remaining:** a human audit against WK Table 1 for the listed sample before `certified`.

### 5.3 Neutron: Sears (1992)

- **Authoritative object:** the printed table in *Neutron News* 3(3) 26–37.
- **Production copy:** the NIST page. It is a manual entry, and NIST warns of errors. Cloudflare changes the page's
  bytes on every request, so the extracted table is hashed and committed as a snapshot.
- **Transcriptions compared:** Mantid `NeutronAtom.cpp` (full table) and gemmi `neutron92.hpp` (elements). Both descend
  from the NIST page, so they catch copying errors, not NIST's own entry errors.
- **Identity checks:**
  - σ_coh = 4π|b_c|²/100 within printed precision (then within su);
  - element vs abundance-weighted isotope average (informational);
  - abundances sum to 100 %.
- **Other evaluations** (ITC edition via Dans_Diffraction; Rauch 2003 via periodictable and GSAS-II) are reported, not
  merged.
- **Result (2026-10-02):** 324 rows crosschecked, 6 discrepant, 6 unresolved, 35 unavailable.
  - The discrepant rows are Sn, Xe, Eu and Hf (σ_coh identity), and ¹⁷⁵Lu and ¹⁷⁶Lu. The Lu rows are shifted in
    Mantid's table.
  - Hf: NIST's 7.7 fm fails the identity check, while 7.77 fm (ITC edition, Rauch) passes. This is probably a NIST
    entry truncation.
  - The unresolved rows are the element rows that carry a half-life: Tc, Pm, Ra, Pa, Np, Am.
- **Rules carried from the draft:**
  - natural-element and isotope rows stay separate;
  - signs are preserved;
  - b is never derived from a cross section;
  - Bragg amplitudes use coherent b only;
  - missing data is an error naming the species;
  - D is an explicit alias for ²H;
  - isotope mixtures need normalized fractions with provenance.

### 5.4 Literature findings so far (details in `docs/data-verification/`)

1. **ITC Cromer–Mann Bi5+ and Ru4+:** cctbx, gemmi and GSAS-II carry b2 = 0.39042 (Bi5+) and b3 = 0.36495 (Ru4+).
   These give unphysical curves; Bi5+ reaches f(2 Å⁻¹) = −0.68 e. DABAX's 0.039042 and 0.036495 reproduce the WK
   curves within 0.04 e. This is probably a dropped digit in the ITC Vol. C reprint.
2. **DABAX `f0_InterTables`:** the Pu, Np3+, Np4+ and Np6+ rows are shuffled, giving f(0) − N of −5.0, +5.0, +3.0 and
   −3.0 e. This is why MATERIA omitted Pu up to `0ee9a7e`; it now uses the cctbx, gemmi and GSAS-II Pu row, which is
   valid.
3. **GSAS-II Tl3+:** a2 is 18.3481 where the other three sources have 18.3841. It looks like a digit transposition,
   and gives f(0) − N = −0.041 e.
4. **MATERIA neutron table** (at `0ee9a7e`; fixed in PR #27): In = 2.08 fm (Sears 4.065); imaginary parts dropped for B,
   Cd, Sm, Eu, Gd, Dy, In; Pu and Cm take isotope values; Au = 7.9 fm is Rauch 2003, not Sears 1992. MATERIA's X-ray CM
   table matches all four transcriptions for 96 of 97 rows. The 97th, Si, is absent from cctbx under that label and
   identical to the other three.
5. **Dans_Diffraction Sears file:** the sign of the imaginary part is inconsistent (B +0.213, ³He −1.483).

### 5.5 Manifest and update policy

`src/data/manifest.json` records each dataset's ID, version, tier, generated-file sha256 and source hash.
`data-sources/sources.json` records each source's URLs (pinned to commits where possible), sha256, license note and
role. The pipeline is: raw source → deterministic converter → cross-checks → generated JSON plus report.
`npm run data:check` fails CI if any generated file is stale. A dataset change requires the full scientific
regression suite and a changelog entry.

**Still open:**
- License and redistribution assessment for DABAX, NIST and WK coefficients. Every comparable package redistributes
  them, but the assessment is not yet written down.
- Reviewer sign-off.

## 6. CIF and crystallographic correctness

- **Tokenizer.** Implement the CIF 1.1 grammar, not a line splitter:
  - loops whose rows span lines;
  - quotes closed only by a quote followed by whitespace;
  - semicolon text fields and trailing comments;
  - su values kept, e.g. 5.431(2) → value 5.431, su 0.002;
  - `.` (inapplicable) and `?` (unknown) kept distinct.
- **Data blocks.** List all blocks with their phase name, formula and cell. The user selects one. Keep the input bytes
  and their sha256.
- **CIF 2.0.** The magic `#\#CIF_2.0` and DDLm-only names are detected and rejected with a message.
- **Symmetry operations.** Parse each operation as rational affine x′ = Rx + t, with R an integer matrix of
  determinant ±1 and t in twenty-fourths (a decimal within 10⁻⁴ of k/24 is snapped to it). Anything else is rejected.
  Uploaded text is never evaluated as code.
- **Symmetry sources, in order:**
  1. explicit operations;
  2. Hall symbol;
  3. H-M symbol plus setting suffix;
  4. space-group number, but only when the setting is unambiguous.

  Conflicts between sources are reported. Explicit operations win only after the group they generate is checked to be
  closed.
- **Site expansion.** Expand each asymmetric-unit site once. Merge images within that site's orbit closer than a
  distance tolerance in Å (0.02 Å), by connected groups so that the result stays symmetric. Keep distinct species that
  share a position (disorder). Cross-check against `_atom_site_symmetry_multiplicity` where it is given.
- **Validation.** Volume > 0, metric positive-definite, 0 < occupancy ≤ 1, and the sum of occupancies at a shared
  site ≤ 1 + 1e-3.
- **Defaults.** Missing occupancy or ADP takes a visible, recorded default (1 and 0).
- **Anisotropic ADPs.** Not supported in v1. They are reported and never silently discarded: the site uses the
  file's U_iso_or_equiv, or else U_eq computed from the U^ij (Fischer & Tillmanns 1988), a recorded assumption.
- **Species.** Resolve from `_atom_site_type_symbol`, which includes charge (`Fe3+`, `Fe+3`, `O2-`). Fall back to
  the label with case-insensitive element matching, which needs user confirmation when ambiguous (`CA` could be C or
  Ca). Isotopes come only from an explicit rule: `D` or a mass number (`2H`, `57Fe`) in a type symbol, or a user
  choice. (`H2` is read as hydrogen, not deuterium: as a label it usually names a second H site.)

### 6.1 Published-structure databases

Unchanged from the draft.

- **COD** is the primary candidate. The first release builds search URLs and imports a downloaded CIF through the
  normal local path. Direct fetch is enabled only after a browser test at `https://drthyang.github.io` shows readable
  CORS responses for both search and CIF endpoints. As of 2026-10-02 neither endpoint sends
  `Access-Control-Allow-Origin`. Never use `no-cors`.
- **CCDC/FIZ, ICSD, Materials Project:** external lookup only. Calculated structures are labeled as calculated.
- The draft's API contract, search, selection, provenance and acceptance requirements stand as written.

## 7. Reflection and powder engine

- **Structure factor.** F(h) = Σⱼ oⱼ·aⱼ(s)·Tⱼ(s)·exp(2πi h·xⱼ) over the expanded cell, where aⱼ is complex:
  f0 for X-ray, conj(b) for neutrons.
- **Enumeration.** Use the per-axis bound |hᵢ| ≤ ⌊|aᵢ|/d_min⌋, then filter by |g| ≤ 1/d_min. A tested limit on the
  count (the app passes 4 × 10⁵ signed reflections) raises an error suggesting a larger d_min. The output is never
  truncated.
- **Absence classes.** *Systematic*: some op has hR = h and h·t ∉ ℤ. *Accidental*: |F| is small but not
  systematic, with the threshold reported. *Present*.
- **Signed list.** The full signed list is kept internally. Friedel pairs are never merged when any amplitude is
  complex.
- **Powder intensity** at each distinct d is the explicit sum of |F|² over all signed hkl at that d (|Δd| < 1e-9·d).
  Equivalence families (point group of the space group) supply labels and multiplicity only, and a test checks that
  Σ|F|² over a family equals m·|F_rep|² when all amplitudes are real.
- **Plot modes.** (a) |F|² sticks; (b) relative intensity with a named CW geometry (Debye–Scherrer or Bragg–Brentano,
  X-ray polarization with an optional monochromator 2θ_M; neutrons have no polarization factor); (c) unit-area
  profiles.
- **Axes.** Sticks are relabeled on 2θ, d or Q. A continuous profile is synthesized natively on each axis rather
  than resampled, so no Jacobian is needed. Multi-wavelength input needs explicit weights.

## 8. UB and basis transformations

- **ISAW file.** Verified from Mantid `SaveIsawUB.cpp`:
  - The file stores UBᵀ in the IPNS frame: x is the beam, z is up, right-handed.
  - Q′ is normalized with |Q′| = 1/d, i.e. no 2π.
  - Mantid's frame relates to it by a cyclic permutation: z_M = x_I, x_M = y_I, y_M = z_I. Handedness is preserved.
  - The fixtures are asymmetric, non-diagonal real files plus Mantid round trips at a pinned Mantid version.
- **Generic matrices.** A generic 3×3 text matrix needs a user-declared layout, transpose, 2π convention, axis map
  and handedness.
- **Kinds of basis change:**
  - Unimodular (|det P| = 1) is an equivalent lattice.
  - Integer |det P| > 1 is a supercell: translated atom images are added and the volume is scaled. Intensities are
    compared after normalization, and new nodes may have F = 0.
  - Rational P (centred ↔ primitive) needs centring-aware atom mapping.
  - An origin shift changes phases only; |F|² is invariant.
- **Rules.** Reject singular or ill-conditioned P (cond > 1e8). Change handedness only through explicit frame
  handling. After a transform, either re-derive the symmetry or export explicitly as P1; never keep a stale
  space-group label. Do not invent uncertainties.
- **Reuse.** `fitOrientation` (Wahba / Davenport q-method) from MATERIA's absorption module may be used for a
  least-squares U fit, after its own tests.

## 9. Single-crystal and experiment planning

Unchanged from the draft. The order is:
1. reciprocal slices, intensity coloring, indexed reflections and orientation vectors;
2. Ewald intersections using |k_in + Q| = |k_in|;
3. detector ray intersections, pixel mapping, masks and rotation axes;
4. one instrument adapter, validated against Mantid or measured spots.

Satellite positions h ± k carry no implied magnetic intensity.

## 10. Validation matrix

Tolerances are frozen before reference comparisons and are not relaxed to hide discrepancies. Any methodology change
is recorded in the relevant report, as `XRAY_WK1995.md` does.

| Test | Independent evidence | Gate |
|---|---|---|
| Table transcription | Two or more transcriptions, canonical decimals | Every deployed row crosschecked; discrepant rows listed |
| Table physics | f0(0) = N, ion convergence, σ = 4π\|b\|² | As §5.2–5.3 |
| f0 evaluator | Script evaluator vs app evaluator, identical coefficients | \|Δ\| ≤ 1e-10 + 1e-10\|ref\| e |
| Lattice d, Q | Analytic cells; independent metric | rel ≤ 1e-12 |
| Complex F | Analytic structures; gemmi with matched tables | \|Δ\| ≤ 1e-8·S + 1e-8\|F_ref\| |
| Absences | gemmi `is_systematically_absent`, all settings | exact |
| Enumeration | Brute force over a cube, triclinic cells | identical sets |
| Complex-b sign | Im a > 0 for every absorber; physics-convention \|F\|²; printed b gives I(−h) | exact |
| UB invariant | Synthetic P, R | rel ≤ 1e-12 |
| ISAW round trip | Mantid fixtures | within serialized precision |
| Powder area | Quadrature, grid convergence | rel ≤ 1e-4 |
| MATERIA modules | Their tests plus the checks in §3.1 | pass before use |

The minimum fixture suite is unchanged from the draft: P1 single atom; cancellation, negative b, partial occupancy,
finite B; centring, diamond, screw and glide absences; triclinic, monoclinic and hexagonal/rhombohedral settings;
disorder; natural vs isotope; ions; Friedel with complex amplitudes; axis swaps, origin shift, shear, supercell,
handedness; real ISAW files; malformed CIFs.

## 11. UI and design system

Match the layout and style of MATERIA, NEBULA3D and the RMCProfile Workbench: the same typography, color tokens,
panel structure, header with status chips, light and dark themes, and phone/tablet behavior. Shared tokens live in
`src/ui/tokens.css` and are copied from those projects, not reinvented.

- **Calculation-status panel:** the dataset tiers used, assumptions applied, unsupported inputs and limits.
- **Exports** (CSV, JSON, session file) record:
  - source and app versions;
  - dataset IDs and hashes;
  - the data block, the expanded model, wavelength and mode;
  - assumptions, conventions and transformations.
- **Determinism.** Exports are deterministic. Display rounding never touches exported values.
- **Privacy.** No analytics and no upload of file contents.

## 12. Milestones with exit criteria

| Milestone | Deliverables | Exit |
|---|---|---|
| **M0 Contracts & data** (done; the print-audit list awaits a reviewer) | Conventions; sources registry; WK1995 and Sears 1992 tables with reports; MATERIA module copy with pin; full-settings space-group table | `data:check` and conventions tests green; human audit list issued |
| **M1 CIF → reflections** | CIF 1.1 reader, block selection, species resolution, expansion, signed reflections, complex F, absences, minimal UI | Parser, analytic and gemmi-matched tests pass; tiers shown in UI |
| **M2 Powder** | Sticks, CW corrections, profiles, axes, exports | Multiplicity, overlap, area, axis and matched-reference tests |
| **M3 UB workbench** | ISAW round trip, orientation inspection, basis changes, supercells | Non-diagonal real fixtures; invariants |
| **M4 Planning** | Slices, Ewald accessibility, rotation scans, one adapter | Analytic and independent geometry comparisons |
| **M5 Research release** (next) | Validation report, licenses, citations, limitations, DOI | Domain-expert review; all deployed rows ≥ crosschecked, validated-mode rows certified |

## 13. Open decisions

1. **License: decided.** AGPL-3.0-only, the same as MATERIA, whose code NEXPLAN includes. The full text is in
   `LICENSE` (2026-10-05).
2. **Upstream fixes to MATERIA: done.** The In value, complex b, Pu/Cm, origin choice, P1 fallback, silent truncation
   and CIF species were fixed in web-refinement PR #27 (merged 2026-10-02). PR #32 closes the gaps #27 left in the CIF
   reader, isotope input and symbol-less export. NEXPLAN pins `93eac17`.
3. **Reviewer** for print certification of the WK and Sears rows.
4. **COD direct import** stays deferred until the CORS gate passes.

## 14. Sources

The draft's list stands, with these corrections and additions:

- The DABAX WK file is at `https://ftp.esrf.fr/pub/scisoft/DabaxFiles/f0_WaasKirf.dat`. The `xop/` path returns 404.
- cctbx `wk1995.cpp` and `it1992.cpp`; gemmi `it92.hpp` and `neutron92.hpp`; Mantid `NeutronAtom.cpp`,
  `LoadIsawUB.cpp` and `SaveIsawUB.cpp`; GSAS-II `atmdata.py`; periodictable `nsf.py`; Dans_Diffraction Sears file.
  All are pinned by commit and sha256 in `data-sources/sources.json`.
- Busing, W. R. & Levy, H. A. (1967). *Acta Cryst.* 22, 457–464 (UB convention).
- Rauch, H. & Waschkowski, W. (2003). *Neutron Data Booklet* (GSAS-II and periodictable neutron values, used for
  comparison only).
