// Regenerates the committed consumer fixture lockfiles.
//
// The consumer verification gates install with `--offline --frozen-lockfile` so
// that a floating transitive dependency publishing upstream cannot break them.
// That determinism is only possible because every consumer fixture ships a
// committed lockfile. This is the deliberate, network-using command that
// refreshes those lockfiles after a fixture manifest or a profile row changes.
//
// It is not what puts those packages in the store. Left to this command's side
// effect, the store is stocked only on whichever machine last ran it, and a machine
// that never has fails the consumer stages with `ERR_PNPM_NO_OFFLINE_TARBALL`.
// Hydrating the store from the committed lockfiles is
// `pnpm run stage:consumer-store`, and it is a precondition of the gate rather than
// a side effect of this.

import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { consumerProfiles } from './package-consumer-profiles.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = resolve(workspaceRoot, 'tmp');
const lockRoot = resolve(workspaceRoot, 'fixtures/package-consumer-locks');
const minimalTemplateRoot = resolve(
  workspaceRoot,
  'fixtures/minimal-package-consumer-template',
);
const documentScaffoldRoot = resolve(
  workspaceRoot,
  'fixtures/document-consumer-scaffold',
);

const assertContained = (path, owner) => {
  if (path !== owner && !path.startsWith(`${owner}${sep}`)) {
    throw new Error(`Refusing path outside ${owner}: ${path}`);
  }
};

const run = (command, args, cwd) => {
  const commandArguments =
    process.platform === 'win32' && command === 'pnpm'
      ? ['/d', '/s', '/c', 'pnpm', ...args]
      : args;
  const executable =
    process.platform === 'win32' && command === 'pnpm'
      ? (process.env.ComSpec ?? 'cmd.exe')
      : command;
  // `CI` is deliberately cleared: pnpm treats a CI environment as
  // `--frozen-lockfile`, which is the opposite of what this command does.
  const { CI: _ignoredCi, ...environment } = process.env;
  const result = spawnSync(executable, commandArguments, {
    cwd,
    encoding: 'utf8',
    env: environment,
  });

  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n'),
  );
  return result;
};

const resolveLockfile = (consumerRoot) => {
  run(
    'pnpm',
    ['install', '--lockfile-only', '--no-frozen-lockfile'],
    consumerRoot,
  );
};

const packageLocator = (consumerRoot, outputRoot) => {
  const path = relative(consumerRoot, resolve(workspaceRoot, outputRoot));
  return `file:${path.replaceAll('\\', '/')}`;
};

for (const outputRoot of ['dist/runtime', 'dist/toolkit']) {
  const manifestPath = resolve(workspaceRoot, outputRoot, 'package.json');
  await readFile(manifestPath, 'utf8').catch(() => {
    throw new Error(
      `Missing built package ${outputRoot}. Run "pnpm run build" before refreshing consumer lockfiles.`,
    );
  });
}

for (const [consumerName, consumerProfile] of consumerProfiles) {
  const consumerRoot = resolve(
    temporaryRoot,
    'package-consumer-verification',
    consumerName,
  );
  run(
    process.execPath,
    [
      resolve(workspaceRoot, 'tools/materialize-package-consumer.mjs'),
      consumerName,
      '--allow-missing-lock',
    ],
    workspaceRoot,
  );
  resolveLockfile(consumerRoot);

  const destination = resolve(lockRoot, consumerName);
  assertContained(destination, lockRoot);
  await mkdir(destination, { recursive: true });
  await cp(
    resolve(consumerRoot, 'pnpm-lock.yaml'),
    resolve(destination, 'pnpm-lock.yaml'),
  );
  process.stdout.write(
    `Refreshed ${consumerName} lockfile (${consumerProfile.label}).\n`,
  );
}

// Two fixtures carry their lockfile inside the template, because the gate stage
// that uses each one copies the template wholesale. Their `file:` locators are
// relative, so the staging path has to sit at the depth that stage installs at,
// or the recorded locators would not match what it resolves.
const refreshTemplateLock = async (templateRoot, stagingRoot, label) => {
  assertContained(stagingRoot, temporaryRoot);
  await rm(stagingRoot, { force: true, recursive: true });
  await mkdir(dirname(stagingRoot), { recursive: true });
  await cp(templateRoot, stagingRoot, { recursive: true });

  const manifestPath = resolve(stagingRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies['@neolorn/atlas'] = packageLocator(
    stagingRoot,
    'dist/runtime',
  );
  manifest.devDependencies['@neolorn/atlas-toolkit'] = packageLocator(
    stagingRoot,
    'dist/toolkit',
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  resolveLockfile(stagingRoot);
  await cp(
    resolve(stagingRoot, 'pnpm-lock.yaml'),
    resolve(templateRoot, 'pnpm-lock.yaml'),
  );
  process.stdout.write(`Refreshed ${label} lockfile.\n`);
};

await refreshTemplateLock(
  minimalTemplateRoot,
  resolve(
    temporaryRoot,
    'focused-package-consumer-verification',
    'minimal-runtime-consumer',
  ),
  'minimal-runtime-consumer',
);

await refreshTemplateLock(
  documentScaffoldRoot,
  resolve(temporaryRoot, 'document-blocks', 'base'),
  'document-consumer-scaffold',
);
