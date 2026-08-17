import { Worker } from "node:worker_threads";

export type HeicConverter = (data: Uint8Array) => Promise<Uint8Array>;

interface HeicWorkerMessage {
  ok: boolean;
  data?: Uint8Array;
  error?: string;
}

export function convertHeicToJpeg(data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolveConversion, rejectConversion) => {
    const worker = new Worker(new URL("./heic-converter-worker.js", import.meta.url), {
      execArgv: [],
      workerData: { data, quality: 0.9 },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    const finish = (error: Error | null, result?: Uint8Array): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) rejectConversion(error);
      else if (result) resolveConversion(result);
      else rejectConversion(new Error("HEIC converter returned no image"));
    };
    const timer = setTimeout(() => {
      finish(new Error("HEIC conversion timed out"));
    }, 60_000);
    worker.once("message", (value: HeicWorkerMessage) => {
      if (value.ok && value.data instanceof Uint8Array) {
        finish(null, value.data);
        return;
      }
      finish(new Error(value.error || "HEIC conversion failed"));
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error(`HEIC converter exited with code ${code}`));
    });
  });
}
