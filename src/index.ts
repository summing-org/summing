import { ConfigError, loadConfig } from "./config.js";
import { SummingRuntime } from "./runtime.js";

async function main(): Promise<number> {
  try {
    const runtime = new SummingRuntime(loadConfig());
    process.once("SIGTERM", () => runtime.requestStop(0));
    process.once("SIGINT", () => runtime.requestStop(0));
    return await runtime.run();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`configuration error: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("fatal runtime error", error);
    process.exitCode = 1;
  });
