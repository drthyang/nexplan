# NEXPLAN · Neutron Experiment Planner

My personal toolkit for planning neutron diffraction experiments at the SNS, from a crystal structure to instrument
settings: **https://drthyang.github.io/nexplan/** (runs in the browser; files are not uploaded).

## What it does

- Reflections and structure factors from a CIF, for X-rays or neutrons, with absences explained.
- Powder patterns for a generic beam, for NOMAD and POWGEN focused banks with measured peak widths, and at the elastic
  line of ARCS, SEQUOIA and CNCS.
- Single-crystal plans for TOPAZ and CORELLI: reflections on the detectors, goniometer settings for chosen
  reflections, scan completeness, and Mantid MDNorm binning.
- UB matrices (ISAW): read, written, matched to the CIF cell (supercells included) and re-indexed, or set from the
  scattering plane as Mantid's SetUB does.
- Detector masks and sample-environment shadows, used in every hit test.

## Quick start

Open the link, load a CIF (or a demo structure) and choose an instrument in the header. For a single crystal, load a
UB on **Orientation** and plan on **Single crystal**; for a powder, see **Powder**. More in the [guide](docs/GUIDE.md).

## Agent tools

The same calculations are 26 MCP tools on stdio, for Claude Code or another MCP client: instrument limits,
reciprocal-space coverage, choosing an instrument for a goal, settings, plans and binning, and input files for
MATERIA, NEBULA3D and the NeXus Viewer. In this repository, run `npm install` and Claude Code finds the server in
`.mcp.json`. The tools and their setup: [docs/MCP.md](docs/MCP.md).

## Status

Work in progress. It plans geometry and relative Bragg intensities only, with nominal detector positions, and it is
not an ORNL or SNS facility tool. The scattering tables are not yet checked against the printed sources: check
anything you publish.

## Docs

- [Guide](docs/GUIDE.md): the pages, what each instrument computes, related tools.
- [Agent tools](docs/MCP.md): the 26 MCP tools and how to register them.
- [Limitations](docs/LIMITATIONS.md): what is not modelled.
- [Validation](docs/VALIDATION.md): what the numbers are checked against.
- [Conventions](docs/CONVENTIONS.md): formulas, units and references.
- [Development](docs/DEVELOPMENT.md): build, test and code layout.
- [Plan](docs/PLAN.md): the scientific plan and progress.
- [Third-party notices](THIRD_PARTY_NOTICES.md): licences, data sources and credits.

## License

[AGPL-3.0-only](LICENSE). © 2026 Tsung-Han Yang. `src/core/instrument/pychop.ts`, ported from Mantid PyChop, is
GPL-3.0-or-later; see the [third-party notices](THIRD_PARTY_NOTICES.md).

*This project is personal work, developed and maintained in my personal capacity.*
