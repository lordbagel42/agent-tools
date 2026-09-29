#!/usr/bin/env node
import { parseArgs } from "node:util";
import { manage } from "../src/manager.js";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "state-dir": { type: "string" },
      "bin-dir": { type: "string" },
      "plugin-dir": { type: "string" },
      source: { type: "string" },
      branch: { type: "string" },
      "allow-local-source": { type: "boolean" },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(
      "tools <status|check|install|update|uninstall> [workspace IDs/package names]\n\nOptions: --state-dir PATH --bin-dir PATH --plugin-dir PATH --source URL --branch main\n         --allow-local-source (absolute local fixture repositories only)\nInstall without names selects all tools. Update preserves selection. Uninstall retains checkout.",
    );
  } else {
    const [command, ...tools] = positionals;
    if (tools.length && !["install", "uninstall"].includes(command))
      throw new Error("Tool names are only accepted for install/uninstall");
    console.log(
      JSON.stringify(
        await manage(command, {
          tools,
          stateDir: values["state-dir"],
          binDir: values["bin-dir"],
          pluginDir: values["plugin-dir"],
          source: values.source,
          branch: values.branch,
          allowLocalSource: values["allow-local-source"],
        }),
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(`tools: ${error.message}`);
  process.exitCode = 1;
}
