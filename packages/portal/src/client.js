import { request } from "node:http";
import { isAbsolute } from "node:path";
import { defaultPaths, loadConfig } from "./config.js";

export async function callPortal(input, { configPath } = {}) {
  let socketPath = process.env.PORTAL_SOCKET;
  if (!socketPath) {
    try {
      socketPath = (await loadConfig(configPath)).socketPath;
    } catch (error) {
      if (error.code !== "ENOENT" || configPath || process.env.PORTAL_CONFIG)
        throw error;
      socketPath = defaultPaths().socketPath;
    }
  }
  if (typeof socketPath !== "string" || !isAbsolute(socketPath))
    throw new Error("An absolute portal socketPath is required");
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/control",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const result = JSON.parse(body);
            if (res.statusCode !== 200)
              reject(new Error(result.error ?? "Portal operation failed"));
            else resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(45_000, () =>
      req.destroy(
        new Error("Portal operation timed out; check status before retrying"),
      ),
    );
    req.on("error", reject);
    req.end(JSON.stringify(input));
  });
}
