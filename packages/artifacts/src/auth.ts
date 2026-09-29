import type { Database } from "bun:sqlite";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { jwt } from "better-auth/plugins";

export interface AuthConfig {
  origin: string;
  secret: string;
  ownerEmail: string;
  production: boolean;
}

/** Never mount an instance with bootstrap or sendSetupToken enabled. */
export function createAuth(
  database: Database,
  config: AuthConfig,
  options: {
    bootstrap?: boolean;
    sendSetupToken?: (token: string) => void;
  } = {},
) {
  return betterAuth({
    database,
    secret: config.secret,
    baseURL: config.origin,
    basePath: "/api/auth",
    trustedOrigins: [config.origin],
    disabledPaths: options.sendSetupToken ? [] : ["/request-password-reset"],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !options.bootstrap,
      minPasswordLength: 6,
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: options.sendSetupToken
        ? async ({ token }) => options.sendSetupToken?.(token)
        : undefined,
    },
    advanced: {
      // Better Auth's automatic prefix is __Secure-. Set our stronger host-only
      // prefix ourselves, while explicitly enforcing Secure on every cookie.
      useSecureCookies: false,
      cookiePrefix: config.production ? "__Host-artifacts" : "artifacts",
      defaultCookieAttributes: {
        secure: config.production,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
      crossSubDomainCookies: { enabled: false },
    },
    rateLimit: { enabled: config.production, storage: "database" },
    plugins: [
      jwt(),
      mcp({
        resource: `${config.origin}/mcp`,
        loginPage: "/login",
        consentPage: "/consent",
        scopes: ["openid", "offline_access", "artifacts:manage"],
        grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        accessTokenExpiresIn: 300,
      }),
    ],
  });
}

export async function migrateAuth(auth: ReturnType<typeof createAuth>) {
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
}

export function readOwner(database: Database, ownerEmail: string): string {
  const users = database
    .query<{ id: string; email: string }, []>('SELECT id, email FROM "user"')
    .all();
  if (
    users.length !== 1 ||
    users[0]?.email !== ownerEmail.trim().toLowerCase()
  ) {
    throw new Error(
      "Expected exactly one user matching the configured owner email",
    );
  }
  return users[0].id;
}

/** Local, pre-listener provisioning only. Existing credentials are never changed. */
export async function bootstrapOwner(
  database: Database,
  config: AuthConfig,
  password: string,
): Promise<string> {
  const auth = createAuth(database, config, { bootstrap: true });
  await migrateAuth(auth);
  const existing = database
    .query<{ count: number }, []>('SELECT count(*) AS count FROM "user"')
    .get();
  if (existing?.count) return readOwner(database, config.ownerEmail);
  const result = await auth.api.signUpEmail({
    body: {
      name: "Owner",
      email: config.ownerEmail.trim().toLowerCase(),
      password,
    },
  });
  return result.user.id;
}

/** Local operator access only. The returned URL is a password-reset credential. */
export async function issueSetupLink(database: Database, config: AuthConfig) {
  const ownerId = readOwner(database, config.ownerEmail);
  let token: string | undefined;
  const auth = createAuth(database, config, {
    sendSetupToken(value) {
      token = value;
    },
  });
  await auth.api.requestPasswordReset({ body: { email: config.ownerEmail } });
  if (!token) throw new Error("Could not issue owner setup link");
  // This service uses SQLite verification storage, without secondary caching.
  // Keep only this newly issued link; never touch OAuth verification records.
  database.run(
    `DELETE FROM "verification" WHERE value = ? AND identifier LIKE 'reset-password:%' AND identifier != ?`,
    [ownerId, `reset-password:${token}`],
  );
  const link = new URL("/signup", config.origin);
  link.hash = new URLSearchParams({ token }).toString();
  return link.href;
}
