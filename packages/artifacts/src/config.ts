import { resolve } from "node:path";
import { z } from "zod";
import type { AuthConfig } from "./auth";

export interface ArtifactConfig extends AuthConfig {
  hostSuffix: string;
}

export function configuration(
  env: Record<string, string | undefined> = process.env,
) {
  const origin = new URL(z.string().url().parse(env.ARTIFACTS_ORIGIN));
  const production = env.NODE_ENV === "production";
  if (
    origin.origin !== env.ARTIFACTS_ORIGIN ||
    (origin.protocol !== "https:" &&
      (production || !["localhost", "127.0.0.1"].includes(origin.hostname)))
  ) {
    throw new Error(
      "ARTIFACTS_ORIGIN must be an HTTPS origin (HTTP loopback is allowed in development)",
    );
  }
  const hostSuffix = z
    .string()
    .regex(/^-[a-z0-9-]+\.[a-z0-9.-]+$/)
    .parse(env.ARTIFACTS_HOST_SUFFIX);
  const config: ArtifactConfig = {
    origin: origin.origin,
    hostSuffix,
    ownerEmail: z
      .string()
      .email()
      .parse(env.ARTIFACTS_OWNER_EMAIL)
      .toLowerCase(),
    secret: z.string().min(32).parse(env.BETTER_AUTH_SECRET),
    production,
  };
  return {
    config,
    dataDir: resolve(z.string().min(1).parse(env.ARTIFACTS_DATA_DIR)),
    port: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.PORT ?? "3000"),
    host: env.HOST ?? "127.0.0.1",
  };
}

export function artifactUrl(config: ArtifactConfig, slug: string): string {
  const url = new URL(config.origin);
  url.hostname = `${slug}${config.hostSuffix}`;
  return url.origin;
}
