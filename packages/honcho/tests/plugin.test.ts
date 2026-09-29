import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentEndEvent,
	AgentStartResult,
	PluginAPI,
	PluginEventMap,
	PluginToolDefinition,
	PluginUI,
	ThreadMessage,
} from "@ampcode/plugin";
import type { ObjectValue } from "../config.ts";
import install from "../index.ts";
import { mockHoncho } from "./server.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(overrides: ObjectValue = {}) {
	const server = mockHoncho(overrides);
	const dir = await mkdtemp(join(tmpdir(), "amp-honcho-plugin-"));
	const path = join(dir, "config.json");
	const previous = process.env.HONCHO_CONFIG_PATH;
	process.env.HONCHO_CONFIG_PATH = path;
	const raw = {
		apiKey: "test-key",
		endpoint: { baseUrl: server.config.baseUrl },
		hosts: { amp: { enabled: true, workspace: "shared", ...overrides } },
	};
	const write = () => writeFile(path, JSON.stringify(raw));
	await write();
	cleanups.push(async () => {
		if (previous === undefined) delete process.env.HONCHO_CONFIG_PATH;
		else process.env.HONCHO_CONFIG_PATH = previous;
		server.close();
		await rm(dir, { recursive: true, force: true });
	});
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const tools = new Map<string, PluginToolDefinition>();
	const notices: string[] = [];
	const confirmations: Parameters<PluginUI["confirm"]>[0][] = [];
	const inputs: Parameters<PluginUI["input"]>[0][] = [];
	let allow = false;
	let setupValues: Record<string, string> | undefined;
	let secretInput: string | undefined;
	let captureMode: string | undefined;
	const ui = {
		notify: async (message: string) => {
			notices.push(message);
		},
		confirm: async (options: Parameters<PluginUI["confirm"]>[0]) => {
			confirmations.push(options);
			return "fields" in options ? setupValues : allow;
		},
		input: async (options: Parameters<PluginUI["input"]>[0]) => {
			inputs.push(options);
			return secretInput;
		},
		select: async () => captureMode,
	};
	const amp = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerTool: (tool: PluginToolDefinition) => {
			tools.set(tool.name, tool);
		},
		registerCommand: () => {},
		registerSkill: async ({ path: skill }: { path: string }) => {
			await readFile(new URL(`../${skill}/SKILL.md`, import.meta.url), "utf8");
		},
		system: { workspaceRoot: null, user: { username: "example-user" } },
		logger: { log: () => {} },
		helpers: {},
	};
	await install(amp as unknown as PluginAPI);
	const fire = async <E extends keyof PluginEventMap>(
		name: E,
		event: PluginEventMap[E],
	) =>
		handlers.get(name)?.(event, {
			thread: event.thread,
			ui,
			logger: amp.logger,
		});
	return {
		server,
		raw,
		path,
		write,
		tools,
		notices,
		confirmations,
		inputs,
		set allow(value: boolean) {
			allow = value;
		},
		set setupValues(value: Record<string, string>) {
			setupValues = value;
		},
		set secretInput(value: string) {
			secretInput = value;
		},
		set captureMode(value: string) {
			captureMode = value;
		},
		start: (
			id = 1,
			thread: `T-${string}` = "T-one",
			message = "Please help with TypeScript",
		) =>
			fire("agent.start", {
				id,
				thread: { id: thread },
				message,
			}) as Promise<AgentStartResult>,
		end: (
			messages: ThreadMessage[],
			id = 1,
			thread: `T-${string}` = "T-one",
			status: AgentEndEvent["status"] = "done",
		) =>
			fire("agent.end", {
				id,
				thread: { id: thread },
				message: "prompt with injected context that must not upload",
				messages,
				status,
			}),
		toolResult: () =>
			fire("tool.result", {
				thread: { id: "T-one" },
				toolUseID: "tool-1",
				tool: "shell_command",
				status: "done",
				input: { command: "sensitive code" },
				output: "sensitive output",
			}),
		call: async (name: string, input: ObjectValue = {}) => {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Missing tool ${name}`);
			return tool.execute(input, {
				ui,
				thread: { id: "T-one" },
				logger: amp.logger,
			} as unknown as Parameters<typeof tool.execute>[1]);
		},
	};
}

test("disabled installation registers setup but performs no network activity", async () => {
	const f = await fixture({ enabled: false });
	expect(await f.start()).toEqual({});
	await f.end([
		{ role: "assistant", id: "a", content: [{ type: "text", text: "reply" }] },
	]);
	await f.toolResult();
	expect(f.server.requests).toHaveLength(0);
	expect(f.tools.has("honcho_setup")).toBe(true);
	expect(await f.call("honcho_get_config")).not.toContain("test-key");
});

test("turn capture excludes injected prompts, thinking and tool payloads, including cancellation", async () => {
	const f = await fixture();
	const start = await f.start();
	expect(start.message?.display).toBe(false);
	expect(start.message?.content).toContain("Prefers concise replies");
	await f.toolResult();
	await f.end(
		[
			{
				role: "user",
				id: 1,
				content: [{ type: "text", text: "injected prompt" }],
			},
			{
				role: "assistant",
				id: "a1",
				content: [
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: "partial answer" },
					{
						type: "tool_use",
						id: "tool",
						name: "shell_command",
						input: { command: "secret body" },
					},
				],
			},
		],
		1,
		"T-one",
		"cancelled",
	);
	expect(f.server.messages.map((message) => message.content)).toEqual([
		"Please help with TypeScript",
		"partial answer",
	]);
	expect(f.server.messages.map((message) => message.peer_id)).toEqual([
		"example-user",
		"amp",
	]);
});

test("concurrent threads and repeated start events keep identities separate", async () => {
	const f = await fixture({ sessionStrategy: "chat-instance" });
	await Promise.all([
		f.start(1, "T-one", "first"),
		f.start(1, "T-two", "second"),
		f.start(1, "T-one", "first"),
	]);
	expect(f.server.messages).toHaveLength(2);
	expect(
		new Set(f.server.messages.map((message) => message.session)).size,
	).toBe(2);
	expect(
		f.server.messages.map((message) => message.metadata.amp_thread_id).sort(),
	).toEqual(["T-one", "T-two"]);
});

test("disabling capture mid-turn stops remaining uploads", async () => {
	const f = await fixture();
	await f.start();
	f.raw.hosts.amp.enabled = false;
	await f.write();
	await f.end([
		{
			role: "assistant",
			id: "a",
			content: [{ type: "text", text: "do not upload" }],
		},
	]);
	expect(f.server.messages).toHaveLength(1);
});

test("network failure never blocks Amp with an exception or leaks remote errors", async () => {
	const f = await fixture();
	f.server.failLookup = true;
	const start = await f.start();
	expect(start.message?.content).toContain("Prefers concise replies");
	expect(f.notices.length).toBe(1);
	expect(f.notices.join(" ")).not.toMatch(/private failure|test-key/);
});

test("opt-in tool capture stores only name and terminal status", async () => {
	const f = await fixture({ saveToolUse: true });
	await f.start();
	await f.toolResult();
	expect(f.server.messages.at(-1)?.content).toBe("[Tool] shell_command: done");
	expect(JSON.stringify(f.server.messages)).not.toContain("sensitive");
});

test("configuration and deletion require human approval and reject secret tool arguments", async () => {
	const f = await fixture();
	const original = await readFile(f.path, "utf8");
	await f.call("honcho_set_config", { settings: { saveMessages: false } });
	expect(await readFile(f.path, "utf8")).toBe(original);
	expect(f.confirmations[0].requireHuman).toBe(true);
	await expect(
		f.call("honcho_set_config", { settings: { apiKey: "do-not-accept" } }),
	).rejects.toThrow();
	await f.call("honcho_delete_conclusion", { id: "fact-one" });
	expect(f.confirmations.at(-1)?.requireHuman).toBe(true);
	expect(f.server.requests.some((request) => request.method === "DELETE")).toBe(
		false,
	);
	f.allow = true;
	await f.call("honcho_set_config", { settings: { saveMessages: false } });
	expect(
		JSON.parse(await readFile(f.path, "utf8")).hosts.amp.saveMessages,
	).toBe(false);
});

test("setup keeps keys in secret UI, changes nothing on refusal and supports recall-only mode", async () => {
	const f = await fixture({ enabled: false });
	await writeFile(f.path, JSON.stringify({ ...f.raw, apiKey: undefined }));
	const original = await readFile(f.path, "utf8");
	f.setupValues = {
		baseUrl: f.server.config.baseUrl,
		workspace: "shared",
		peerName: "example-user",
		aiPeer: "amp",
	};
	f.secretInput = "entered-test-key";
	f.captureMode = "Retrieve memory only";
	await f.call("honcho_setup");
	expect(await readFile(f.path, "utf8")).toBe(original);
	expect(f.inputs[0]).toMatchObject({
		secret: true,
		requireHuman: true,
		fieldName: "HONCHO_API_KEY",
	});
	expect(f.confirmations.every((options) => options.requireHuman)).toBe(true);
	f.allow = true;
	expect(await f.call("honcho_setup")).not.toContain("entered-test-key");
	expect(JSON.parse(await readFile(f.path, "utf8")).hosts.amp).toMatchObject({
		enabled: true,
		saveMessages: false,
		apiKey: "entered-test-key",
	});
	expect(JSON.stringify(f.confirmations)).not.toContain("entered-test-key");
	expect(f.server.requests).toHaveLength(0);
});

test("in-flight turns stay pinned when a later turn changes session strategy", async () => {
	const f = await fixture();
	await f.start(1, "T-one", "first turn");
	const firstSession = f.server.messages[0].session;
	Object.assign(f.raw.hosts.amp, { sessionStrategy: "chat-instance" });
	await f.write();
	await f.start(2, "T-one", "second turn");
	await f.end(
		[
			{
				role: "assistant",
				id: "a1",
				content: [{ type: "text", text: "first answer" }],
			},
		],
		1,
	);
	expect(
		f.server.messages.find((message) => message.content === "first answer")
			?.session,
	).toBe(firstSession);
	expect(
		f.server.messages.find((message) => message.content === "second turn")
			?.session,
	).not.toBe(firstSession);
});

test("setup consent shows the effective workspace under Honcho globalOverride", async () => {
	const f = await fixture({ enabled: false });
	Object.assign(f.raw, { globalOverride: true, workspace: "forced-shared" });
	await f.write();
	f.setupValues = {
		baseUrl: f.server.config.baseUrl,
		workspace: "requested",
		peerName: "example-user",
		aiPeer: "amp",
	};
	f.captureMode = "Capture conversations and retrieve memory";
	await f.call("honcho_setup");
	expect(f.confirmations.at(-1)?.message).toContain("Workspace: forced-shared");
});
