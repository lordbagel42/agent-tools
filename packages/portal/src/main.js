#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { createService } from "./server.js";
import { loadConfig, validatePrefix } from "./config.js";

const { values } = parseArgs({
  options: { config: { type: "string" }, help: { type: "boolean" } },
});
if (values.help) {
  console.log(
    "Usage: portal-server [--config /absolute/config.json] (foreground)",
  );
  process.exit(0);
}
const config = await loadConfig(values.config);
validatePrefix(config);
await mkdir(dirname(config.socketPath), { recursive: true, mode: 0o700 });
const service = await createService(config);
console.log(`Portal listening on ${config.bindHost}:${config.port}`);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    await service.close();
    process.exit(0);
  });
