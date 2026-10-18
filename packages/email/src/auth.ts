import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";

// Bootstrap options are used only by offline operator tooling, never HTTP routes.
export function createAuth(
  env: Env,
  options: { bootstrap?: boolean; setupToken?: (token: string) => void } = {},
) {
  return betterAuth({
    database: env.AUTH_DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.PUBLIC_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: [env.PUBLIC_ORIGIN],
    disabledPaths: options.setupToken ? [] : ["/request-password-reset"],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !options.bootstrap,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: 1800,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: options.setupToken
        ? async ({ token }) => options.setupToken?.(token)
        : undefined,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) =>
            user.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase()
              ? { data: user }
              : false,
        },
        update: {
          before: async (user) =>
            !user.email ||
            user.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase()
              ? { data: user }
              : false,
        },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: false,
      cookiePrefix: env.PUBLIC_ORIGIN.startsWith("https:")
        ? "__Host-email"
        : "email",
      defaultCookieAttributes: {
        secure: env.PUBLIC_ORIGIN.startsWith("https:"),
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
      crossSubDomainCookies: { enabled: false },
    },
    rateLimit: { enabled: true, storage: "database" },
    plugins: [
      jwt(),
      mcp({
        resource: `${env.PUBLIC_ORIGIN}/mcp`,
        loginPage: "/login",
        consentPage: "/consent",
        scopes: ["openid", "offline_access", "email:manage"],
        grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        accessTokenExpiresIn: 300,
      }),
    ],
  });
}

export async function ownerId(env: Env) {
  const { results } = await env.AUTH_DB.prepare(
    'SELECT id, email FROM "user" LIMIT 2',
  ).all<{ id: string; email: string }>();
  if (
    results.length !== 1 ||
    results[0].email !== env.OWNER_EMAIL.toLowerCase()
  )
    throw new Error("Owner not provisioned");
  return results[0].id;
}
