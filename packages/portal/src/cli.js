#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { callPortal } from "./client.js";
import { initConfig } from "./config.js";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      cwd: { type: "string" },
      command: { type: "string" },
      port: { type: "string" },
      thread: { type: "string" },
      config: { type: "string" },
      domain: { type: "string" },
      "login-host": { type: "string" },
      workspace: { type: "string" },
      "state-dir": { type: "string" },
      socket: { type: "string" },
      "id-prefix": { type: "string" },
      "pin-stdin": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(
      "Usage: portal <start|expose|list|status|logs|restart|stop|login-url|set-pin> [--config PATH] [--name NAME] [--cwd DIR --command COMMAND] [--port PORT] [--thread THREAD] [--pin-stdin]\nportal init --domain preview.example.com --workspace /absolute/workspace [--config PATH --state-dir DIR --socket PATH --login-host HOST --id-prefix p- --port 8787] [--pin-stdin]\ninit and set-pin use a hidden terminal prompt. set-pin --name NAME changes only that portal's PIN without restarting it; omit --name to rotate the shared PIN. --pin-stdin reads a PIN from stdin (also supported by start/expose). Thread defaults to AMP_THREAD_ID and is required for named portals. Login URLs are sensitive and expire after 60 seconds. Run portal-server separately; HTTPS ingress and DNS must be configured externally.",
    );
    process.exitCode = values.help ? 0 : 1;
  } else {
    const options = { ...values };
    delete options.help;
    delete options["pin-stdin"];
    delete options.config;
    let pin;
    if (values["pin-stdin"]) {
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 64) throw new Error("PIN input too long");
      }
      pin = input.trim();
    } else if (["set-pin", "init"].includes(positionals[0])) {
      if (!process.stdin.isTTY)
        throw new Error("Use --pin-stdin or run in a terminal");
      let muted = false;
      const output = new Writable({
        write(chunk, _encoding, done) {
          if (!muted) process.stdout.write(chunk);
          done();
        },
      });
      const terminal = createInterface({
        input: process.stdin,
        output,
        terminal: true,
      });
      terminal.on("SIGINT", () => {
        terminal.close();
        process.exit(130);
      });
      try {
        const answer = terminal.question(
          positionals[0] === "set-pin" && values.name !== undefined
            ? "New portal PIN (6–12 digits): "
            : "New shared PIN (6–12 digits): ",
        );
        muted = true;
        pin = await answer;
      } finally {
        terminal.close();
        process.stdout.write("\n");
      }
    }
    const result =
      positionals[0] === "init"
        ? await initConfig(values, pin)
        : await callPortal(
            {
              ...options,
              ...(pin !== undefined && { pin }),
              ...(values.port !== undefined && { port: Number(values.port) }),
              action: positionals[0],
              thread:
                values.thread ||
                process.env.AMP_THREAD_ID ||
                (positionals[0] === "set-pin" && values.name === undefined
                  ? "T-00000000-0000-0000-0000-000000000000"
                  : undefined),
            },
            { configPath: values.config },
          );
    console.log(JSON.stringify(result, null, 2));
    if (result.ready === false) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
