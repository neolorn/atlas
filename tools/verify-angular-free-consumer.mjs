import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A consumer with no Angular anywhere, importing `@neolorn/atlas/http` and `@neolorn/atlas/core`.
 *
 * *Why this exists.* Two entry points exist for the sole reason that they load where the rest of the
 * package cannot: a worker, a serverless function, a server that is not the Angular one. That claim
 * is not visible in the source and it is not provable from inside this repository, where
 * `@angular/core` resolves from the workspace root no matter what any individual file imports. So
 * the package is installed somewhere `@angular/*` genuinely does not resolve, and used from there.
 * `specs/02-packages-and-platform.spec.md` section 3 is the requirement, and it is written about
 * both halves for the reason the next paragraph gives.
 *
 * *Why both halves.* The runtime half was passing while the type half was broken, and that is not a
 * hypothetical: `contracts.ts` imported `Signal` and `TemplateRef` from `@angular/core` as types.
 * `import type` is erased, so the bundle was clean and plain Node loaded it, and the generated
 * `.d.ts` kept the import, so a consumer without Angular could run the core and could not typecheck
 * against it. A runtime-only check would have reported success for a package that did not work.
 *
 * *No package manager.* The dependency tree is assembled by copying the built package into a
 * `node_modules` that contains nothing else. That is the point rather than a shortcut: an install
 * would resolve peers from a registry or a store and could quietly supply the very thing this is
 * meant to prove absent. Here, absence is a property of the directory.
 */

const scratch = await mkdtemp(resolve(tmpdir(), 'atlas-angular-free-'));
try {
  const packageRoot = resolve(scratch, 'node_modules/@neolorn/atlas');
  await mkdir(packageRoot, { recursive: true });
  await cp(resolve(workspaceRoot, 'dist/runtime'), packageRoot, {
    recursive: true,
  });

  // The claim under test, stated as a precondition rather than assumed.
  const installed = await readdir(resolve(scratch, 'node_modules'));
  assert.deepEqual(
    installed,
    ['@neolorn'],
    `the consumer must have nothing installed but Atlas, found: ${installed.join(', ')}`,
  );

  await writeFile(
    resolve(scratch, 'package.json'),
    `${JSON.stringify({ name: 'atlas-angular-free-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );

  // --- the runtime half -------------------------------------------------------------------------
  await writeFile(
    resolve(scratch, 'use.mjs'),
    `import assert from 'node:assert/strict';
import { createLocaleRequestHandler, toWebRequest } from '@neolorn/atlas/http';
import { directionForLocale, resolveLocalizedRoute } from '@neolorn/atlas/core';

assert.equal(directionForLocale('ar-EG'), 'rtl');

const policy = {
  kind: 'path-prefix',
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
  prefixes: { 'en-us': 'en-US', 'ar-eg': 'ar-EG' },
  aliases: {},
  localeNeutralRoots: ['assets'],
  omitDefaultPrefix: false,
};
const projection = {
  generated: {
    profile: 'atlas-route-projection/1',
    identity: 'sha256-AtlasBuiltLocaleAddressesTestIdentity012345',
    routes: [
      { id: 'route:_index', path: '', parameterNames: [] },
      { id: 'route:second', path: 'second', parameterNames: [] },
    ],
  },
  localizedPaths: { 'route:second': { 'en-US': 'second', 'ar-EG': 'second' } },
};

// The classification, reached without the handler, which is the reason the descriptor stayed a
// composable layer rather than being folded into it.
const direct = resolveLocalizedRoute('/ar-eg/second', policy, projection);
assert.equal(direct.status, 'success');
assert.equal(direct.locale, 'ar-EG');

const handler = createLocaleRequestHandler({
  policy,
  projection,
  cache: { successMaxAge: 600, permanentRedirectMaxAge: 86400 },
  cookie: { name: 'atlas-locale' },
  render: ({ locale }) => new Response('<!doctype html><html lang="' + locale + '"></html>'),
});

const redirect = await handler(new Request('https://atlas.example/second'));
assert.equal(redirect.status, 307);
assert.equal(redirect.headers.get('location'), '/en-us/second');

const page = await handler(new Request('https://atlas.example/ar-eg/second'));
assert.equal(page.status, 200);
assert.equal(page.headers.get('content-language'), 'ar-EG');
assert.match(page.headers.get('set-cookie') ?? '', /atlas-locale=ar-EG/u);
assert.equal(
  page.headers.get('cache-control'),
  'public, max-age=600, must-revalidate',
);

// The Node adapter, without a socket and without \`node:http\` types.
const adapted = toWebRequest(
  { method: 'GET', url: '/ar-eg/second', headers: { host: 'atlas.example' } },
  'http://atlas.example',
);
assert.equal(adapted.url, 'http://atlas.example/ar-eg/second');

process.stdout.write('angular-free runtime use verified\\n');
`,
  );

  const executed = await run(process.execPath, ['use.mjs'], { cwd: scratch });
  assert.match(executed.stdout, /angular-free runtime use verified/u);

  // --- the type half ----------------------------------------------------------------------------
  await writeFile(
    resolve(scratch, 'use.ts'),
    `import { createLocaleRequestHandler } from '@neolorn/atlas/http';
import type { LocaleRequestHandler, NodeRequestLike } from '@neolorn/atlas/http';
import type {
  LocaleUrlPolicy,
  RouteResolution,
  RouteRuntimeProjection,
} from '@neolorn/atlas/core';

export declare const policy: LocaleUrlPolicy;
export declare const projection: RouteRuntimeProjection;
export declare const resolution: RouteResolution;
export declare const message: NodeRequestLike;

export const handler: LocaleRequestHandler = createLocaleRequestHandler({
  policy,
  projection,
  cache: { successMaxAge: 600, permanentRedirectMaxAge: 86400 },
});
`,
  );
  await writeFile(
    resolve(scratch, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'preserve',
          moduleResolution: 'bundler',
          lib: ['ES2022', 'DOM'],
          types: [],
          noEmit: true,
          skipLibCheck: false,
          sourceMap: false,
        },
        files: ['use.ts'],
      },
      null,
      2,
    )}\n`,
  );

  // `skipLibCheck` is off deliberately. With it on, a declaration file referencing a module that
  // cannot resolve is not an error, which is exactly the failure being tested for.
  const typescript = resolve(workspaceRoot, 'node_modules/typescript/bin/tsc');
  try {
    await run(process.execPath, [typescript, '--project', 'tsconfig.json'], {
      cwd: scratch,
    });
  } catch (error) {
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    assert.fail(
      `the published types do not typecheck without Angular installed:\n${detail}`,
    );
  }

  process.stdout.write(
    'Atlas Angular-free consumer verified: runtime and declarations.\n',
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
