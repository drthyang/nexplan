/// <reference lib="webworker" />
import { runCalculation, type CalcInput, type CalcResult } from "../app/compute.ts";

export interface CalcRequest {
  readonly id: number;
  readonly input: CalcInput;
}
export interface CalcResponse {
  readonly id: number;
  readonly result: CalcResult;
}

self.onmessage = async (ev: MessageEvent<CalcRequest>) => {
  const { id, input } = ev.data;
  let result: CalcResult;
  try {
    result = await runCalculation(input);
  } catch (e) {
    result = { ok: false, stage: "input", message: `Unexpected error: ${(e as Error).message}` };
  }
  const transfer: Transferable[] = [];
  if (result.ok) {
    const r = result.reflections;
    transfer.push(r.h.buffer, r.k.buffer, r.l.buffer, r.d.buffer, r.re.buffer, r.im.buffer, r.f2.buffer, r.cls.buffer, result.profile.x.buffer, result.profile.y.buffer);
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, result } satisfies CalcResponse, transfer);
};
