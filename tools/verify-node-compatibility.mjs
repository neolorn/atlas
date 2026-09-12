/**
 * The declared Node range, run rather than declared.
 *
 * `specs/01-standards-profile.spec.md` section 6 requires correctness-bearing behavior not to vary
 * between supported runtimes, and an engines range in a manifest is a claim about that, not
 * evidence of it. The suites run on each end of the range, so both bounds of what the manifest
 * admits have been executed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareVersions,
  developmentNode,
  nodeFloors,
  nodeRange,
} from './supported-versions.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultNodeRoot = resolve(workspaceRoot, '.runtimes/node');
const nodeRoot = resolve(
  process.env.ATLAS_NODE_COMPATIBILITY_ROOT ?? defaultNodeRoot,
);
const rowWorker = resolve(
  workspaceRoot,
  'tools/verify-node-compatibility-row.mjs',
);
/**
 * A row per Node line the manifests admit, at the bottom of each, plus the one this repository
 * develops on.
 *
 * Derived rather than listed. The engines range is what a consumer installs against, so a row list
 * written out beside it is a second claim about the same thing, and the failure it hides is the
 * quiet one: a raised floor with a row still proving the old one.
 *
 * The development row is skipped when it is already a floor, so the set stays one row per version
 * whatever `.node-version` says.
 */
const rows = Object.freeze(
  [
    ...nodeFloors.map((version) => ({
      id: `node-${version.split('.')[0]}-minimum`,
      version,
    })),
    ...(nodeFloors.includes(developmentNode)
      ? []
      : [{ id: 'development-reference', version: developmentNode }]),
  ]
    .sort((left, right) => compareVersions(left.version, right.version))
    .map((row) =>
      Object.freeze({
        ...row,
        environment: `ATLAS_NODE_${row.version.replaceAll('.', '_')}_EXECUTABLE`,
      }),
    ),
);

const isWithin = (candidate, owner) => {
  const path = relative(owner, candidate);
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  );
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

function platformLayout(version) {
  const executable = process.platform === 'win32' ? 'node.exe' : 'bin/node';
  const distributionPlatform =
    process.platform === 'win32'
      ? 'win'
      : process.platform === 'darwin'
        ? 'darwin'
        : process.platform;
  const distribution = `node-v${version}-${distributionPlatform}-${process.arch}`;
  return Object.freeze({ executable, distribution });
}

function candidatesFor(row) {
  const explicit = process.env[row.environment];
  if (explicit !== undefined && explicit.trim() !== '') {
    return Object.freeze([resolve(explicit)]);
  }
  const layout = platformLayout(row.version);
  return Object.freeze([
    resolve(nodeRoot, row.version, layout.executable),
    resolve(nodeRoot, `v${row.version}`, layout.executable),
    resolve(nodeRoot, layout.distribution, layout.executable),
    resolve(nodeRoot, row.version, layout.distribution, layout.executable),
  ]);
}

function spawnOptions() {
  return {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_PATH: '',
      NO_COLOR: '1',
    },
    maxBuffer: 1_048_576,
    timeout: 120_000,
    windowsHide: true,
  };
}

function describeSpawnFailure(result) {
  if (result.error !== undefined) return result.error.message;
  if (result.signal !== null) return `terminated by signal ${result.signal}`;
  return (result.stderr || result.stdout || `exit ${result.status}`).trim();
}

async function locateRows() {
  const located = [];
  const failures = [];
  for (const row of rows) {
    const candidates = candidatesFor(row);
    const executable = await (async () => {
      for (const candidate of candidates) {
        if (await isFile(candidate)) return realpath(candidate);
      }
      return undefined;
    })();
    if (executable === undefined) {
      const layout = platformLayout(row.version);
      failures.push(
        [
          `Missing Node.js ${row.version} (${row.id}).`,
          `Looked for:`,
          ...candidates.map((candidate) => `  ${candidate}`),
          '`pnpm run stage:node-runtimes` downloads the official archive for every row,',
          `checks it against nodejs.org's published digest and extracts it under`,
          `${nodeRoot}: this one as ${layout.distribution}. Or set`,
          `${row.environment} to that row's exact Node executable.`,
        ].join('\n'),
      );
      continue;
    }
    const probe = spawnSync(
      executable,
      ['--eval', 'process.stdout.write(process.versions.node)'],
      spawnOptions(),
    );
    if (
      probe.status !== 0 ||
      probe.error !== undefined ||
      probe.signal !== null
    ) {
      failures.push(
        `Could not run ${row.id} at ${executable}: ${describeSpawnFailure(probe)}`,
      );
      continue;
    }
    const actualVersion = probe.stdout.trim();
    if (actualVersion !== row.version) {
      failures.push(
        `${row.id} resolved to ${executable}, but it reports Node.js ${actualVersion}; expected exactly ${row.version}.`,
      );
      continue;
    }
    located.push(Object.freeze({ ...row, executable }));
  }
  if (failures.length > 0) {
    throw new Error(
      `Portable Node compatibility rows are incomplete. No downloads are performed by this verifier. Set ATLAS_NODE_COMPATIBILITY_ROOT to use a different portable-runtime root.\n\n${failures.join('\n\n')}`,
    );
  }
  return Object.freeze(located);
}

async function dependencySource(specifier) {
  const segments = specifier.split('/');
  const candidates = [
    resolve(workspaceRoot, 'packages/toolkit/node_modules', ...segments),
    resolve(workspaceRoot, 'packages/runtime/node_modules', ...segments),
    resolve(workspaceRoot, 'node_modules', ...segments),
  ];
  for (const candidate of candidates) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error(
    `Installed dependency ${specifier} is missing. Run the repository's locked pnpm install before compatibility verification.`,
  );
}

async function createHarness(runtimeManifest, toolkitManifest) {
  await mkdir(nodeRoot, { recursive: true });
  const harnessRoot = await mkdtemp(
    resolve(nodeRoot, '.atlas-node-compatibility-harness-'),
  );
  try {
    const nodeModules = resolve(harnessRoot, 'node_modules');
    const scopeRoot = resolve(nodeModules, '@neolorn');
    await mkdir(scopeRoot, { recursive: true });
    await cp(
      resolve(workspaceRoot, 'dist/runtime'),
      resolve(scopeRoot, 'atlas'),
      {
        recursive: true,
      },
    );
    await cp(
      resolve(workspaceRoot, 'dist/toolkit'),
      resolve(scopeRoot, 'atlas-toolkit'),
      { recursive: true },
    );

    const dependencies = new Set([
      ...Object.keys(runtimeManifest.dependencies ?? {}),
      ...Object.keys(runtimeManifest.peerDependencies ?? {}),
      ...Object.keys(toolkitManifest.dependencies ?? {}),
      ...Object.keys(toolkitManifest.peerDependencies ?? {}),
    ]);
    for (const specifier of [...dependencies].sort()) {
      const destination = resolve(nodeModules, ...specifier.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await symlink(
        await dependencySource(specifier),
        destination,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    return harnessRoot;
  } catch (error) {
    await rm(harnessRoot, { recursive: true, force: true });
    throw error;
  }
}

async function verifyBuiltInputs() {
  const runtimeManifestPath = resolve(
    workspaceRoot,
    'dist/runtime/package.json',
  );
  const toolkitManifestPath = resolve(
    workspaceRoot,
    'dist/toolkit/package.json',
  );
  if (
    !(await isFile(runtimeManifestPath)) ||
    !(await isFile(toolkitManifestPath))
  ) {
    throw new Error(
      'Built Atlas packages are missing. Run `pnpm run build` before Node compatibility verification.',
    );
  }
  const runtimeManifest = await readJson(runtimeManifestPath);
  const toolkitManifest = await readJson(toolkitManifestPath);
  assert.equal(runtimeManifest.name, '@neolorn/atlas');
  assert.equal(toolkitManifest.name, '@neolorn/atlas-toolkit');
  // What shipped against what the packages declare. The range itself is not restated here: it is
  // read from the source manifests, so this compares the build to its own declaration.
  assert.equal(runtimeManifest.engines?.node, nodeRange);
  assert.equal(toolkitManifest.engines?.node, nodeRange);
  return Object.freeze({ runtimeManifest, toolkitManifest });
}

async function main() {
  const manifests = await verifyBuiltInputs();
  const locatedRows = await locateRows();
  let harnessRoot;
  try {
    harnessRoot = await createHarness(
      manifests.runtimeManifest,
      manifests.toolkitManifest,
    );
    const evidence = [];
    const formattingByRow = new Map();
    for (const row of locatedRows) {
      const result = spawnSync(
        row.executable,
        [
          rowWorker,
          '--expected-version',
          row.version,
          '--harness-root',
          harnessRoot,
          '--row',
          row.id,
        ],
        spawnOptions(),
      );
      if (
        result.status !== 0 ||
        result.error !== undefined ||
        result.signal !== null
      ) {
        throw new Error(
          `${row.id} (${row.version}) failed: ${describeSpawnFailure(result)}`,
        );
      }
      const recordLine = result.stdout
        .split(/\r?\n/u)
        .find((line) => line.startsWith('ATLAS_NODE_ROW '));
      assert.notEqual(
        recordLine,
        undefined,
        `${row.id} did not emit compatibility evidence`,
      );
      const record = JSON.parse(recordLine.slice('ATLAS_NODE_ROW '.length));
      assert.equal(record.profile, 'atlas-node-compatibility/1');
      assert.equal(record.row, row.id);
      assert.equal(record.node, row.version);
      assert.equal(
        record.formatting?.profile,
        'atlas-node-localized-output/1',
        `${row.id} produced no localized output evidence`,
      );
      formattingByRow.set(row.id, record.formatting);
      assert.equal(
        record.toolkitWorkflow?.profile,
        'atlas-node-toolkit-workflow/1',
      );
      assert.equal(record.toolkitWorkflow?.initialGenerate, 'changed');
      assert.equal(
        record.toolkitWorkflow?.repeatedGenerate,
        'unchanged-deterministic',
      );
      assert.equal(
        record.toolkitWorkflow?.repeatedCheck,
        'fresh-deterministic-read-only',
      );
      assert.ok(
        Number.isSafeInteger(record.toolkitWorkflow?.generatedFiles) &&
          record.toolkitWorkflow.generatedFiles > 0,
        `${row.id} did not report bounded generated-file evidence`,
      );
      assert.ok(
        Number.isSafeInteger(record.toolkitWorkflow?.generatedBytes) &&
          record.toolkitWorkflow.generatedBytes > 0,
        `${row.id} did not report bounded generated-byte evidence`,
      );
      evidence.push(record);
    }

    // The comparison the matrix existed for. Server and client must not diverge in locale or
    // formatting, and a build that prerenders on one Node major while a server renders on another
    // is exactly that situation.
    const [referenceRow, referenceFormatting] = [...formattingByRow][0] ?? [];
    assert.notEqual(
      referenceFormatting,
      undefined,
      'No row produced localized output evidence',
    );
    for (const [rowId, formatting] of formattingByRow) {
      if (rowId === referenceRow) continue;
      const differences = Object.keys(referenceFormatting)
        .filter(
          (key) =>
            JSON.stringify(formatting[key]) !==
            JSON.stringify(referenceFormatting[key]),
        )
        .map(
          (key) =>
            `  ${key}: ${referenceRow} produced ${JSON.stringify(referenceFormatting[key])}, ${rowId} produced ${JSON.stringify(formatting[key])}`,
        );
      assert.equal(
        differences.length,
        0,
        `Localized output differs across supported Node rows:\n${differences.join('\n')}`,
      );
    }

    process.stdout.write('Atlas built-package Node compatibility:\n');
    for (const row of evidence) {
      process.stdout.write(
        `  ${row.row} ${row.node} (${row.platform}/${row.architecture}) - runtime ${row.runtimeEntrypoints.length} entry point(s), toolkit API, host admission, CLI help, identical ar-EG and en-US output, generate changed->stable, check fresh (${row.toolkitWorkflow.generatedFiles} files/${row.toolkitWorkflow.generatedBytes} bytes)\n`,
      );
    }
  } finally {
    if (harnessRoot !== undefined) {
      const resolvedHarness = resolve(harnessRoot);
      assert.ok(
        isWithin(resolvedHarness, nodeRoot) &&
          dirname(resolvedHarness) === nodeRoot &&
          resolvedHarness
            .slice(nodeRoot.length + 1)
            .startsWith('.atlas-node-compatibility-harness-'),
        `Refusing to remove unexpected harness path ${resolvedHarness}`,
      );
      await rm(resolvedHarness, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `Atlas Node compatibility verification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
