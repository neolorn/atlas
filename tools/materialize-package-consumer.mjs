import assert from 'node:assert/strict';
import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveAngularVersion,
  resolveConsumerProfile,
} from './package-consumer-profiles.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = resolve(
  workspaceRoot,
  'fixtures/package-consumer-template',
);
const lockRoot = resolve(workspaceRoot, 'fixtures/package-consumer-locks');
const consumerName = process.argv[2] ?? 'package-consumer';
const consumerProfile = resolveConsumerProfile(consumerName);
const allowMissingLock = process.argv.includes('--allow-missing-lock');
const temporaryRoot = resolve(
  workspaceRoot,
  'tmp/package-consumer-verification',
);
const consumerRoot = resolve(temporaryRoot, consumerName);

const assertContained = (path, owner) => {
  if (path !== owner && !path.startsWith(`${owner}${sep}`)) {
    throw new Error(`Refusing path outside ${owner}: ${path}`);
  }
};

assertContained(consumerRoot, temporaryRoot);
await rm(consumerRoot, { force: true, recursive: true });
await mkdir(temporaryRoot, { recursive: true });
await cp(templateRoot, consumerRoot, { recursive: true });

// Sources a row adds to the template, copied over it. A row that needs application code the other
// rows do not have declares the directory holding it rather than the template carrying code every
// row must then keep compiling. That separation is what lets one row be the discriminator for a
// defect: the code that would meet it exists in that row and nowhere else.
if (consumerProfile.overlay !== undefined) {
  const overlayRoot = resolve(workspaceRoot, consumerProfile.overlay);
  assertContained(overlayRoot, workspaceRoot);
  await cp(overlayRoot, consumerRoot, { recursive: true });
}

// The compiler this row's application uses. Analysis adopts a consumer's own options, so a row
// that changes them changes the program every Atlas diagnostic is computed against.
if (consumerProfile.compilerOptions !== undefined) {
  const tsconfigPath = resolve(consumerRoot, 'tsconfig.json');
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8'));
  tsconfig.compilerOptions = {
    ...tsconfig.compilerOptions,
    ...consumerProfile.compilerOptions,
  };
  await writeFile(
    tsconfigPath,
    `${JSON.stringify(tsconfig, null, 2)}\n`,
    'utf8',
  );
}

const lockPath = resolve(lockRoot, consumerName, 'pnpm-lock.yaml');
const lockExists = await lstat(lockPath).then(
  (entry) => entry.isFile(),
  () => false,
);
if (lockExists) {
  await cp(lockPath, resolve(consumerRoot, 'pnpm-lock.yaml'));
} else if (!allowMissingLock) {
  throw new Error(
    `Missing committed lockfile for ${consumerName}: ${lockPath}\nRun "pnpm run refresh:consumer-locks" to regenerate the consumer fixture lockfiles.`,
  );
}

const manifestPath = resolve(consumerRoot, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.name = `@neolorn/atlas-feature-lab-${consumerName}`;
for (const dependencySet of [manifest.dependencies, manifest.devDependencies]) {
  for (const dependency of Object.keys(dependencySet)) {
    if (dependency.startsWith('@angular/')) {
      dependencySet[dependency] = resolveAngularVersion(
        consumerProfile,
        dependency,
      );
    }
  }
}
manifest.dependencies.rxjs = consumerProfile.rxjs;
manifest.devDependencies.typescript = consumerProfile.typescript;

const packageLocator = (outputRoot) => {
  const path = relative(consumerRoot, resolve(workspaceRoot, outputRoot));
  return `file:${path.replaceAll('\\', '/')}`;
};

manifest.dependencies['@neolorn/atlas'] = packageLocator('dist/runtime');
manifest.devDependencies['@neolorn/atlas-toolkit'] =
  packageLocator('dist/toolkit');

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

process.stdout.write(`${consumerRoot}\n`);
