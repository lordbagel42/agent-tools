import { manage } from "./manager.js";

export const description =
  "Manage user-local agent-tools installations and explicit GitHub updates. Never updates in the background.";

export default function (amp) {
  for (const command of ["status", "check", "install", "update", "uninstall"]) {
    amp.registerTool({
      name: `tools_${command}`,
      description:
        command === "status"
          ? "Read local agent-tools installation status without network access or filesystem writes."
          : `Explicitly ${command} agent-tools. check fetches Git metadata; install/update download and execute trusted repository build scripts; uninstall removes only owned links. Use only when requested.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tools: {
            type: "array",
            items: { type: "string" },
            description:
              "Workspace IDs/package names for install or uninstall; update preserves installed selection.",
          },
          stateDir: { type: "string" },
          binDir: { type: "string" },
          pluginDir: { type: "string" },
          source: {
            type: "string",
            description:
              "Credential-free HTTPS GitHub source for first install.",
          },
          branch: { type: "string" },
        },
      },
      execute: async (input) =>
        JSON.stringify(await manage(command, input), null, 2),
    });
  }
}
