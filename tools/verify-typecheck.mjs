import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(workspaceRoot, 'tsconfig.typecheck.json');

/**
 * Typechecks every TypeScript file in the repository, including the ones no build reaches.
 *
 * *What was not checked, and how that stayed invisible.* Types were checked only as a side effect of
 * building: `ngc` compiles what each entry point's `public-api.ts` imports, and `tsc -p
 * tsconfig.build.json` compiles the toolkit's `src`. Two categories fell outside every program.
 * Test files, all of them, because vitest transpiles with esbuild, which strips types
 * without checking them. And any module no entry point reaches: `route-table.ts` was written, tested, and
 * `pnpm run build` reported success while the file was in no program at all, which from outside
 * looks exactly like a file that compiled.
 *
 * *Why this is a script and not just a config.* A `tsconfig` cannot check that it covers the ground
 * it was written for, and that is the failure this item exists to prevent: a hand-written
 * `include` that passes every run while covering nothing new. So two things are derived from disk
 * here and compared against the config: the entry points, and the files the program actually loaded.
 * A new entry point, a new package, or a new test directory is covered on the day it lands, and if
 * the config stops reaching it this fails and names what it missed.
 */

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.git',
  '.atlas',
  'tmp',
]);

/** Every `src` and `test` directory under `packages/`, at any depth. */
async function sourceRoots(from) {
  const roots = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.name === 'src' || entry.name === 'test') roots.push(path);
      await walk(path);
    }
  };
  await walk(from);
  return roots.sort();
}

/** Every `.ts` file under a root, excluding declaration files, which are not compiled units. */
async function typeScriptFiles(root) {
  const files = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(path);
        continue;
      }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(path);
      }
    }
  };
  await walk(root);
  return files;
}

/**
 * The published specifier every entry point answers to, and the file behind it.
 *
 * A secondary entry point imports the primary by its published name rather than by a relative path,
 * which is what keeps the shared core compiled into one bundle. `ng-packagr` resolves that during a
 * build; a bare `tsc` has to be told, and being told by hand is how the list rots. Each entry point
 * already declares its own `entryFile`, so the list is read from the same declarations the build
 * reads.
 */
async function entryPointPaths() {
  const mappings = new Map();
  for (const packageDirectory of await readdir(
    resolve(workspaceRoot, 'packages'),
    { withFileTypes: true },
  )) {
    if (!packageDirectory.isDirectory()) continue;
    const packageRoot = resolve(
      workspaceRoot,
      'packages',
      packageDirectory.name,
    );
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    );

    let sawEntryPoint = false;
    for (const root of [packageRoot, ...(await subdirectories(packageRoot))]) {
      const declaration = await readJson(resolve(root, 'ng-package.json'));
      if (declaration === undefined) continue;
      sawEntryPoint = true;
      const subpath = relative(packageRoot, root).replaceAll('\\', '/');
      const specifier =
        subpath === '' ? manifest.name : `${manifest.name}/${subpath}`;
      mappings.set(
        specifier,
        `./${relative(workspaceRoot, resolve(root, declaration.lib.entryFile)).replaceAll('\\', '/')}`,
      );
    }

    // A package that declares no Angular entry points still publishes one module, and the toolkit
    // is that package. Its entry is the file its build config takes as `rootDir`'s index.
    if (!sawEntryPoint) {
      mappings.set(
        manifest.name,
        `./${relative(workspaceRoot, resolve(packageRoot, 'src/index.ts')).replaceAll('\\', '/')}`,
      );
    }
  }
  return mappings;
}

async function subdirectories(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name),
    )
    .map((entry) => resolve(root, entry.name));
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

const configuration = JSON.parse(readFileSync(configPath, 'utf8'));

// 1. The entry points the config maps are exactly the ones on disk.
const expected = await entryPointPaths();
const declared = new Map(
  Object.entries(configuration.compilerOptions.paths ?? {}).map(
    ([specifier, targets]) => [specifier, targets[0]],
  ),
);
const expectedText = JSON.stringify(
  Object.fromEntries([...expected].sort()),
  null,
  2,
);
assert.equal(
  JSON.stringify(Object.fromEntries([...declared].sort()), null, 2),
  expectedText,
  `tsconfig.typecheck.json no longer maps the entry points that exist. An unmapped entry point ` +
    `does not fail to resolve quietly: it produces a cascade of unrelated errors in every file ` +
    `that imports it. Set "compilerOptions.paths" to:\n${expectedText}\n`,
);

// 2. The program loads every file under every derived root.
const roots = await sourceRoots(resolve(workspaceRoot, 'packages'));
assert.ok(
  roots.length > 0,
  'No src or test directory was found under packages/, which cannot be right: the walk is broken.',
);

const tsc = spawnSync(
  process.execPath,
  [
    resolve(workspaceRoot, 'node_modules/typescript/bin/tsc'),
    '-p',
    configPath,
    '--noEmit',
    '--listFiles',
    '--pretty',
    'false',
  ],
  { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const output = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`;
const loaded = new Set(
  output
    .split(/\r?\n/u)
    .filter((line) => line.endsWith('.ts') || line.endsWith('.tsx'))
    .map((line) => resolve(workspaceRoot, line.trim())),
);

const missing = [];
for (const root of roots) {
  for (const file of await typeScriptFiles(root)) {
    if (!loaded.has(resolve(file))) missing.push(relative(workspaceRoot, file));
  }
}
assert.deepEqual(
  missing,
  [],
  `The typecheck program did not load ${missing.length} file(s) that exist under packages/. This ` +
    `is the failure the item was written for: a file outside every program compiles by not being ` +
    `compiled, and reads from outside exactly like one that passed. Widen "include" in ` +
    `tsconfig.typecheck.json until this is empty.\n  ${missing.join('\n  ')}\n`,
);

// 3. And the types themselves.
const diagnostics = output
  .split(/\r?\n/u)
  .filter((line) => /error TS\d+:/u.test(line));
if (diagnostics.length > 0 || tsc.status !== 0) {
  process.stderr.write(
    `${diagnostics.join('\n')}\n\nAtlas typecheck failed with ${diagnostics.length} error(s).\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Atlas typecheck verified: ${loaded.size} files loaded across ${roots.length} source roots, ` +
    `${expected.size} entry points mapped, no type errors.\n`,
);
