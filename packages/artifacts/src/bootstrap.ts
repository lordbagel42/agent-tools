import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bootstrapOwner } from "./auth";
import { configuration } from "./config";
import { ArtifactStore } from "./store";

export async function bootstrap() {
  process.umask(0o077);
  const { config, dataDir } = configuration();
  const password = process.env.ARTIFACTS_OWNER_PASSWORD;
  if (!password || password.length < 6)
    throw new Error(
      "ARTIFACTS_OWNER_PASSWORD must contain at least 6 characters",
    );
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const database = new Database(join(dataDir, "artifacts.sqlite"));
  try {
    new ArtifactStore(database);
    await bootstrapOwner(database, config, password);
    console.log(JSON.stringify({ event: "bootstrap_complete" }));
  } finally {
    delete process.env.ARTIFACTS_OWNER_PASSWORD;
    database.close();
  }
}

if (import.meta.main) await bootstrap();
