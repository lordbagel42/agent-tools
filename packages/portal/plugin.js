import { callPortal } from "./src/client.js";

export const description =
  "Start, expose, inspect and stop thread-owned, PIN-protected web previews through your configured HTTPS ingress.";

export default function (amp) {
  amp.registerTool({
    name: "portal",
    title: "Portal",
    description:
      "Create and manage PIN-protected HTTPS previews using an already configured local portal daemon and external HTTPS ingress. Use start with an absolute cwd and a foreground command listening on $PORT; $PUBLIC_URL and the exact Vite allowed host are supplied. Use expose for an existing loopback HTTP server. Actions: start, expose, list, status, logs, restart, stop, login-url, set-pin. Names are scoped to this Amp thread. Identical start/expose renews a 24-hour lease and reuses the URL; changed definitions require stop/start, except PIN changes via set-pin. Check ready before sharing. Previews use the shared PIN by default; optional pin on start/expose overrides it for that portal. Use set-pin with name and pin to change a running portal's PIN without restarting it or changing its URL; this revokes its sessions, login links and open connections. Other portals and the shared PIN are unchanged. PINs are secrets; do not put them in URLs, commands or logs. Give people the ordinary url (built-in PIN screen); login-url is a sensitive single-use 60-second URL only for curl/headless browsers—never share it publicly. This does not enable Amp’s native Portal tab, annotations, or multiplayer. Do not use this to expose admin services or arbitrary LAN hosts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "start",
            "expose",
            "list",
            "status",
            "logs",
            "restart",
            "stop",
            "login-url",
            "set-pin",
          ],
        },
        name: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9-]{0,31}$",
          description:
            "Required except for list; stable name within this thread.",
        },
        cwd: {
          type: "string",
          description: "Absolute workspace directory, required for start.",
        },
        command: {
          type: "string",
          description:
            "Foreground shell command, required for start. Listen on $PORT; do not background it.",
        },
        port: {
          type: "integer",
          minimum: 1024,
          maximum: 65535,
          description: "Required for expose; optional fixed port for start.",
        },
        pin: {
          type: "string",
          pattern: "^[0-9]{6,12}$",
          description:
            "Required secret PIN for set-pin; optional for start/expose. Use a random 6–12 digit string. set-pin changes only the named portal. Omit on start/expose to use the shared PIN on new portals or preserve an existing portal's PIN.",
        },
      },
      required: ["action"],
    },
    async execute(input, ctx) {
      if (input.action === "set-pin" && !input.name)
        throw new Error("set-pin requires a portal name");
      return JSON.stringify(
        await callPortal({ ...input, thread: ctx.thread.id }),
        null,
        2,
      );
    },
  });
}
