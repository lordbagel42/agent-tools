import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("./", import.meta.url);
const output = new URL("dist/honcho/", root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
	absWorkingDir: fileURLToPath(root),
	entryPoints: ["index.ts"],
	outfile: fileURLToPath(new URL("index.js", output)),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "es2022",
	external: ["@ampcode/plugin"],
});
await cp(new URL("skills/", root), new URL("skills/", output), {
	recursive: true,
});
