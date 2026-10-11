import { useMemo } from "react";
import type { Mat3 } from "@materia/core/math/types";
import type { CalcSuccess } from "../app/compute.ts";
import type { BasisMatch } from "../core/ub/ub.ts";
import { cellMatches, chosenMatch, mountPlane, orientationUB, type UbState } from "./ubShared.ts";

/**
 * The orientation in use (ubShared.ts viewOrientation), memoised so that the views and simulations keyed on the UB
 * recompute only when the file, the chosen match, the cell or the plane changes.
 */
export function useViewUB(result: CalcSuccess, ub: UbState): { viewUB: Mat3; match?: BasisMatch; matches: readonly BasisMatch[]; fileUB?: Mat3 } {
  const cifCell = result.structure.cell;
  const rotations = result.structure.rotations;
  const fileUB = ub.UB;
  const matches = useMemo(() => cellMatches(cifCell, fileUB, rotations), [fileUB, cifCell, rotations]);
  const match = chosenMatch(matches, ub);
  const plane = mountPlane(cifCell, ub);
  const planeKey = plane ? `${plane.u.join(",")};${plane.v.join(",")}` : "";
  const viewUB = useMemo(
    () => orientationUB(cifCell, fileUB, match, plane),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- planeKey is the plane's value
    [fileUB, match, cifCell, planeKey],
  );
  return { viewUB, matches, ...(match ? { match } : {}), ...(fileUB ? { fileUB } : {}) };
}
