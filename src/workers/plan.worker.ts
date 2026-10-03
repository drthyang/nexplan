/// <reference lib="webworker" />
import { suggestSettings, type SuggestInput, type SuggestResult } from "../core/instrument/plan.ts";

export type PlanMessage = { readonly kind: "progress"; readonly done: number; readonly total: number } | { readonly kind: "done"; readonly result: SuggestResult } | { readonly kind: "error"; readonly message: string };

const post = (m: PlanMessage) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = (ev: MessageEvent<SuggestInput>) => {
  try {
    post({ kind: "done", result: suggestSettings(ev.data, (done, total) => post({ kind: "progress", done, total })) });
  } catch (e) {
    post({ kind: "error", message: (e as Error).message });
  }
};
