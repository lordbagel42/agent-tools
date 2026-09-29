import { mkdir, readFile, writeFile } from "node:fs/promises";

// Both modules use only Node built-ins; concatenate to make a self-contained plugin.
const core = await readFile(
  new URL("./src/manager.js", import.meta.url),
  "utf8",
);
const plugin = await readFile(
  new URL("./src/plugin.js", import.meta.url),
  "utf8",
);
await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
await writeFile(
  new URL("./dist/tools.js", import.meta.url),
  core +
    "\n" +
    plugin.replace(
      /^import \{ manage \} from ['"]\.\/manager\.js['"];?\s*/m,
      "",
    ),
);
