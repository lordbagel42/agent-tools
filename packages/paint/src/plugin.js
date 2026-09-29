import { paint } from "./paint.js";

export const description =
  "Generate a PNG using your existing Codex ChatGPT login and native image generation.";

export default function (amp) {
  amp.registerTool({
    name: "paint",
    description:
      "Generate exactly one PNG through the configured Codex executable using native image generation. Consumes provider quota; use only when the user requests image generation. No API-key fallback. Saves to a new output path; optional reference images are sent to Codex. Requires an existing eligible ChatGPT login.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        output: {
          type: "string",
          description: "New PNG output path; never overwritten.",
        },
        images: { type: "array", items: { type: "string" }, maxItems: 8 },
      },
      required: ["prompt", "output"],
      additionalProperties: false,
    },
    async execute(input) {
      const result = await paint(input);
      return JSON.stringify(result);
    },
  });
}
