/** Adapter: a ScatterPlan calculation result → MATERIA's StructureModel, for the copied viewer code. */
import type { StructureModel } from "@materia/core/crystal/types";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import type { CalcSuccess } from "../app/compute.ts";
import { parseSymOp, TDEN } from "../core/symmetry/ops.ts";

export function toMateriaModel(result: CalcSuccess): StructureModel {
  const s = result.structure;
  return {
    id: `${result.provenance.inputSha256}:${result.blockName}`,
    name: s.name,
    cell: s.cell,
    spaceGroup: {
      ...(s.settingNumber !== undefined ? { number: s.settingNumber } : {}),
      ...(s.setting ? { hermannMauguin: s.setting } : {}),
      operations: s.ops.map((xyz) => {
        const op = parseSymOp(xyz);
        return { rotation: op.R as unknown as Mat3, translation: op.t.map((n) => n / TDEN) as unknown as Vec3, xyz };
      }),
    },
    sites: s.sites.map((r) => ({
      label: r.label,
      element: r.element,
      position: [r.x, r.y, r.z] as Vec3,
      occupancy: r.occupancy,
      adp: { kind: "isotropic" as const, bIso: r.bIso },
    })),
  };
}
