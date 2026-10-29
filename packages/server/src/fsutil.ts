/** The only filesystem helpers of the server (single write layer, Р-005). */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Write via temp file + rename so Obsidian / obsidian-git never see a half file. */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.of-tmp`);
  await writeFile(tmp, text, "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function appendText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, text, "utf8");
}

export async function listDir(path: string): Promise<{ name: string; isDir: boolean }[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

export async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
