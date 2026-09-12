import { describe, expect, it } from 'vitest';

import {
  createHostLocalePolicy,
  createLocaleNeutralPolicy,
  createPathPrefixLocalePolicy,
  localeFromRoute,
  resolveInitialRouteLocale,
  resolveLocalizedRoute,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

/**
 * An address the projection has no route for still states its locale.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 5 says what has to happen: "an address the
 * projection does not contain therefore resolves to no route identity. That is not a localization
 * failure: the locale resolved, and only the page is unknown. Resolution commits the locale and
 * yields no route context", and the runtime did the opposite: `resolveInitialRouteLocale` reached
 * past the `presentationLocale` the resolution had already computed and answered with the policy
 * default, and `localeFromRoute` declined to answer at all.
 *
 * *How it surfaces, and it is not a hypothetical.* Routes discovered inside a module reached by
 * `loadChildren` are not in Atlas's projection: the generator never saw them. The build still
 * prerenders their localized addresses, because Angular's own router does follow `loadChildren`, so
 * `/ar-eg/<arabic>/detail` is emitted, matches no projected route, and rendered in `en-US`. The
 * projection's coverage is a separate item, `ATL1406`. This is the half that stops a gap in coverage
 * from also losing the locale, and it is the general fix rather than the `loadChildren` one,
 * because a route table assembled at runtime or spread in from another module hides routes the same
 * way.
 *
 * *Why the distinction between the two functions matters here.* `localeFromRoute` exists to be able
 * to say nothing, so that a URL stating no locale steps aside and lets the next source answer. An
 * unknown address under a recognised prefix is not that case: the address states `ar-EG` and merely
 * has no page. An unknown address with no prefix at all is that case, and the two must not be
 * conflated, which is why the second assertion in each pair is the one that carries the design.
 */

const IDENTITY = 'sha256-AtlasRouteProjectionTestIdentity0123456789_';

/** A projection that knows about `tools` and nothing else, as one that never saw a lazy child. */
const PROJECTION: RouteRuntimeProjection = {
  generated: {
    profile: 'atlas-route-projection/1',
    identity: IDENTITY,
    routes: [
      { id: 'route:_index', path: '', parameterNames: [] },
      { id: 'tools', path: 'tools', parameterNames: [] },
    ],
  },
  localizedPaths: { tools: { 'en-US': 'tools', 'ar-EG': 'أدوات' } },
};

const PREFIXED = createPathPrefixLocalePolicy({
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
  localeNeutralRoots: ['assets'],
});

const HOSTED = createHostLocalePolicy({
  defaultLocale: 'en-US',
  origins: {
    'en-US': 'https://example.com',
    'ar-EG': 'https://example.eg',
  },
  localeNeutralRoots: ['assets'],
});

const NEUTRAL = createLocaleNeutralPolicy({
  defaultLocale: 'en-US',
  locales: ['en-US', 'ar-EG'],
  localeNeutralRoots: ['assets'],
});

/** The shape a lazily loaded child produces: a real prefix, and a path the projection never saw. */
const LAZY_CHILD = '/ar-eg/قسم/detail';

describe('an address with no projected route, under a prefix policy', () => {
  it('resolves not-found and presents the locale the address states', () => {
    const resolution = resolveLocalizedRoute(LAZY_CHILD, PREFIXED, PROJECTION);
    expect(resolution.status).toBe('not-found');
    if (resolution.status !== 'not-found') return;
    expect(resolution.presentationLocale).toBe('ar-EG');
    expect(resolution.requestedLocale).toBe('ar-EG');
  });

  it('is the locale the runtime initializes in', () => {
    expect(resolveInitialRouteLocale(LAZY_CHILD, PREFIXED, PROJECTION)).toBe(
      'ar-EG',
    );
  });

  it('is a locale the address states, so the chain does not step past it', () => {
    expect(localeFromRoute(LAZY_CHILD, PREFIXED, PROJECTION)).toBe('ar-EG');
  });

  /**
   * The control, and it is the half that keeps the two answers apart.
   *
   * Without it, `localeFromRoute` could satisfy the assertion above by answering the default for
   * every unknown address, which is exactly the behaviour that would put an unprefixed request
   * ahead of the cookie and the header that should have answered it.
   */
  it('says nothing for an unknown address that states no locale', () => {
    expect(
      localeFromRoute('/قسم/detail', PREFIXED, PROJECTION),
    ).toBeUndefined();
  });

  it('still declines an address whose prefix names a locale the build lacks', () => {
    const resolution = resolveLocalizedRoute('/de/tools', PREFIXED, PROJECTION);
    expect(resolution.status).toBe('unsupported-locale');
    // `unsupported-locale` carries `requestedLocale` too, and it holds the raw prefix rather than a
    // locale this application has. Answering with it would hand the runtime a locale that does not
    // exist, so the address is presented in the default and the chain is told nothing.
    expect(localeFromRoute('/de/tools', PREFIXED, PROJECTION)).toBeUndefined();
    expect(resolveInitialRouteLocale('/de/tools', PREFIXED, PROJECTION)).toBe(
      'en-US',
    );
  });
});

describe('an address with no projected route, under a locale-host policy', () => {
  const target = 'https://example.eg/قسم/detail';

  it('presents the locale the origin states', () => {
    const resolution = resolveLocalizedRoute(target, HOSTED, PROJECTION);
    expect(resolution.status).toBe('not-found');
    if (resolution.status !== 'not-found') return;
    expect(resolution.presentationLocale).toBe('ar-EG');
    expect(resolution.requestedLocale).toBe('ar-EG');
  });

  it('is the locale the runtime initializes in', () => {
    expect(resolveInitialRouteLocale(target, HOSTED, PROJECTION)).toBe('ar-EG');
  });
});

describe('an address with no projected route, under a locale-neutral policy', () => {
  /**
   * Unchanged, and it must be: a locale-neutral address states no locale by construction, so an
   * unknown one has nothing extra to say and the preference remains the only source.
   */
  it('says nothing, because the address never stated a locale', () => {
    expect(localeFromRoute('/قسم/detail', NEUTRAL, PROJECTION)).toBeUndefined();
  });

  it('presents the preference it was given, not the address', () => {
    const resolution = resolveLocalizedRoute(
      '/قسم/detail',
      NEUTRAL,
      PROJECTION,
      {
        locale: 'ar-EG',
      },
    );
    expect(resolution.status).toBe('not-found');
    if (resolution.status !== 'not-found') return;
    expect(resolution.presentationLocale).toBe('ar-EG');
    expect(resolution.requestedLocale).toBeUndefined();
  });
});
