import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import plugin from "../dist/switchboard.js";

test("disabled without configuration; pending answers never imply consent and other sessions are rejected", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "switchboard-test-"));
	const keys = [
		"AMP_SWITCHBOARD_CONFIG",
		"PHONE_PLATFORM_URL",
		"PHONE_PLATFORM_TOKEN_FILE",
	];
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env.AMP_SWITCHBOARD_CONFIG = join(root, "missing.json");
	t.after(async () => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		await rm(root, { recursive: true, force: true });
	});
	await plugin({
		registerTool() {
			assert.fail("Disabled plugin registered a tool");
		},
	});
	const thread = "T-00000000-0000-0000-0000-000000000031";
	const requests = [];
	const server = createServer(async (req, res) => {
		assert.equal(req.headers.authorization, "Bearer synthetic-token");
		assert.equal(req.url, "/api/v1/phone/rpc");
		let body = "";
		for await (const chunk of req) body += chunk;
		const { method, params } = JSON.parse(body);
		requests.push({ method, params });
		let result;
		if (method === "amp_poll")
			result = {
				sessions: { [thread]: { id: 23, extension: "100" } },
				commands: [],
			};
		else if (method === "ask") result = { id: "question-1" };
		else
			result = {
				session_id: params.question_id === "other" ? 42 : 23,
				state: "pending",
				answers: [],
			};
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ result }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const token = join(root, "token");
	await writeFile(token, "synthetic-token", { mode: 0o600 });
	process.env.PHONE_PLATFORM_URL = `http://127.0.0.1:${server.address().port}`;
	process.env.PHONE_PLATFORM_TOKEN_FILE = token;
	const tools = new Map();
	let dispose;
	await plugin({
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on() {},
		onDispose(handler) {
			dispose = handler;
		},
		logger: { log() {} },
	});
	t.after(() => dispose());
	const ctx = { thread: { id: thread } };
	const answer = JSON.parse(
		await tools
			.get("phone_ask_user")
			.execute({ question: "Continue?", options: ["Yes", "No"] }, ctx),
	);
	assert.equal(answer.state, "pending");
	assert.match(answer.instructions, /Pending means no answer or approval/);
	await assert.rejects(
		tools.get("phone_get_answer").execute({ question_id: "other" }, ctx),
		/another phone session/,
	);
	assert.equal(requests.filter((r) => r.method === "ask").length, 1);
	assert.deepEqual(
		requests.find((r) => r.method === "ask").params.questions[0].options,
		[
			{ label: "Yes", description: "" },
			{ label: "No", description: "" },
		],
	);
	assert.equal(
		requests.filter((r) => r.params.question_id === "other").length,
		1,
	);
	dispose();
});
