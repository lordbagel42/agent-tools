import { build } from "esbuild";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

await mkdir("dist", { recursive: true });
const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  legalComments: "eof",
};
await build({
  ...common,
  entryPoints: { daemon: "src/main.js", cli: "src/cli.js" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await build({
  ...common,
  entryPoints: ["plugin.js"],
  outfile: "dist/portal.js",
});
let revision = "uncommitted";
try {
  revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  /* Initial build before first commit. */
}
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
  "dist/release.json",
  JSON.stringify({ version: pkg.version, revision }) + "\n",
);
await Promise.all(
  ["dist/daemon.mjs", "dist/cli.mjs"].map((path) => chmod(path, 0o755)),
);
console.log("Built portal CLI, foreground server and Amp plugin in dist/");
