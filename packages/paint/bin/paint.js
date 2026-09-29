#!/usr/bin/env node
import { parseArgs } from "node:util";
import { paint } from "../src/paint.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string" },
      output: { type: "string", short: "o" },
      image: { type: "string", multiple: true, short: "i" },
      executable: { type: "string" },
      "codex-home": { type: "string" },
      "timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      'paint --prompt "image description" --output new.png [--image reference.png ...]\nOptions: --executable PATH, --codex-home DIR, --timeout-ms N\nUses your existing Codex ChatGPT login and native image generation; may consume quota.',
    );
  } else {
    const result = await paint(
      { prompt: values.prompt, output: values.output, images: values.image },
      {
        executable: values.executable,
        codexHome: values["codex-home"],
        timeoutMs: values["timeout-ms"],
        signal: controller.signal,
      },
    );
    console.log(JSON.stringify(result));
  }
} catch {
  // Neither argument parsing errors nor subprocess output may echo prompt/secrets.
  console.error(
    "paint failed. Check arguments, a new writable .png output, Codex bundle/login/quota, and native image availability. No automatic retry or API fallback.",
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
