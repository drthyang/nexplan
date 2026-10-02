/**
 * Calculation client: one worker, latest-request-wins. A newer request
 * terminates a running one, so typing in a field never queues stale work.
 * A worker crash resolves the pending request with an error result instead of
 * leaving the UI waiting.
 */
import type { CalcInput, CalcResult } from "../app/compute.ts";
import type { CalcResponse } from "./calc.worker.ts";

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
    console.error("calculation worker error", ev.message);
    fail(`The calculation worker failed: ${ev.message || "unknown error"}`);
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
