/**
 * NEXPLAN's agent tools: the registry, a validated call, and the tools as JSON Schema definitions for any
 * tool-use API (Anthropic `tools`, OpenAI-style function calling). src/mcp/server.ts serves the same registry.
 */
import { z } from "zod";
import { ToolError, type AgentTool, type ToolContext } from "./tool.ts";
import { findSetting, simulatePlan, simulateSetting, suggestBinningTool, suggestSettingsTool } from "./tools/crystal.ts";
import { chopperResolution, configureInstrument, listInstruments } from "./tools/instruments.ts";
import { compareInstruments, instrumentLimits, reciprocalCoverage } from "./tools/limits.ts";
import { convertUnits, scatteringPowerTool } from "./tools/materials.ts";
import { analyzeUB, mountCrystal, transformUBTool } from "./tools/orientation.ts";
import { instrumentPowderPattern, powderPattern } from "./tools/powder.ts";
import { instrumentParameters } from "./tools/refinement.ts";
import { describeStructure, listReflections, loadStructure, reflectionInfo } from "./tools/structure.ts";
import { braggPositions, coverageMap, laueSymmetry } from "./tools/volumes.ts";

export { ToolError, toJson, type AgentTool, type ToolContext } from "./tool.ts";
export { Workspace } from "./workspace.ts";

/** Every tool, in the order a session usually needs them. */
export const NEXPLAN_TOOLS: readonly AgentTool[] = [
  loadStructure,
  describeStructure,
  listReflections,
  reflectionInfo,
  powderPattern,
  listInstruments,
  configureInstrument,
  instrumentLimits,
  compareInstruments,
  reciprocalCoverage,
  instrumentPowderPattern,
  instrumentParameters,
  analyzeUB,
  mountCrystal,
  transformUBTool,
  simulateSetting,
  findSetting,
  simulatePlan,
  suggestSettingsTool,
  suggestBinningTool,
  laueSymmetry,
  braggPositions,
  coverageMap,
  chopperResolution,
  scatteringPowerTool,
  convertUnits,
] as unknown as readonly AgentTool[];

/** How to use the tools, for a client's system prompt (MCP `instructions`). */
export const NEXPLAN_INSTRUCTIONS = `NEXPLAN plans neutron (and X-ray) diffraction experiments, mainly at the SNS (TOPAZ, CORELLI, NOMAD, POWGEN, ARCS, SEQUOIA, CNCS), from a crystal structure.

Workflow: load_structure (a CIF path, CIF text or a bundled structure) returns a structure_id that the other tools take. If it answers 'needs_choice', call it again with the structure_id and the block, setting or species it asks for.
- Reflections: list_reflections, reflection_info (absences explained).
- Powder: powder_pattern (generic X-ray or neutron beam, CW or one TOF bank); instrument_powder_pattern (NOMAD and POWGEN focused banks with measured widths; ARCS, SEQUOIA, CNCS elastic 2θ pattern).
- Single crystal: the orientation is a UB (orientation.ub, ub_path or ub_text; analyze_ub checks it against the structure, transform_ub re-indexes it) or a mount u, v (mount_crystal; Mantid SetUB). Then simulate_setting (one setting), find_setting (bring an hkl onto a detector), simulate_plan (orientation list or rotation scan: completeness, redundancy, wanted reflections), suggest_settings (TOPAZ planner), suggest_binning (Mantid MDNorm limits).
- configure_instrument sets an instrument's goniometer limits, detector masks and sample-environment shadows for the session; every other tool on it then uses them.
- Instrument limits: instrument_limits (coverage, d and Q reach, resolution, Ei and |Q| limits, what is not modelled), reciprocal_coverage (fraction of reciprocal space a goniometer or plan reaches), compare_instruments (which instruments suit a goal, and why not).
- Refinement (MATERIA, GSAS-II): instrument_parameters (.instprm and MATERIA JSON for a NOMAD bank or POWGEN frame, with its d range).
- Volumes (NeXus Viewer, NEBULA3D, Mantid MDNorm output): laue_symmetry (hkl operations to average with, viewer preset, grid check), bragg_positions (allowed, forbidden and satellite nodes on a grid), coverage_map (what a plan records on the grid, as .npy).
- Instruments and beams: list_instruments, chopper_resolution (PyChop port), convert_units; scattering_power compares a material with a reference.

Conventions: Mantid's frame (beam +z, up +y); q = UB·h in 1/Å without 2π (NEBULA3D's in-memory UB is 2π times it; analyze_ub gives both), Q = 2π/d; volume grids say whether their indices follow Mantid's default Q convention (inelastic, h labelled −h) or the crystallographic one; angles in degrees; times of flight in µs; |F| in fm for neutrons and electrons for X-rays. Goniometer angles are given per axis in order or by name (omega, chi, phi, psi). Reflections are calculated down to d_min (default 0.8 Å); results say when the detectors reach further.

Limits: geometry and relative Bragg intensities only (|F|² with Lorentz and polarization factors). Not modelled: counting time, absolute intensity, detector efficiency, background, absorption and extinction corrections, diffuse, magnetic and inelastic scattering. Detector positions are nominal (Mantid instrument definitions at a pinned commit). A plan from suggest_settings is a starting point, not an optimum. Check anything you publish.`;

export type ToolResult = { readonly ok: true; readonly value: object } | { readonly ok: false; readonly error: string; readonly details?: Readonly<Record<string, unknown>> };

/** Validates the arguments and runs the tool; a failure comes back as a message the caller can act on, not a throw. */
export async function runTool(tool: AgentTool, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: `Invalid arguments for ${tool.name}:\n${z.prettifyError(parsed.error)}` };
  try {
    return { ok: true, value: await tool.run(parsed.data, ctx) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, error: e.message, ...(e.details ? { details: e.details } : {}) };
    return { ok: false, error: `${tool.name} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Runs a tool by name. */
export function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = NEXPLAN_TOOLS.find((t) => t.name === name);
  if (!tool) return Promise.resolve({ ok: false, error: `No tool '${name}'. Tools: ${NEXPLAN_TOOLS.map((t) => t.name).join(", ")}.` });
  return runTool(tool, args, ctx);
}

/** The tools as JSON Schema (draft 7) definitions: `{ name, description, input_schema }`, the Anthropic Messages API shape. */
export function toolDefinitions(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return NEXPLAN_TOOLS.map((t) => {
    const { $schema: _schema, ...input_schema } = z.toJSONSchema(t.input, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    return { name: t.name, description: t.description, input_schema };
  });
}
