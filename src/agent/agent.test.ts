import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vec3 } from "@materia/core/math/types";
import { afterAll, describe, expect, it } from "vitest";
import { energyResolution } from "../core/instrument/pychop.ts";
import { observeAt, pointCoverage, scanSettings } from "../core/instrument/simulate.ts";
import { goniometerMatrix } from "../core/ub/goniometer.ts";
import { SNS_CATALOG } from "../core/ub/instrumentCatalog.ts";
import { SNS_INSTRUMENTS } from "../core/ub/instrumentsSns.ts";
import { presentReflections } from "../ui/ubShared.ts";
import { callTool, NEXPLAN_TOOLS, toJson, toolDefinitions, Workspace } from "./index.ts";

const cif = (name: string) => readFileSync(new URL(`../../fixtures/cif/${name}`, import.meta.url), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "nexplan-agent-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** One session for the whole file, as an MCP client has. */
const ctx = { workspace: new Workspace() };

/** Calls a tool and returns its value, failing the test with the tool's message if it fails. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok(name: string, args: object): Promise<any> {
  const r = await callTool(name, args, ctx);
  if (!r.ok) throw new Error(`${name}: ${r.error} ${toJson(r.details ?? {})}`);
  return JSON.parse(toJson(r.value));
}

async function fails(name: string, args: object): Promise<string> {
  const r = await callTool(name, args, ctx);
  if (r.ok) throw new Error(`${name} should have failed`);
  return r.error;
}

describe("the tool definitions", () => {
  it("have unique names, descriptions and object input schemas usable as Anthropic tool definitions", () => {
    const defs = toolDefinitions();
    expect(defs.length).toBe(NEXPLAN_TOOLS.length);
    expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
    for (const d of defs) {
      expect(d.name).toMatch(/^[a-z_]{3,64}$/);
      expect(d.description.length).toBeGreaterThan(80);
      expect(d.input_schema.type).toBe("object");
      expect(d.input_schema).not.toHaveProperty("$schema");
    }
  });

  it("reject bad arguments with the field at fault", async () => {
    const msg = await fails("reflection_info", { structure_id: "si", hkl: [1, 1] });
    expect(msg).toMatch(/Invalid arguments for reflection_info/);
    expect(msg).toMatch(/hkl/);
    expect(await fails("no_such_tool", {})).toMatch(/No tool 'no_such_tool'/);
  });
});

describe("structures and reflections", () => {
  it("loads a bundled structure under its id", async () => {
    const r = await ok("load_structure", { bundled: "si" });
    expect(r.status).toBe("ok");
    expect(r.structure_id).toBe("si");
    expect(r.cell.a).toBeCloseTo(5.43096, 5);
    expect(r.space_group.number).toBe(227);
    expect(r.cell_content).toEqual({ Si: 8 });
  });

  it("asks for the data block when a file has several, then reads the one chosen", async () => {
    const path = join(tmp, "two-blocks.cif");
    await import("node:fs").then((fs) => fs.writeFileSync(path, cif("cod-2104737.cif") + "\n" + cif("cod-1000041.cif")));
    const r = await ok("load_structure", { path, name: "two" });
    expect(r.status).toBe("needs_choice");
    expect(r.blocks.map((b: { name: string }) => b.name)).toEqual(["2104737", "1000041"]);
    const chosen = await ok("load_structure", { structure_id: r.structure_id, block: "1000041" });
    expect(chosen.status).toBe("ok");
    expect(chosen.cell_content).toEqual({ "Na1+": 4, "Cl1-": 4 });
  });

  it("names an unknown structure and the ones loaded", async () => {
    expect(await fails("list_reflections", { structure_id: "nope" })).toMatch(/No structure 'nope'. Loaded: si/);
  });

  it("explains a systematic absence and a present reflection with its family", async () => {
    const absent = await ok("reflection_info", { structure_id: "si", hkl: [2, 0, 0] });
    expect(absent.status).toBe("systematic absence");
    expect(absent.f2).toBe(0);
    expect(absent.message).toMatch(/forbidden/);
    const present = await ok("reflection_info", { structure_id: "si", hkl: [1, 1, 1] });
    expect(present.status).toBe("present");
    expect(present.family.multiplicity).toBe(8);
    expect(present.d).toBeCloseTo(5.43096 / Math.sqrt(3), 6);
  });

  it("lists families, or every signed hkl, and writes the CSV", async () => {
    const folded = await ok("list_reflections", { structure_id: "si", limit: 5000 });
    const signed = await ok("list_reflections", { structure_id: "si", fold: false, limit: 5000, output_path: join(tmp, "si.csv") });
    expect(signed.total).toBe(folded.reflections.reduce((n: number, r: { multiplicity: number }) => n + r.multiplicity, 0));
    expect(folded.reflections[0].hkl).toEqual([1, 1, 1]);
    expect(readFileSync(signed.written, "utf8").split("\n").filter((l) => /^-?\d/.test(l)).length).toBe(signed.total);
  });
});

describe("powder patterns", () => {
  it("puts Si (111) at 2θ = 28.44° for Cu Kα1 X-rays", async () => {
    const r = await ok("powder_pattern", { structure_id: "si", radiation: "xray", wavelength: 1.5406, limit: 1 });
    expect(r.peaks[0].hkl).toBe("(1 1 1)");
    expect(r.peaks[0].two_theta).toBeCloseTo(28.443, 2);
  });

  it("models NOMAD's focused banks: the bank nearest 90° by default, its measured width, TOF on its DIFC", async () => {
    const r = await ok("instrument_powder_pattern", { structure_id: "si", instrument: "nomad" });
    expect(r.banks).toHaveLength(6);
    const bank = r.banks.find((b: { selected?: boolean }) => b.selected);
    expect(bank.name).toBe("Bank 2");
    expect(r.peak_width).toMatch(/0\.0137/);
    for (const p of r.peaks) expect(p.tof).toBeCloseTo(bank.difc * p.d, 0);
    expect(r.peaks.every((p: { fwhm_percent: number }) => Math.abs(p.fwhm_percent - 1.37) < 1e-6)).toBe(true);
  });

  it("refuses a band on a chopper spectrometer and a frame POWGEN does not have", async () => {
    expect(await fails("instrument_powder_pattern", { structure_id: "si", instrument: "arcs", lambda_min: 1 })).toMatch(/ei_mev/);
    expect(await fails("instrument_powder_pattern", { structure_id: "si", instrument: "powgen", frame: 1.2 })).toMatch(/0\.8 Å/);
  });
});

describe("single crystals", () => {
  it("records at a setting exactly what observeAt does (the pages' test)", async () => {
    const r = await ok("simulate_setting", { structure_id: "si", instrument: "corelli", angles: [37], limit: 2000 });
    const corelli = SNS_INSTRUMENTS.find((i) => i.id === "corelli")!;
    const calc = await ctx.workspace.calculate("si", { radiation: "neutron", wavelength: 1.5, dMin: 0.8 });
    const B = 1 / 5.43096;
    const UB = [
      [B, 0, 0],
      [0, B, 0],
      [0, 0, B],
    ] as const;
    const pts = presentReflections(calc).map((p) => ({ h: p.h as Vec3, family: p.family }));
    const direct = observeAt(goniometerMatrix(corelli.goniometer, [37]), UB as never, pts, corelli.detectors!, corelli.lambdaMin, corelli.lambdaMax);
    expect(r.on_detectors).toBe(direct.length);
    expect(r.on_detectors).toBeGreaterThan(0);
  });

  it("finds a setting that records the reflection there, on the panel it names", async () => {
    const found = await ok("find_setting", { structure_id: "si", instrument: "topaz-ambient", hkl: [2, 2, 0] });
    expect(found.found).toBe(true);
    const at = await ok("simulate_setting", { structure_id: "si", instrument: "topaz-ambient", angles: found.best.angles, hkl: [[2, 2, 0]], limit: 1 });
    expect(at.checked[0].recorded).toBe(true);
    expect(at.checked[0].panel).toBe(found.best.panel);
  });

  it("says why an unreachable reflection cannot be recorded", async () => {
    const r = await ok("find_setting", { structure_id: "si", instrument: "topaz-cryo", hkl: [28, 0, 0] });
    expect(r.found).toBe(false);
    expect(r.message).toMatch(/below λmin\/2/);
  });

  it("suggests settings whose record simulate_plan confirms", async () => {
    const wanted = [
      [2, 2, 0],
      [3, 1, 1],
    ];
    const s = await ok("suggest_settings", { structure_id: "si", instrument: "topaz-cryo", wanted, n: 3 });
    expect(s.settings_as_lists.length).toBeGreaterThan(0);
    const plan = await ok("simulate_plan", { structure_id: "si", instrument: "topaz-cryo", settings: s.settings_as_lists, wanted });
    const recorded = plan.wanted.filter((w: { settings_recording: number }) => w.settings_recording > 0).length;
    const well = plan.wanted.filter((w: { settings_well_placed: number }) => w.settings_well_placed > 0).length;
    expect(recorded).toBe(s.wanted.recorded_after);
    expect(well).toBe(s.wanted.well_placed_after);
    expect(plan.families_recorded).toBe(s.families.recorded_after);
  });

  it("runs CORELLI's usual scan when none is given, and writes the plan", async () => {
    const r = await ok("simulate_plan", { structure_id: "si", instrument: "corelli", output_path: join(tmp, "plan.csv") });
    expect(r.plan).toMatchObject({ kind: "rotation scan", axis: "omega", start: 0, end: 357, step: 3, settings: 120 });
    expect(r.completeness).toBeGreaterThan(0.9);
    expect(readFileSync(r.written, "utf8")).toMatch(/^setting,omega_deg,reflections_on_detectors/m);
    expect(await fails("simulate_plan", { structure_id: "si", instrument: "topaz-cryo" })).toMatch(/orientation list/);
  });

  it("keeps masks set with configure_instrument for every later tool, until cleared", async () => {
    const names = SNS_INSTRUMENTS.find((i) => i.id === "topaz-cryo")!.detectors!.map((p) => p.name);
    const set = await ok("configure_instrument", { instrument: "topaz-cryo", masks: { panels_off: names } });
    expect(set.pixels_masked_percent).toBe(100);
    expect(set.fraction_of_sphere.now).toBe(0);
    const r = await ok("simulate_setting", { structure_id: "si", instrument: "topaz-cryo" });
    expect(r.on_detectors).toBe(0);
    expect(r.notes.join(" ")).toMatch(/configure_instrument/);
    // TOPAZ ambient shares the detectors but not the session's settings.
    expect((await ok("simulate_setting", { structure_id: "si", instrument: "topaz-ambient" })).on_detectors).toBeGreaterThan(0);
    await ok("configure_instrument", { instrument: "topaz-cryo", clear: true });
    expect((await ok("simulate_setting", { structure_id: "si", instrument: "topaz-cryo" })).on_detectors).toBeGreaterThan(0);
    expect(await fails("configure_instrument", { instrument: "topaz-cryo", masks: { panels_off: ["bank999"] } })).toMatch(/no panel bank999/);
  });

  it("limits a goniometer axis for the searches", async () => {
    await ok("configure_instrument", { instrument: "corelli", goniometer_limits: [{ axis: "omega", min: 0, max: 90 }] });
    const r = await ok("find_setting", { structure_id: "si", instrument: "corelli", hkl: [2, 2, 0] });
    expect(r.best.angles.omega).toBeLessThanOrEqual(90);
    await ok("configure_instrument", { instrument: "corelli", clear: true });
  });

  it("refuses arguments it does not know, rather than ignoring them", async () => {
    expect(await fails("simulate_setting", { structure_id: "si", instrument: "corelli", masks: { panels_off: [] } })).toMatch(/masks/);
    expect(await fails("simulate_setting", { structure_id: "si", instrument: "corelli", orientation: { ub_file: "x.mat" } })).toMatch(/ub_file/);
  });

  it("gives MDNorm binning for a chopper spectrometer with the energy axis", async () => {
    const r = await ok("suggest_binning", { structure_id: "si", instrument: "sequoia", orientation: { u: [1, 1, 0], v: [0, 0, 1] }, scan: { start: -30, end: 30, step: 2 } });
    expect(r.energy_transfer).toMatchObject({ min: -30, step: 0.6 });
    expect(r.mdnorm_call).toMatch(/Dimension3Name="DeltaE"/);
    for (const a of r.axes) expect(a.bins).toBeGreaterThanOrEqual(201);
  });
});

describe("orientation", () => {
  it("writes a 2 × 2 × 2 supercell UB that analyze_ub reads back and recognises", async () => {
    const mount = await ok("mount_crystal", { structure_id: "si", u: [1, 0, 0], v: [0, 1, 0] });
    expect(mount.mantid_setub).toMatch(/u="1,0,0", v="0,1,0"/);
    const t = await ok("transform_ub", { ub: mount.ub, supercell: [2, 2, 2], output_path: join(tmp, "super.mat") });
    expect(t.lattice.a).toBeCloseTo(2 * 5.43096, 4);
    const a = await ok("analyze_ub", { ub_path: t.written, structure_id: "si" });
    expect(a.structure.matches[0].ub_cell).toBe("a 2 × 2 × 2 supercell of the CIF cell");
    a.structure.ub_in_cif_cell.flat().forEach((v: number, k: number) => expect(v).toBeCloseTo(mount.ub.flat()[k], 6));
    expect(a.directions.beam.reciprocal.text).toBe("(1 0 0)");
  });

  it("refuses a mount whose u and v are parallel", async () => {
    expect(await fails("simulate_setting", { structure_id: "si", instrument: "corelli", orientation: { u: [1, 0, 0], v: [2, 0, 0] } })).toMatch(/parallel/);
  });
});

describe("beams and materials", () => {
  it("gives PyChop's elastic width (the port's value) and refuses a chopper the instrument lacks", async () => {
    const r = await ok("chopper_resolution", { instrument: "arcs", ei_mev: 100 });
    expect(r.resolution[0].fwhm_mev).toBeCloseTo(energyResolution({ instrument: "arcs", package: "ARCS-100-1.5-AST", frequency: 300 }, 100, 0)!, 6);
    expect(await fails("chopper_resolution", { instrument: "arcs", ei_mev: 100, chopper: "SEQ-100-2.0-AST" })).toMatch(/no chopper/);
  });

  it("converts 25.3 meV neutrons to 1.798 Å and 2200 m/s", async () => {
    const r = await ok("convert_units", { energy_mev: 25.3 });
    expect(r.wavelength).toBeCloseTo(1.798, 3);
    expect(r.velocity).toBeCloseTo(2200, 0);
  });

  it("compares with vanadium: its incoherent and absorption Σ are both ≈ 0.367 cm⁻¹", async () => {
    const r = await ok("scattering_power", { structure_id: "si", reference: "vanadium" });
    expect(r.reference.incoherent_cm).toBeCloseTo(0.367, 2);
    expect(r.reference.absorption_cm).toBeCloseTo(0.367, 2);
    expect(r.ratios.coherent).toBeGreaterThan(10);
  });
});

describe("instrument limits", () => {
  it("summarise every instrument, with what is not modelled", async () => {
    for (const { id } of SNS_CATALOG) {
      const r = await ok("instrument_limits", { instrument: id });
      expect(r.detectors.fraction_of_sphere).toBeGreaterThan(0.05);
      expect(r.reach.d_min).toBeGreaterThan(0);
      expect(r.not_modelled.join(" ")).toMatch(/nominal/);
    }
  });

  it("give a chopper spectrometer's reach at λ, as its elastic |Q| limits", async () => {
    const r = await ok("instrument_limits", { instrument: "arcs", ei_mev: 60 });
    expect(r.energy.kinematics[0].q_max).toBeCloseTo(r.reach.q_max, 4);
    expect(r.energy.kinematics[1].q_min).toBeGreaterThan(r.energy.kinematics[0].q_min);
    expect(r.not_modelled.join(" ")).toMatch(/Elastic line only/);
  });

  it("list NOMAD's banks with their calibrated DIFC and measured Δd/d", async () => {
    const r = await ok("instrument_limits", { instrument: "nomad" });
    expect(r.focused_banks).toHaveLength(6);
    expect(r.focused_banks[4]).toMatchObject({ name: "Bank 4", difc: 9912.083, d_over_d: 0.0036, difc_source: "calibrated (published)" });
    expect(r.focused_banks[5].difc_source).toBe("geometric");
  });

  it("find that TOPAZ ambient's two axes reach all of reciprocal space and CNCS at 12 meV nothing below its shortest d", async () => {
    const topaz = await ok("reciprocal_coverage", { instrument: "topaz-ambient", directions: 200 });
    expect(topaz.volume_fraction).toBeCloseTo(1, 2);
    const cncs = await ok("reciprocal_coverage", { instrument: "cncs", ei_mev: 12, d_min: 0.8 });
    for (const sh of cncs.shells) if (sh.d[0] < cncs.shortest_d_recordable) expect(sh.fraction).toBe(0);
    expect(cncs.shells[0].max_out_of_plane_deg).toBeGreaterThan(0);
  });

  it("give a scan less coverage than the full rotation", async () => {
    const full = await ok("reciprocal_coverage", { instrument: "corelli", directions: 300 });
    const part = await ok("reciprocal_coverage", { instrument: "corelli", directions: 300, scan: { start: 0, end: 60, step: 3 } });
    expect(part.volume_fraction).toBeLessThan(full.volume_fraction);
    expect(part.shells[0].mean_recordings).toBeGreaterThan(0);
  });

  it("compare instruments for a powder goal: POWGEN meets 0.5 % Δd/d, NOMAD and the chopper spectrometers do not", async () => {
    const r = await ok("compare_instruments", { sample: "powder", d_min: 0.5, d_max: 5, resolution: 0.005 });
    const by = (id: string) => r.instruments.find((x: { instrument: string }) => x.instrument === id);
    expect(by("powgen").verdict).toBe("suitable");
    expect(by("nomad").checks.resolution).toBe(false);
    // A chopper spectrometer's energy width only bounds Δd/d from below: never "met".
    for (const id of ["arcs", "sequoia", "cncs"]) expect(by(id).checks.resolution).not.toBe(true);
    expect(by("cncs").verdict).toBe("unsuitable");
    expect(by("cncs").reasons[0]).toMatch(/needs Ei ≥/);
  });

  it("compare instruments for a single crystal, wanted reflections included", async () => {
    const r = await ok("compare_instruments", { sample: "single-crystal", d_min: 0.7, structure_id: "si", wanted: [[2, 2, 0]] });
    expect(r.instruments.map((x: { instrument: string }) => x.instrument)).not.toContain("nomad");
    const ambient = r.instruments.find((x: { instrument: string }) => x.instrument === "topaz-ambient");
    expect(ambient.verdict).toBe("suitable");
    expect(ambient.reciprocal_space_reached.down_to_d_min).toBeGreaterThan(0.95);
  });
});

describe("tools for MATERIA, NEBULA3D and the NeXus Viewer", () => {
  it("write a POWGEN frame's GSAS-II parameters from the catalog's profile", async () => {
    const r = await ok("instrument_parameters", { instrument: "powgen", frame: 1.5, output_path: join(tmp, "pg.instprm") });
    const frame = SNS_CATALOG.find((i) => i.id === "powgen")!.frames!.list.find((f) => f.centre === 1.5)!;
    expect(r.materia_instrument).toMatchObject({ kind: "tof", alpha: frame.profile!.alpha, sig1: frame.profile!.sig1 });
    expect(r.d_range).toEqual([frame.dMin, frame.dMax]);
    expect(r.complete_gsas2_file).toBe(true);
    expect(readFileSync(r.written, "utf8")).toMatch(/^beta-0:0\.011013$/m);
  });

  it("write a NOMAD bank's Gaussian width from its Δd/d, and ask which bank when none is given", async () => {
    const r = await ok("instrument_parameters", { instrument: "nomad", bank: 3 });
    // Results carry 7 significant figures.
    expect(r.materia_instrument.sig1 / ((9068.553 * 0.0069) / (2 * Math.sqrt(2 * Math.LN2))) ** 2).toBeCloseTo(1, 6);
    expect(r.complete_gsas2_file).toBe(false);
    expect(r.bank.gsas_bank).toBe(4);
    const missing = await callTool("instrument_parameters", { instrument: "nomad" }, ctx);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.details?.banks).toHaveLength(6);
  });

  it("give the Laue group in the viewer's syntax and check a grid against it", async () => {
    const r = await ok("laue_symmetry", { structure_id: "si", grid: { binning: ["-6.05,0.1,6.05", "-6.05,0.1,6.05", "-0.05,0.05"] } });
    expect(r).toMatchObject({ laue_class: "m-3m", nexus_viewer_preset: "m-3m", order: 48, centrosymmetric: true });
    expect(r.symmetry_ops.split("; ")).toHaveLength(48);
    // Cubic operations mix L into H and K: an integrated L axis cannot follow them.
    expect(r.grid.compatible).toBe(false);
    const hex = await ok("laue_symmetry", { space_group: "P 63/m m c", grid: { binning: ["-6.05,0.1,6.05", "-6.05,0.1,6.05", "-0.05,0.05"] } });
    expect(hex.grid.compatible).toBe(true);
    expect(await fails("laue_symmetry", { space_group: "R -3 m" })).toMatch(/R -3 m:H/);
  });

  it("list Bragg nodes on a grid, mirrored for Mantid's default convention, absences flagged", async () => {
    const grid = { binning: ["-4.5,0.1,4.5", "-4.5,0.1,4.5", "-0.05,0.05"] };
    const inel = await ok("bragg_positions", { structure_id: "si", grid, limit: 5000 });
    const cryst = await ok("bragg_positions", { structure_id: "si", grid: { ...grid, q_convention: "crystallography" }, limit: 5000 });
    const node = (r: { nodes: { hkl: number[]; grid: number[]; class: string }[] }, h: number[]) => r.nodes.find((n) => n.hkl.join() === h.join())!;
    expect(node(inel, [2, 2, 0]).grid).toEqual([-2, -2, 0]);
    expect(node(cryst, [2, 2, 0]).grid).toEqual([2, 2, 0]);
    expect(node(inel, [2, 0, 0]).class).toBe("systematic absence");
    expect(node(inel, [2, 2, 0]).class).toBe("present");
    const sat = await ok("bragg_positions", { structure_id: "si", grid, include: "present", propagation_vectors: [[0.5, 0, 0]], limit: 5000 });
    expect(sat.counts.satellite).toBeGreaterThan(0);
    expect(sat.counts["systematic absence"]).toBeUndefined();
  });

  it("map what a CORELLI scan records on a slice as the exact simulation does, and write it as .npy", async () => {
    const binning = ["-6.1,0.2,6.1", "-6.1,0.2,6.1", "-0.05,0.05"];
    const r = await ok("coverage_map", { structure_id: "si", instrument: "corelli", grid: { binning, q_convention: "crystallography" }, output_path: join(tmp, "cov.npy") });
    expect(r.array.shape).toEqual([1, 61, 61]);
    const bytes = readFileSync(r.written);
    const len = bytes[8]! | (bytes[9]! << 8);
    expect(String.fromCharCode(...bytes.subarray(10, 10 + len))).toMatch(/'shape': \(1, 61, 61\)/);
    const counts = new Uint16Array(bytes.buffer.slice(bytes.byteOffset + 10 + len, bytes.byteOffset + bytes.length));
    // The same points through pointCoverage (exact ray casts): U = I, so q = B·h with B = 1/a.
    const corelli = SNS_INSTRUMENTS.find((i) => i.id === "corelli")!;
    const settings = scanSettings(0, [0], { start: 0, end: 357, step: 3 }).map((a) => goniometerMatrix(corelli.goniometer, a));
    const qs: Vec3[] = [];
    for (let j = 0; j < 61; j++) for (let i = 0; i < 61; i++) qs.push([(-6 + 0.2 * i) / 5.43096, (-6 + 0.2 * j) / 5.43096, 0]);
    const exact = pointCoverage(settings, qs, corelli.detectors!, corelli.lambdaMin, corelli.lambdaMax);
    let agree = 0;
    exact.forEach((c, k) => (agree += c > 0 === counts[k]! > 0 ? 1 : 0));
    expect(agree / exact.length).toBeGreaterThan(0.98);
    expect(r.fraction_recorded).toBeGreaterThan(0.3);
  });

  it("give the UB in NEBULA3D's 2π convention too", async () => {
    const m = await ok("mount_crystal", { structure_id: "si", u: [1, 0, 0], v: [0, 1, 0] });
    m.ub.flat().forEach((v: number, k: number) => expect(Math.abs(m.ub_times_2pi.flat()[k] - 2 * Math.PI * v)).toBeLessThan(1e-6 * Math.max(1, Math.abs(2 * Math.PI * v))));
  });
});
