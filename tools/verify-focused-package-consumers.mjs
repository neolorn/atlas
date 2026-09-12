/**
 * Consumers that select almost nothing, so what they do not select can be shown to be absent.
 *
 * `specs/02-packages-and-platform.spec.md` section 8 requires an unselected capability to stay out
 * of a production graph, and an application that selects everything cannot demonstrate an
 * absence. So the fixture selects the minimum, and the assertions are about what is missing from
 * its output: the optional entry points, the toolkit, Node's own modules. Section 2 of
 * `specs/02-packages-and-platform.spec.md` is where a deep import is refused, and it is checked
 * here because a deep import resolves inside this repository whether or not it is exported.
 *
 * `specs/12-verification.spec.md` section 2 states the general form: an application holding
 * every capability cannot demonstrate an absence, so the fixtures that prove one select the
 * minimum.
 */
import assert from 'node:assert/strict';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { withOfflineStoreRemedy } from './offline-store.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = resolve(
  workspaceRoot,
  'tmp/focused-package-consumer-verification',
);
const consumerRoot = resolve(temporaryRoot, 'minimal-runtime-consumer');
const templateRoot = resolve(
  workspaceRoot,
  'fixtures/minimal-package-consumer-template',
);

const assertContained = (path, owner) => {
  assert.ok(
    path === owner || path.startsWith(`${owner}${sep}`),
    `Refusing path outside ${owner}: ${path}`,
  );
};

const isWithin = (candidate, owner) => {
  const path = relative(owner, candidate);
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  );
};

const run = (command, args, expectedStatus = 0) => {
  const result = spawnSync(command, args, {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  });
  assert.equal(
    result.status,
    expectedStatus,
    withOfflineStoreRemedy(
      [result.error?.message, result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n'),
    ),
  );
  return result;
};

const pnpm = (args, expectedStatus = 0) =>
  process.platform === 'win32'
    ? run(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', 'pnpm', ...args],
        expectedStatus,
      )
    : run('pnpm', args, expectedStatus);

const parseMachineResult = (result) => {
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.profile, 'atlas-cli-result/1');
  return value;
};

const snapshotFiles = async (root) => {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        assert.equal(
          entry.isFile(),
          true,
          `Unexpected generated entry: ${path}`,
        );
        files.push({
          path: relative(root, path).replaceAll('\\', '/'),
          contents: await readFile(path, 'utf8'),
        });
      }
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

assertContained(consumerRoot, temporaryRoot);
await rm(consumerRoot, { recursive: true, force: true });
await mkdir(temporaryRoot, { recursive: true });
await cp(templateRoot, consumerRoot, { recursive: true });

const manifestPath = resolve(consumerRoot, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const packageLocator = (outputRoot) => {
  const path = relative(consumerRoot, resolve(workspaceRoot, outputRoot));
  return `file:${path.replaceAll('\\', '/')}`;
};
manifest.dependencies['@neolorn/atlas'] = packageLocator('dist/runtime');
manifest.devDependencies['@neolorn/atlas-toolkit'] =
  packageLocator('dist/toolkit');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const generatedRoot = resolve(consumerRoot, 'src/generated/i18n');
await assert.rejects(lstat(generatedRoot), { code: 'ENOENT' });
pnpm(['install', '--offline', '--frozen-lockfile']);

const firstGeneration = parseMachineResult(
  pnpm(['exec', 'atlas', 'generate', '--json']),
);
assert.equal(firstGeneration.status, 'success');
assert.equal(firstGeneration.result.changed, true);
const generatedSnapshot = await snapshotFiles(generatedRoot);
assert.ok(generatedSnapshot.length > 0, 'Minimal generation emitted no files.');

const checked = parseMachineResult(pnpm(['exec', 'atlas', 'check', '--json']));
assert.equal(checked.status, 'success');
assert.equal(checked.result.fresh, true);
const unchangedGeneration = parseMachineResult(
  pnpm(['exec', 'atlas', 'generate', '--json']),
);
assert.equal(unchangedGeneration.result.changed, false);
assert.deepEqual(await snapshotFiles(generatedRoot), generatedSnapshot);

const cleaned = parseMachineResult(pnpm(['exec', 'atlas', 'clean', '--json']));
assert.equal(cleaned.status, 'success');
assert.equal(cleaned.result.changed, true);
await assert.rejects(lstat(generatedRoot), { code: 'ENOENT' });
await assert.rejects(lstat(resolve(consumerRoot, '.atlas')), {
  code: 'ENOENT',
});

const regenerated = parseMachineResult(
  pnpm(['exec', 'atlas', 'generate', '--json']),
);
assert.equal(regenerated.result.changed, true);
assert.deepEqual(await snapshotFiles(generatedRoot), generatedSnapshot);
assert.equal(
  parseMachineResult(pnpm(['exec', 'atlas', 'check', '--json'])).status,
  'success',
);

pnpm(['run', 'test']);
pnpm(['exec', 'ng', 'build', '--stats-json']);

const stats = JSON.parse(
  await readFile(
    resolve(consumerRoot, 'dist/atlas-minimal/stats.json'),
    'utf8',
  ),
);
assert.equal(typeof stats.inputs, 'object', 'Angular stats inputs are absent.');
assert.equal(
  typeof stats.outputs,
  'object',
  'Angular stats outputs are absent.',
);

const installedRuntimeRoot = await realpath(
  resolve(consumerRoot, 'node_modules/@neolorn/atlas'),
);
const installedToolkitRoot = await realpath(
  resolve(consumerRoot, 'node_modules/@neolorn/atlas-toolkit'),
);
const installedRuntimePackage = JSON.parse(
  await readFile(resolve(installedRuntimeRoot, 'package.json'), 'utf8'),
);
const runtimeEntries = Object.fromEntries(
  await Promise.all(
    ['.', './forms', './router', './testing'].map(async (entrypoint) => [
      entrypoint,
      await realpath(
        resolve(
          installedRuntimeRoot,
          installedRuntimePackage.exports[entrypoint].default,
        ),
      ),
    ]),
  ),
);

const productionInputs = new Set();
for (const output of Object.values(stats.outputs)) {
  for (const input of Object.keys(output.inputs ?? {})) {
    productionInputs.add(input);
  }
}
const resolveStatsInput = async (input) => {
  try {
    return await realpath(resolve(consumerRoot, input));
  } catch {
    return undefined;
  }
};
const canonicalProductionInputs = new Set(
  (
    await Promise.all(
      [...productionInputs].map((input) => resolveStatsInput(input)),
    )
  ).filter((input) => input !== undefined),
);
assert.equal(
  canonicalProductionInputs.has(runtimeEntries['.']),
  true,
  'Minimal consumer did not bundle the supported Atlas runtime entrypoint.',
);
for (const entrypoint of ['./forms', './router', './testing']) {
  assert.equal(
    canonicalProductionInputs.has(runtimeEntries[entrypoint]),
    false,
    `Minimal consumer retained the unused Atlas ${entrypoint} entrypoint.`,
  );
}
for (const [input, canonicalInput] of await Promise.all(
  [...productionInputs].map(async (input) => [
    input,
    await resolveStatsInput(input),
  ]),
)) {
  if (canonicalInput !== undefined) {
    assert.equal(
      isWithin(canonicalInput, installedToolkitRoot),
      false,
      `Minimal browser output contains toolkit input: ${input}`,
    );
  }
  const normalizedInput = input.replaceAll('\\', '/');
  for (const forbiddenPackage of ['@angular/forms', '@angular/router']) {
    assert.equal(
      normalizedInput.includes(`/node_modules/${forbiddenPackage}/`),
      false,
      `Minimal browser output contains unused ${forbiddenPackage} input: ${input}`,
    );
  }
}

const browserEntry = Object.entries(stats.outputs).find(
  ([, output]) => output.entryPoint === 'src/main.ts',
);
assert.notEqual(
  browserEntry,
  undefined,
  'Minimal browser entry metadata is absent.',
);
const pendingBrowserOutputs = [browserEntry[0]];
const visitedBrowserOutputs = new Set();
while (pendingBrowserOutputs.length > 0) {
  const outputName = pendingBrowserOutputs.pop();
  if (visitedBrowserOutputs.has(outputName)) continue;
  visitedBrowserOutputs.add(outputName);
  const output = stats.outputs[outputName];
  assert.notEqual(
    output,
    undefined,
    `Minimal browser output ${outputName} is absent.`,
  );
  for (const input of Object.keys(output.inputs ?? {})) {
    for (const imported of stats.inputs[input]?.imports ?? []) {
      assert.equal(
        isBuiltin(imported.path),
        false,
        `Minimal browser graph imports Node built-in ${imported.path} from ${input}.`,
      );
    }
  }
  for (const imported of output.imports ?? []) {
    assert.equal(
      isBuiltin(imported.path),
      false,
      `Minimal browser output imports Node built-in ${imported.path}.`,
    );
    const importedOutput = imported.path.replace(/^\.\//u, '');
    if (!imported.external && stats.outputs[importedOutput] !== undefined) {
      pendingBrowserOutputs.push(importedOutput);
    }
  }
}

const browserRoot = resolve(consumerRoot, 'dist/atlas-minimal/browser');
const outputFiles = await readdir(browserRoot, { recursive: true });
const maps = outputFiles.filter((path) => path.endsWith('.js.map'));
assert.ok(
  maps.length > 0,
  'Minimal consumer emitted no JavaScript source maps.',
);
for (const mapPath of maps) {
  const map = JSON.parse(await readFile(resolve(browserRoot, mapPath), 'utf8'));
  assert.ok(Array.isArray(map.sources), `${mapPath} has no source list.`);
}

const publicImport = run(process.execPath, [
  '--input-type=module',
  '--eval',
  "await import('@angular/compiler'); await import('@neolorn/atlas');",
]);
assert.equal(publicImport.stderr, '');
const privateRuntimeSpecifier = '@neolorn/atlas/fesm2022/neolorn-atlas.mjs';
const privateTypesSpecifier = '@neolorn/atlas/types/neolorn-atlas';
assert.equal((await lstat(runtimeEntries['.'])).isFile(), true);
assert.equal(
  (
    await lstat(resolve(installedRuntimeRoot, 'types/neolorn-atlas.d.ts'))
  ).isFile(),
  true,
);
const privateImport = run(
  process.execPath,
  [
    '--input-type=module',
    '--eval',
    `await import('${privateRuntimeSpecifier}');`,
  ],
  1,
);
assert.match(privateImport.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/u);

await writeFile(
  resolve(consumerRoot, 'deep-import.ts'),
  `import type { LocaleDirection } from '${privateTypesSpecifier}';\ndeclare const direction: LocaleDirection;\nvoid direction;\n`,
  'utf8',
);
await writeFile(
  resolve(consumerRoot, 'tsconfig.deep-import.json'),
  `${JSON.stringify(
    {
      extends: './tsconfig.json',
      compilerOptions: { noEmit: true },
      files: ['./deep-import.ts'],
    },
    null,
    2,
  )}\n`,
  'utf8',
);
const deepImport = pnpm(['exec', 'tsc', '-p', 'tsconfig.deep-import.json'], 2);
assert.match(`${deepImport.stdout}\n${deepImport.stderr}`, /TS2307/u);
assert.match(
  `${deepImport.stdout}\n${deepImport.stderr}`,
  new RegExp(privateTypesSpecifier.replaceAll('.', '\\.')),
);

process.stdout.write(
  'Atlas focused package consumers verified: deterministic minimal generation, zoneless runtime behavior, optional-entrypoint tree shaking, toolkit and Node isolation, declarations, and deep-import rejection.\n',
);
