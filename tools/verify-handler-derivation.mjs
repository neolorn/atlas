import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The handler calls the classification. It does not reimplement it.
 *
 * *Why a mutation and not an assertion.* `http-handler.test.ts` already asserts that what the handler
 * emits equals what `routeHttpDescriptor` and `routeCacheHeaders` produce for the same resolution.
 * That assertion is worth having and it cannot prove this on its own: the expected value is computed
 * through the same functions the handler uses, so if the handler stopped calling them and computed
 * the same answer another way, the equality would still hold on the day it was written. It is only
 * ever violated once the two drift, which is the day *after* the one worth catching.
 *
 * So the classification is changed and the handler is asked again. A handler that reads the
 * descriptor changes its answer. A handler that reimplements the classification keeps the old one,
 * and that is the failure reported here.
 *
 * Two derivations of one answer is a defect this codebase produces readily (two components
 * restoring one caret with different arithmetic, one address carrying two cacheability answers) so
 * it gets a check that fails rather than a comment saying not to.
 *
 * `specs/12-verification.spec.md` section 9 names the other half of this: a check derived from
 * the thing it checks agrees by construction, which is why the expected value cannot be
 * computed through the functions under test.
 */

const routingPath = resolve(
  workspaceRoot,
  'packages/runtime/core/src/routing.ts',
);
const probePath = resolve(
  workspaceRoot,
  'packages/runtime/test/handler-derivation-probe.generated.test.ts',
);

/**
 * The mutation: a successful localized page stops being shared-cacheable.
 *
 * Chosen because it is a classification change with a directly observable consequence that no other
 * part of the pipeline can produce, and because the two values are unmistakable in a failure
 * message. It is applied to the descriptor, the thing the handler is supposed to be consulting,
 * rather than to the header serializer, so a handler calling `routeCacheHeaders` with its own
 * hand-computed descriptor is caught too.
 */
const MUTATION = Object.freeze({
  find: "              : 'public',",
  replace: "              : 'private-no-store',",
});

const PROBE = `import { describe, expect, it } from 'vitest';

import { createLocaleRequestHandler } from '../http/src/handler.js';
import type {
  LocaleUrlPolicy,
  RouteRuntimeProjection,
} from '@neolorn/atlas/core';

const POLICY: LocaleUrlPolicy = {
  kind: 'path-prefix',
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
  prefixes: { 'en-us': 'en-US', 'ar-eg': 'ar-EG' },
  aliases: {},
  localeNeutralRoots: ['assets'],
  omitDefaultPrefix: false,
};

const PROJECTION: RouteRuntimeProjection = {
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

describe('the handler under a mutated classification', () => {
  it('follows the descriptor rather than its own arithmetic', async () => {
    const handler = createLocaleRequestHandler({
      policy: POLICY,
      projection: PROJECTION,
      cache: { successMaxAge: 600, permanentRedirectMaxAge: 86_400 },
      cookie: { name: 'atlas-locale' },
      render: () => new Response('<!doctype html>'),
    });

    const response = await handler(
      new Request('https://atlas.example/ar-eg/second'),
    );

    // Unmutated this address answers 'public, max-age=600, must-revalidate'. If it still does, the
    // handler is not reading the classification it was changed in.
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
`;

const original = await readFile(routingPath, 'utf8');
const occurrences = original.split(MUTATION.find).length - 1;
assert.equal(
  occurrences,
  1,
  `the mutation site must be unique in routing.ts, found ${occurrences}. ` +
    'Update MUTATION in this file to a site that still exists.',
);

try {
  await writeFile(
    routingPath,
    original.replace(MUTATION.find, MUTATION.replace),
    'utf8',
  );
  await writeFile(probePath, PROBE, 'utf8');

  let failed = false;
  let detail = '';
  try {
    await run(
      process.execPath,
      [
        resolve(workspaceRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        'packages/runtime/test/handler-derivation-probe.generated.test.ts',
      ],
      { cwd: workspaceRoot },
    );
  } catch (error) {
    failed = true;
    detail = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }

  assert.equal(
    failed,
    false,
    'the handler did not follow the mutated classification, which means it is computing the ' +
      'answer itself rather than calling routeHttpDescriptor:\n' +
      detail.slice(0, 2000),
  );
} finally {
  await writeFile(routingPath, original, 'utf8');
  await rm(probePath, { force: true });
}

// And the restore is verified, because a harness that leaves a mutation behind is worse than no
// harness: every later gate would be measuring the mutated tree.
const restored = await readFile(routingPath, 'utf8');
assert.equal(
  restored,
  original,
  'routing.ts was not restored after the mutation. Restore it from git before trusting any ' +
    'later verification in this run.',
);

process.stdout.write(
  'Atlas handler derivation verified: the handler follows the descriptor.\n',
);
