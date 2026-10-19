# Development

```bash
npm install
npm run data:fetch   # download the pinned sources and check their SHA-256
npm run dev          # http://localhost:5173/nexplan/
npm test             # tests that read the pinned sources are skipped until data:fetch has run
npm run typecheck
npm run build        # the static site, dist/
npm run data:build   # regenerate src/data/*.json and the reports
npm run mcp:build    # the MCP server, dist-mcp/nexplan-mcp.mjs (npm run mcp builds and starts it on stdio)
```

Node 22.18 or later.

## Layout

```text
src/core/   science, no UI: symmetry, structure, reflections, powder and TOF, UB, goniometers, instruments
src/io/     CIF 1.1 reader, ISAW UB files, .npy and GSAS-II .instprm writers
src/ui/     pages and cards (React); src/views/ 3D views; src/workers/ the calculation worker
src/agent/  the features as agent tools; src/mcp/ the MCP server that serves them
src/data/   generated tables; src/materia/ the pinned MATERIA copy
scripts/    fetch and cross-check the pinned sources; generate tables and reports
docs/       guide, limitations, validation, conventions, MCP, plan, data-verification reports
```

## Pinned sources

The gemmi references are committed; regenerate them with
`uv run --no-project --with gemmi==0.7.3 python scripts/data/gen_space_groups.py` (and `gen_reference_sf.py`).
`src/materia/` is copied from MATERIA (`drthyang/materia-platform`, formerly `web-refinement`) at a pinned commit: fix it upstream, then
`npm run materia:sync`. CI fetches the pinned sources, runs the tests, checks the MATERIA copy and the generated
tables (`npm run materia:check`, `npm run data:check`), and builds the site and the MCP server.
