import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.ts";

const exec = promisify(execFile);
export interface Identity {
	sessionId: string;
	git?: { branch: string; head: string; dirty: boolean };
}
export async function sessionIdentity(
	cwd: string | null,
	thread: string,
	config: Config,
): Promise<Identity> {
	let root = cwd ? await realpath(cwd) : "no-workspace";
	let git: Identity["git"];
	if (cwd) {
		const run = async (...args: string[]) =>
			(
				await exec("git", ["-C", cwd, ...args], {
					timeout: 1500,
					maxBuffer: 1024 * 1024,
				})
			).stdout.trim();
		try {
			const common = await run(
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			);
			root = dirname(resolve(cwd, common));
			const [branch, head, status] = await Promise.all([
				run("symbolic-ref", "--short", "HEAD").catch(() => "detached"),
				run("rev-parse", "HEAD").catch(() => "unborn"),
				config.saveGitEvents
					? run("status", "--porcelain", "--untracked-files=no")
					: Promise.resolve(""),
			]);
			git = { branch, head, dirty: status.length > 0 };
		} catch {
			/* Not a git repository. */
		}
	}
	const branch =
		git?.branch === "detached" ? git.head : (git?.branch ?? "no-branch");
	const scope =
		config.sessionStrategy === "chat-instance"
			? thread
			: `${root}${config.sessionStrategy === "git-branch" ? `\0${branch}` : ""}`;
	const hash = createHash("sha256")
		.update(
			JSON.stringify([scope, config.sessionPeerPrefix ? config.peerName : ""]),
		)
		.digest("hex")
		.slice(0, 16);
	const label = (
		config.sessionStrategy === "chat-instance" ? "thread" : basename(root)
	)
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.slice(0, 24);
	const prefix = config.sessionPeerPrefix
		? `${config.peerName.slice(0, 50)}-`
		: "";
	return { sessionId: `${prefix}${label}-${hash}`, git };
}
