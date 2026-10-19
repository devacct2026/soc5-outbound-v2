import "reflect-metadata";
import { main } from "./main.ts";

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "fatal");
  process.exit(1);
});
