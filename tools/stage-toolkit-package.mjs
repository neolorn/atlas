/**
 * The toolkit's published manifest, written rather than committed.
 *
 * `specs/02-packages-and-platform.spec.md` section 4 says what this package publishes: a
 * side-effect-free programmatic API, the schemas of its public file formats, its own manifest, and
 * the `atlas` executable. The schemas are exports because a consumer validating a file against the
 * schema Atlas used has to resolve it by name; reaching a path inside the installed directory
 * would make the package's internal layout a consumer's dependency.
 *
 * The manifest is derived from the source one so the two cannot disagree about a version, a peer
 * range, or a dependency.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePackagePath = resolve(
  workspaceRoot,
  'packages/toolkit/package.json',
);
const outputRoot = resolve(workspaceRoot, 'dist/toolkit');

if (dirname(outputRoot) !== resolve(workspaceRoot, 'dist')) {
  throw new Error(`Refusing to stage an unexpected path: ${outputRoot}`);
}

const sourcePackage = JSON.parse(await readFile(sourcePackagePath, 'utf8'));

const outputPackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  description: sourcePackage.description,
  // A published package with no homepage and no keywords is one a registry search cannot
  // return and a reader cannot leave: `description` is one sentence, and the only other thing npm
  // shows is the README. All three travel or none of them does.
  homepage: sourcePackage.homepage,
  keywords: sourcePackage.keywords,
  type: sourcePackage.type,
  license: sourcePackage.license,
  author: sourcePackage.author,
  repository: sourcePackage.repository,
  bugs: sourcePackage.bugs,
  publishConfig: sourcePackage.publishConfig,
  sideEffects: sourcePackage.sideEffects,
  engines: sourcePackage.engines,
  dependencies: sourcePackage.dependencies,
  peerDependencies: sourcePackage.peerDependencies,
  exports: {
    '.': {
      types: './index.d.ts',
      default: './index.js',
    },
    './schemas/configuration.v1.schema.json':
      './schemas/configuration.v1.schema.json',
    './schemas/source-catalog.v1.schema.json':
      './schemas/source-catalog.v1.schema.json',
    './schemas/target-catalog.v1.schema.json':
      './schemas/target-catalog.v1.schema.json',
    './schemas/extension-registry.v1.schema.json':
      './schemas/extension-registry.v1.schema.json',
    './schemas/cli-result.v1.schema.json':
      './schemas/cli-result.v1.schema.json',
    './schemas/cli-watch-event.v1.schema.json':
      './schemas/cli-watch-event.v1.schema.json',
    './package.json': './package.json',
  },
  bin: {
    atlas: './cli.js',
  },
};

await mkdir(outputRoot, { recursive: true });
await copyFile(
  resolve(workspaceRoot, 'packages/toolkit/README.md'),
  resolve(outputRoot, 'README.md'),
);
// The diagnostics reference travels with the package, because the codes it explains are what a
// consumer meets. A document that exists only in the repository is one a reader who installed the
// package cannot reach, and every code in it is a code they can be shown.
await copyFile(
  resolve(workspaceRoot, 'packages/toolkit/DIAGNOSTICS.md'),
  resolve(outputRoot, 'DIAGNOSTICS.md'),
);
const schemaRoot = resolve(outputRoot, 'schemas');
await mkdir(schemaRoot, { recursive: true });
const schemas = await import(
  pathToFileURL(resolve(outputRoot, 'schemas.js')).href
);
for (const [fileName, schema] of [
  ['cli-result.v1.schema.json', schemas.ATLAS_CLI_RESULT_SCHEMA],
  ['cli-watch-event.v1.schema.json', schemas.ATLAS_CLI_WATCH_EVENT_SCHEMA],
  ['configuration.v1.schema.json', schemas.ATLAS_CONFIGURATION_SCHEMA],
  ['source-catalog.v1.schema.json', schemas.ATLAS_SOURCE_CATALOG_SCHEMA],
  ['target-catalog.v1.schema.json', schemas.ATLAS_TARGET_CATALOG_SCHEMA],
  [
    'extension-registry.v1.schema.json',
    schemas.ATLAS_EXTENSION_REGISTRY_SCHEMA,
  ],
]) {
  if (
    typeof schema !== 'object' ||
    schema === null ||
    schema.$schema !== 'https://json-schema.org/draft/2020-12/schema'
  ) {
    throw new TypeError(
      `Refusing to stage an invalid Atlas schema: ${fileName}`,
    );
  }
  await writeFile(
    resolve(schemaRoot, fileName),
    `${JSON.stringify(schema, null, 2)}\n`,
    'utf8',
  );
}
await writeFile(
  resolve(outputRoot, 'package.json'),
  `${JSON.stringify(outputPackage, null, 2)}\n`,
  'utf8',
);
