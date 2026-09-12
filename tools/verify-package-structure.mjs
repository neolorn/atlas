/**
 * The two distributables, read as a consumer resolves them.
 *
 * `specs/02-packages-and-platform.spec.md` section 11 is the reason this reads `dist/` rather than
 * `packages/`: a source import does not exercise the export map, the declarations, or the
 * packaging a consumer resolves. Section 1 of `specs/02-packages-and-platform.spec.md` is what
 * the toolkit and Node
 * isolation assertions hold, and section 11 of `specs/02-packages-and-platform.spec.md` is where the
 * path and metadata assertions come from.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import {
  dirname,
  extname,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import ts from 'typescript';

import { nodeRange, peerRange } from './supported-versions.mjs';

// The packaged Angular entrypoint is intentionally published in partial-Ivy
// form, which `specs/02-packages-and-platform.spec.md` section 5 requires. Load Angular's JIT
// fallback before importing that raw package in Node; real consumer builds process the same
// declarations through the linker.
await import('@angular/compiler');

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = resolve(workspaceRoot, 'dist/runtime');
const toolkitRoot = resolve(workspaceRoot, 'dist/toolkit');
const isWithin = (candidate, owner) => {
  const path = relative(owner, candidate);
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  );
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const assertPortableReference = (reference, label) => {
  assert.equal(typeof reference, 'string', `${label} is not a string`);
  assert.notEqual(reference, '', `${label} is empty`);
  assert.equal(
    win32.isAbsolute(reference) || posix.isAbsolute(reference),
    false,
    `${label} is machine-absolute: ${reference}`,
  );
  assert.equal(
    /^file:/iu.test(reference),
    false,
    `${label} uses a file URL: ${reference}`,
  );
  assert.equal(
    /^[a-z][a-z0-9+.-]*:/iu.test(reference),
    false,
    `${label} uses an unsupported URL scheme: ${reference}`,
  );
};

const collectManifestPaths = (value, paths = []) => {
  if (typeof value === 'string') {
    paths.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectManifestPaths(item, paths);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      collectManifestPaths(item, paths);
    }
  }
  return paths;
};

const assertPackageFile = async (packageRoot, reference, label) => {
  assertPortableReference(reference, label);
  const path = resolve(packageRoot, reference);
  assert.equal(
    isWithin(path, packageRoot),
    true,
    `${label} escapes its package root: ${reference}`,
  );
  const [canonicalPackageRoot, canonicalPath] = await Promise.all([
    realpath(packageRoot),
    realpath(path),
  ]);
  assert.equal(
    isWithin(canonicalPath, canonicalPackageRoot),
    true,
    `${label} resolves outside its package root: ${reference}`,
  );
  const metadata = await stat(canonicalPath);
  assert.equal(metadata.isFile(), true, `${label} is not a file: ${reference}`);
  return canonicalPath;
};

const assertManifestTargets = async (manifest, packageRoot, label) => {
  for (const reference of collectManifestPaths({
    bin: manifest.bin,
    exports: manifest.exports,
    main: manifest.main,
    module: manifest.module,
    types: manifest.types,
    typings: manifest.typings,
  })) {
    await assertPackageFile(packageRoot, reference, `${label} manifest path`);
  }
};

const workspacePackage = await readJson(resolve(workspaceRoot, 'package.json'));
assert.equal(workspacePackage.packageManager, 'pnpm@11.1.2');
// Literals, deliberately: this is a tripwire against an accidental `pnpm update` moving the
// development row, so reading the versions back out of the manifest would assert nothing. Angular's
// framework and tooling ship on separate patch trains, so both halves are pinned: pinning only
// `@angular/core` would let `@angular/build`, `@angular/cli` and `@angular/ssr` drift unwatched.
assert.equal(workspacePackage.devDependencies['@angular/core'], '22.1.3');
assert.equal(workspacePackage.devDependencies['@angular/ssr'], '22.1.7');
assert.equal(workspacePackage.devDependencies.typescript, '6.0.3');
assert.equal(
  (await readFile(resolve(workspaceRoot, '.node-version'), 'utf8')).trim(),
  '24.18.0',
);

const workspaceConfiguration = await readFile(
  resolve(workspaceRoot, 'pnpm-workspace.yaml'),
  'utf8',
);
for (const setting of [
  'autoInstallPeers: false',
  'strictPeerDependencies: true',
  "savePrefix: ''",
  'nodeVersion: 24.18.0',
  'engineStrict: true',
]) {
  assert.match(workspaceConfiguration, new RegExp(`^${setting}$`, 'mu'));
}
const lockfile = await readFile(
  resolve(workspaceRoot, 'pnpm-lock.yaml'),
  'utf8',
);
assert.match(
  lockfile,
  /^settings:\r?\n\s+autoInstallPeers: false$/mu,
  'The lockfile was not generated with the pnpm 11 peer policy',
);
const standardsLock = await readJson(
  resolve(workspaceRoot, 'standards/sources.lock.json'),
);
assert.equal(standardsLock.schemaVersion, 1);
assert.equal(standardsLock.profileId, 'atlas-1');
assert.equal(standardsLock.updatePolicy, 'intentional-review-only');
assert.equal(standardsLock.standardsProfile.unicode, '17.0.0');
assert.equal(standardsLock.standardsProfile.cldrLdml, '48.2');
assert.equal(standardsLock.standardsProfile.messageFormat, 'LDML 48.2');
assert.equal(
  standardsLock.standardsProfile.xliff,
  '2.2 Committee Specification 01',
);

const assertDigest = (source, algorithm, length) => {
  assert.equal(source.digest.algorithm, algorithm);
  assert.equal(source.digest.encoding, 'hex');
  assert.match(source.digest.value, new RegExp(`^[0-9a-f]{${length}}$`, 'u'));
};

const cldr = standardsLock.dataSources.cldrCore;
assert.equal(cldr.version, '48.2');
assert.equal(cldr.url, 'https://unicode.org/Public/cldr/48.2/core.zip');
assert.equal(
  cldr.checksumManifest,
  'https://unicode.org/Public/cldr/48.2/hashes/SHASUM512.txt',
);
assert.equal(cldr.bytes, 36044097);
assert.equal(cldr.license.name, 'Unicode-3.0');
assertDigest(cldr, 'SHA-512', 128);

const cldrJson = standardsLock.dataSources.cldrJsonCore;
assert.equal(cldrJson.package, 'cldr-core');
assert.equal(cldrJson.version, '48.2.0');
assert.equal(cldrJson.role, 'development-only derivation input');
assert.equal(
  cldrJson.url,
  'https://registry.npmjs.org/cldr-core/-/cldr-core-48.2.0.tgz',
);
assert.equal(cldrJson.digest.algorithm, 'SHA-512');
assert.equal(cldrJson.digest.encoding, 'base64');
assert.match(cldrJson.digest.value, /^[A-Za-z0-9+/]{86}==$/u);
assert.equal(cldrJson.license.name, 'Unicode-3.0');

const cldrLocaleNames = standardsLock.dataSources.cldrLocaleNames;
assert.equal(cldrLocaleNames.package, 'cldr-localenames-full');
assert.equal(cldrLocaleNames.version, '48.2.0');
assert.equal(
  cldrLocaleNames.url,
  'https://registry.npmjs.org/cldr-localenames-full/-/cldr-localenames-full-48.2.0.tgz',
);
assert.equal(cldrLocaleNames.digest.algorithm, 'SHA-512');
assert.equal(cldrLocaleNames.digest.encoding, 'base64');
assert.match(cldrLocaleNames.digest.value, /^[A-Za-z0-9+/]{86}==$/u);
assert.equal(cldrLocaleNames.license.name, 'Unicode-3.0');

/**
 * A locale-data package the lock records is the one the workspace installs.
 *
 * `specs/01-standards-profile.spec.md` section 4 requires the recorded digest of a source that is
 * not vendored to be the one the package manager recorded for the same version. Comparing the two
 * ties the lock entry to what the workspace actually installed, and these two packages are the
 * only inputs to the generated tables that arrive over the network.
 */
for (const source of [cldrJson, cldrLocaleNames]) {
  const installed = new RegExp(
    `^  ${source.package}@${source.version.replace(/\./gu, '\\.')}:\\r?\\n` +
      '    resolution: \\{integrity: sha512-([A-Za-z0-9+/=]+)\\}',
    'mu',
  ).exec(lockfile);
  assert.notEqual(
    installed,
    null,
    `${source.package}@${source.version} is recorded in standards/sources.lock.json and is not what pnpm-lock.yaml installs`,
  );
  assert.equal(
    installed[1],
    source.digest.value,
    `${source.package}@${source.version} hashes to ${installed[1]} in pnpm-lock.yaml and to ${source.digest.value} in standards/sources.lock.json`,
  );
}

const languageRegistry = standardsLock.dataSources.ianaLanguageSubtagRegistry;
assert.equal(languageRegistry.fileDate, '2026-06-14');
assert.equal(
  languageRegistry.projectSnapshot,
  'data/language-subtag-registry-2026-06-14.txt',
);
assert.equal(languageRegistry.bytes, 731605);
assertDigest(languageRegistry, 'SHA-256', 64);
const standardsRoot = resolve(workspaceRoot, 'standards');
const registrySnapshotPath = resolve(
  standardsRoot,
  languageRegistry.projectSnapshot,
);
assert.equal(
  isWithin(registrySnapshotPath, standardsRoot),
  true,
  'The language registry snapshot escapes the standards root',
);
const registrySnapshot = await readFile(registrySnapshotPath);
assert.equal(registrySnapshot.byteLength, languageRegistry.bytes);
assert.equal(
  createHash('sha256').update(registrySnapshot).digest('hex'),
  languageRegistry.digest.value,
);
assert.match(
  registrySnapshot.toString('utf8', 0, 64),
  /^File-Date: 2026-06-14$/mu,
);

const timeZoneDatabase = standardsLock.dataSources.ianaTimeZoneDatabase;
assert.equal(timeZoneDatabase.version, '2026c');
assert.equal(timeZoneDatabase.bytes, 475694);
assertDigest(timeZoneDatabase, 'SHA-512', 128);
assert.equal(
  standardsLock.normativeDocuments.xliffCore,
  'https://docs.oasis-open.org/xliff/xliff-core/v2.2/cs01/xliff-core-v2.2-cs01-part1.html',
);
assert.equal(
  standardsLock.normativeDocuments.xliffExtended,
  'https://docs.oasis-open.org/xliff/xliff-core/v2.2/cs01/xliff-extended-v2.2-cs01-part2.html',
);

const runtimePackage = await readJson(resolve(runtimeRoot, 'package.json'));
assert.equal(runtimePackage.name, '@neolorn/atlas');
assert.equal(runtimePackage.version, workspacePackage.version);
assert.equal(
  runtimePackage.description,
  'Localization runtime for Angular applications.',
);
// Both packages are MIT and go to public npm. The registry and the access
// level are pinned in the manifest rather than passed on the command line, so
// a publish cannot reach a different registry, and a scoped package cannot go
// out restricted by npm's default.
assert.equal(runtimePackage.private, undefined);
assert.deepEqual(runtimePackage.publishConfig, {
  registry: 'https://registry.npmjs.org',
  access: 'public',
});
assert.deepEqual(runtimePackage.repository, {
  type: 'git',
  url: 'git+https://github.com/neolorn/atlas.git',
  directory: 'packages/runtime',
});
assert.equal(runtimePackage.type, 'module');
assert.equal(runtimePackage.license, 'MIT');
assert.equal(runtimePackage.sideEffects, false);
// The names are written here and the ranges are not. A peer added to or dropped from the manifest
// fails on the shape; a range that shipped differently from what the package declares fails on the
// value. Writing the ranges here too would make this file a second place to change them, and the
// one most likely to be missed.
assert.deepEqual(runtimePackage.engines, { node: nodeRange });
// `specs/01-standards-profile.spec.md` section 14 states the dependency set of each published
// package. Compared whole rather than by membership, so a dependency added to the manifest fails
// here.
assert.deepEqual(runtimePackage.dependencies, { tslib: '^2.8.1' });
assert.deepEqual(runtimePackage.peerDependencies, {
  '@angular/common': peerRange('@angular/common'),
  '@angular/core': peerRange('@angular/core'),
  '@angular/forms': peerRange('@angular/forms'),
  '@angular/router': peerRange('@angular/router'),
  '@angular/ssr': peerRange('@angular/ssr'),
  rxjs: peerRange('rxjs'),
});
// Optional, and it has to stay that way. `@angular/ssr` is reachable only from `./ssr`, so a
// browser-only consumer must not be asked to install it, which is the condition
// `specs/02-packages-and-platform.spec.md` section 2 sets for the entry point existing at all, and
// section 6 of `specs/02-packages-and-platform.spec.md` forbids putting the peer on the primary.
assert.deepEqual(runtimePackage.peerDependenciesMeta, {
  '@angular/forms': { optional: true },
  '@angular/router': { optional: true },
  '@angular/ssr': { optional: true },
});
assert.equal(runtimePackage.module, 'fesm2022/neolorn-atlas.mjs');
assert.equal(runtimePackage.typings, 'types/neolorn-atlas.d.ts');
assert.deepEqual(Object.keys(runtimePackage.exports).sort(), [
  '.',
  './core',
  './forms',
  './http',
  './package.json',
  './router',
  './ssr',
  './testing',
]);

const runtimeEntrypoints = Object.freeze([
  Object.freeze({
    subpath: '.',
    javascript: './fesm2022/neolorn-atlas.mjs',
    declarations: './types/neolorn-atlas.d.ts',
    angularDeclarations: true,
  }),
  Object.freeze({
    subpath: './ssr',
    javascript: './fesm2022/neolorn-atlas-ssr.mjs',
    declarations: './types/neolorn-atlas-ssr.d.ts',
    angularDeclarations: false,
  }),
  Object.freeze({
    subpath: './forms',
    javascript: './fesm2022/neolorn-atlas-forms.mjs',
    declarations: './types/neolorn-atlas-forms.d.ts',
    angularDeclarations: true,
  }),
  Object.freeze({
    subpath: './router',
    javascript: './fesm2022/neolorn-atlas-router.mjs',
    declarations: './types/neolorn-atlas-router.d.ts',
    angularDeclarations: false,
  }),
  Object.freeze({
    subpath: './testing',
    javascript: './fesm2022/neolorn-atlas-testing.mjs',
    declarations: './types/neolorn-atlas-testing.d.ts',
    angularDeclarations: false,
  }),
  Object.freeze({
    subpath: './core',
    javascript: './fesm2022/neolorn-atlas-core.mjs',
    declarations: './types/neolorn-atlas-core.d.ts',
    angularDeclarations: false,
  }),
  Object.freeze({
    subpath: './http',
    javascript: './fesm2022/neolorn-atlas-http.mjs',
    declarations: './types/neolorn-atlas-http.d.ts',
    angularDeclarations: false,
  }),
]);

assert.deepEqual(runtimePackage.exports['./package.json'], {
  default: './package.json',
});

// The pseudo-localization transform is absent from every shipped runtime bundle.
//
// This is the criterion the removed runtime helper could not have met. The transform now runs at
// build time in `@neolorn/atlas-toolkit`, which a consumer installs as a development dependency, so
// what reaches an application is a compiled catalog that nothing can tell from a translation. That
// makes "never in production" an absence rather than a flag: there is no code in the bundle to
// enable, no environment to read, and nothing to defeat.
//
// Asserted against the built bundles rather than against the source layout, because the layout is
// what is intended and the bundle is what ships.
const pseudoTransformMarkers = Object.freeze([
  // The public entry points of the transform.
  'pseudoLocalizeAtlasMessage',
  'createAtlasPseudoCatalog',
  // The boundary markers it emits. If these are in a runtime bundle, the transform is too.
  '\u27e6',
  '\u27e7',
  // A slice of the accent table, which nothing else in Atlas has a reason to contain.
  '\u00c5\u00cb\u00cf',
]);
for (const entrypoint of runtimeEntrypoints) {
  const bundlePath = resolve(runtimeRoot, entrypoint.javascript);
  // Escapes are decoded before comparing. A bundler may emit a non-ASCII character literally or as
  // `\uXXXX`, in either hex case, and `includes` sees three different strings for one character.
  // Comparing against the literal form alone was this gate's first shape, and a leak injected as
  // `\u27E6` walked straight past it: found by mutating a real bundle rather than by review.
  const bundle = (await readFile(bundlePath, 'utf8')).replace(
    /\\u([0-9a-fA-F]{4})/gu,
    (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)),
  );
  for (const marker of pseudoTransformMarkers) {
    assert.ok(
      !bundle.includes(marker),
      `${entrypoint.subpath} bundle contains the pseudo-localization marker ${JSON.stringify(marker)}; the transform must stay in the toolkit.`,
    );
  }
  // The control for the five absences above. Without it they prove only that a file was read:
  // a renamed bundle, an empty read, or a wrong path would satisfy every one of them.
  assert.ok(
    bundle.length > 0 && bundle.includes('atlas'),
    `${entrypoint.subpath} bundle was not read, so the absence checks above mean nothing.`,
  );
}
const fullIvyDeclaration =
  /\.ɵɵdefine(?:Component|Directive|Factory|Injectable|Injector|NgModule|Pipe)\(/u;
const partialIvyDeclaration =
  /\.ɵɵngDeclare(?:ClassMetadata|Component|Directive|Factory|Injectable|Injector|NgModule|Pipe)\(/u;
for (const entrypoint of runtimeEntrypoints) {
  assert.deepEqual(runtimePackage.exports[entrypoint.subpath], {
    types: entrypoint.declarations,
    default: entrypoint.javascript,
  });
  const javascriptPath = await assertPackageFile(
    runtimeRoot,
    entrypoint.javascript,
    `runtime ${entrypoint.subpath} JavaScript`,
  );
  await assertPackageFile(
    runtimeRoot,
    entrypoint.declarations,
    `runtime ${entrypoint.subpath} declarations`,
  );
  await assertPackageFile(
    runtimeRoot,
    `${entrypoint.javascript}.map`,
    `runtime ${entrypoint.subpath} JavaScript map`,
  );
  await assertPackageFile(
    runtimeRoot,
    `${entrypoint.declarations}.map`,
    `runtime ${entrypoint.subpath} declaration map`,
  );
  const javascript = await readFile(javascriptPath, 'utf8');
  assert.doesNotMatch(
    javascript,
    fullIvyDeclaration,
    `runtime ${entrypoint.subpath} contains full-Ivy declarations`,
  );
  if (entrypoint.angularDeclarations) {
    assert.match(
      javascript,
      partialIvyDeclaration,
      `runtime ${entrypoint.subpath} contains no partial-Ivy declarations`,
    );
  }
}
await assertManifestTargets(runtimePackage, runtimeRoot, 'runtime package');

/**
 * Can anyone find these packages, and is there anything to read when they do?
 *
 * The half that needs no baseline, because it is binary. Neither package shipped a README,
 * a `homepage` or `keywords`: a registry search returned nothing for every task-oriented phrase, and
 * a reader who arrived anyway got one sentence of `description` and a file listing. That is the same
 * discovery failure the checks above are about, one layer out from the API.
 *
 * Checked on the staged package rather than the source directory, because the source directory is
 * not what gets published: the toolkit's manifest is assembled key by key by
 * `stage-toolkit-package.mjs`, and a field nobody copied is a field that exists everywhere except
 * where it matters.
 */
const assertDiscoverable = async (manifest, packageRoot, label) => {
  assert.equal(
    typeof manifest.homepage,
    'string',
    `The ${label} publishes no homepage, so a reader who finds it on a registry has nowhere to go.`,
  );
  assert.match(
    manifest.homepage,
    /^https:\/\//u,
    `The ${label} homepage is not an https URL: ${manifest.homepage}`,
  );
  assert.ok(
    Array.isArray(manifest.keywords) && manifest.keywords.length > 0,
    `The ${label} publishes no keywords, so a registry search cannot return it for anything but its own name.`,
  );
  assert.equal(
    typeof manifest.author,
    'string',
    `The ${label} names no author, so a registry entry says who wrote nothing and a consumer has nobody to attribute.`,
  );
  assert.match(
    manifest.bugs?.url ?? '',
    /^https:\/\//u,
    `The ${label} publishes no issue address, so a consumer who finds a defect has nowhere to report it.`,
  );
  // MIT requires the notice to travel with every copy, and an installed package is a copy. Compared
  // against the repository's own file rather than merely present, because a stale copy of a license
  // is a claim about terms that were not the ones granted.
  assert.equal(
    await readFile(resolve(packageRoot, 'LICENSE'), 'utf8'),
    await readFile(resolve(workspaceRoot, 'LICENSE'), 'utf8'),
    `The ${label} ships a LICENSE that is not the one this repository grants.`,
  );
  const readme = await readFile(resolve(packageRoot, 'README.md'), 'utf8');
  // A file that exists and says nothing satisfies "has a README" and nothing else. The floor is low
  // on purpose (this is a presence check, and the coverage gate next door is what has opinions)
  // but it is not zero.
  assert.ok(
    readme.length > 500 && readme.includes('#'),
    `The ${label} README is ${readme.length} characters and has no headings; that is a placeholder rather than a README.`,
  );
};
await assertDiscoverable(runtimePackage, runtimeRoot, 'runtime package');

const runtimeEntry = runtimePackage.exports['.'].default;
const runtimeFormsEntry = runtimePackage.exports['./forms'].default;
const runtimeRouterEntry = runtimePackage.exports['./router'].default;
const runtimeTestingEntry = runtimePackage.exports['./testing'].default;
await import(pathToFileURL(resolve(runtimeRoot, runtimeEntry)).href);
await import(pathToFileURL(resolve(runtimeRoot, runtimeFormsEntry)).href);
await import(pathToFileURL(resolve(runtimeRoot, runtimeRouterEntry)).href);
await import(pathToFileURL(resolve(runtimeRoot, runtimeTestingEntry)).href);

const toolkitPackage = await readJson(resolve(toolkitRoot, 'package.json'));
assert.equal(toolkitPackage.name, '@neolorn/atlas-toolkit');
assert.equal(toolkitPackage.version, runtimePackage.version);
assert.equal(
  toolkitPackage.description,
  'Compiler and developer tooling for Atlas localization projects.',
);
assert.equal(toolkitPackage.private, undefined);
assert.deepEqual(toolkitPackage.publishConfig, {
  registry: 'https://registry.npmjs.org',
  access: 'public',
});
assert.deepEqual(toolkitPackage.repository, {
  type: 'git',
  url: 'git+https://github.com/neolorn/atlas.git',
  directory: 'packages/toolkit',
});
assert.equal(toolkitPackage.type, 'module');
assert.equal(toolkitPackage.license, 'MIT');
assert.equal(toolkitPackage.sideEffects, false);
assert.deepEqual(toolkitPackage.engines, { node: nodeRange });
assert.deepEqual(toolkitPackage.bin, { atlas: './cli.js' });
assert.deepEqual(toolkitPackage.dependencies, {
  ajv: '8.20.0',
  'jsonc-parser': '3.3.1',
  messageformat: '4.0.0',
  tslib: '^2.8.1',
  yaml: '2.9.0',
});
// A peer rather than a dependency, because these decide compilation and the consumer's copy is the
// one that runs. `specs/02-packages-and-platform.spec.md` section 7 divides the graph this way, and
// section 9 of `specs/02-packages-and-platform.spec.md` names these manifests as where the ranges
// themselves are stated.
assert.deepEqual(toolkitPackage.peerDependencies, {
  '@angular/compiler': peerRange('@angular/compiler'),
  typescript: peerRange('typescript'),
});
assert.equal(toolkitPackage.peerDependenciesMeta, undefined);

// The Angular range appears in three places that can drift apart: the two published manifests, and
// the toolkit's own host-admission profile, which is the one that decides at runtime whether a
// consumer's compiler is admitted. Two manifests agreeing proves the least, because they are the
// pair most likely to be edited together; the profile is the one that gets forgotten. All three are
// compared against what the packages declare, and against the built profile rather than the source,
// so this reads what actually shipped.
// The leaf module rather than `index.js`: the package entry pulls the whole toolkit, including
// dependencies that are declared for a consumer to install and are not resolvable from `dist`.
// This is the same reach the schema assertions below already make.
const { ATLAS_HOST_COMPATIBILITY_PROFILE: hostProfile } = await import(
  pathToFileURL(resolve(toolkitRoot, 'host-compatibility.js')).href
);
const declaredAngularRanges = new Map([
  ['runtime @angular/core', runtimePackage.peerDependencies['@angular/core']],
  [
    'runtime @angular/common',
    runtimePackage.peerDependencies['@angular/common'],
  ],
  [
    'runtime @angular/router',
    runtimePackage.peerDependencies['@angular/router'],
  ],
  ['runtime @angular/forms', runtimePackage.peerDependencies['@angular/forms']],
  [
    'toolkit @angular/compiler',
    toolkitPackage.peerDependencies['@angular/compiler'],
  ],
  ['toolkit host-admission profile', hostProfile.angularCompiler],
]);
for (const [where, range] of declaredAngularRanges) {
  assert.equal(
    range,
    peerRange('@angular/core'),
    `The Angular range declared by ${where} disagrees with what the packages declare. One range, declared once per manifest, or a consumer is admitted by one gate and refused by another.`,
  );
}

// `@angular/compiler-cli` was a required peer that Atlas never imported: two occurrences in the
// whole repository, both of them declarations. It forced every consumer to install a package the
// toolkit does not load. Asserted absent rather than deleted quietly, so it cannot come back as a
// copy-paste from the compiler peer beside it.
assert.equal(
  toolkitPackage.peerDependencies['@angular/compiler-cli'],
  undefined,
  'The toolkit declares @angular/compiler-cli as a peer again. Nothing imports it; if that changes, the import lands before the peer does.',
);
assert.deepEqual(Object.keys(toolkitPackage.exports).sort(), [
  '.',
  './package.json',
  './schemas/cli-result.v1.schema.json',
  './schemas/cli-watch-event.v1.schema.json',
  './schemas/configuration.v1.schema.json',
  './schemas/extension-registry.v1.schema.json',
  './schemas/source-catalog.v1.schema.json',
  './schemas/target-catalog.v1.schema.json',
]);
assert.deepEqual(toolkitPackage.exports['.'], {
  types: './index.d.ts',
  default: './index.js',
});
assert.equal(toolkitPackage.exports['./package.json'], './package.json');
for (const entrypoint of [
  {
    label: 'programmatic API',
    javascript: './index.js',
    declarations: './index.d.ts',
  },
  {
    label: 'CLI',
    javascript: './cli.js',
    declarations: './cli.d.ts',
  },
]) {
  await assertPackageFile(
    toolkitRoot,
    entrypoint.javascript,
    `toolkit ${entrypoint.label} JavaScript`,
  );
  await assertPackageFile(
    toolkitRoot,
    entrypoint.declarations,
    `toolkit ${entrypoint.label} declarations`,
  );
  await assertPackageFile(
    toolkitRoot,
    `${entrypoint.javascript}.map`,
    `toolkit ${entrypoint.label} JavaScript map`,
  );
  await assertPackageFile(
    toolkitRoot,
    `${entrypoint.declarations}.map`,
    `toolkit ${entrypoint.label} declaration map`,
  );
}
await assertManifestTargets(toolkitPackage, toolkitRoot, 'toolkit package');
await assertDiscoverable(toolkitPackage, toolkitRoot, 'toolkit package');
const builtSchemas = await import(
  pathToFileURL(resolve(toolkitRoot, 'schemas.js')).href
);
for (const [fileName, exportName] of [
  ['cli-result.v1.schema.json', 'ATLAS_CLI_RESULT_SCHEMA'],
  ['cli-watch-event.v1.schema.json', 'ATLAS_CLI_WATCH_EVENT_SCHEMA'],
  ['configuration.v1.schema.json', 'ATLAS_CONFIGURATION_SCHEMA'],
  ['extension-registry.v1.schema.json', 'ATLAS_EXTENSION_REGISTRY_SCHEMA'],
  ['source-catalog.v1.schema.json', 'ATLAS_SOURCE_CATALOG_SCHEMA'],
  ['target-catalog.v1.schema.json', 'ATLAS_TARGET_CATALOG_SCHEMA'],
]) {
  const schemaPath = resolve(toolkitRoot, 'schemas', fileName);
  assert.deepEqual(
    await readJson(schemaPath),
    builtSchemas[exportName],
    `${fileName} does not match the toolkit schema authority`,
  );
  assert.equal(
    toolkitPackage.exports[`./schemas/${fileName}`],
    `./schemas/${fileName}`,
  );
}

const help = spawnSync(
  process.execPath,
  [resolve(toolkitRoot, 'cli.js'), '--help'],
  {
    encoding: 'utf8',
  },
);
assert.equal(help.status, 0, help.stderr);
assert.match(
  help.stdout,
  /Compile and safely publish generated #i18n artifacts/,
);
assert.match(help.stdout, /Reconcile changes in one foreground process/);
assert.match(
  help.stdout,
  /Preview or apply one explicit Atlas-authored migration plan/,
);
assert.match(help.stdout, /--plan <path>/);

/**
 * Does the shipped `--help` state every field the shipped configuration schema accepts?
 *
 * Checked at the package boundary and on purpose not inside it. `--help` is printed from
 * `cli-options.generated.ts`, which is generated from `ATLAS_CONFIGURATION_SCHEMA`, so asking the
 * table whether it agrees with itself would agree by construction and prove nothing. The
 * two artifacts below are staged separately: `schemas/configuration.v1.schema.json` is written from
 * the constant at pack time, and the help text is compiled from a file checked into source. A stale
 * table therefore shows up here as a schema key whose own sentence is missing from `--help`.
 *
 * The sentence is the join. Descriptions live on the schema properties, so a key absent from the
 * option table takes its description with it, and no amount of the table being internally tidy puts
 * it back.
 */
const shippedConfigurationSchema = await readJson(
  resolve(toolkitRoot, 'schemas', 'configuration.v1.schema.json'),
);
const settableConfigurationKeys = Object.entries(
  shippedConfigurationSchema.properties,
).filter(([, property]) => property.const === undefined);
assert.ok(
  settableConfigurationKeys.length > 0,
  'The shipped configuration schema has no settable properties, so the check below would pass on nothing.',
);
for (const [key, property] of settableConfigurationKeys) {
  assert.equal(
    typeof property.description,
    'string',
    `The shipped configuration schema describes no ${key}, so this check cannot tell whether atlas init --help mentions it.`,
  );
  assert.ok(
    help.stdout.includes(property.description),
    `atlas init --help does not state ${key}: the shipped schema accepts it and the install line says nothing about it. Run pnpm run build && pnpm run generate:cli-options.`,
  );
}
// A description that matched by accident (an empty string, a substring of the banner)
// would make every assertion above pass while saying nothing, so one sentence that must not be
// there is checked too.
assert.ok(
  !help.stdout.includes('A field no schema describes.'),
  'The atlas init --help check matches text the schema never contained, so it is not reading what it thinks it is.',
);

const toolkitHarnessRoot = await mkdtemp(
  resolve(tmpdir(), 'atlas-built-toolkit-'),
);
const toolkitHarnessNodeModules = resolve(toolkitHarnessRoot, 'node_modules');
const toolkitHarnessPackageRoot = resolve(
  toolkitHarnessNodeModules,
  '@neolorn/atlas-toolkit',
);
await mkdir(dirname(toolkitHarnessPackageRoot), { recursive: true });
await cp(toolkitRoot, toolkitHarnessPackageRoot, { recursive: true });
for (const [specifier, sourceRoot] of [
  ['ajv', 'packages/toolkit/node_modules/ajv'],
  ['jsonc-parser', 'packages/toolkit/node_modules/jsonc-parser'],
  ['messageformat', 'packages/toolkit/node_modules/messageformat'],
  ['tslib', 'packages/toolkit/node_modules/tslib'],
  ['yaml', 'packages/toolkit/node_modules/yaml'],
  ['@angular/compiler', 'node_modules/@angular/compiler'],
  ['typescript', 'node_modules/typescript'],
]) {
  const linkPath = resolve(toolkitHarnessNodeModules, ...specifier.split('/'));
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(
    await realpath(resolve(workspaceRoot, sourceRoot)),
    linkPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}
const builtToolkit = await import(
  pathToFileURL(resolve(toolkitHarnessPackageRoot, 'index.js')).href
);
// Host admission is internal: a consumer does not ask Atlas whether its own compiler is admitted,
// Atlas answers that when it compiles. The leaf module, for the reason the schema assertions above
// already give.
const builtHostCompatibility = await import(
  pathToFileURL(resolve(toolkitHarnessPackageRoot, 'host-compatibility.js'))
    .href
);
const { default: Ajv2020 } = await import(
  pathToFileURL(resolve(toolkitHarnessNodeModules, 'ajv/dist/2020.js')).href
);
const schemaValidator = new Ajv2020({ allErrors: true, strict: true });
const validateCliResult = schemaValidator.compile(
  builtToolkit.ATLAS_CLI_RESULT_SCHEMA,
);
const validateWatchEvent = schemaValidator.compile(
  builtToolkit.ATLAS_CLI_WATCH_EVENT_SCHEMA,
);
assert.equal(
  validateWatchEvent({
    profile: 'atlas-cli-watch-event/1',
    command: 'watch',
    sequence: 1,
    status: 'success',
    diagnostics: [],
    result: {
      changed: false,
      written: [],
      removed: [],
      unchanged: [],
    },
  }),
  true,
  JSON.stringify(validateWatchEvent.errors),
);
assert.equal(
  validateWatchEvent({
    profile: 'atlas-cli-watch-event/1',
    command: 'watch',
    sequence: 2,
    status: 'diagnostic-failure',
    diagnostics: [],
    result: {},
  }),
  false,
  'A failed watch event cannot carry a success result.',
);
const currentHost = builtHostCompatibility.admitAtlasHostCompatibility();
assert.equal(
  currentHost.ok,
  true,
  JSON.stringify(currentHost.diagnostics, null, 2),
);
// The shipped admission profile against what the packages declare. This profile is compiled into
// the toolkit and cannot read a manifest at the moment it decides, so it carries its own copy of
// the three ranges, and this is the check that the copy is still the same claim.
assert.deepEqual(builtHostCompatibility.ATLAS_HOST_COMPATIBILITY_PROFILE, {
  profile: 'atlas-host-compatibility/1',
  node: nodeRange,
  typescript: peerRange('typescript'),
  angularCompiler: peerRange('@angular/compiler'),
});
const unsupportedHost = builtHostCompatibility.admitAtlasHostCompatibility({
  node: '22.22.2',
  typescript: '6.1.0',
  angularCompiler: '23.0.0',
});
assert.equal(unsupportedHost.ok, false);
assert.deepEqual(
  unsupportedHost.diagnostics.map(({ code, path }) => ({ code, path })),
  [
    { code: 'ATL1806', path: ['host', 'node'] },
    { code: 'ATL1806', path: ['host', 'typescript'] },
    { code: 'ATL1806', path: ['host', 'angularCompiler'] },
  ],
);

const migrationRoot = await mkdtemp(
  resolve(tmpdir(), 'atlas-built-migration-'),
);
try {
  const cliPath = resolve(toolkitHarnessPackageRoot, 'cli.js');
  const ownerFile = resolve(migrationRoot, 'source.txt');
  const planPath = resolve(migrationRoot, 'migration-plan.json');
  const invalidPlanPath = resolve(migrationRoot, 'invalid-plan.json');
  const tamperedPlanPath = resolve(migrationRoot, 'tampered-plan.json');
  await writeFile(ownerFile, 'before\n', 'utf8');
  const migrationPlan = builtToolkit.createAtlasMigrationPlan({
    id: 'built-cli',
    domain: 'authored-data',
    fromVersion: '1',
    toVersion: '1.1',
    changes: [
      {
        path: 'source.txt',
        before: 'before\n',
        after: 'after\n',
      },
    ],
  });
  assert.equal(
    migrationPlan.ok,
    true,
    JSON.stringify(migrationPlan.diagnostics, null, 2),
  );
  await writeFile(
    planPath,
    `${JSON.stringify(migrationPlan.value, null, 2)}\n`,
    'utf8',
  );
  await writeFile(invalidPlanPath, '{}\n', 'utf8');
  await writeFile(
    tamperedPlanPath,
    `${JSON.stringify(
      {
        ...migrationPlan.value,
        digest: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const runAtlas = (arguments_) =>
    spawnSync(process.execPath, [cliPath, ...arguments_], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
  const machineResult = (result) => {
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    assert.equal(
      validateCliResult(parsed),
      true,
      JSON.stringify(validateCliResult.errors),
    );
    return parsed;
  };

  const unknownCommand = runAtlas(['not-an-atlas-command', '--json']);
  assert.equal(unknownCommand.status, 2);
  assert.equal(machineResult(unknownCommand).command, 'unknown');

  const missingProject = runAtlas(['migrate', '--plan', planPath, '--json']);
  assert.equal(missingProject.status, 2);
  assert.equal(machineResult(missingProject).diagnostics[0].code, 'ATL1701');

  const missingPlan = runAtlas([
    'migrate',
    '--project',
    migrationRoot,
    '--json',
  ]);
  assert.equal(missingPlan.status, 2);
  assert.equal(machineResult(missingPlan).diagnostics[0].code, 'ATL1701');

  const absentPlan = runAtlas([
    'migrate',
    '--project',
    migrationRoot,
    '--plan',
    resolve(migrationRoot, 'absent.json'),
    '--json',
  ]);
  assert.equal(absentPlan.status, 2);
  assert.equal(machineResult(absentPlan).diagnostics[0].code, 'ATL1701');

  const invalidPlan = runAtlas([
    'migrate',
    '--project',
    migrationRoot,
    '--plan',
    invalidPlanPath,
    '--json',
  ]);
  assert.equal(invalidPlan.status, 2);
  assert.equal(machineResult(invalidPlan).diagnostics[0].code, 'ATL1805');

  const tamperedPlan = runAtlas([
    'migrate',
    '--project',
    migrationRoot,
    '--plan',
    tamperedPlanPath,
    '--json',
  ]);
  assert.equal(tamperedPlan.status, 2);
  assert.equal(machineResult(tamperedPlan).diagnostics[0].code, 'ATL1805');
  assert.equal(await readFile(ownerFile, 'utf8'), 'before\n');

  const humanPreview = runAtlas([
    'migrate',
    '--project',
    migrationRoot,
    '--plan',
    planPath,
    '--dry-run',
  ]);
  assert.equal(humanPreview.status, 0, humanPreview.stderr);
  assert.match(
    humanPreview.stdout,
    /would apply .* to 1 authored file: source\.txt/,
  );
  assert.equal(await readFile(ownerFile, 'utf8'), 'before\n');

  const machinePreview = runAtlas([
    'migrate',
    '--project',
    migrationRoot,
    '--plan',
    planPath,
    '--dry-run',
    '--json',
  ]);
  assert.equal(machinePreview.status, 0, machinePreview.stderr);
  assert.deepEqual(machineResult(machinePreview).result, {
    dryRun: true,
    changed: true,
    files: ['source.txt'],
    planId: migrationPlan.value.id,
    planDigest: migrationPlan.value.digest,
    regenerate: true,
  });
  assert.equal(await readFile(ownerFile, 'utf8'), 'before\n');

  const applied = runAtlas([
    'migrate',
    '--project',
    migrationRoot,
    '--plan',
    planPath,
    '--json',
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(machineResult(applied).result, {
    dryRun: false,
    changed: true,
    files: ['source.txt'],
    planId: migrationPlan.value.id,
    planDigest: migrationPlan.value.digest,
    regenerate: true,
  });
  assert.equal(await readFile(ownerFile, 'utf8'), 'after\n');

  const repeated = runAtlas([
    'migrate',
    '--project',
    migrationRoot,
    '--plan',
    planPath,
  ]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /is already applied/);
  assert.equal(await readFile(ownerFile, 'utf8'), 'after\n');

  // The install line, run cold on the shipped CLI: `init`, then `generate`, with
  // nothing authored in between.
  //
  // A `generate` that refuses this (`ATL1702` for the missing `i18n` directory, then `ATL1702`
  // again for the catalogs nobody has written yet) makes the documented first run fail twice
  // before it can succeed once. A project with zero messages is a valid project; it is the state
  // every project is in the moment after `init`. The two assertions that matter are that both
  // commands exit zero, and that the directory `init` created is empty: containers, never content.
  const coldRoot = resolve(migrationRoot, 'cold-install');
  await mkdir(resolve(coldRoot, 'src'), { recursive: true });
  await writeFile(
    resolve(coldRoot, 'package.json'),
    `${JSON.stringify({ name: '@example/atlas-cold-install', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    resolve(coldRoot, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'preserve', moduleResolution: 'bundler', resolvePackageJsonImports: true }, include: ['src/**/*.ts'] }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    resolve(coldRoot, 'src/app.ts'),
    'export const app = 1;\n',
    'utf8',
  );

  const coldInit = runAtlas([
    'init',
    '--project',
    coldRoot,
    '--source-locale',
    'en-US',
    '--default-locale',
    'en-US',
    '--locale',
    'en-US',
  ]);
  assert.equal(coldInit.status, 0, `${coldInit.stdout}${coldInit.stderr}`);
  const coldCatalogRoot = resolve(coldRoot, 'i18n');
  assert.ok(
    await stat(coldCatalogRoot).then(
      (metadata) => metadata.isDirectory(),
      () => false,
    ),
    'atlas init did not create the catalog directory, so the name of the one thing a consumer cannot guess is still unwritten.',
  );
  assert.deepEqual(
    await readdir(coldCatalogRoot),
    [],
    'atlas init wrote something into the catalog directory. It creates containers and never content.',
  );

  const coldGenerate = runAtlas(['generate', '--project', coldRoot, '--json']);
  assert.equal(
    coldGenerate.status,
    0,
    `atlas generate refused a project with no messages yet:\n${coldGenerate.stdout}${coldGenerate.stderr}`,
  );
  const coldReport = machineResult(coldGenerate);
  assert.deepEqual(
    coldReport.diagnostics.map(({ code, severity }) => ({ code, severity })),
    [{ code: 'ATL1702', severity: 'info' }],
    'A project with no messages yet reports one note and nothing else.',
  );
  assert.match(
    coldReport.diagnostics[0].summary,
    /Write the first catalog at i18n\/<scope>\/en-US\.yaml/u,
    'The note has to say where the first message goes; that is the whole of what it is for.',
  );
} finally {
  await Promise.all([
    rm(migrationRoot, { recursive: true, force: true }),
    rm(toolkitHarnessRoot, { recursive: true, force: true }),
  ]);
}

const inspectableExtensions = new Set([
  '.cjs',
  '.d.ts',
  '.js',
  '.json',
  '.map',
  '.mjs',
]);

const walk = async (root) => {
  const paths = [];

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walk(path)));
    } else if (
      entry.name.endsWith('.d.ts') ||
      inspectableExtensions.has(extname(entry.name))
    ) {
      paths.push(path);
    }
  }

  return paths;
};

const machinePrivateRoots = new Set(
  [workspaceRoot, homedir(), tmpdir()].flatMap((root) => {
    const forward = root.replaceAll('\\', '/');
    return [
      root,
      root.replaceAll('\\', '\\\\'),
      forward,
      pathToFileURL(root).href,
    ];
  }),
);

const collectModuleSpecifiers = (path, text) => {
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.d.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const specifiers = [];
  const add = (node) => {
    if (node !== undefined && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

const packageSurfaces = [
  {
    outputRoot: runtimeRoot,
    sourceRoots: [
      resolve(workspaceRoot, 'packages/runtime/src'),
      resolve(workspaceRoot, 'packages/runtime/core/src'),
      resolve(workspaceRoot, 'packages/runtime/forms/src'),
      resolve(workspaceRoot, 'packages/runtime/http/src'),
      resolve(workspaceRoot, 'packages/runtime/router/src'),
      resolve(workspaceRoot, 'packages/runtime/ssr/src'),
      resolve(workspaceRoot, 'packages/runtime/testing/src'),
    ],
    runtimeSafe: true,
  },
  {
    outputRoot: toolkitRoot,
    sourceRoots: [resolve(workspaceRoot, 'packages/toolkit/src')],
    runtimeSafe: false,
  },
];

for (const surface of packageSurfaces) {
  const approvedSourceRoots = await Promise.all(
    surface.sourceRoots.map((root) => realpath(root)),
  );

  for (const path of await walk(surface.outputRoot)) {
    const text = await readFile(path, 'utf8');
    const normalizedText = text.toLowerCase();
    for (const privateRoot of machinePrivateRoots) {
      assert.equal(
        normalizedText.includes(privateRoot.toLowerCase()),
        false,
        `${path} leaks machine-private path ${privateRoot}`,
      );
    }

    for (const match of text.matchAll(
      /(?:sourceMappingURL=|<reference\s+path=["'])([^"'\s>]+)/gu,
    )) {
      assertPortableReference(match[1], `${path} metadata reference`);
    }

    if (path.endsWith('.map')) {
      const map = JSON.parse(text);
      if (typeof map.file === 'string') {
        assertPortableReference(map.file, `${path} file`);
      }
      const sourceRoot = map.sourceRoot ?? '';
      assert.equal(
        typeof sourceRoot,
        'string',
        `${path} sourceRoot is invalid`,
      );
      if (sourceRoot !== '') {
        assertPortableReference(sourceRoot, `${path} sourceRoot`);
      }
      assert.ok(Array.isArray(map.sources), `${path} sources are invalid`);
      if (map.sourcesContent !== undefined) {
        assert.ok(
          Array.isArray(map.sourcesContent),
          `${path} sourcesContent is invalid`,
        );
        assert.equal(
          map.sourcesContent.length,
          map.sources.length,
          `${path} sourcesContent does not match sources`,
        );
      }
      for (const source of map.sources) {
        assert.equal(typeof source, 'string', `${path} source is invalid`);
        assertPortableReference(source, `${path} source`);
        const canonicalSource = resolve(dirname(path), sourceRoot, source);
        assert.equal(
          approvedSourceRoots.some((root) => isWithin(canonicalSource, root)),
          true,
          `${path} maps to unowned source ${source}`,
        );
      }
    }

    if (
      surface.runtimeSafe &&
      (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.d.ts'))
    ) {
      for (const specifier of collectModuleSpecifiers(path, text)) {
        assert.equal(
          isBuiltin(specifier),
          false,
          `${path} imports Node built-in ${specifier}`,
        );
        assert.equal(
          specifier === '@neolorn/atlas-toolkit' ||
            specifier.startsWith('@neolorn/atlas-toolkit/'),
          false,
          `${path} imports toolkit module ${specifier}`,
        );
      }
    }
  }
}

// The Angular-free entry points are Angular-free, and the core is published once.
//
// Two checks, and the second is the one with teeth.
//
// `@neolorn/atlas/core` and `@neolorn/atlas/http` exist for an environment boundary: they load in a
// worker, a Lambda, or plain Node, where every other entry point of this package throws
// `The injectable 'PlatformLocation' needs to be compiled using the JIT compiler`. That property is
// not visible in the source, a source file that imports `@angular/core` for a type looks exactly
// like one that does not, so it is asserted against the built distributable, which is the only
// place the property is visible at all.
//
// The single-copy rule is what makes this more than tidiness. A secondary entry point's bundle keeps
// a sibling entry point as an external import, but anything it reaches by a *relative* path is
// compiled into it. So one file imported both relatively and by specifier is published twice, and
// two copies of `contracts.ts` means two `LocalizationError` classes. `instanceof LocalizationError`
// is tested in eight places in the primary, including the conversion of a thrown error back into a
// `LocalizationDiagnostic`; against the wrong copy it silently returns false, the diagnostic is lost,
// and the error arrives unrecognised: for one entry point only. Nothing about the mistake that
// causes it looks wrong: it is a relative import that reads like every other relative import in the
// file. Hence a check that fails the build rather than one that hopes for a careful reviewer.

const angularFreeEntrypoints = Object.freeze([
  Object.freeze({
    subpath: './core',
    javascript: 'fesm2022/neolorn-atlas-core.mjs',
    declarations: 'types/neolorn-atlas-core.d.ts',
    // The base of the package. It may import nothing at all.
    permitted: Object.freeze([]),
  }),
  Object.freeze({
    subpath: './http',
    javascript: 'fesm2022/neolorn-atlas-http.mjs',
    declarations: 'types/neolorn-atlas-http.d.ts',
    // The handler calls the classification; it does not reimplement it.
    permitted: Object.freeze(['@neolorn/atlas/core']),
  }),
]);

for (const entrypoint of angularFreeEntrypoints) {
  for (const artifact of [entrypoint.javascript, entrypoint.declarations]) {
    const path = resolve(workspaceRoot, 'dist/runtime', artifact);
    const text = await readFile(path, 'utf8');
    for (const specifier of collectModuleSpecifiers(path, text)) {
      assert.equal(
        specifier === '@angular/core' || specifier.startsWith('@angular/'),
        false,
        `${entrypoint.subpath} is not Angular-free: ${artifact} imports ${specifier}`,
      );
      assert.equal(
        specifier === '@neolorn/atlas',
        false,
        `${entrypoint.subpath} imports the primary (${artifact}), which cannot load outside Angular`,
      );
      if (specifier.startsWith('.')) continue;
      assert.equal(
        entrypoint.permitted.includes(specifier),
        true,
        `${entrypoint.subpath} imports ${specifier}, which is not on its permitted list`,
      );
    }
  }
}

// The core is compiled into exactly one bundle. Asserted on a class rather than a function, because
// a duplicated class is the case that breaks `instanceof` while every test of either copy passes.
const runtimeBundles = (
  await readdir(resolve(workspaceRoot, 'dist/runtime/fesm2022'))
).filter((name) => name.endsWith('.mjs'));
const bundlesDefiningCore = [];
for (const name of runtimeBundles) {
  const text = await readFile(
    resolve(workspaceRoot, 'dist/runtime/fesm2022', name),
    'utf8',
  );
  if (/\bclass LocalizationError\b/u.test(text)) bundlesDefiningCore.push(name);
}
assert.deepEqual(
  bundlesDefiningCore,
  ['neolorn-atlas-core.mjs'],
  `LocalizationError must be defined in exactly one bundle, found: ${bundlesDefiningCore.join(', ')}`,
);

// And in source: no entry point reaches into another entry point's files by a relative path.
//
// This is the check that catches the mistake at the moment it is made, where the FESM check catches
// it at the moment it ships. Both are kept: the first is the one a developer sees, the second is
// the one that cannot be forgotten.
const entrypointSourceRoots = Object.freeze([
  'packages/runtime/src',
  'packages/runtime/core/src',
  'packages/runtime/forms/src',
  'packages/runtime/http/src',
  'packages/runtime/router/src',
  'packages/runtime/ssr/src',
  'packages/runtime/testing/src',
]);

const walkTypeScript = async (directory) => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walkTypeScript(path)));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
};

for (const root of entrypointSourceRoots) {
  const absoluteRoot = resolve(workspaceRoot, root);
  for (const path of await walkTypeScript(absoluteRoot)) {
    const text = await readFile(path, 'utf8');
    for (const specifier of collectModuleSpecifiers(path, text)) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(path), specifier);
      assert.equal(
        isWithin(target, absoluteRoot),
        true,
        `${relative(workspaceRoot, path)} reaches outside its entry point: ${specifier}. ` +
          'Import the other entry point by its published specifier instead, or the file is ' +
          'compiled into both bundles.',
      );
    }
  }
}

process.stdout.write('Atlas package structure verified.\n');
