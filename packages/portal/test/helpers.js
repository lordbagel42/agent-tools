import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { once } from "node:events";
import { createService } from "../src/server.js";

export const thread = "T-00000000-0000-0000-0000-000000000002";
export const otherThread = "T-00000000-0000-0000-0000-000000000001";
export async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
export async function fixture(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "portal-"));
  const config = {
    stateDir: dir,
    socketPath: join(dir, "control.sock"),
    bindHost: "127.0.0.1",
    port: 0,
    domain: "example.com",
    loginHost: "portals.example.com",
    signingKey: "ab".repeat(32),
    workspaceRoot: dir,
    readinessMs: 1500,
    ...extra,
  };
  const service = await createService(config);
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { service, config, dir };
}
export function httpRequest({
  port,
  host,
  path = "/",
  method = "GET",
  headers = {},
  body,
  socketPath,
}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        socketPath,
        path,
        method,
        headers: { host, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
