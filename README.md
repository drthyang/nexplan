# NEXPLAN · Neutron Experiment Planner

My personal toolkit for planning neutron experiments at the SNS. I wrote it for my own beamtimes; it is public in
case it helps others.

**https://drthyang.github.io/nexplan/**: runs in the browser, nothing to install, files are not uploaded.

Work in progress. The scattering tables are cross-checked against independent copies but not yet against the
printed sources. The formulas, with their literature sources, are in [CONVENTIONS](docs/CONVENTIONS.md). A code
review on 2026-10-06, not a domain-expert review, re-derived them and corrected a few
([§13](docs/CONVENTIONS.md#13-changes-from-the-2026-10-06-audit)). Check anything you publish.

## For AI agents: 26 tools over MCP

NEXPLAN is also an MCP server: 26 tools on stdio that run the same code as the web app, so an agent (Claude Code,
Claude Desktop or another MCP client) gets the app's numbers. Load a structure once with `load_structure` and pass its
id to the other tools. Results are JSON with their units; a failure says what to change.

What an agent can ask:

| Question | Tools |
|---|---|
| What can this instrument measure, and where does it stop? Coverage, d and Q reach, resolution, Ei and \|Q\| limits, what NEXPLAN does not model for it. | `instrument_limits`; `configure_instrument` sets goniometer limits, masks and shadows for the session |
| How much of reciprocal space does it reach, and what is never measured? | `reciprocal_coverage` |
| Which instrument suits my goal (d range, Δd/d, line pairs to resolve, wanted reflections), and why not the others? | `compare_instruments` |
| Which goniometer settings record my reflections, and how complete is the plan? | `find_setting`, `simulate_setting`, `suggest_settings` (the TOPAZ planner), `simulate_plan` |
| How do I bin the volume in Mantid? | `suggest_binning` (the MDNorm call) |
| Reflections and absences, powder patterns, UB matrices, chopper resolution, units | `list_reflections`, `reflection_info`, `powder_pattern`, `instrument_powder_pattern`, `analyze_ub`, `mount_crystal`, `transform_ub`, `chopper_resolution`, `scattering_power`, `convert_units` and more |

Hand-offs to my other tools, written in their own formats:

- **MATERIA** (refinement): `instrument_parameters` writes a GSAS-II `.instprm` and MATERIA's JSON for a NOMAD bank
  or a POWGEN frame, with the d and TOF range it records.
- **NEBULA3D** and the **NeXus Viewer** (HKL volumes): `laue_symmetry` gives the operations in their `h,k,l; …` syntax
  and the viewer preset; `bragg_positions` the allowed, forbidden and satellite nodes on a volume's grid;
  `coverage_map` what a plan records on that grid, as a `.npy` array.

Register it with Claude Code. In this repository, run `npm install`; Claude Code reads `.mcp.json` and offers to
enable `nexplan`, which `npm run mcp` builds and starts:

```json
{ "mcpServers": { "nexplan": { "type": "stdio", "command": "npm", "args": ["run", "--silent", "mcp"] } } }
```

For other projects, build once and register the bundle:

```bash
npm run mcp:build
claude mcp add --scope user nexplan -- node /path/to/nexplan/dist-mcp/nexplan-mcp.mjs
```

The tools have the app's limits ([below](#limits)), and an agent can still misread a result. Setup, conventions and
examples: [docs/MCP.md](docs/MCP.md).

## Quick start

1. Load a CIF (or a demo structure). **Structure** and **Reflections** show what was read and every reflection
   with its structure factor.
2. Choose an instrument in the header, or a generic X-ray or neutron beam.
3. Single crystal: load a UB on **Orientation** (or keep the CIF cell with U = I). On **Single crystal**, type the
   reflections you need and press *Suggest settings* (TOPAZ), or set a rotation scan (CORELLI, ψ scans).
4. Powder: **Powder** shows the pattern of each focused bank; **Detectors** shows the rings on the panels.

The session is kept in the browser's storage, so a reload resumes it.

## What it does

| Instrument | What it computes |
|---|---|
| TOPAZ | Bragg spots on the panels at a goniometer setting. Finds a setting that centres a chosen reflection, or a set of settings that records the chosen reflections (greedy, with proven bounds: a starting plan, not an optimum). |
| CORELLI | Rotation or rocking scans, and completeness as the scan proceeds. |
| NOMAD, POWGEN | Bragg powder pattern of a focused bank (focused and divided by vanadium) or of a single panel, on TOF, d or Q, with measured peak widths (NOMAD: Δd/d per bank, 2014; POWGEN: ORNL's GSAS-II profiles). Warns when d_min cuts the bank's range; says whether two lines are resolved. |
| ARCS, SEQUOIA, CNCS | Elastic line only: powder rings and single-crystal ψ scans at a chosen Ei. The chopper setting sets the elastic width. |
| Generic beam | Reflection lists and powder patterns for X-rays or neutrons at one wavelength, or at one TOF bank. |

Also:

- Reflections with d, Q and complex F, folded into symmetry families, with absences flagged. Absent or weak
  reflections can still be simulated and planned.
- The mount: choose the scattering plane, (H K 0), (H H L) or any u and v, and without a UB file the crystal is
  oriented as Mantid's SetUB would (u along the beam, v horizontal); the Detectors page shows the plane at the sample,
  its tilt and the curve on the detectors where its reflections land.
- UB matrices in the ISAW format, read and written. A UB for a supercell or a smaller cell of the CIF cell (e.g.
  2 × 2 × 2) is recognised and written in the CIF cell; any UB can be re-indexed to another cell.
- Every detector pixel a reflection can reach over the goniometer range.
- The recorded HKL range along chosen axes, as Mantid MDNorm parameters (Mantid's default Q convention or the
  crystallographic one), with practical bins: a round step giving about 200–400 bins per axis, or one you choose, and
  energy steps of 1 % of Ei for chopper spectrometers (Mantid's default). The best bin depends on your counts: try a
  few.
- Detector masks (including Mantid mask files) and sample-environment shadows, used in every hit test.
- Scattering power relative to a reference material (V, diamond, Si, CeO₂, corundum).

## Limits

Geometry and relative Bragg intensities only: |F|² with Lorentz (and, for X-rays, polarization) factors.

- Not modelled: counting time, absolute intensity, detector efficiency, background, diffuse scattering, magnetic
  scattering, anomalous X-ray scattering, gaps between the tubes of a pack, and inelastic scattering (chopper
  spectrometers are simulated at the elastic line).
- Not applied to intensities: absorption, extinction, multiple scattering, preferred orientation. (The scattering
  power card estimates an attenuation length.)
- Detector positions are nominal: the Mantid instrument definition at a pinned commit, not a cycle's calibration.
  NOMAD banks are numbered 0–5, as in Mantid and the TOPAS files (GSAS files: 1–6); banks 0–4 use calibrated DIFC.
- Masks and shadows apply only as you set them; there are no defaults.
- Anisotropic ADPs enter as U_eq. Complex b are the 2200 m/s values.
- CIF 1.1 only. Ambiguous settings (origin choice, rhombohedral axes, monoclinic cell choice) are asked, not guessed.

## Checks

Tables are generated from pinned upstream files ([`data-sources/sources.json`](data-sources/sources.json)) and
tested (`npm test`):

- X-ray f0, Waasmaier & Kirfel (1995): 209 species cross-checked ([report](docs/data-verification/XRAY_WK1995.md)).
- Neutron b, Sears (1992): 324 rows cross-checked, 6 discrepant rows listed
  ([report](docs/data-verification/NEUTRON_SEARS1992.md)).
- Systematic absences equal gemmi's for all 564 space-group settings. Neutron F equals gemmi 0.7.3's to 1e-8,
  phases included.
- Constants, DIFC, TOF, E ↔ λ, the B matrix and goniometers follow Mantid
  ([report](docs/data-verification/MANTID_CONSISTENCY.md)).
- The energy resolution is a port of Mantid PyChop's model (`67c2f43`; ARCS and SEQUOIA parameters tuned to ORNL
  vanadium data, Mantid PR #38591), tested to reproduce its output to 1e-6.
- POWGEN peak widths (0.8 Å frame) are within 25 % of the LaB₆ widths in Huq et al., J. Appl. Cryst. 52, 1189
  (2019).
- Each correction from the 2026-10-06 review has a test that fails on the code before it.

## Key references

The full list is in [CONVENTIONS §12](docs/CONVENTIONS.md#12-references); each formula there cites its source.

- Busing & Levy, *Acta Cryst.* 22, 457 (1967): UB matrix and goniometer angles.
- *International Tables for Crystallography* Vols. A, B and C: space groups, structure factors, Lorentz–polarization.
- Waasmaier & Kirfel, *Acta Cryst.* A51, 416 (1995); Sears, *Neutron News* 3(3), 26 (1992).
- Von Dreele, Jorgensen & Windsor, *J. Appl. Cryst.* 15, 581 (1982), and GSAS-II (Toby & Von Dreele, *J. Appl.
  Cryst.* 46, 544 (2013)): TOF positions, Lorentz factor and peak shapes.
- Mantid (Arnold et al., *Nucl. Instrum. Methods* A764, 156 (2014)) at `67c2f43`: instrument definitions, units,
  goniometers, ISAW files, PyChop.
- Nemhauser, Wolsey & Fisher, *Math. Program.* 14, 265 (1978); Johnson, *J. Comput. Syst. Sci.* 9, 256 (1974): the
  planner's greedy bounds.

## Related tools

The facility tools cover measured data and much that NEXPLAN does not:

- [NeuXtalViz](https://github.com/neutrons/NeuXtalViz-tools): single-crystal UB, reduction, slicing and experiment
  planning (TOPAZ, CORELLI, MANDI and others).
- [Mantid](https://www.mantidproject.org/): DGS Planner for inelastic Q–E coverage on chopper spectrometers; PyChop
  for their resolution and flux; PredictPeaks and InstrumentView.
- [ADDIE](https://github.com/neutrons/addie): total-scattering reduction for NOMAD, S(Q) and G(r).

## Develop

```bash
npm install
npm run data:fetch   # download the pinned sources and check their SHA-256
npm run dev          # http://localhost:5173/nexplan/
npm test             # tests that read the pinned sources are skipped until data:fetch has run
npm run typecheck
npm run data:build   # regenerate src/data/*.json and the reports
npm run mcp:build    # the MCP server, dist-mcp/nexplan-mcp.mjs (npm run mcp builds and starts it on stdio)
```

```text
src/core/   science, no UI: symmetry, structure, reflections, powder and TOF, UB, goniometers, instruments
src/io/     CIF 1.1 reader, ISAW UB files
src/ui/     pages and cards (React); src/views/ 3D views; src/workers/ the calculation worker
src/agent/  the features as agent tools; src/mcp/ the MCP server that serves them
src/data/   generated tables; src/materia/ the pinned MATERIA copy
scripts/    fetch and cross-check the pinned sources; generate tables and reports
docs/       CONVENTIONS (formulas and references), PLAN, MCP (agent tools), data-verification reports
```

The gemmi references are committed; regenerate them with
`uv run --no-project --with gemmi==0.7.3 python scripts/data/gen_space_groups.py` (and `gen_reference_sf.py`).
`src/materia/` is copied from MATERIA (`drthyang/web-refinement`) at a pinned commit: fix it upstream, then
`npm run materia:sync`.

## Credits

- Mantid (commit `67c2f43`): detector geometry extracted from its instrument definitions (numbers only), and the
  chopper-spectrometer resolution, ported from PyChop.
- NeuXtalViz (Morgan et al., arXiv:2606.25414): *Find a setting* follows the stepped sweep of its "individual peak"
  planner (NEXPLAN's own implementation).
- Data: Sears (1992) neutron scattering lengths, via the NIST Center for Neutron Research; Waasmaier & Kirfel (1995)
  form factors, via DABAX (ESRF); space-group tables generated with gemmi; ORNL's NOMAD and POWGEN instrument files;
  demo and reference structures from the Crystallography Open Database (Gražulis et al. 2009, 2012).

The notices these licences require, and what each part is used for, are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[AGPL-3.0-only](LICENSE), the same as MATERIA, whose code it includes. © 2026 Tsung-Han Yang. Parts derived from
other projects keep their licences: `src/core/instrument/pychop.ts` (from Mantid PyChop) is GPL-3.0-or-later; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
