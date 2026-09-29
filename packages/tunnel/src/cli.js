#!/usr/bin/env node
import { Tunnels } from "./tunnel.js";

const help = `tunnel start NAME --owner THREAD --destination SSH_ALIAS --direction local|reverse --listen-port PORT --target-port PORT
tunnel status NAME --owner THREAD
tunnel list --owner THREAD
tunnel stop NAME --owner THREAD

For reverse also pass --remote-loopback-confirmed after verifying remote GatewayPorts is not yes.
Listeners and targets are 127.0.0.1. Existing SSH reachability and trusted host keys are required.
TUNNEL_OWNER supplies a CLI default owner; TUNNEL_STATE_DIR overrides the private state directory.
Mac OAuth example: tunnel start oauth --owner my-session --destination agent --direction local --listen-port 1455 --target-port 1455`;

export async function main(argv) {
  if (argv.length === 0 || argv.includes("--help")) {
    console.log(help);
    return;
  }
  const [action, ...rest] = argv;
  if (!["start", "status", "list", "stop"].includes(action))
    throw new Error("Unknown action; use --help");
  const name = action === "list" ? undefined : rest.shift();
  const opts = {};
  const allowed = [
    "owner",
    "destination",
    "direction",
    "listen-port",
    "target-port",
    "remote-loopback-confirmed",
  ];
  while (rest.length) {
    const key = rest.shift().replace(/^--/, "");
    if (!allowed.includes(key) || key in opts)
      throw new Error(`Unknown or duplicate option: ${key}`);
    opts[key] = key === "remote-loopback-confirmed" ? true : rest.shift();
    if (opts[key] === undefined) throw new Error(`Missing value for ${key}`);
  }
  const tunnels = new Tunnels({ root: process.env.TUNNEL_STATE_DIR });
  const owner = opts.owner ?? process.env.TUNNEL_OWNER;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Cancelled"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result =
      action === "start"
        ? await tunnels.start(
            owner,
            name,
            {
              direction: opts.direction,
              destination: opts.destination,
              listenPort: Number(opts["listen-port"]),
              targetPort: Number(opts["target-port"]),
              remoteLoopbackConfirmed: opts["remote-loopback-confirmed"],
            },
            controller.signal,
          )
        : await tunnels[action](owner, name);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

await main(process.argv.slice(2)).catch((error) => {
  console.error(`tunnel: ${error.message}`);
  process.exitCode = 1;
});
