/**
 * The three filesystem questions both hosts ask, answered once.
 *
 * The output host and the project host each walk a consumer's tree, and a tree they did not create
 * answers differently on every platform. A missing path is a thrown `ENOENT` rather than a return
 * value, a durable write is a write plus an `fsync`, and a path written into a diagnostic or a
 * generated file has to read the same on Windows as it does anywhere else.
 */
import { lstat, open } from 'node:fs/promises';
import { type Stats } from 'node:fs';
import { relative } from 'node:path';

/**
 * What is at a path, or nothing where there is nothing.
 *
 * `lstat` rather than `stat`, so a symbolic link is reported as itself. A link pointing outside the
 * owner is a thing to refuse, and following it first would hide it.
 */
export async function pathMetadata(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Whether anything is at a path. A permission error is raised rather than read as absence. */
export async function pathExists(path: string): Promise<boolean> {
  return (await pathMetadata(path)) !== undefined;
}

/**
 * Writes a file that survives losing power, and refuses to write over one that is already there.
 *
 * `wx` makes the create and the exclusivity one operation, so two runs cannot both believe they
 * created the file. The `sync` is what carries the bytes past the operating system's cache, which
 * matters because the next step of a transaction takes the file's existence as proof of its
 * contents.
 */
export async function writeSynced(
  path: string,
  contents: string,
): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** A path relative to a root, spelled with forward slashes on every platform. */
export function portablePath(root: string, candidate: string): string {
  const path = relative(root, candidate).replaceAll('\\', '/');
  return path === '' ? '.' : path;
}
