import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The two directories a clean may remove, and why `build` asks for one of them by name.
 *
 * `dist` is the build's own output, removed first so a package cannot be assembled from a file an
 * earlier state of the tree produced. `tmp` is where the gate works: its work trees, the consumers
 * it materializes, its traces and its attempt ledger.
 *
 * `build` names `dist` alone because one gate stage builds after a consumer has been materialized
 * beside it, rebuilding the packages once per injection and handing each build to that consumer. A
 * build that emptied `tmp` would delete the consumer it is about to install into.
 */
const REMOVABLE = ['dist', 'tmp'];

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !REMOVABLE.includes(name));
if (unknown.length > 0) {
  throw new Error(
    `Nothing here is called ${unknown.join(', ')}. A clean removes ${REMOVABLE.join(' or ')}, and naming none of them removes both.`,
  );
}

const targets = requested.length > 0 ? requested : REMOVABLE;

for (const name of targets) {
  await rm(resolve(workspaceRoot, name), { force: true, recursive: true });
}
