import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests must never inherit deployment or service credentials.
for (const key of Object.keys(process.env)) {
  if (/^(CLOUDFLARE_|CF_|API_TOKEN$)/.test(key)) delete process.env[key];
}
process.env.API_TOKEN = "fixture-management-key-not-for-production-12345";
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          API_TOKEN: "fixture-management-key-not-for-production-12345",
          PUBLIC_ORIGIN: "https://uploads.example.com",
          WEBHOOK_ORIGINS: "https://hooks.example.com",
        },
      },
    }),
  ],
  test: { fileParallelism: false },
});
