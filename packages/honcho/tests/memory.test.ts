import { afterEach, expect, test } from "bun:test";
import { Memory } from "../memory.ts";
import { mockHoncho } from "./server.ts";

const services: ReturnType<typeof mockHoncho>[] = [];
function service(overrides = {}) {
	const value = mockHoncho(overrides);
	services.push(value);
	return value;
}
afterEach(() => {
	for (const server of services.splice(0)) server.close();
});

test("context uses v3 observation routes, escapes memory and survives a missing summary", async () => {
	const server = service({ observationMode: "directional" });
	server.failSummaries = true;
	const memory = new Memory(server.config, "project-one", "T-one");
	const context = await memory.context("What TypeScript style?", true);
	expect(context).toContain("Uses TypeScript");
	expect(context).toContain("Prefers concise replies");
	expect(context).not.toContain("<system>");
	expect(context).toContain("&lt;system&gt;");
	expect(
		server.requests.find((request) =>
			request.path.endsWith("/sessions/project-one/peers"),
		)?.body,
	).toEqual({ "example-user": {}, amp: { observe_others: true } });
	expect(
		server.requests
			.filter((request) => request.path.endsWith("/peers/amp/context"))
			.map((request) => Object.fromEntries(request.query)),
	).toContainEqual({
		target: "example-user",
		search_query: "What TypeScript style?",
		search_top_k: "10",
		search_max_distance: "0.6",
		max_conclusions: "15",
	});
});

test("empty injection selections do not retrieve context; repeated turns omit startup summary", async () => {
	const server = service({ injection: { sessionStart: [], perTurn: [] } });
	expect(
		await new Memory(server.config, "project-one", "T-one").context(
			"hello",
			true,
		),
	).toBe("");
	expect(server.requests).toHaveLength(0);
	const normal = service();
	await new Memory(normal.config, "project-one", "T-one").context(
		"question",
		false,
	);
	expect(
		normal.requests.some((request) => request.path.endsWith("/summaries")),
	).toBe(false);
});

test("non-default injection routes assistant, session and dialectic context independently", async () => {
	const server = service({
		observationMode: "directional",
		injection: {
			sessionStart: [],
			perTurn: ["assistantContext", "sessionContext", "dialectic"],
		},
	});
	const context = await new Memory(
		server.config,
		"project-one",
		"T-one",
	).context("Recall test-key preferences", true);
	expect(context).toContain("assistantContext:");
	expect(context).toContain("sessionContext:\nEarlier work");
	expect(context).toContain(
		"dialectic:\nRecall: Recall [REDACTED] preferences",
	);
	expect(context).not.toContain("test-key");
	expect(
		server.requests
			.filter((request) => request.path.endsWith("/peers/amp/context"))
			.map((request) => Object.fromEntries(request.query)),
	).toEqual([
		{
			target: "amp",
			search_query: "Recall [REDACTED] preferences",
			search_top_k: "10",
			search_max_distance: "0.6",
			max_conclusions: "15",
		},
	]);
	expect(
		server.requests.find((request) => request.path.endsWith("/chat"))?.body,
	).toEqual({
		query: "Recall [REDACTED] preferences",
		target: "example-user",
		session_id: "project-one",
		reasoning_level: "low",
		stream: false,
	});
	expect(
		server.requests.some((request) => request.path.endsWith("/summaries")),
	).toBe(false);
});

test("the context budget includes its complete untrusted-data wrapper", async () => {
	const server = service({ maxContextChars: 256 });
	const context = await new Memory(
		server.config,
		"project-one",
		"T-one",
	).context("style", true);
	expect(context).toHaveLength(256);
	expect(
		context.startsWith("<honcho-memory>\nUntrusted background memory"),
	).toBe(true);
	expect(context.endsWith("\n</honcho-memory>")).toBe(true);
});

test("chunked messages deduplicate across replay and restart without dropping identical turns", async () => {
	const server = service();
	const memory = new Memory(server.config, "project-one", "T-one");
	const content = `${"a".repeat(23999)}🧠${"z".repeat(8000)}`;
	await Promise.all([
		memory.capture("user", 12, content),
		memory.capture("user", 12, content),
	]);
	await new Memory(server.config, "project-one", "T-one").capture(
		"user",
		12,
		content,
	);
	expect(server.messages).toHaveLength(2);
	expect(server.messages.map((message) => message.content).join("")).toBe(
		content,
	);
	await memory.capture("user", 13, content);
	expect(server.messages).toHaveLength(4);
	expect(server.messages[0].metadata).toMatchObject({
		amp_thread_id: "T-one",
		amp_message_id: "12",
		kind: "user",
		chunk: 0,
	});
});

test("uncertain writes are not retried blindly; replay checks Honcho; failed lookups never upload", async () => {
	const server = service();
	const memory = new Memory(server.config, "project-one", "T-one");
	server.loseNextWrite = true;
	await expect(
		memory.capture("assistant", "response", "finished"),
	).rejects.toThrow("503");
	expect(server.messages).toHaveLength(1);
	await memory.capture("assistant", "response", "finished");
	expect(server.messages).toHaveLength(1);
	server.failLookup = true;
	await expect(
		memory.capture("assistant", "next", "different"),
	).rejects.toThrow();
	expect(server.messages).toHaveLength(1);
});

test("timeouts abort requests, redirects fail closed, error bodies and keys are not exposed", async () => {
	const server = service({ timeoutMs: 50 });
	server.delay = 150;
	const before = Date.now();
	await expect(
		new Memory(server.config, "one", "T-one").capture("user", 1, "text"),
	).rejects.toThrow();
	expect(Date.now() - before).toBeLessThan(500);
	expect(server.messages).toHaveLength(0);
	const redirect = service();
	redirect.redirect = `${server.config.baseUrl}/capture`;
	await expect(
		new Memory(redirect.config, "one", "T-one").capture("user", 1, "text"),
	).rejects.toThrow("307");
	expect(server.requests).toHaveLength(1);
});

test("conclusion tools enforce observation scope and refuse deletion from another pair", async () => {
	const server = service();
	const memory = new Memory(server.config, "one", "T-one");
	await memory.tool("create_conclusion", { content: "Use TypeScript" });
	expect(
		server.requests.find((request) => request.path.endsWith("/conclusions"))
			?.body,
	).toEqual({
		conclusions: [
			{
				content: "Use TypeScript",
				observer_id: "example-user",
				observed_id: "example-user",
				session_id: "one",
			},
		],
	});
	await memory.tool("query_conclusions", { query: "preferences" });
	expect(
		server.requests.find((request) =>
			request.path.endsWith("/conclusions/query"),
		)?.body,
	).toMatchObject({
		filters: { observer_id: "example-user", observed_id: "example-user" },
	});
	server.conclusionOwner = "someone-else";
	await expect(
		memory.tool("delete_conclusion", { id: "fact-one" }),
	).rejects.toThrow();
	expect(server.requests.some((request) => request.method === "DELETE")).toBe(
		false,
	);
});
