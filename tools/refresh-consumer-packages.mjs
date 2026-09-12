/**
 * Hand a materialized consumer the Atlas packages that are in `dist/` right now.
 *
 * The consumer takes Atlas as a `file:` dependency, which pnpm imports into its store rather than
 * linking through to `dist`. A rebuild replaces those files, so the consumer goes on running the
 * build it was installed with until something re-imports them, and two gates depend on that
 * happening: the one that mutates the runtime and asks whether the consumer's suite notices, and
 * the one whose whole subject is this refresh. One spelling here, so the two cannot disagree.
 *
 * It is not `pnpm update`. `update` re-resolves every direct dependency, and resolving reads the
 * registry metadata mirror even when every tarball is already in the store. `pnpm fetch` never
 * writes that mirror, so staging the store cannot warm it, and `--offline` on a machine that has
 * not accumulated one fails with `ERR_PNPM_NO_OFFLINE_META` before either gate measures anything.
 * A machine that has a warm mirror has it by accident.
 *
 * Removing the tree and installing from the committed lockfile resolves nothing and needs no
 * metadata, which is why the consumer gates install that way in the first place. Removing it is not
 * housekeeping either: pnpm answers `Already up to date` for a frozen install that finds
 * `node_modules` in place, with `--force` and without, and hands back the previous build. Against
 * a cold metadata cache this costs 3.5 seconds, and the rebuilt file arrives.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ARGUMENTS = Object.freeze(['install', '--offline', '--frozen-lockfile']);

/**
 * What the child process ran, for a failure that has to say what it ran.
 *
 * Not what a person runs. That is `pnpm run refresh:consumer`, which is this plus the removal
 * above it, and the two are only correct together.
 */
export const refreshCommand = `pnpm ${ARGUMENTS.join(' ')}`;

/**
 * Runs the refresh and hands back what happened. The caller decides how a failure is reported,
 * because the two callers report differently and both are right about their own gate.
 */
export function refreshConsumerPackages(consumerRoot) {
  const windows = process.platform === 'win32';
  rmSync(resolve(consumerRoot, 'node_modules'), {
    force: true,
    recursive: true,
  });
  return spawnSync(
    windows ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm',
    windows ? ['/d', '/s', '/c', 'pnpm', ...ARGUMENTS] : ARGUMENTS,
    {
      cwd: consumerRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', NO_COLOR: '1' },
      maxBuffer: 16_777_216,
      timeout: 600_000,
    },
  );
}

/**
 * The consumer this refreshes when it is run rather than imported.
 *
 * `verify:consumer` materializes it there, and it is the copy every consumer gate and every manual
 * check of a rebuild is looking at. A path argument overrides it, for a consumer somewhere else.
 */
const DEFAULT_CONSUMER = 'tmp/package-consumer-verification/package-consumer';

// Run rather than imported: `pnpm run refresh:consumer [consumer path]`. The gates import the
// function above instead, so there is one definition of the refresh and one way it can behave.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const consumerRoot = resolve(
    workspaceRoot,
    process.argv[2] ?? DEFAULT_CONSUMER,
  );
  if (!existsSync(consumerRoot)) {
    process.stderr.write(
      `There is no consumer at ${consumerRoot}.\n` +
        `Run \`pnpm run verify:consumer\` to materialize it, or pass the path to another one.\n`,
    );
    process.exit(1);
  }
  const result = refreshConsumerPackages(consumerRoot);
  if (result.status !== 0) {
    process.stderr.write(
      `${refreshCommand} failed in ${consumerRoot}: exit ${result.status ?? 'null'}\n` +
        `${result.stdout ?? ''}${result.stderr ?? ''}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `Refreshed ${consumerRoot} with the packages now in dist/.\n`,
  );
}
