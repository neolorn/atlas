import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attemptLedgerPath, workingRoot } from './working-state.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const remove = (path) => rm(path, { force: true, recursive: true });

/**
 * The gate's working directory, emptied of everything a run can produce again.
 *
 * The directory itself stays, and so does the attempt ledger, for the reason `working-state.mjs`
 * gives. An absent directory is nothing to clean rather than an error, because a clean is how a
 * tree with no run behind it is asked for.
 */
async function emptyWorkingRoot() {
  let entries;
  try {
    entries = await readdir(workingRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = resolve(workingRoot, entry);
    if (path === attemptLedgerPath) continue;
    await remove(path);
  }
}

/**
 * What a clean may remove, and why `build` asks for one of them by name.
 *
 * `dist` is the build's own output, removed first so a package cannot be assembled from a file an
 * earlier state of the tree produced.
 *
 * `build` names `dist` alone because one gate stage builds after a consumer has been materialized
 * under `tmp`, rebuilding the packages once per injection and handing each build to that consumer.
 * A build that emptied `tmp` would delete the consumer it is about to install into.
 */
const REMOVABLE = {
  dist: () => remove(resolve(workspaceRoot, 'dist')),
  tmp: emptyWorkingRoot,
};

const names = Object.keys(REMOVABLE);
const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !names.includes(name));
if (unknown.length > 0) {
  throw new Error(
    `Nothing here is called ${unknown.join(', ')}. A clean removes ${names.join(' or ')}, and naming neither removes both.`,
  );
}

for (const name of requested.length > 0 ? requested : names) {
  await REMOVABLE[name]();
}
