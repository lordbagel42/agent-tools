import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function prepareState(
  directory: string,
): Promise<{ token: string; tokenPath: string; profileDir: string }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tokenPath = join(directory, "api-token");
  await writeFile(tokenPath, `${randomBytes(32).toString("hex")}\n`, {
    flag: "wx",
    mode: 0o600,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await chmod(tokenPath, 0o600);
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error(
      "Invalid API token file. Restore it or remove it to rotate the token.",
    );
  const profileDir = join(directory, "profile");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  return { token, tokenPath, profileDir };
}
