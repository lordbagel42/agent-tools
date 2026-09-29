import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createApp } from "./app";
import { createAuth, issueSetupLink, readOwner } from "./auth";
import { bootstrap } from "./bootstrap";
import { configuration } from "./config";
import { ArtifactStore } from "./store";

if (process.argv.includes("--bootstrap")) {
  await bootstrap();
} else if (process.argv.includes("--setup-link")) {
  process.umask(0o077);
  const { config, dataDir } = configuration();
  const database = new Database(join(dataDir, "artifacts.sqlite"), {
    create: false,
    readwrite: true,
  });
  try {
    // Explicit operator output only. Never run this command in service logs.
    console.log(await issueSetupLink(database, config));
  } finally {
    database.close();
  }
} else {
  process.umask(0o077);
  const { config, dataDir, host, port } = configuration();
  const database = new Database(join(dataDir, "artifacts.sqlite"), {
    create: false,
    readwrite: true,
  });
  const ownerId = readOwner(database, config.ownerEmail);
  const store = new ArtifactStore(database);
  const auth = createAuth(database, config);
  const metrics = {
    requests: 0,
    serverErrors: 0,
    durationMs: 0,
    maxDurationMs: 0,
  };
  const app = createApp({
    config,
    auth,
    store,
    ownerId,
    log(record) {
      metrics.requests++;
      if (record.status >= 500) metrics.serverErrors++;
      metrics.durationMs += record.durationMs;
      metrics.maxDurationMs = Math.max(
        metrics.maxDurationMs,
        record.durationMs,
      );
      console.log(
        JSON.stringify({
          event: "request",
          timestamp: new Date().toISOString(),
          ...record,
        }),
      );
    },
  }).listen({
    hostname: host,
    port,
    maxRequestBodySize: 20 * 1024 * 1024,
    idleTimeout: 30,
  });
  const interval = setInterval(() => {
    console.log(
      JSON.stringify({
        event: "process_usage",
        timestamp: new Date().toISOString(),
        uptimeSeconds: process.uptime(),
        memory: process.memoryUsage(),
        cpuMicroseconds: process.cpuUsage(),
        ...metrics,
      }),
    );
  }, 60_000);
  console.log(JSON.stringify({ event: "listening", port }));
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    await app.stop(true);
    database.close();
    process.exit(0);
  }
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
