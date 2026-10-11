/**
 * NEXPLAN's features as agent tools: a name, a description written for a model, a zod input schema and a handler
 * that returns plain JSON. Nothing here depends on a transport: src/mcp/server.ts serves the tools over MCP, and
 * toolDefinitions() (index.ts) gives the same tools as JSON Schema for any tool-use API.
 */
import { z } from "zod";
import type { Workspace } from "./workspace.ts";

export interface ToolContext {
  /** Structures loaded in this session, and their cached calculations. */
  readonly workspace: Workspace;
  /** Set when the client cancels the call. */
  readonly signal?: AbortSignal;
}

/** Hints for clients (MCP ToolAnnotations): whether a tool only reads, and whether it touches anything outside NEXPLAN. */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface AgentTool<S extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: S;
  readonly annotations: ToolAnnotations;
  readonly run: (args: z.infer<S>, ctx: ToolContext) => Promise<object> | object;
}

/** A tool, with its handler typed by its schema. */
export const defineTool = <S extends z.ZodObject>(tool: AgentTool<S>): AgentTool<S> => tool;

/** A failure the caller can act on: the message says what to change, `details` carries the choices (blocks, settings, ids). */
export class ToolError extends Error {
  readonly details: Readonly<Record<string, unknown>> | undefined;
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ToolError";
    this.details = details;
  }
}

/** Rounds to `sig` significant figures (finite values only): tool output carries no more precision than it means. */
export const sig = (x: number, n = 6): number => (Number.isFinite(x) && x !== 0 ? Number(x.toPrecision(n)) : x);

/**
 * JSON for a tool result: numbers to 7 significant figures (integers unchanged), magnitudes below 1e-12 as 0 (the
 * rounding residue of quantities that are zero: |F| of an absence, off-diagonal UB entries; no result carries a real
 * value that small), typed arrays as arrays, and non-finite numbers as null.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? v : Math.abs(v) < 1e-12 ? 0 : Number(v.toPrecision(7))) : null;
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number>);
    if (v instanceof Set) return [...v];
    if (v instanceof Map) return Object.fromEntries(v);
    return v;
  });
}
