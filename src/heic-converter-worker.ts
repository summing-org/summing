import convert from "heic-convert";
import { parentPort, workerData } from "node:worker_threads";

interface HeicWorkerInput {
  data: Uint8Array;
  quality: number;
}

const input = workerData as HeicWorkerInput;

try {
  const converted = await convert({
    buffer: input.data,
    format: "JPEG",
    quality: input.quality,
  });
  const data = Uint8Array.from(converted);
  parentPort?.postMessage({ ok: true, data }, [data.buffer]);
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  });
}
