import { build } from "esbuild";
import { chmod } from "node:fs/promises";
await build({
  entryPoints: { cli: "src/cli.js", tunnel: "src/plugin.js" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20.19",
});
await chmod("dist/cli.js", 0o755);
