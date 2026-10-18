import { createHash } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

for (const key of Object.keys(process.env)) {
  if (/^(CLOUDFLARE_|CF_|ACCESS_POLICY$)/.test(key)) delete process.env[key];
}
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
process.env.ACCESS_POLICY = "[]";
const principal = (id: string, inboxes: string[], webhooks: boolean) => ({
  id,
  tokenHash: createHash("sha256").update(`fixture-${id}`).digest("hex"),
  inboxes,
  webhooks,
  manageInboxes: webhooks,
});
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          BETTER_AUTH_SECRET:
            "synthetic-fixture-auth-secret-not-for-production-12345",
          OAUTH_PRINCIPAL_ID: "alice",
          ACCESS_POLICY: JSON.stringify([
            principal("alice", ["mcp", "mcp-alpha"], true),
            principal("bob", ["mcp", "mcp-beta"], true),
            principal("reader", ["mcp"], false),
          ]),
          WEBHOOK_URLS: '["https://hooks.example.com/mail"]',
          FORWARD_TO: "owner@example.net",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60000,
  },
});
