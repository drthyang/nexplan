# Agent tools and the MCP server

NEXPLAN's calculations are also available as tools for AI agents. The tools are in `src/agent/`. `src/mcp/` serves
them as a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio, so Claude Code, Claude Desktop or
any other MCP client can use them. An agent can load a CIF, list and explain reflections, simulate powder patterns,
plan a TOPAZ or CORELLI measurement, get MDNorm binning, and say what each instrument can and cannot measure, all by
calling tools. Some tools also produce inputs for MATERIA, NEBULA3D and the NeXus Viewer, in their own formats
([below](#with-materia-nebula3d-and-the-nexus-viewer)).

The tools call the same code as the web app (`src/core/`, `src/app/compute.ts`, and the pages' state functions in
`src/ui/experimentState.ts` and `src/ui/ubShared.ts`), so for the same choices they give the app's numbers. The
3D views, detector maps and reciprocal slices stay in the web app.

## Setup

Install the dependencies first: `npm install`.

**Claude Code, in this repository.** `.mcp.json` registers the server as `nexplan`; Claude Code asks once whether to
enable it. It runs `npm run --silent mcp`, which builds `dist-mcp/nexplan-mcp.mjs` (under a second) and starts it.
The build is fresh each time, so the server always matches the code.

**Claude Code, in another project.** Build once, then register the bundle for every project:

```bash
npm run mcp:build
claude mcp add --scope user nexplan -- node /path/to/nexplan/dist-mcp/nexplan-mcp.mjs
```

Run `npm run mcp:build` again after updating NEXPLAN.

**Claude Desktop and other clients.** Point the client at the bundle (after `npm run mcp:build`), e.g. in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nexplan": { "command": "node", "args": ["/path/to/nexplan/dist-mcp/nexplan-mcp.mjs"] }
  }
}
```

The bundle needs Node 22.18 or later and the repository's `node_modules` (the MCP SDK and zod are not inlined).

## Tools

| Tool | What it does | In the web app |
| --- | --- | --- |
| `load_structure` | Reads a CIF (a path, text, or a bundled structure) and returns its id, cell, space group and sites. When the CIF is ambiguous (several blocks, a setting, species), it answers `needs_choice` with the candidates. | Structure |
| `describe_structure` | Symmetry operations, each site's neutron b and cross-sections, X-ray f0 and ions; without an id, the structures loaded. | Structure |
| `list_reflections` | d, Q, 2θ, complex F and \|F\|², folded into families or signed, absences on request; CSV. | Reflections |
| `reflection_info` | One hkl: F, rank, family, and why it is absent (systematic, accidental, below d_min). | Reflections |
| `powder_pattern` | Generic beam: X-ray or neutron CW, or one neutron TOF bank; peaks and profile. | Powder |
| `list_instruments` | The SNS instruments: goniometers, bands or Ei, choppers, banks, frames, panels. | Instrument menu |
| `configure_instrument` | Sets an instrument's goniometer limits, detector masks and sample-environment shadows for the session; the other tools use them. | Detectors: masks and shadows |
| `instrument_limits` | What one instrument can and cannot record: solid angle, 2θ and vertical coverage, d and Q reach, resolution, Ei and kinematic \|Q\| limits, and what NEXPLAN does not model for it. | — |
| `reciprocal_coverage` | The fraction of reciprocal space a goniometer (or a plan) reaches, per \|Q\| shell, and the blind cone about a single rotation axis. Independent of the crystal. | — |
| `compare_instruments` | Which instruments suit a goal (d range, Δd/d, line pairs to resolve, wanted reflections), and why the others do not. | — |
| `instrument_powder_pattern` | NOMAD and POWGEN focused banks with measured widths; resolved lines; sharpest bank or frame; ARCS, SEQUOIA, CNCS elastic 2θ pattern; any instrument's single panel. | Powder (instrument) |
| `analyze_ub` | A UB's lattice, U, the directions along the beam and vertical; the structure's cells it fits (supercell, smaller cell, other setting). | Orientation |
| `mount_crystal` | UB from a scattering plane (u, v), as Mantid SetUB; the plane's tilt at a setting. | Orientation: mount |
| `transform_ub` | Re-indexes a UB to a supercell, smaller cell, primitive cell or any P; ISAW file and TransformHKL call. | Orientation: re-index |
| `simulate_setting` | Reflections on the detectors at one goniometer setting (λ, 2θ, panel, pixel, TOF); why a given hkl is missed. | Single crystal, Detectors |
| `find_setting` | Angles that bring an hkl to the middle of a panel at mid band, and how much of the goniometer range records it. | Single crystal: Find a setting |
| `simulate_plan` | Orientation list or rotation scan: per-step completeness, 90 % point, redundancy, wanted reflections; CSV. | Single crystal |
| `suggest_settings` | TOPAZ's planner: greedy coverage or fewest settings for the wanted reflections. | Single crystal: Suggest settings |
| `suggest_binning` | Recorded HKL range as Mantid MDNorm binning (energy axis for chopper spectrometers). | Binning |
| `instrument_parameters` | GSAS-II `.instprm` and MATERIA JSON for a NOMAD bank or POWGEN frame, with the d and TOF range it records. | — |
| `laue_symmetry` | The Laue group as hkl operations, the NeXus Viewer preset it equals, centring conditions; checks a volume grid against it. | — |
| `bragg_positions` | Allowed, forbidden and satellite nodes on a volume's grid, with grid coordinates and voxels. | — |
| `coverage_map` | What a plan records on a volume's grid, as a NumPy `.npy` count or mask array. | Single crystal: slice coverage |
| `chopper_resolution` | ARCS, SEQUOIA, CNCS energy resolution (PyChop port) at Ei and transfers, per frequency. | Chopper controls |
| `scattering_power` | Σ_coh, Σ_inc, Σ_abs, attenuation length and Bragg strength against a reference material. | Scattering power |
| `convert_units` | Energy, wavelength, velocity, d, Q, 2θ, TOF and DIFC. | Energy ↔ λ |

The server also gives `docs/CONVENTIONS.md` as the resource `nexplan://docs/conventions`, and its `instructions`
(`NEXPLAN_INSTRUCTIONS` in `src/agent/index.ts`) tell the client how the tools fit together.

## How the tools work

- **A session.** `load_structure` keeps the structure in the server's workspace and returns its id (from the file
  name, or `name`); the other tools take `structure_id`. Calculations are cached per structure and settings.
- **d_min.** Reflections are calculated down to `d_min` (default 0.8 Å, as in the app). The single-crystal and
  instrument powder tools say when the detectors reach shorter d and which d_min to pass.
- **Orientation.** Single-crystal tools take `orientation`: a UB (`ub` as rows, `ub_path` or `ub_text` of an ISAW
  file), read in the CIF cell when it is the same lattice in another setting, a supercell or a smaller cell; or a
  mount `u`, `v` (Mantid SetUB); or nothing (U = I with the CIF cell).
- **Instrument.** `instrument` with the optional `lambda_min`, `lambda_max`, `frame` (POWGEN), `ei_mev`, `chopper`,
  `chopper_frequency` and `elastic_fwhm`. Goniometer limits, masks (edge pixels, panels off, detector IDs, a Mantid
  mask file) and shadows (sample-environment openings, sectors and boxes) are set once per instrument with
  `configure_instrument`, as the web app's Detectors page sets them for every page; results say when they apply. These
  are the app's own state functions, so they are validated the same way.
- **Arguments.** Unknown arguments are refused, not ignored, so a misspelt field is an error.
- **Angles.** Per axis in order (`[30, 135, 60]`) or by name (`{"omega": 30, "phi": 60}`); fixed axes keep their
  value.
- **Files.** Inputs (CIF, ISAW UB, Mantid mask XML) are read from the local disk, up to 20 MB. `output_path` writes
  CSV, JSON, ISAW, `.instprm` or `.npy` files and overwrites an existing file. Relative paths start from the directory the client started the
  server in; `~` is the home directory.
- **Results.** JSON, numbers to 7 significant figures, with the units stated. A failure is an MCP tool error whose
  text says what to change, followed by the details (candidates, ids loaded) as JSON.

Conventions are the app's: Mantid's frame (beam +z, up +y), q = UB·h in 1/Å without 2π, Q = 2π/d, angles in
degrees, TOF in µs, |F| in fm (neutrons) or electrons (X-rays).

## Instrument limits

`instrument_limits` answers "what can this instrument do, and where does it stop?" for one instrument with its band,
Ei, chopper, masks and shadows. It reports the detector coverage (the solid angle from ray casts, so overlapping
panels count once; 2θ, horizontal and vertical ranges), the d and Q reach, the resolution NEXPLAN has for it (NOMAD's
measured Δd/d per bank, POWGEN's GSAS-II profiles per frame, PyChop energy widths), the goniometer, the kinematic
|Q| limits of a chopper spectrometer at energy transfers, and a `not_modelled` list (nominal geometry, no flux,
CORELLI's correlation chopper, NOMAD bank 5's nominal geometry, and so on).

`reciprocal_coverage` measures how much of reciprocal space a single-crystal instrument reaches in |Q| shells, either
with its free axes swept over their ranges or for a plan. The estimate does not depend on the crystal or its
orientation. It samples directions evenly in each shell. White-beam instruments use a 0.1° table of the recording
detector directions (within 2.5 % of exact ray casts, the difference at panel edges); chopper spectrometers use exact
Bragg crossings. With one rotation axis it gives how far out of the plane perpendicular to that axis q is reached,
i.e. the blind cone about the axis.

`compare_instruments` checks every instrument that takes the sample against a goal and gives a verdict with reasons:
the d range (and the Ei a chopper spectrometer needs to reach d_min), the Δd/d needed or the line pairs to resolve
(powder), and the fraction of reciprocal space reached and the wanted reflections recordable (single crystal). A
chopper spectrometer's energy width gives only a lower bound on Δd/d, so it can fail a resolution check but never
pass one. Flux and counting time are not compared.

## With MATERIA, NEBULA3D and the NeXus Viewer

Each of these apps reads files and can run tools, so the simplest link is through files. Register NEXPLAN's server
next to the app's own, have the agent call NEXPLAN's tools with `output_path`, then load the files in the app.
MATERIA has its own MCP server, and a Claude Code session can use both, e.g. NEXPLAN's entry from `.mcp.json` next
to MATERIA's. Refs do not cross servers, so the tools write self-contained files in each app's own format.

**MATERIA (powder refinement).**

- `instrument_parameters` writes the `.instprm` that MATERIA's `parse_instrument {path}` reads, and returns the same
  values as MATERIA's `InstrumentParameters` JSON. For POWGEN frames it uses ORNL's published GSAS-II profiles; for
  NOMAD banks it gives the calibrated DIFC and a Gaussian width from the measured Δd/d but no exponential terms:
  MATERIA's powder page starts them from its defaults (α 1.5, β₀ 0.02); GSAS-II needs them added, or ORNL's own file.
- Its `d_range` and `tof_range_us` give the fit range.
- `instrument_powder_pattern` lists the lines a bank records, with their FWHM and which are resolved.
- `compare_instruments` and `instrument_limits` say which bank or frame to refine.

**NeXus Viewer (reduced HKL volumes).**

- `laue_symmetry` gives the Laue class, the preset it equals (e.g. `6/mmm`) or, when no preset matches in the
  file's setting, the full operation list for the symmetry field.
- `bragg_positions` marks allowed and forbidden nodes inside the volume's grid, to tell superlattice peaks and λ/2
  or multiple-scattering spots from diffuse scattering.
- `coverage_map` predicts the measured region, which explains coverage wedges and detector-edge rims.
- `powder_pattern` with `axis: "q"` gives the powder lines for the I(Q) view.

**NEBULA3D (3D-ΔPDF).**

- `laue_symmetry`'s `symmetry_ops` is the triplet string `PipelineParams.symmetry` and the `/entry@symmetry_ops`
  attribute take. With a grid it also checks the condition `GridSymmetry.for_volume` imposes: equal bins on mixed
  axes, symmetric ranges, and a bin at 0 for hexagonal operations.
- `bragg_positions` (JSON) is a node prior for the Bragg punch: forbidden nodes that hold intensity, and satellites
  from propagation vectors.
- `coverage_map` with `array_order: "hkl"` and `values: "mask"` gives a measured-region mask on the
  `(nh, nk, nl)` grid, which separates unmeasured from punched space for the backfill and the ΔPDF support.
- `suggest_binning` suggests the grid.

**Conventions to keep straight.**

- **UB.** Mantid and ISAW files store q = UB·h without 2π; NEBULA3D's in-memory and HDF5 `ub_matrix` is 2π times
  that. `analyze_ub` and `mount_crystal` return both (`ub`, `ub_times_2pi`).
- **Q convention.** Volume grids take `q_convention`. The default, `inelastic`, is Mantid's default
  `Q.convention`, which labels NEXPLAN's (h k l) as (−h −k −l); `crystallography` is for X-ray reductions and data
  reduced with that setting. `bragg_positions` gives both NEXPLAN's hkl and the file's grid coordinates.
- **Array order.** `coverage_map` writes Mantid's MDHisto order `(n2, n1, n0)` by default (as the NeXus Viewer
  stores it) or `(n0, n1, n2)` with `array_order: "hkl"` (NEBULA3D). Large grids are computed on every n-th voxel
  and written at full size by nearest neighbour; the result says which.

## Examples

Things to ask an agent with the server enabled:

- "Load `~/samples/spinel.cif`. Which (h 0 0) reflections are forbidden, and why?"
- "With the UB in `~/topaz/spinel.mat`, plan a TOPAZ cryogenic run that places (2 2 0), (4 4 4) and (5 3 1) well in as
  few settings as possible, then show the completeness of that list."
- "Which NOMAD bank separates (5 1 1)/(3 3 3) from (4 4 0) best?"
- "My crystal is mounted in (H H L) on CORELLI. Give me MDNorm binning for a 0–357° scan in 3° steps."
- "Compare the scattering power of this sample with vanadium, and tell me how thick it can be."
- "Which SNS instruments can resolve (5 1 1)/(3 3 3) from (4 4 0) down to d = 0.5 Å? Why not the others?"
- "How much of reciprocal space does CNCS reach at 12 meV with ψ from −90° to 90°, and what is never measured?"
- "Write the GSAS-II parameters for POWGEN's 1.5 Å frame to `refine/pg15.instprm` for MATERIA."
- "My CORELLI volume is `[H,0,0]`, `[0,K,0]`, `[0,0,L]` binned -10.05,0.1,10.05 on each axis. Give me the Laue
  operations for NEBULA3D, the forbidden nodes inside it, and a coverage mask for my 0–357° scan."

## Using the tools from code

`src/agent/index.ts` exports the registry without a transport:

- `NEXPLAN_TOOLS`: each tool's `name`, `description`, zod `input` schema and `run`.
- `toolDefinitions()`: `{ name, description, input_schema }` with JSON Schema (draft 7), the shape of the Claude
  Messages API `tools` parameter.
- `callTool(name, input, { workspace })`: validates the input and runs the tool; it returns `{ ok: true, value }` or
  `{ ok: false, error, details }` and never throws for a tool failure.

The modules use Vite's conventions (the `@materia` alias, `?raw` imports), so run them through Vite: Vitest, or a
Vite build like `vite.mcp.config.ts`.

To add a tool: write it with `defineTool` in `src/agent/tools/`, add it to `NEXPLAN_TOOLS`, and test it in
`src/agent/agent.test.ts`. `src/mcp/server.test.ts` checks that the server lists every tool.

## Limits

The tools have the app's limits (see the README). They give geometry and relative Bragg intensities only. They do
not model counting time, absolute intensity, detector efficiency, background, absorption and extinction corrections,
or diffuse, magnetic or inelastic scattering. Detector positions are nominal. A plan from `suggest_settings` is a
starting point, not an optimum. An agent can still misread a result, so check what you publish against the formulas
in [CONVENTIONS](CONVENTIONS.md).
