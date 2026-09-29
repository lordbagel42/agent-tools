import type { PluginAPI, PluginUI, ThreadID } from "@ampcode/plugin";
import {
	configPath,
	loadConfig,
	type ObjectValue,
	object,
	previewAmpConfig,
	redact,
	saveAmpConfig,
} from "./config.ts";
import { Memory } from "./memory.ts";
import { type Identity, sessionIdentity } from "./session.ts";

export const description =
	"Honcho persistent memory: opt-in conversation capture, relevant context, recall tools, and preference interviews. Coexists with the Honcho MCP.";

interface Route {
	fingerprint: string;
	memory: Memory;
	started: boolean;
}
const configurable = [
	"enabled",
	"saveMessages",
	"saveToolUse",
	"saveGitEvents",
	"sessionStrategy",
	"sessionPeerPrefix",
	"observationMode",
	"injection",
	"timeoutMs",
	"maxContextChars",
	"redactPatterns",
];

export default async function (amp: PluginAPI) {
	const path = configPath();
	const username = amp.system.user?.username ?? "user";
	const cwd = amp.system.workspaceRoot
		? amp.helpers.filePathFromURI(amp.system.workspaceRoot)
		: null;
	const routes = new Map<ThreadID, Route>();
	const turns = new Map<string, { memory: Memory; prompt: string }>();
	const gitStates = new Map<ThreadID, Identity["git"]>();
	const warned = new Set<ThreadID>();
	const config = () => loadConfig(path, process.env, username);
	const turnKey = (thread: ThreadID, id: string | number) => `${thread}/${id}`;
	const warn = async (thread: ThreadID, ui: PluginUI) => {
		if (warned.has(thread)) return;
		warned.add(thread);
		const message =
			"Honcho memory is unavailable or an upload failed. Amp will continue; use honcho_get_config to check configuration. Some messages may not be saved.";
		amp.logger.log(message);
		try {
			await ui.notify(message);
		} catch {
			/* Headless clients need no dialog. */
		}
	};
	const routeFor = async (thread: ThreadID) => {
		const settings = await config();
		if (!settings.enabled) return undefined;
		const identity = await sessionIdentity(cwd, thread, settings);
		const fingerprint = JSON.stringify([settings, identity.sessionId]);
		let route = routes.get(thread);
		if (route?.fingerprint !== fingerprint) {
			route = {
				fingerprint,
				memory: new Memory(settings, identity.sessionId, thread),
				started: false,
			};
			routes.set(thread, route);
		}
		return { route, identity };
	};
	const getMemory = async (thread: ThreadID) => {
		const state = await routeFor(thread);
		if (!state)
			throw new Error(
				"Honcho is disabled. Run honcho_setup to configure and enable it.",
			);
		return state.route.memory;
	};

	amp.on("session.start", (event) => {
		const route = routes.get(event.thread.id);
		if (route) route.started = false;
		warned.delete(event.thread.id);
	});
	amp.on("agent.start", async (event, ctx) => {
		try {
			const state = await routeFor(event.thread.id);
			if (!state) return {};
			const { route, identity } = state;
			const { memory } = route;
			turns.set(turnKey(event.thread.id, event.id), {
				memory,
				prompt: event.message,
			});
			const signal = AbortSignal.timeout(memory.config.timeoutMs);
			const priorGit = gitStates.get(event.thread.id);
			gitStates.set(event.thread.id, identity.git);
			const gitChanged =
				priorGit &&
				identity.git &&
				JSON.stringify(priorGit) !== JSON.stringify(identity.git);
			const results = await Promise.allSettled([
				memory.context(event.message, !route.started, signal),
				memory.capture("user", event.id, event.message, signal),
				memory.config.saveGitEvents && gitChanged
					? memory.capture(
							"git",
							event.id,
							`[Git] ${JSON.stringify(identity.git)}`,
							signal,
						)
					: Promise.resolve(),
			]);
			if (results.some((result) => result.status === "rejected"))
				await warn(event.thread.id, ctx.ui);
			const context = results[0];
			if (context.status !== "fulfilled") return {};
			route.started = true;
			return context.value
				? { message: { content: context.value, display: false } }
				: {};
		} catch {
			await warn(event.thread.id, ctx.ui);
			return {};
		}
	});
	amp.on("agent.end", async (event, ctx) => {
		const key = turnKey(event.thread.id, event.id);
		const turn = turns.get(key);
		turns.delete(key);
		if (!turn) return; // Never backfill history on reload or adopt another turn's session.
		try {
			const current = await config();
			if (!current.enabled || !current.saveMessages) return;
			const signal = AbortSignal.timeout(current.timeoutMs);
			await turn.memory.capture("user", event.id, turn.prompt, signal);
			for (const message of event.messages) {
				if (message.role !== "assistant") continue;
				const text = message.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("\n");
				await turn.memory.capture("assistant", message.id, text, signal);
			}
		} catch {
			await warn(event.thread.id, ctx.ui);
		}
	});
	amp.on("tool.result", async (event, ctx) => {
		try {
			const settings = await config();
			const route = routes.get(event.thread.id);
			if (
				!settings.enabled ||
				!settings.saveMessages ||
				!settings.saveToolUse ||
				!route?.memory.config.saveToolUse
			)
				return;
			await route.memory.capture(
				"tool",
				event.toolUseID,
				`[Tool] ${event.tool}: ${event.status}`,
			);
		} catch {
			await warn(event.thread.id, ctx.ui);
		}
	});

	const status = async () => {
		const { apiKey, ...settings } = await config();
		return JSON.stringify(
			{
				...settings,
				hasApiKey: Boolean(apiKey),
				configPath: path,
				note: "Local configuration only; this does not verify the connection. MCP credentials are separate.",
			},
			null,
			2,
		);
	};
	const setup = async (ui: PluginUI) => {
		const current = await config();
		const values = await ui.confirm({
			title: "Configure Honcho for Amp",
			requireHuman: true,
			message:
				"Match your existing MCP workspace and peer names to share memory. This changes only hosts.amp in the local Honcho config.",
			fields: [
				{
					name: "baseUrl",
					label: "Honcho API endpoint",
					value: current.baseUrl,
				},
				{ name: "workspace", label: "Workspace", value: current.workspace },
				{ name: "peerName", label: "Your peer name", value: current.peerName },
				{ name: "aiPeer", label: "Assistant peer name", value: current.aiPeer },
			],
		});
		if (!values) return "Setup cancelled.";
		const apiKey =
			current.apiKey ||
			(await ui.input({
				title: "Honcho API key",
				fieldName: "HONCHO_API_KEY",
				secret: true,
				requireHuman: true,
				helpText:
					"Stored locally in ~/.honcho/config.json with mode 0600, never returned to the agent. Remote MCP credentials cannot be reused automatically.",
			}));
		if (!apiKey) return "Setup cancelled; no key supplied.";
		const mode = await ui.select({
			title: "Honcho capture mode",
			requireHuman: true,
			options: [
				"Capture conversations and retrieve memory",
				"Retrieve memory only",
			],
			message:
				"Both modes send prompt text to Honcho for relevance. Capture also sends user/assistant text from future turns across projects on this executor. Thinking, attachments, tool inputs/outputs and old transcripts are excluded. Known secrets are scrubbed, but other private information can still be sent.",
		});
		if (!mode) return "Setup cancelled.";
		const update = {
			apiKey,
			workspace: values.workspace,
			peerName: values.peerName,
			aiPeer: values.aiPeer,
			endpoint: { baseUrl: values.baseUrl },
			enabled: true,
			saveMessages: mode === "Capture conversations and retrieve memory",
			saveToolUse: false,
			saveGitEvents: false,
		};
		const effective = await previewAmpConfig(path, update, username);
		if (
			!(await ui.confirm({
				title: "Enable Honcho for Amp?",
				requireHuman: true,
				message: `Destination: ${effective.baseUrl}\nWorkspace: ${effective.workspace}\nUser: ${effective.peerName}\nAssistant: ${effective.aiPeer}\nMode: ${mode}\nThis enables external memory access for future turns. Existing globalOverride and kill switches apply. It does not modify the existing MCP connection.`,
			}))
		)
			return "Setup cancelled.";
		await saveAmpConfig(path, update);
		return "Honcho configuration saved. It takes effect on the next turn; the live connection has not been tested. Root/environment kill switches still apply.";
	};
	amp.registerCommand(
		"honcho-setup",
		{ title: "Setup", category: "Honcho" },
		async (ctx) => {
			await ctx.ui.notify(await setup(ctx.ui));
		},
	);
	amp.registerCommand(
		"honcho-status",
		{ title: "Status", category: "Honcho" },
		async (ctx) => {
			await ctx.ui.notify(await status());
		},
	);
	amp.registerTool({
		name: "honcho_setup",
		description:
			"Configure native Honcho memory using human-only dialogs, including secret API-key entry. Never pass a key in a tool argument.",
		inputSchema: { type: "object", additionalProperties: false },
		execute: async (_input, ctx) => setup(ctx.ui),
	});
	amp.registerTool({
		name: "honcho_get_config",
		description:
			"Show native Honcho configuration and enablement without revealing API keys or making network requests.",
		inputSchema: { type: "object", additionalProperties: false },
		execute: status,
	});
	amp.registerTool({
		name: "honcho_set_config",
		description:
			"Change native Honcho capture/injection settings after human approval. Routing and credentials must use honcho_setup.",
		inputSchema: {
			type: "object",
			required: ["settings"],
			properties: {
				settings: {
					type: "object",
					description: `Allowed keys: ${configurable.join(", ")}`,
				},
			},
			additionalProperties: false,
		},
		async execute(input, ctx) {
			const settings = object(input.settings);
			if (Object.keys(settings).some((key) => !configurable.includes(key)))
				throw new Error(
					"Unsupported setting; credentials and routing must use honcho_setup",
				);
			const effective = await previewAmpConfig(path, settings, username);
			if (
				!(await ctx.ui.confirm({
					title: "Change Honcho settings?",
					requireHuman: true,
					message: `Destination: ${effective.baseUrl}\nWorkspace: ${effective.workspace}\nUser: ${effective.peerName}\nEnabling capture sends future user/assistant text to Honcho across projects. Retrieval sends prompts for relevance. Proposed settings:\n\n${JSON.stringify(settings, null, 2)}`,
				}))
			)
				return "No changes made.";
			await saveAmpConfig(path, settings);
			return status();
		},
	});
	const tools: [string, string, ObjectValue, string[]][] = [
		[
			"search",
			"Search this session's messages and the user's conclusions.",
			{ query: { type: "string" } },
			["query"],
		],
		[
			"chat",
			"Ask Honcho a reasoned question about the user in this session.",
			{ query: { type: "string" } },
			["query"],
		],
		[
			"remember",
			"Recall answers to up to five questions in parallel.",
			{
				questions: {
					type: "array",
					minItems: 1,
					maxItems: 5,
					items: { type: "string" },
				},
			},
			["questions"],
		],
		[
			"create_conclusion",
			"Save a confirmed stable preference or fact about the user. Do not store secrets or guesses.",
			{ content: { type: "string" } },
			["content"],
		],
		[
			"list_conclusions",
			"List conclusions in the configured observation pair, with pagination.",
			{ page: { type: "integer", minimum: 1 } },
			[],
		],
		[
			"query_conclusions",
			"Search conclusions in the configured observation pair.",
			{ query: { type: "string" } },
			["query"],
		],
		[
			"delete_conclusion",
			"Delete one conclusion in the configured observation pair after human confirmation.",
			{ id: { type: "string" } },
			["id"],
		],
		[
			"get_briefing",
			"Retrieve the session summary and user peer card.",
			{},
			[],
		],
		["get_context", "Retrieve the user representation and peer card.", {}, []],
		[
			"get_representation",
			"Retrieve the user's derived representation.",
			{},
			[],
		],
	];
	for (const [name, description, properties, required] of tools)
		amp.registerTool({
			name: `honcho_${name}`,
			description,
			inputSchema: {
				type: "object",
				properties: properties as Record<string, object>,
				required,
				additionalProperties: false,
			},
			async execute(input, ctx) {
				if (
					name === "delete_conclusion" &&
					!(await ctx.ui.confirm({
						title: "Delete Honcho conclusion?",
						message: `Conclusion ID: ${String(input.id)}`,
						requireHuman: true,
					}))
				)
					return "Deletion cancelled.";
				const memory = await getMemory(ctx.thread.id);
				const result = await memory.tool(name, input);
				return redact(JSON.stringify(result ?? null), memory.config);
			},
		});
	await amp.registerSkill({ path: "skills/using-memory" });
}
