import { spawnSync } from "node:child_process";

// Fixtures must never inherit live Honcho credentials, destinations, or kill switches.
const env = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("HONCHO_")),
);
const result = spawnSync("bun", ["test", "tests"], {
	cwd: new URL("./", import.meta.url),
	env,
	stdio: "inherit",
});
if (result.error) {
	console.error("Bun is required for tests; see README.md for provisioning.");
}
process.exitCode = result.status ?? 1;
