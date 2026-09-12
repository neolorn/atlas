/**
 * What a new project costs Atlas between `atlas init` and its second scope.
 *
 * Adding a scope is ordinary localization work and must cost no Atlas step. A generated-owner
 * identity taken as a digest over the scope list costs one: it moves the first time a consumer
 * writes a catalog and again every time they add another, the work root still records the identity
 * of the run before, and `atlas generate` refuses with `ATL1602` until `atlas clean` removes the
 * marker. A new project meets that on its second command: `generate` on an empty project prints
 * `ATL1702`, which names the exact next step, write `i18n/shell/en-US.yaml`, and doing exactly
 * that breaks the next `generate`.
 *
 * So this is the sequence a new project actually performs, run cold:
 *
 *   1. `atlas init`
 *   2. `atlas generate`: no catalogs yet
 *   3. write the first catalog, in the scope `ATL1702` names
 *   4. `atlas generate`
 *   5. write a second scope
 *   6. `atlas generate`
 *
 * Every one must succeed, and `atlas clean` appears nowhere.
 *
 * **The identity is checked against what it is supposed to be made of, not merely against itself.**
 * "The three generates all passed" would also be true of an identity that still moved and a refusal
 * that had been softened into a silent re-own, and a silent re-own is how one project's disposable
 * state comes to serve another's build, which is the whole reason the marker exists. So after each
 * generation the marker is read and required to equal `atlasOwnerId({providerId, generatedRootPath})`
 * computed here from the project's own package name and its configured output location. That
 * equality is the rule itself, stated as an assertion: an identity equal to a function of those two
 * fields cannot contain anything the consumer authored.
 *
 * **The toolkit under test is the installed one**, from the materialized consumer's `node_modules`,
 * because a package is verified through its built distributable and because a staged `dist/toolkit`
 * cannot resolve its own dependencies in place. Nothing here writes to that consumer.
 *
 * Cold on purpose and small on purpose: no `ng new`, no install. The defect is in the toolkit's own
 * ownership handling, and a directory with a package manifest, a tsconfig, one source file and some
 * catalogs reaches it in a second. The tsconfig is not scaffolding for its own sake: `generate`
 * refuses an owner it cannot analyze, because with no TypeScript graph every message reads as
 * unused.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installedToolkit = resolve(
  workspaceRoot,
  'tmp/package-consumer-verification/package-consumer/node_modules/@neolorn/atlas-toolkit',
);
if (!existsSync(installedToolkit)) {
  process.stderr.write(
    'The cold start runs the installed toolkit. Run "pnpm run verify:consumer" first.\n',
  );
  process.exit(1);
}
// The modules rather than the package entry. The ownership marker is Atlas's own bookkeeping
// rather than something a build script writes, so it is not published, and this reads it from where
// it is declared.
const { ATLAS_WORK_OWNER_PATH, ATLAS_WORK_OWNER_PROFILE } = await import(
  pathToFileURL(resolve(installedToolkit, 'output-host.js')).href
);
const { atlasOwnerId } = await import(
  pathToFileURL(resolve(installedToolkit, 'compiled-artifacts.js')).href
);

const cli = resolve(installedToolkit, 'cli.js');
const scratchRoot = resolve(workspaceRoot, 'tmp/cold-start');
// The project directory's name is the package name, which is the provider identity, which is half
// of what the owner identity is made of. Named rather than incidental for that reason.
const projectName = 'atlas-cold-start';
const projectRoot = resolve(scratchRoot, projectName);
const generatedRootPath = 'src/generated/i18n';
const expectedOwnerId = atlasOwnerId({
  providerId: projectName,
  generatedRootPath,
});

const steps = [];

function run(...args) {
  const label = `atlas ${args.join(' ')}`;
  const finished = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const stdout = finished.stdout ?? '';
  let result;
  try {
    result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    result = undefined;
  }
  assert.ok(
    result !== undefined,
    `${label} emitted no machine-readable result.\n${stdout}\n${finished.stderr ?? ''}`,
  );
  steps.push(label);
  return { label, result, exitCode: finished.status };
}

function atlas(...args) {
  const { label, result, exitCode } = run(...args);
  assert.equal(
    result.status,
    'success',
    `${label} reported ${result.status}: ${JSON.stringify(result.diagnostics, null, 2)}`,
  );
  // Both, because they are two different claims. The status says what the command decided; the exit
  // code is what a consumer's script reads, and the two disagreeing is itself the defect that put
  // the severity test on the success path.
  assert.equal(exitCode, 0, `${label} exited ${exitCode}.`);
  return result;
}

async function recordedOwnerId() {
  const markerPath = resolve(projectRoot, '.atlas', ATLAS_WORK_OWNER_PATH);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(
    marker.profile,
    ATLAS_WORK_OWNER_PROFILE,
    'The work-root marker is not the profile this version of Atlas writes.',
  );
  return marker.ownerId;
}

async function writeScope(scope, key, source, translation) {
  const scopeRoot = resolve(projectRoot, 'i18n', scope);
  await mkdir(scopeRoot, { recursive: true });
  await writeFile(
    resolve(scopeRoot, 'en-US.yaml'),
    `messages:\n  ${key}: ${JSON.stringify(source)}\n`,
    'utf8',
  );
  await writeFile(
    resolve(scopeRoot, 'ar-EG.yaml'),
    `messages:\n  ${key}: ${JSON.stringify(translation)}\n`,
    'utf8',
  );
  steps.push(`write i18n/${scope}`);
}

await rm(scratchRoot, { recursive: true, force: true });
await mkdir(resolve(projectRoot, 'src'), { recursive: true });
await writeFile(
  resolve(projectRoot, 'package.json'),
  `${JSON.stringify({ name: projectName, private: true }, undefined, 2)}\n`,
  'utf8',
);
await writeFile(
  resolve(projectRoot, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: { target: 'ES2022', module: 'preserve', strict: true },
      include: ['src/**/*.ts'],
    },
    undefined,
    2,
  )}\n`,
  'utf8',
);
await writeFile(
  resolve(projectRoot, 'src/main.ts'),
  'export const started = true;\n',
  'utf8',
);

atlas(
  'init',
  '--source-locale',
  'en-US',
  '--default-locale',
  'en-US',
  '--locale',
  'en-US',
  '--locale',
  'ar-EG',
);

atlas('generate');
const afterFirstGenerate = await recordedOwnerId();

await writeScope('shell', 'app-title', 'Atlas', 'أطلس');
atlas('generate');
const afterFirstCatalog = await recordedOwnerId();

await writeScope('checkout', 'pay-now', 'Pay now', 'ادفع الآن');
atlas('generate');
const afterSecondScope = await recordedOwnerId();

assert.equal(
  afterFirstGenerate,
  expectedOwnerId,
  'The recorded owner identity is not what this project and its output location compute to, so something else is in it.',
);
assert.equal(
  afterFirstCatalog,
  expectedOwnerId,
  'The owner identity moved when the first catalog was written. That is the defect ATL1602 reported on day one.',
);
assert.equal(
  afterSecondScope,
  expectedOwnerId,
  'The owner identity moved when a second scope was added. Adding a scope must cost no Atlas step.',
);

// And then the case where ownership genuinely is foreign, because the refusal has to stay a refusal.
// Renaming the package is the honest way to reach it: the provider identity is the package name, so
// after a rename this is a different project generating into a work root the previous one marked.
// Re-owning is the correct outcome, and the diagnostic is how a reader learns that.
const renamed = 'atlas-cold-start-renamed';
await writeFile(
  resolve(projectRoot, 'package.json'),
  `${JSON.stringify(
    {
      ...JSON.parse(
        await readFile(resolve(projectRoot, 'package.json'), 'utf8'),
      ),
      name: renamed,
    },
    undefined,
    2,
  )}\n`,
  'utf8',
);
const renamedOwnerId = atlasOwnerId({ providerId: renamed, generatedRootPath });
const foreign = run('generate');
assert.equal(
  foreign.result.status,
  'environment-failure',
  'A work root marked by another project was adopted rather than refused.',
);
const refusal = foreign.result.diagnostics.find(
  (diagnostic) => diagnostic.code === 'ATL1602',
);
assert.ok(refusal, 'The refusal did not report ATL1602.');
// Read from the machine output on purpose. The summary passes through the redaction that keeps a
// consumer's absolute paths out of published JSON, and a redaction running to the end of the line
// takes everything after the path with it, which is both identities and the recovery, leaving them
// for a human reader and no machine one.
for (const [what, expected] of [
  ['the identity it found', expectedOwnerId],
  ['the identity this project computes', renamedOwnerId],
  ['the recovery', 'atlas clean'],
]) {
  assert.ok(
    refusal.summary.includes(expected),
    `ATL1602 does not name ${what}. It says: ${refusal.summary}`,
  );
}

// The recovery the message names, performed. A diagnostic that prescribes a step Atlas does not
// actually accept is worse than one that prescribes none.
atlas('clean');
atlas('generate');
assert.equal(
  await recordedOwnerId(),
  renamedOwnerId,
  'After the prescribed recovery the work root does not belong to the project that ran it.',
);

await rm(scratchRoot, { recursive: true, force: true });

process.stdout.write(
  `Atlas cold start: ${steps.join(', ')}. Six steps green on one owner identity (${expectedOwnerId}) with no clean, and a foreign work root refused by name with its recovery.\n`,
);
