import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mockHoncho } from "./server.ts";

test.skipIf(!Bun.which("amp"))(
	"real Amp runtime loads the plugin and executes an adapted synthetic turn",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "amp-honcho-loader-"));
		const server = mockHoncho();
		try {
			const plugin = join(dir, "honcho");
			await mkdir(plugin);
			const path = join(dir, "config.json");
			await writeFile(
				path,
				JSON.stringify({
					hosts: {
						amp: {
							enabled: true,
							apiKey: "test-key",
							workspace: "shared",
							peerName: "example-user",
							aiPeer: "amp",
							endpoint: { baseUrl: server.config.baseUrl },
						},
					},
				}),
			);
			// This CLI's exec command delivers notification events, not request hooks.
			// Keep registration on the real API; adapt session.start only in this fixture.
			await cp(new URL("../skills", import.meta.url), join(plugin, "skills"), {
				recursive: true,
			});
			await writeFile(
				join(plugin, "index.ts"),
				`
import install from ${JSON.stringify(fileURLToPath(new URL("../index.ts", import.meta.url)))};
export default async function (amp) {
  const handlers = new Map();
  await install(new Proxy(amp, {
    get(target, key) {
      if (key === 'on') return (event, handler) => {
        handlers.set(event, handler);
        return target.on(event, handler);
      };
      return Reflect.get(target, key);
    }
  }));
  amp.on('session.start', async (event, ctx) => {
    const start = { thread: event.thread, id: 1, message: 'Synthetic loader verification' };
    const result = await handlers.get('agent.start')(start, ctx);
    if (!result?.message?.content?.includes('Prefers concise replies')) throw new Error('Context missing');
    await handlers.get('agent.end')({ ...start, status: 'done', messages: [
      { role: 'assistant', id: 2, content: [{ type: 'text', text: 'Synthetic reply' }] }
    ] }, ctx);
  });
}
`,
			);
			const proc = Bun.spawn(
				[
					"amp",
					"--log-file",
					join(dir, "amp.log"),
					"plugins",
					"exec",
					plugin,
					"session.start",
					"--data",
					JSON.stringify({
						thread: { id: "T-00000000-0000-0000-0000-000000000001" },
					}),
				],
				{
					cwd: fileURLToPath(new URL("..", import.meta.url)),
					env: {
						...process.env,
						HONCHO_CONFIG_PATH: path,
						HONCHO_AMP_ENABLED: "true",
						HONCHO_ENABLED: "true",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exit, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(stdout + stderr).not.toMatch(/error|Context missing/i);
			expect(exit).toBe(0);
			expect(server.messages.map((message) => message.content)).toEqual([
				"Synthetic loader verification",
				"Synthetic reply",
			]);
			expect(
				server.requests.some((request) =>
					request.path.endsWith("/peers/example-user/context"),
				),
			).toBe(true);
		} finally {
			server.close();
			await rm(dir, { recursive: true, force: true });
		}
	},
	30000,
);
