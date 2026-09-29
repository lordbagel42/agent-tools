import { Tunnels } from "./tunnel.js";

export const description =
  "Thread-owned, loopback-only SSH tunnels for connecting devices and OAuth callbacks.";

export default function (amp) {
  const tunnels = new Tunnels({ root: process.env.TUNNEL_STATE_DIR });
  amp.registerTool({
    name: "tunnel",
    description:
      "Start/status/list/stop a loopback SSH tunnel owned by this thread on this executor. Requires existing SSH reachability, known host keys and noninteractive credentials. Local: executor localhost listener → SSH destination localhost target. Reverse: destination listener → executor target; verify remote GatewayPorts is no/clientspecified first. Never provisions SSH or bypasses NAT. For OAuth browser on a Mac and callback on a remote agent, run the CLI on the Mac with direction local and both ports 1455. Stop when finished. Start has a bounded readiness timeout; readiness does not prove target health.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["start", "status", "list", "stop"] },
        name: {
          type: "string",
          description: "Stable name within this thread; required except list",
        },
        direction: { type: "string", enum: ["local", "reverse"] },
        destination: {
          type: "string",
          description:
            "Explicit existing SSH alias or user@hostname; required for start",
        },
        listenPort: { type: "integer", minimum: 1024, maximum: 65535 },
        targetPort: { type: "integer", minimum: 1, maximum: 65535 },
        remoteLoopbackConfirmed: {
          type: "boolean",
          description:
            "Only true after verifying remote GatewayPorts is no or clientspecified; required for reverse",
        },
      },
    },
    async execute(input, ctx) {
      if (!["start", "status", "list", "stop"].includes(input.action))
        throw new Error("Invalid action");
      const owner = ctx.thread.id;
      const result =
        input.action === "start"
          ? await tunnels.start(owner, input.name, input)
          : await tunnels[input.action](owner, input.name);
      return JSON.stringify(result);
    },
  });
}
