#!/usr/bin/env node
/**
 * Every vendored normative source is what `standards/sources.lock.json` says it is.
 *
 * `specs/01-standards-profile.spec.md` section 4 is the requirement: every source Atlas derives
 * from, or verifies itself against, is recorded with its release, its provenance, its role and a
 * digest, and a vendored one matches that digest byte for byte.
 *
 * The lock recorded digests before this existed, and nothing recomputed them. A digest nobody
 * checks is a record of what was true once, not a guarantee about the working copy, and the
 * failure it is supposed to catch is silent by construction: a vendored file edited by hand, a
 * partial download, a `.gitattributes` gap normalizing line endings on the way into the object
 * store. All three produce a tree that builds and tests green.
 *
 * Two shapes are recorded and both are verified here:
 *
 *   - a single file, with `bytes` and a SHA-256 of its contents;
 *   - a directory, with `fileCount`, `bytes`, and a **manifest digest**. One SHA-256 over the
 *     sorted `<name> <sha256>` lines for every file in it. The XLIFF schemas predate this and
 *     carry a per-file `files` map instead, which is verified entry by entry.
 *
 * A manifest digest rather than 767 entries for the person-name release: any single byte anywhere
 * moves it, so it is exactly as strong and it is one value to read.
 *
 * Sources with no `projectSnapshot` are archives and packages that are not in this repository.
 * They are listed as counted and skipped rather than passed over silently, because "verified"
 * over a set that quietly excluded most of it is the kind of claim this gate exists to prevent.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const standardsRoot = resolve(workspaceRoot, 'standards');
const lockPath = resolve(standardsRoot, 'sources.lock.json');

const lock = JSON.parse(await readFile(lockPath, 'utf8'));

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Every file under a directory, relative to it, sorted, so the manifest is order-independent. */
async function filesUnder(root) {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  await walk(root);
  return found.map((path) => relative(root, path).split('\\').join('/')).sort();
}

const failures = [];
const verified = [];
const skipped = [];

/**
 * Snapshots that are a single file inside another snapshot's directory.
 *
 * `xml.xsd` is the case: it sits in the OASIS schema directory because the validator resolves it
 * from there and makes no network requests, but it is a W3C file that OASIS does not publish, so
 * it carries its own record. It is covered (by a stronger record than the directory's, its own
 * digest) and the directory must not report it as unrecorded.
 */
const nestedSnapshots = new Set(
  Object.values(lock.dataSources ?? {})
    .map((source) => source.projectSnapshot)
    .filter((snapshot) => snapshot !== undefined)
    .map((snapshot) => resolve(standardsRoot, snapshot)),
);

for (const [id, source] of Object.entries(lock.dataSources ?? {})) {
  const snapshot = source.projectSnapshot;
  if (snapshot === undefined) {
    skipped.push(`${id} (${source.url ?? 'no url'})`);
    continue;
  }

  const path = resolve(standardsRoot, snapshot);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) {
    failures.push(`${id}: ${snapshot} does not exist`);
    continue;
  }

  if (info.isFile()) {
    const contents = await readFile(path);
    if (source.bytes !== undefined && contents.byteLength !== source.bytes) {
      failures.push(
        `${id}: ${snapshot} is ${contents.byteLength} bytes, the lock says ${source.bytes}`,
      );
    }
    const digest = sha256(contents);
    if (digest !== source.digest?.value) {
      failures.push(
        `${id}: ${snapshot} hashes to ${digest}, the lock says ${source.digest?.value}`,
      );
    } else {
      verified.push(`${id} (1 file, ${contents.byteLength} bytes)`);
    }
    continue;
  }

  const names = await filesUnder(path);
  const contents = new Map();
  let bytes = 0;
  for (const name of names) {
    const payload = await readFile(join(path, name));
    contents.set(name, payload);
    bytes += payload.byteLength;
  }

  if (source.fileCount !== undefined && names.length !== source.fileCount) {
    failures.push(
      `${id}: ${snapshot} holds ${names.length} files, the lock says ${source.fileCount}`,
    );
  }
  if (source.bytes !== undefined && bytes !== source.bytes) {
    failures.push(
      `${id}: ${snapshot} is ${bytes} bytes, the lock says ${source.bytes}`,
    );
  }

  // The older per-file shape. Kept verified rather than migrated: the entries are the record.
  if (source.files !== undefined) {
    for (const [name, entry] of Object.entries(source.files)) {
      const payload = contents.get(name);
      if (payload === undefined) {
        failures.push(`${id}: ${snapshot}/${name} is recorded but missing`);
        continue;
      }
      const digest = sha256(payload);
      if (digest !== entry.digest?.value) {
        failures.push(
          `${id}: ${snapshot}/${name} hashes to ${digest}, the lock says ${entry.digest?.value}`,
        );
      }
    }
    for (const name of names) {
      if (name in source.files) continue;
      if (nestedSnapshots.has(resolve(path, name))) continue;
      failures.push(`${id}: ${snapshot}/${name} is present but not recorded`);
    }
    verified.push(
      `${id} (${names.length} files, ${bytes} bytes, per-file digests)`,
    );
    continue;
  }

  const manifest = names
    .map((name) => `${name} ${sha256(contents.get(name))}\n`)
    .sort()
    .join('');
  const digest = sha256(Buffer.from(manifest, 'utf8'));
  if (digest !== source.digest?.value) {
    failures.push(
      `${id}: ${snapshot} manifest hashes to ${digest}, the lock says ${source.digest?.value}`,
    );
  } else {
    verified.push(
      `${id} (${names.length} files, ${bytes} bytes, manifest digest)`,
    );
  }
}

for (const line of verified) console.log(`verified  ${line}`);
for (const line of skipped) console.log(`not here  ${line}`);

if (failures.length > 0) {
  console.error('');
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  console.error(
    `\n${failures.length} vendored normative source${failures.length === 1 ? '' : 's'} ` +
      'no longer match standards/sources.lock.json.',
  );
  process.exitCode = 1;
} else {
  console.log(
    `\n${verified.length} vendored normative sources match standards/sources.lock.json; ` +
      `${skipped.length} recorded acquisition sources are not vendored here.`,
  );
}
