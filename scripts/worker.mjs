// Entrypoint: node scripts/worker.mjs [--once]  (Node >= 22 runs the .ts sources directly)
import { main } from "../src/server/worker/main.ts";

process.exitCode = await main();
