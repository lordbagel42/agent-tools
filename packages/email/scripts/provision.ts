import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { createAuth } from "../src/auth.ts";

// Offline only. Outputs are credentials; never serve this script over HTTP.
const [configPath, outputDirectory, existingOwnerId] = process.argv.slice(2);
if (!configPath || !outputDirectory)
  throw new Error(
    "Usage: node scripts/provision.ts <private-config.json> <new-private-output-directory> [existing-owner-id]",
  );
const config = JSON.parse(await readFile(configPath, "utf8"));
if (!config.OWNER_EMAIL || new URL(config.PUBLIC_ORIGIN).protocol !== "https:")
  throw new Error("Configure OWNER_EMAIL and an HTTPS PUBLIC_ORIGIN");
if (existingOwnerId && !config.BETTER_AUTH_SECRET)
  throw new Error("Password recovery requires the existing BETTER_AUTH_SECRET");
await mkdir(outputDirectory, { mode: 0o700 });
const secret = config.BETTER_AUTH_SECRET ?? randomBytes(32).toString("hex");
const database = new DatabaseSync(":memory:");
database.exec(
  await readFile(
    new URL("../migrations/0001_auth.sql", import.meta.url),
    "utf8",
  ),
);
const env = {
  ...config,
  BETTER_AUTH_SECRET: secret,
  AUTH_DB: database,
} as unknown as Env;
let token = "";
const auth = createAuth(env, {
  bootstrap: true,
  setupToken: (value) => {
    token = value;
  },
});
if (existingOwnerId) {
  database
    .prepare(
      'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, ?, ?, 0, ?, ?)',
    )
    .run(
      existingOwnerId,
      "Owner",
      config.OWNER_EMAIL.toLowerCase(),
      Date.now(),
      Date.now(),
    );
} else {
  await auth.api.signUpEmail({
    body: {
      name: "Owner",
      email: config.OWNER_EMAIL,
      password: randomBytes(32).toString("hex"),
    },
  });
}
await auth.api.requestPasswordReset({ body: { email: config.OWNER_EMAIL } });
if (!token) throw new Error("Setup token not issued");
const quote = (value: unknown) =>
  value == null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${String(value).replaceAll("'", "''")}'`;
const statements: string[] = [];
if (existingOwnerId)
  statements.push(
    `DELETE FROM "verification" WHERE value=${quote(existingOwnerId)} AND identifier LIKE 'reset-password:%';`,
  );
for (const table of existingOwnerId
  ? ["verification"]
  : ["user", "account", "verification"]) {
  for (const row of database.prepare(`SELECT * FROM "${table}"`).all()) {
    statements.push(
      `INSERT INTO "${table}" (${Object.keys(row)
        .map((key) => `"${key}"`)
        .join(",")}) VALUES (${Object.values(row).map(quote).join(",")});`,
    );
  }
}
const setup = new URL("/setup", config.PUBLIC_ORIGIN);
setup.hash = new URLSearchParams({ token }).toString();
await writeFile(join(outputDirectory, "owner.sql"), statements.join("\n"), {
  mode: 0o600,
  flag: "wx",
});
await writeFile(
  join(outputDirectory, "credentials.json"),
  JSON.stringify({ BETTER_AUTH_SECRET: secret, setupUrl: setup.href }),
  { mode: 0o600, flag: "wx" },
);
database.close();
console.log(
  "Private provisioning files written. Apply owner.sql, set the secret, and deliver the single-use setup URL privately within 30 minutes. No live system was changed.",
);
