/**
 * Proves that rebuilding a package reaches the consumer that installed it by `file:` link.
 *
 * A consumer fixture installs both packages from `dist` by path rather than from a tarball, and
 * pnpm satisfies a `file:` dependency by copying. A copy does not change when its source does, so a
 * rebuild that is not followed by a refresh leaves every later stage reading the previous build and
 * reporting it as the current one. This runs the documented refresh command and checks that what
 * the consumer resolves afterwards is what was just built.
 */
import assert from 'node:assert/strict';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withOfflineStoreRemedy } from './offline-store.mjs';
import { refreshConsumerPackages } from './refresh-consumer-packages.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = resolve(workspaceRoot, 'dist/runtime');
const toolkitRoot = resolve(workspaceRoot, 'dist/toolkit');
const consumerRoot = resolve(
  workspaceRoot,
  'tmp/package-consumer-verification/package-consumer',
);
const installedRuntimeRoot = resolve(
  consumerRoot,
  'node_modules/@neolorn/atlas',
);
const installedToolkitRoot = resolve(
  consumerRoot,
  'node_modules/@neolorn/atlas-toolkit',
);

const assertContained = (path, owner) => {
  if (path !== owner && !path.startsWith(`${owner}${sep}`)) {
    throw new Error(`Refusing path outside ${owner}: ${path}`);
  }
};

const replaceFile = async (path, contents) => {
  assertContained(path, workspaceRoot);
  const temporaryPath = `${path}.atlas-package-refresh`;
  assertContained(temporaryPath, workspaceRoot);

  await rm(temporaryPath, { force: true });
  await writeFile(temporaryPath, contents);
  await rm(path, { force: true });
  await rename(temporaryPath, path);
};

for (const [path, owner] of [
  [runtimeRoot, workspaceRoot],
  [toolkitRoot, workspaceRoot],
  [consumerRoot, resolve(workspaceRoot, 'tmp')],
]) {
  assertContained(path, owner);
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const runtimeManifestPath = resolve(runtimeRoot, 'package.json');
const toolkitManifestPath = resolve(toolkitRoot, 'package.json');
const runtimeManifest = await readJson(runtimeManifestPath);
const toolkitManifest = await readJson(toolkitManifestPath);
const primaryExport = runtimeManifest.exports['.'];
assert.equal(typeof primaryExport.default, 'string');
assert.equal(typeof primaryExport.types, 'string');

const trimRelative = (path) => path.replace(/^\.\//u, '');
const paths = {
  runtimeJavaScript: resolve(runtimeRoot, trimRelative(primaryExport.default)),
  runtimeTypes: resolve(runtimeRoot, trimRelative(primaryExport.types)),
  toolkitCli: resolve(toolkitRoot, trimRelative(toolkitManifest.bin.atlas)),
};

for (const path of Object.values(paths)) {
  assertContained(path, workspaceRoot);
}

const installedPaths = {
  runtimeJavaScript: resolve(
    installedRuntimeRoot,
    trimRelative(primaryExport.default),
  ),
  runtimeTypes: resolve(
    installedRuntimeRoot,
    trimRelative(primaryExport.types),
  ),
  toolkitCli: resolve(
    installedToolkitRoot,
    trimRelative(toolkitManifest.bin.atlas),
  ),
};

const originals = new Map();
for (const path of [
  ...Object.values(paths),
  runtimeManifestPath,
  toolkitManifestPath,
]) {
  originals.set(path, await readFile(path));
}

const markers = {
  runtimeJavaScript: 'atlas-package-refresh-javascript',
  runtimeTypes: 'atlas-package-refresh-declarations',
  toolkitCli: 'atlas-package-refresh-cli',
  runtimeExport: './package-refresh-probe',
  toolkitBin: 'atlas-package-refresh-probe',
};

// The refresh this gate is about is defined once, in the module both its callers import,
// because a gate that verifies a documented command has to run the documented command.
const refreshConsumer = () => {
  const result = refreshConsumerPackages(consumerRoot);

  assert.equal(
    result.status,
    0,
    withOfflineStoreRemedy(
      [result.error?.message, result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n'),
    ),
  );
};

const installedHasEveryProbe = async () => {
  for (const [key, path] of Object.entries(installedPaths)) {
    if (!(await readFile(path, 'utf8')).includes(markers[key])) {
      return false;
    }
  }

  const installedRuntimeManifest = await readJson(
    resolve(installedRuntimeRoot, 'package.json'),
  );
  const installedToolkitManifest = await readJson(
    resolve(installedToolkitRoot, 'package.json'),
  );
  return (
    installedRuntimeManifest.exports[markers.runtimeExport] !== undefined &&
    installedToolkitManifest.bin[markers.toolkitBin] === './cli.js'
  );
};

let directPropagation = false;

try {
  for (const [key, path] of Object.entries(paths)) {
    const original = await readFile(path, 'utf8');
    await replaceFile(path, `${original}\n// ${markers[key]}\n`);
  }

  runtimeManifest.exports[markers.runtimeExport] = primaryExport;
  toolkitManifest.bin[markers.toolkitBin] = './cli.js';
  await replaceFile(
    runtimeManifestPath,
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    'utf8',
  );
  await replaceFile(
    toolkitManifestPath,
    `${JSON.stringify(toolkitManifest, null, 2)}\n`,
    'utf8',
  );

  directPropagation = await installedHasEveryProbe();
  if (!directPropagation) {
    refreshConsumer();
  }

  assert.equal(
    await installedHasEveryProbe(),
    true,
    'The documented file-package refresh did not propagate every package surface.',
  );
} finally {
  for (const [path, bytes] of originals) {
    await replaceFile(path, bytes);
  }
  refreshConsumer();
}

// The command is defined in package.json as `refresh:consumer`, and callers name it rather than
// spell its steps. Spelling them here as well is how this gate and the injection gate came to
// disagree about them in the first place, and a gate's own stdout is not where a reader finds a
// command they need before they run the gate.
process.stdout.write(
  directPropagation
    ? 'Atlas file-package rebuilds propagate directly.\n'
    : 'Atlas file-package refresh verified: `pnpm run refresh:consumer` propagates it.\n',
);
