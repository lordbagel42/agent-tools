import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, redact, resolveConfig, saveAmpConfig } from "../config.ts";
import { sessionIdentity } from "../session.ts";

const dirs: string[] = [];
async function temporary() {
	const dir = await mkdtemp(join(tmpdir(), "amp-honcho-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

test("existing Claude credentials and enabled flag do not authorize Amp capture", () => {
	const config = resolveConfig(
		{
			apiKey: "secret",
			enabled: true,
			hosts: { claude_code: { enabled: true } },
		},
		{},
		"example-user",
	);
	expect(config.enabled).toBe(false);
	expect(config.workspace).toBe("amp");
	expect(config.peerName).toBe("example-user");
});

test("Amp overrides preserve false and empty injection selections; root kill switch wins", () => {
	const raw = {
		saveMessages: true,
		workspace: "legacy",
		injection: { sessionStart: ["summary"], perTurn: ["userContext"] },
		hosts: {
			amp: {
				enabled: true,
				workspace: "shared",
				saveMessages: false,
				injection: { perTurn: [] },
			},
		},
	};
	const config = resolveConfig(raw, {}, "example-user");
	expect(config.enabled).toBe(true);
	expect(config.saveMessages).toBe(false);
	expect(config.workspace).toBe("shared");
	expect(config.injection).toMatchObject({
		sessionStart: ["summary"],
		perTurn: [],
	});
	expect(
		resolveConfig({ ...raw, enabled: false }, {}, "example-user").enabled,
	).toBe(false);
	expect(
		resolveConfig(raw, { HONCHO_ENABLED: "false" }, "example-user").enabled,
	).toBe(false);
});

test("config persists only Amp settings with private permissions and preserves other hosts", async () => {
	const path = join(await temporary(), "config.json");
	await writeFile(
		path,
		JSON.stringify({
			peerName: "existing",
			hosts: {
				claude_code: { workspace: "old" },
				amp: { apiKey: "private", enabled: true },
			},
		}),
	);
	await saveAmpConfig(path, { workspace: "new", saveMessages: false });
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
		peerName: "existing",
		hosts: {
			claude_code: { workspace: "old" },
			amp: {
				apiKey: "private",
				enabled: true,
				workspace: "new",
				saveMessages: false,
			},
		},
	});
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect((await loadConfig(path, {}, "example-user")).peerName).toBe(
		"existing",
	);
	await writeFile(path, "not json");
	await expect(loadConfig(path, {}, "example-user")).rejects.toThrow();
	await expect(saveAmpConfig(path, { enabled: false })).rejects.toThrow();
	expect(await readFile(path, "utf8")).toBe("not json");
});

test("rejects unsafe endpoints, bad identifiers, invalid regexes and unknown injection choices", () => {
	for (const baseUrl of [
		"https://user:pass@example.com",
		"http://example.com",
		"file:///tmp/key",
		"https://example.com?key=secret",
	]) {
		expect(() =>
			resolveConfig({ endpoint: { baseUrl } }, {}, "example-user"),
		).toThrow();
	}
	expect(
		resolveConfig(
			{ endpoint: { baseUrl: "http://127.0.0.1:8000/v3/" } },
			{},
			"example-user",
		).baseUrl,
	).toBe("http://127.0.0.1:8000/v3");
	expect(() =>
		resolveConfig({ peerName: "../../escape" }, {}, "example-user"),
	).toThrow();
	expect(() =>
		resolveConfig({ redactPatterns: ["["] }, {}, "example-user"),
	).toThrow();
	expect(() =>
		resolveConfig({ injection: { perTurn: ["madeUp"] } }, {}, "example-user"),
	).toThrow();
});

test("redacts configured literal key, bearer tokens, assignment values and custom secrets", () => {
	const config = resolveConfig(
		{ apiKey: "literal-key", redactPatterns: ["ACME_[0-9]+"] },
		{},
		"example-user",
	);
	const result = redact(
		"literal-key Authorization: Bearer abc.def.ghi password=hidden ACME_123 keep this",
		config,
	);
	expect(result).not.toMatch(/literal-key|abc\.def|hidden|ACME_123/);
	expect(result).toContain("keep this");
});

test("directory sessions handle nested directories, linked worktrees and basename collisions", async () => {
	const base = await temporary();
	const repo = join(base, "main");
	await mkdir(join(repo, "nested"), { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
	git("init", "-b", "main");
	git(
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"--allow-empty",
		"-m",
		"initial",
	);
	const worktree = join(base, "feature");
	git("worktree", "add", "-b", "feature/one", worktree);
	const config = resolveConfig({}, {}, "example-user");
	const main = await sessionIdentity(repo, "T-one", config);
	expect(
		(await sessionIdentity(join(repo, "nested"), "T-two", config)).sessionId,
	).toBe(main.sessionId);
	expect((await sessionIdentity(worktree, "T-two", config)).sessionId).toBe(
		main.sessionId,
	);
	const other = join(base, "elsewhere", "main");
	await mkdir(other, { recursive: true });
	expect((await sessionIdentity(other, "T-one", config)).sessionId).not.toBe(
		main.sessionId,
	);
	const branch = { ...config, sessionStrategy: "git-branch" as const };
	expect((await sessionIdentity(worktree, "T-one", branch)).sessionId).not.toBe(
		(await sessionIdentity(repo, "T-one", branch)).sessionId,
	);
	const chat = { ...config, sessionStrategy: "chat-instance" as const };
	expect((await sessionIdentity(repo, "T-one", chat)).sessionId).not.toBe(
		(await sessionIdentity(repo, "T-two", chat)).sessionId,
	);
	expect((await sessionIdentity(repo, "T-one", chat)).sessionId).toBe(
		(await sessionIdentity(worktree, "T-one", chat)).sessionId,
	);
});

test("long peer names do not collide after session name truncation", async () => {
	const dir = await temporary();
	const prefix = "a".repeat(60);
	const one = resolveConfig({ peerName: `${prefix}one` }, {}, "example-user");
	const two = resolveConfig({ peerName: `${prefix}two` }, {}, "example-user");
	expect((await sessionIdentity(dir, "T-one", one)).sessionId).not.toBe(
		(await sessionIdentity(dir, "T-one", two)).sessionId,
	);
});

test("redaction covers quoted JSON values with spaces before chunking", () => {
	const password = ["private", "phrase"].join(" ");
	const input = JSON.stringify({ password });
	expect(redact(input, resolveConfig({}, {}, "example-user"))).not.toContain(
		password,
	);
});
