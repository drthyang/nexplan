/**
 * Calculation client: one worker, latest-request-wins. A newer request
 * terminates a running one, so typing in a field never queues stale work.
 * A worker crash resolves the pending request with an error result instead of
 * leaving the UI waiting.
 */
import type { CalcInput, CalcResult } from "../app/compute.ts";
import type { SuggestInput, SuggestResult } from "../core/instrument/plan.ts";
import type { CalcResponse } from "./calc.worker.ts";
import type { PlanMessage } from "./plan.worker.ts";

let worker: Worker | undefined;
let seq = 0;
let pending: { id: number; resolve: (r: CalcResult | undefined) => void } | undefined;

function fail(message: string) {
  if (!pending) return;
  pending.resolve({ ok: false, stage: "input", message });
  pending = undefined;
  worker?.terminate();
  worker = undefined;
}

function spawn(): Worker {
  const w = new Worker(new URL("./calc.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (ev: MessageEvent<CalcResponse>) => {
    if (pending && ev.data.id === pending.id) {
      pending.resolve(ev.data.result);
      pending = undefined;
    }
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    // A worker script that fails to load has no message: usually an old tab after a redeploy.
    console.error("calculation worker error", ev.message ?? "(script failed to load)");
    fail(ev.message ? `The calculation worker failed: ${ev.message}` : "The calculation engine could not be loaded. Reload the page; the app may have been updated.");
  };
  w.onmessageerror = () => fail("The calculation result could not be transferred from the worker.");
  return w;
}

/** Resolves with the result, or undefined if superseded by a newer call. */
export function calculate(input: CalcInput): Promise<CalcResult | undefined> {
  if (pending) {
    pending.resolve(undefined);
    pending = undefined;
    worker?.terminate();
    worker = undefined;
  }
  worker ??= spawn();
  const id = ++seq;
  return new Promise((resolve) => {
    pending = { id, resolve };
    try {
      worker!.postMessage({ id, input });
    } catch (e) {
      fail(`Could not start the calculation: ${(e as Error).message}`);
    }
  });
}

/**
 * A calculation on its own short-lived worker, for side results such as a
 * reference material: it neither cancels nor is cancelled by `calculate`.
 */
export function calculateIsolated(input: CalcInput): Promise<CalcResult> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new Worker(new URL("./calc.worker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      resolve({ ok: false, stage: "input", message: `Could not start the calculation: ${(e as Error).message}` });
      return;
    }
    const done = (r: CalcResult) => {
      w.terminate();
      resolve(r);
    };
    w.onmessage = (ev: MessageEvent<CalcResponse>) => done(ev.data.result);
    w.onerror = (ev) => {
      ev.preventDefault();
      done({ ok: false, stage: "input", message: ev.message ? `The calculation worker failed: ${ev.message}` : "The calculation engine could not be loaded. Reload the page." });
    };
    w.postMessage({ id: 0, input });
  });
}

/**
 * Suggested orientation list (src/core/instrument/plan.ts) on its own worker:
 * the search over goniometer settings can take a second or two.
 */
export function suggestPlan(input: SuggestInput, onProgress: (done: number, total: number) => void): { readonly result: Promise<SuggestResult>; readonly cancel: () => void } {
  let w: Worker | undefined;
  let settle: ((e: Error) => void) | undefined;
  const result = new Promise<SuggestResult>((resolve, reject) => {
    settle = reject;
    try {
      w = new Worker(new URL("./plan.worker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      reject(new Error(`Could not start the search: ${(e as Error).message}`));
      return;
    }
    w.onmessage = (ev: MessageEvent<PlanMessage>) => {
      const m = ev.data;
      if (m.kind === "progress") return onProgress(m.done, m.total);
      w?.terminate();
      if (m.kind === "done") resolve(m.result);
      else reject(new Error(m.message));
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      w?.terminate();
      reject(new Error(ev.message || "The search worker could not be loaded. Reload the page."));
    };
    w.postMessage(input);
  });
  return {
    result,
    cancel: () => {
      w?.terminate();
      settle?.(new Error("cancelled"));
    },
  };
}
