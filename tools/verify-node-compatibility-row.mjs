import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';

import { nodeRange } from './supported-versions.mjs';

const cliTimeout = 30_000;
const cliMaxBuffer = 4 * 1024 * 1024;
const generatedFileLimit = 64;
const generatedByteLimit = 2 * 1024 * 1024;
const digestPattern = /^sha256-[A-Za-z0-9_-]{43}$/u;

function readArguments() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    assert.ok(
      name?.startsWith('--'),
      `Unexpected argument ${name ?? '<missing>'}`,
    );
    assert.notEqual(value, undefined, `Missing value for ${name}`);
    values.set(name.slice(2), value);
  }
  for (const name of ['expected-version', 'harness-root', 'row']) {
    assert.ok(values.has(name), `Missing --${name}`);
  }
  return Object.freeze({
    expectedVersion: values.get('expected-version'),
    harnessRoot: resolve(values.get('harness-root')),
    row: values.get('row'),
  });
}

const isWithin = (candidate, owner) => {
  const path = relative(owner, candidate);
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  );
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function writeProjectFile(projectRoot, portablePath, contents) {
  const outputPath = resolve(projectRoot, ...portablePath.split('/'));
  assert.ok(
    outputPath !== projectRoot && isWithin(outputPath, projectRoot),
    `Fixture path ${portablePath} escapes its project root`,
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contents, 'utf8');
}

async function createProjectFixture(projectRoot) {
  const files = Object.freeze({
    'package.json': `${JSON.stringify(
      {
        name: '@example/atlas-node-row-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
        imports: {
          '#i18n': './src/generated/i18n/index.ts',
          '#i18n/*': './src/generated/i18n/*.ts',
        },
        scripts: {
          'atlas:generate': 'atlas generate',
          'atlas:check': 'atlas check',
        },
      },
      null,
      2,
    )}\n`,
    'atlas.config.json': `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: ['en-US', 'ar-EG'],
      },
      null,
      2,
    )}\n`,
    'i18n/shell/en-US.yaml': [
      'messages:',
      '  app-title: Atlas Node row fixture',
      "  welcome: 'Welcome, {$name}!'",
      '  recovery.unavailable: Localization is temporarily unavailable.',
      '',
    ].join('\n'),
    'i18n/shell/ar-EG.yaml': [
      'messages:',
      '  app-title: تطبيق Atlas',
      "  welcome: 'مرحبًا، {$name}!'",
      '  recovery.unavailable: الترجمة غير متاحة مؤقتًا.',
      '',
    ].join('\n'),
    'tsconfig.app.json': `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'preserve',
          moduleResolution: 'bundler',
          resolvePackageJsonImports: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
    // Every message this fixture authors is read, so the unused-source-message advisory has
    // nothing to say and the row keeps asserting that generation reports no diagnostics at all.
    // Loosening that to "no errors" would take the shape a known defect had: a severity filter a real
    // regression can hide behind.
    'src/app.ts': [
      "import { messages } from '#i18n/shell';",
      '',
      'export const title = messages.appTitle.messageId;',
      'export const greeting = messages.welcome.messageId;',
      'export const unavailable = messages.recovery.unavailable.messageId;',
      '',
    ].join('\n'),
  });
  for (const [portablePath, contents] of Object.entries(files)) {
    await writeProjectFile(projectRoot, portablePath, contents);
  }
}

const compareNames = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

async function snapshotGeneratedOutput(generatedRoot) {
  const files = [];
  let bytes = 0;
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const outputPath = resolve(directory, entry.name);
      assert.ok(
        isWithin(outputPath, generatedRoot),
        `Generated entry ${outputPath} escapes ${generatedRoot}`,
      );
      assert.equal(
        entry.isSymbolicLink(),
        false,
        `Generated output must not contain a symbolic link: ${outputPath}`,
      );
      if (entry.isDirectory()) {
        await visit(outputPath);
        continue;
      }
      assert.equal(
        entry.isFile(),
        true,
        `Generated output must contain only ordinary files: ${outputPath}`,
      );
      const metadata = await lstat(outputPath);
      assert.equal(
        metadata.isSymbolicLink(),
        false,
        `Generated output must not contain a symbolic link: ${outputPath}`,
      );
      const contents = await readFile(outputPath);
      bytes += contents.byteLength;
      files.push(
        Object.freeze({
          path: relative(generatedRoot, outputPath).split(sep).join('/'),
          bytes: contents.byteLength,
          digest: createHash('sha256').update(contents).digest('hex'),
          mtimeMs: metadata.mtimeMs,
        }),
      );
      assert.ok(
        files.length <= generatedFileLimit,
        `Generated fixture exceeded the ${generatedFileLimit}-file row limit`,
      );
      assert.ok(
        bytes <= generatedByteLimit,
        `Generated fixture exceeded the ${generatedByteLimit}-byte row limit`,
      );
    }
  };
  await visit(generatedRoot);
  assert.ok(files.length > 0, 'Atlas generate did not publish any files');
  return Object.freeze({ files: Object.freeze(files), bytes });
}

function cliFailure(result) {
  if (result.error !== undefined) return result.error.message;
  if (result.signal !== null) return `terminated by signal ${result.signal}`;
  return [result.stderr, result.stdout]
    .filter((value) => value.trim() !== '')
    .join('\n')
    .trim();
}

function runMachineCommand(cliPath, projectRoot, command, validateCliResult) {
  const result = spawnSync(
    process.execPath,
    [cliPath, command, '--project', projectRoot, '--json'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        NODE_PATH: '',
        NO_COLOR: '1',
      },
      maxBuffer: cliMaxBuffer,
      timeout: cliTimeout,
      windowsHide: true,
    },
  );
  assert.equal(
    result.error,
    undefined,
    `Atlas ${command} could not launch: ${cliFailure(result)}`,
  );
  assert.equal(result.signal, null, `Atlas ${command} ${cliFailure(result)}`);
  assert.equal(
    result.status,
    0,
    `Atlas ${command} failed: ${cliFailure(result)}`,
  );
  assert.equal(
    result.stderr,
    '',
    `Atlas ${command} emitted stderr: ${result.stderr}`,
  );
  const source = result.stdout.trim();
  const lines = source.split(/\r?\n/u).filter((line) => line !== '');
  assert.equal(
    lines.length,
    1,
    `Atlas ${command} must emit exactly one machine-result line`,
  );
  let record;
  try {
    record = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(
      `Atlas ${command} emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert.equal(
    validateCliResult(record),
    true,
    `Atlas ${command} machine result violates the public schema: ${JSON.stringify(validateCliResult.errors)}`,
  );
  assert.equal(record.profile, 'atlas-cli-result/1');
  assert.equal(record.command, command);
  assert.equal(record.status, 'success');
  assert.deepEqual(record.diagnostics, []);
  assert.equal(
    typeof record.result,
    'object',
    `Atlas ${command} did not include a result object`,
  );
  assert.notEqual(record.result, null);
  return Object.freeze({ source, record });
}

function assertGeneration(run, changed, invalidationKind) {
  const result = run.record.result;
  assert.equal(result.dryRun, false);
  assert.equal(result.changed, changed);
  assert.ok(Array.isArray(result.written));
  assert.ok(Array.isArray(result.removed));
  assert.ok(Array.isArray(result.unchanged));
  assert.match(result.inputFingerprint, digestPattern);
  assert.match(result.planDigest, digestPattern);
  assert.equal(result.invalidation?.kind, invalidationKind);
  assert.ok(Array.isArray(result.invalidation?.changedInputs));
  assert.ok(Array.isArray(result.invalidation?.affectedOutputs));
  assert.equal(result.catalogs, 2);
  assert.equal(result.scopes, 1);
  assert.equal(result.messages, 3);
  if (changed) {
    assert.ok(result.written.length > 0);
    assert.deepEqual(result.removed, []);
    assert.ok(result.invalidation.changedInputs.length > 0);
    assert.ok(result.invalidation.affectedOutputs.length > 0);
  } else {
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.invalidation.changedInputs, []);
    assert.deepEqual(result.invalidation.affectedOutputs, []);
  }
  return result;
}

function assertCheck(run, generation) {
  const result = run.record.result;
  assert.equal(result.fix, false);
  assert.equal(result.fresh, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.fixedFiles, []);
  assert.equal(result.inputFingerprint, generation.inputFingerprint);
  assert.equal(result.planDigest, generation.planDigest);
  assert.equal(result.catalogs, 2);
  assert.equal(result.scopes, 1);
  assert.equal(result.messages, 3);
  return result;
}

function defaultExportTarget(exportsEntry, label) {
  const target =
    typeof exportsEntry === 'string' ? exportsEntry : exportsEntry?.default;
  assert.equal(
    typeof target,
    'string',
    `${label} must declare a default JavaScript export target`,
  );
  assert.ok(
    target.startsWith('./'),
    `${label} must use a relative export target`,
  );
  return target;
}

/**
 * Every runtime subpath this row actually loaded.
 *
 * Collected by the importing rather than written as a literal beside it. A literal
 * `['.', './forms', './router', './testing']` makes the summary read `runtime 4/4` whether or not
 * any of them loaded, and still read `4/4` after the `ssr` entry point is added, with the new one
 * unmentioned. A count that cannot move is not evidence of anything.
 */
const importedRuntimeEntrypoints = [];

async function importPublicEntry(packageRoot, manifest, subpath) {
  const exportsEntry = manifest.exports?.[subpath];
  assert.notEqual(
    exportsEntry,
    undefined,
    `${manifest.name} does not declare public export ${subpath}`,
  );
  const target = defaultExportTarget(
    exportsEntry,
    `${manifest.name} export ${subpath}`,
  );
  const outputPath = resolve(packageRoot, target);
  assert.ok(
    isWithin(outputPath, packageRoot),
    `${manifest.name} export ${subpath} escapes its built package root`,
  );
  const loaded = await import(pathToFileURL(outputPath).href);
  if (manifest.name === '@neolorn/atlas') {
    importedRuntimeEntrypoints.push(subpath);
  }
  return loaded;
}

function assertFunction(module, name, entrypoint) {
  assert.equal(
    typeof module[name],
    'function',
    `${entrypoint} is missing public function/class ${name}`,
  );
}

/**
 * What Atlas actually renders on this Node runtime.
 *
 * Rendered rather than type-checked. Asserting that five exports are functions and invoking none
 * of them says nothing about the three Node majors `engines.node` advertises. ICU data differs
 * across majors, and server and client must not diverge in locale or formatting: a build that
 * prerenders on one major and a server that renders on another produce different text with every
 * export still passing a typeof check.
 *
 * Deliberately not pinned to a numbering system or a calendar where the default is the thing at
 * risk. If two supported Node majors disagree about what `ar-EG` means, that is precisely the
 * divergence this exists to surface, and the correct response is a decision rather than a silently
 * widened expectation.
 */
function localizedOutputEvidence(runtime) {
  const arabic = Object.freeze({ locale: 'ar-EG', timeZone: 'Africa/Cairo' });
  const english = Object.freeze({ locale: 'en-US', timeZone: 'UTC' });
  const moment = runtime.instant('1800000000123456789');
  const text = (result) => {
    assert.equal(
      result.ok,
      true,
      `Formatting failed: ${JSON.stringify(result)}`,
    );
    return result.value.text;
  };

  return Object.freeze({
    profile: 'atlas-node-localized-output/1',
    numberArabic: text(
      runtime.formatNumber(runtime.decimal('1234567.89'), arabic, {}),
    ),
    numberEnglish: text(
      runtime.formatNumber(runtime.decimal('1234567.89'), english, {}),
    ),
    moneyArabic: text(
      runtime.formatMoney(
        runtime.money(runtime.decimal('1234.50'), 'EGP'),
        arabic,
        {},
      ),
    ),
    moneyEnglish: text(
      runtime.formatMoney(
        runtime.money(runtime.decimal('1234.50'), 'EGP'),
        english,
        {},
      ),
    ),
    instantArabic: text(
      runtime.formatInstant(moment, arabic, {
        dateStyle: 'long',
        timeStyle: 'medium',
      }),
    ),
    instantEnglish: text(
      runtime.formatInstant(moment, english, {
        dateStyle: 'long',
        timeStyle: 'medium',
      }),
    ),
    relativeArabic: text(
      runtime.formatRelativeTime(runtime.decimal('-1'), 'day', arabic, {
        numeric: 'auto',
      }),
    ),
    listArabic: text(
      runtime.formatList(['\u0623', '\u0628', '\u062c'], arabic, {}),
    ),
    // Arabic has six cardinal categories and they are the reason plural coverage is checked at
    // all. A Node major that resolved them differently would change which variant every counted
    // noun renders.
    pluralArabic: [0, 1, 2, 3, 11, 100].map((count) =>
      runtime.selectPlural(count, 'ar-EG', 'cardinal'),
    ),
    directionArabic: runtime.languagePresentation('ar-EG').direction,
  });
}

async function main() {
  const options = readArguments();
  assert.match(
    options.row,
    /^[a-z0-9-]+$/u,
    'The compatibility row identifier is unsafe',
  );
  assert.equal(
    process.versions.node,
    options.expectedVersion,
    `Compatibility row ${options.row} launched Node ${process.versions.node}, expected ${options.expectedVersion}`,
  );

  const harnessRoot = await realpath(options.harnessRoot);
  const runtimeRoot = resolve(harnessRoot, 'node_modules', '@neolorn', 'atlas');
  const toolkitRoot = resolve(
    harnessRoot,
    'node_modules',
    '@neolorn',
    'atlas-toolkit',
  );
  const runtimeManifest = await readJson(resolve(runtimeRoot, 'package.json'));
  const toolkitManifest = await readJson(resolve(toolkitRoot, 'package.json'));

  assert.equal(runtimeManifest.name, '@neolorn/atlas');
  assert.equal(toolkitManifest.name, '@neolorn/atlas-toolkit');
  // The installed copies against what the packages declare, with the range read from the source
  // manifests rather than written again here.
  assert.equal(runtimeManifest.engines?.node, nodeRange);
  assert.equal(toolkitManifest.engines?.node, nodeRange);

  const harnessRequire = createRequire(resolve(harnessRoot, 'package.json'));
  const angularCompilerEntry = harnessRequire.resolve('@angular/compiler');
  await import(pathToFileURL(angularCompilerEntry).href);

  const runtime = await importPublicEntry(runtimeRoot, runtimeManifest, '.');
  const forms = await importPublicEntry(
    runtimeRoot,
    runtimeManifest,
    './forms',
  );
  const router = await importPublicEntry(
    runtimeRoot,
    runtimeManifest,
    './router',
  );
  const testing = await importPublicEntry(
    runtimeRoot,
    runtimeManifest,
    './testing',
  );
  // The server entry point, and the one with the most to prove here: it is the only Atlas code
  // that runs under Node in production rather than in a test, and the only one whose peer is
  // optional *and* server-only. An entry point that fails to load on a supported Node row fails
  // at a consumer's prerender, which is the least recoverable place to find out.
  const ssr = await importPublicEntry(runtimeRoot, runtimeManifest, './ssr');
  assertFunction(runtime, 'createLocalizationContext', '@neolorn/atlas');
  assertFunction(runtime, 'provideLocalizationSetup', '@neolorn/atlas');
  assertFunction(forms, 'LocalizedInput', '@neolorn/atlas/forms');
  assertFunction(router, 'provideLocalizedRouter', '@neolorn/atlas/router');
  assertFunction(ssr, 'provideLocalizedServerRendering', '@neolorn/atlas/ssr');
  assertFunction(
    testing,
    'provideLocalizationTesting',
    '@neolorn/atlas/testing',
  );

  const toolkit = await importPublicEntry(toolkitRoot, toolkitManifest, '.');
  assertFunction(toolkit, 'compileAtlasProject', '@neolorn/atlas-toolkit');
  assertFunction(toolkit, 'parseAtlasConfiguration', '@neolorn/atlas-toolkit');
  // Host admission is internal to the toolkit, so it comes from the module that declares it. The
  // public entry is still loaded above, because whether it loads at all on this row is half of what
  // this gate asks.
  const hostCompatibility = await import(
    pathToFileURL(resolve(toolkitRoot, 'host-compatibility.js')).href
  );
  const hostVersions = hostCompatibility.currentAtlasHostVersions();
  assert.equal(hostVersions.node, options.expectedVersion);
  const admission = hostCompatibility.admitAtlasHostCompatibility();
  assert.equal(
    admission.ok,
    true,
    `Host admission rejected ${JSON.stringify(hostVersions)}: ${JSON.stringify(admission.diagnostics)}`,
  );
  assert.equal(admission.value.profile, 'atlas-host-compatibility/1');

  const formatting = localizedOutputEvidence(runtime);

  assert.equal(
    typeof toolkit.ATLAS_CLI_RESULT_SCHEMA,
    'object',
    'Toolkit public API is missing ATLAS_CLI_RESULT_SCHEMA',
  );
  const { default: Ajv2020 } = await import(
    pathToFileURL(harnessRequire.resolve('ajv/dist/2020.js')).href
  );
  const validateCliResult = new Ajv2020({
    allErrors: true,
    strict: true,
  }).compile(toolkit.ATLAS_CLI_RESULT_SCHEMA);

  const cliTarget = toolkitManifest.bin?.atlas;
  assert.equal(typeof cliTarget, 'string', 'Toolkit atlas binary is missing');
  const cliPath = resolve(toolkitRoot, cliTarget);
  assert.ok(
    isWithin(cliPath, toolkitRoot),
    'Toolkit atlas binary escapes package',
  );
  const help = spawnSync(process.execPath, [cliPath, '--help'], {
    cwd: harnessRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_PATH: '',
      NO_COLOR: '1',
    },
    maxBuffer: 1_048_576,
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(help.error, undefined, help.error?.message);
  assert.equal(
    help.signal,
    null,
    `Atlas CLI help terminated by ${help.signal}`,
  );
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /Usage: atlas <command> \[options\]/u);
  assert.match(help.stdout, /migrate\s+Preview or apply/u);
  assert.match(help.stdout, /Exit codes: 0 success/u);

  const projectsRoot = resolve(harnessRoot, 'projects');
  await mkdir(projectsRoot, { recursive: true });
  const projectPrefix = `.atlas-node-row-${options.row}-`;
  let projectRoot;
  let workflowEvidence;
  try {
    projectRoot = await mkdtemp(resolve(projectsRoot, projectPrefix));
    await createProjectFixture(projectRoot);

    const firstGenerate = runMachineCommand(
      cliPath,
      projectRoot,
      'generate',
      validateCliResult,
    );
    const initialGeneration = assertGeneration(firstGenerate, true, 'initial');
    const generatedRoot = resolve(projectRoot, 'src/generated/i18n');
    const initialSnapshot = await snapshotGeneratedOutput(generatedRoot);

    const secondGenerate = runMachineCommand(
      cliPath,
      projectRoot,
      'generate',
      validateCliResult,
    );
    const stableGeneration = assertGeneration(secondGenerate, false, 'none');
    assert.equal(
      stableGeneration.inputFingerprint,
      initialGeneration.inputFingerprint,
    );
    assert.equal(stableGeneration.planDigest, initialGeneration.planDigest);
    const stableSnapshot = await snapshotGeneratedOutput(generatedRoot);
    assert.deepEqual(
      stableSnapshot,
      initialSnapshot,
      'A no-change generate mutated generated bytes or mtimes',
    );

    const thirdGenerate = runMachineCommand(
      cliPath,
      projectRoot,
      'generate',
      validateCliResult,
    );
    assertGeneration(thirdGenerate, false, 'none');
    assert.equal(
      thirdGenerate.source,
      secondGenerate.source,
      'Repeated no-change generate machine output is not deterministic',
    );
    assert.deepEqual(
      await snapshotGeneratedOutput(generatedRoot),
      initialSnapshot,
      'A repeated no-change generate mutated generated bytes or mtimes',
    );

    const firstCheck = runMachineCommand(
      cliPath,
      projectRoot,
      'check',
      validateCliResult,
    );
    assertCheck(firstCheck, stableGeneration);
    const secondCheck = runMachineCommand(
      cliPath,
      projectRoot,
      'check',
      validateCliResult,
    );
    assertCheck(secondCheck, stableGeneration);
    assert.equal(
      secondCheck.source,
      firstCheck.source,
      'Repeated check machine output is not deterministic',
    );
    assert.deepEqual(
      await snapshotGeneratedOutput(generatedRoot),
      initialSnapshot,
      'Atlas check mutated generated bytes or mtimes',
    );

    workflowEvidence = Object.freeze({
      profile: 'atlas-node-toolkit-workflow/1',
      fixture: 'two-locale-typescript',
      generatedFiles: initialSnapshot.files.length,
      generatedBytes: initialSnapshot.bytes,
      inputFingerprint: stableGeneration.inputFingerprint,
      planDigest: stableGeneration.planDigest,
      initialGenerate: 'changed',
      repeatedGenerate: 'unchanged-deterministic',
      repeatedCheck: 'fresh-deterministic-read-only',
    });
  } finally {
    if (projectRoot !== undefined) {
      const resolvedProject = resolve(projectRoot);
      assert.ok(
        isWithin(resolvedProject, projectsRoot) &&
          dirname(resolvedProject) === projectsRoot &&
          basename(resolvedProject).startsWith(projectPrefix),
        `Refusing to remove unexpected row project ${resolvedProject}`,
      );
      await rm(resolvedProject, { recursive: true, force: true });
      assert.equal(
        await pathExists(resolvedProject),
        false,
        `Row project cleanup failed for ${resolvedProject}`,
      );
    }
  }
  assert.notEqual(workflowEvidence, undefined);

  process.stdout.write(
    `ATLAS_NODE_ROW ${JSON.stringify({
      profile: 'atlas-node-compatibility/1',
      row: options.row,
      node: options.expectedVersion,
      architecture: process.arch,
      platform: process.platform,
      typescript: hostVersions.typescript,
      angularCompiler: hostVersions.angularCompiler,
      runtimeEntrypoints: [...importedRuntimeEntrypoints].sort(),
      formatting,
      toolkitEntrypoints: ['.'],
      hostAdmission: 'accepted',
      cliHelp: 'accepted',
      toolkitWorkflow: workflowEvidence,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Atlas Node row verification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
