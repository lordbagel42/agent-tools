import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ObjectValue = Record<string, unknown>;
export const startComponents = [
	"directives",
	"summary",
	"peerCard",
	"peerRepresentation",
	"briefing",
] as const;
export const turnComponents = [
	"userContext",
	"assistantContext",
	"sessionContext",
	"dialectic",
] as const;
export interface Config {
	enabled: boolean;
	apiKey: string;
	baseUrl: string;
	workspace: string;
	peerName: string;
	aiPeer: string;
	sessionStrategy: "per-directory" | "git-branch" | "chat-instance";
	sessionPeerPrefix: boolean;
	observationMode: "unified" | "directional";
	saveMessages: boolean;
	saveToolUse: boolean;
	saveGitEvents: boolean;
	redactPatterns: string[];
	timeoutMs: number;
	maxContextChars: number;
	injection: {
		sessionStart: (typeof startComponents)[number][];
		perTurn: (typeof turnComponents)[number][];
		searchTopK: number;
		maxConclusions: number;
		searchMaxDistance: number;
		sessionContextTokens: number;
	};
}

export function object(value: unknown): ObjectValue {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected a configuration object");
	return value as ObjectValue;
}

function text(value: unknown, fallback: string): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !value.trim())
		throw new Error("Expected a non-empty configuration string");
	return value.trim();
}
function bool(value: unknown, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean")
		throw new Error("Expected a configuration boolean");
	return value;
}
function choice<T extends string>(
	value: unknown,
	choices: readonly T[],
	fallback: T,
): T {
	if (value === undefined) return fallback;
	if (!choices.includes(value as T))
		throw new Error("Unsupported configuration choice");
	return value as T;
}
function selection<T extends string>(
	value: unknown,
	choices: readonly T[],
	fallback: T[],
): T[] {
	if (value === undefined) return fallback;
	if (!Array.isArray(value)) throw new Error("Expected component array");
	return [...new Set(value.map((item) => choice(item, choices, fallback[0])))];
}
function number(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
): number {
	if (value === undefined) return fallback;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < min ||
		value > max
	)
		throw new Error("Configuration number outside allowed range");
	return value;
}
function identifier(value: unknown, fallback: string): string {
	const result = text(value, fallback);
	if (!/^[a-zA-Z0-9_-]{1,100}$/.test(result))
		throw new Error(
			"Honcho identity must contain 1–100 letters, digits, underscores or hyphens",
		);
	return result;
}

export function resolveConfig(
	raw: ObjectValue = {},
	env: NodeJS.ProcessEnv = process.env,
	username = "user",
): Config {
	const host = object(object(raw.hosts).amp);
	const merged = { ...raw, ...host };
	const injection = { ...object(raw.injection), ...object(host.injection) };
	const endpoint = object(merged.endpoint);
	const target = text(
		endpoint.baseUrl ?? endpoint.environment ?? env.HONCHO_ENDPOINT,
		"production",
	);
	const url = new URL(
		target === "production"
			? "https://api.honcho.dev/v3"
			: target === "local"
				? "http://localhost:8000/v3"
				: target,
	);
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(
			"Honcho endpoint must be HTTPS (or loopback HTTP), without credentials, query or fragment",
		);
	url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v3$/, "")}/v3`;
	const patterns = merged.redactPatterns ?? [];
	if (
		!Array.isArray(patterns) ||
		patterns.some((item) => typeof item !== "string")
	)
		throw new Error("redactPatterns must contain regex strings");
	for (const pattern of patterns) new RegExp(pattern, "g");
	const peerName = identifier(
		merged.peerName ?? env.HONCHO_PEER_NAME,
		username,
	);
	const aiPeer = identifier(host.aiPeer ?? env.HONCHO_AI_PEER, "amp");
	if (peerName === aiPeer)
		throw new Error("User and assistant peer identities must differ");
	return {
		enabled:
			(host.enabled !== undefined
				? bool(host.enabled, false)
				: env.HONCHO_AMP_ENABLED === "true") &&
			raw.enabled !== false &&
			env.HONCHO_ENABLED !== "false" &&
			env.HONCHO_AMP_ENABLED !== "false",
		apiKey: text(host.apiKey ?? env.HONCHO_API_KEY ?? raw.apiKey, ""),
		baseUrl: url.toString().replace(/\/$/, ""),
		workspace: identifier(
			raw.globalOverride === true
				? raw.workspace
				: (host.workspace ?? env.HONCHO_WORKSPACE),
			"amp",
		),
		peerName,
		aiPeer,
		sessionStrategy: choice(
			merged.sessionStrategy,
			["per-directory", "git-branch", "chat-instance"],
			"per-directory",
		),
		sessionPeerPrefix: bool(merged.sessionPeerPrefix, true),
		observationMode: choice(
			merged.observationMode,
			["unified", "directional"],
			"unified",
		),
		saveMessages: bool(
			merged.saveMessages,
			env.HONCHO_SAVE_MESSAGES !== "false",
		),
		saveToolUse: bool(merged.saveToolUse, env.HONCHO_SAVE_TOOL_USE === "true"),
		saveGitEvents: bool(
			merged.saveGitEvents,
			env.HONCHO_SAVE_GIT_EVENTS === "true",
		),
		redactPatterns: patterns,
		timeoutMs: number(merged.timeoutMs, 4000, 50, 30000),
		maxContextChars: number(merged.maxContextChars, 12000, 256, 50000),
		injection: {
			sessionStart: selection(injection.sessionStart, startComponents, [
				"directives",
				"summary",
				"peerCard",
			]),
			perTurn: selection(injection.perTurn, turnComponents, ["userContext"]),
			searchTopK: number(injection.searchTopK, 10, 1, 100),
			maxConclusions: number(injection.maxConclusions, 15, 1, 100),
			searchMaxDistance: number(injection.searchMaxDistance, 0.6, 0, 1),
			sessionContextTokens: number(
				injection.sessionContextTokens,
				1500,
				1,
				10000,
			),
		},
	};
}

export function configPath(): string {
	return (
		process.env.HONCHO_CONFIG_PATH ?? join(homedir(), ".honcho", "config.json")
	);
}
async function readConfig(path: string): Promise<ObjectValue> {
	try {
		return object(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(
			"Cannot read Honcho configuration; fix it before enabling memory",
		);
	}
}
export async function loadConfig(
	path = configPath(),
	env = process.env,
	username = "user",
): Promise<Config> {
	return resolveConfig(await readConfig(path), env, username);
}
async function mergedConfig(
	path: string,
	update: ObjectValue,
): Promise<ObjectValue> {
	const raw = await readConfig(path);
	const hosts = object(raw.hosts);
	return {
		...raw,
		hosts: { ...hosts, amp: { ...object(hosts.amp), ...update } },
	};
}
export async function previewAmpConfig(
	path: string,
	update: ObjectValue,
	username: string,
): Promise<Config> {
	return resolveConfig(await mergedConfig(path, update), process.env, username);
}
export async function saveAmpConfig(
	path: string,
	update: ObjectValue,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const lock = await open(`${path}.lock`, "wx", 0o600);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const next = await mergedConfig(path, update);
		resolveConfig(next);
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await lock.close();
		await rm(`${path}.lock`, { force: true });
		await rm(temporary, { force: true });
	}
}

export function redact(content: string, config: Config): string {
	let result = config.apiKey
		? content.split(config.apiKey).join("[REDACTED]")
		: content;
	for (const pattern of [
		/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
		/\b(?:hch-|sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}/g,
		/\bAKIA[A-Z0-9]{16}\b/g,
		/\bBearer\s+[^\s"'<>]+/gi,
		/\b(?:api[_-]?key|password|secret|access[_-]?token|authorization)["']?\s*[=:]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'<>]+)/gi,
		...config.redactPatterns.map((pattern) => new RegExp(pattern, "g")),
	])
		result = result.replace(pattern, "[REDACTED]");
	return result;
}
