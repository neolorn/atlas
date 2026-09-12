import { describe, expect, it } from 'vitest';

import {
  buildLocalizedRoute,
  createIdentifierParameterCodec,
  createPathPrefixLocalePolicy,
  resolveLocalizedRoute,
  type GeneratedRouteProjectionEntry,
  type LocaleUrlPolicy,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

/**
 * A route table larger than a hand-written one, resolved and built the ordinary way.
 *
 * Atlas is built for a hundred times the size it is used at today, and a table of a few dozen
 * routes hides the difference between a lookup and a search. Every case in this file is ordinary:
 * one address in, one address out. What makes it a case is the table it happens against.
 *
 * The bound is deliberately not a stopwatch. A test that fails when a machine is busy teaches
 * people to rerun it, and the thing worth catching here is not a slow second but a return to
 * walking the whole table on every call, which at this size is the difference between a suite that
 * finishes and one that does not. The size is the assertion.
 */

const ROUTES = 20_000;
const POLICY: LocaleUrlPolicy = createPathPrefixLocalePolicy({
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
});

function largeProjection(): RouteRuntimeProjection {
  const routes: GeneratedRouteProjectionEntry[] = [
    // First in the table, and parameterised, so a concrete address has to be offered to it before
    // any later static route can claim the same shape. Order is what a lookup has to preserve.
    {
      id: 'article',
      path: 'articles/:slug',
      parameterNames: ['slug'],
      indexing: 'indexable',
    },
  ];
  for (let index = 0; index < ROUTES; index += 1) {
    routes.push({
      id: `route:section-${index}`,
      path: `sections/section-${index}`,
      parameterNames: [],
      indexing: 'indexable',
    });
  }
  return {
    generated: {
      profile: 'atlas-route-projection/1',
      identity: 'sha256-AtlasRouteTableScaleTestIdentity01234567890',
      routes,
    },
    parameters: { article: { slug: createIdentifierParameterCodec() } },
    localizedPaths: {
      'route:section-0': { 'en-US': 'sections/first', 'ar-EG': 'أقسام/الأول' },
    },
  };
}

describe('a route table of twenty thousand', () => {
  const projection = largeProjection();

  it('resolves an address near the end of the table', () => {
    const resolution = resolveLocalizedRoute(
      '/en-us/sections/section-19999',
      POLICY,
      projection,
    );
    expect(resolution.status).toBe('success');
    expect(resolution.status === 'success' && resolution.routeId).toBe(
      'route:section-19999',
    );
  });

  it('resolves the parameterised route that stands in front of all of them', () => {
    const resolution = resolveLocalizedRoute(
      '/en-us/articles/atlas-handbook',
      POLICY,
      projection,
    );
    expect(resolution.status).toBe('success');
    expect(resolution.status === 'success' && resolution.routeId).toBe(
      'article',
    );
  });

  it('resolves a localized spelling and the fallback spelling beside it', () => {
    // Encoded, because that is the only form a request can carry: the decoded spelling resolves to
    // a redirect to this one, which is a different case and not this one.
    const localized = resolveLocalizedRoute(
      '/ar-eg/%D8%A3%D9%82%D8%B3%D8%A7%D9%85/%D8%A7%D9%84%D8%A3%D9%88%D9%84',
      POLICY,
      projection,
    );
    expect(localized.status).toBe('success');
    expect(localized.status === 'success' && localized.routeId).toBe(
      'route:section-0',
    );
    // The same locale, a route with no localized path of its own, which falls back to the spelling
    // the table carries.
    const fallback = resolveLocalizedRoute(
      '/ar-eg/sections/section-1',
      POLICY,
      projection,
    );
    expect(fallback.status).toBe('success');
    expect(fallback.status === 'success' && fallback.routeId).toBe(
      'route:section-1',
    );
  });

  it('answers nothing for an address no route in the table spells', () => {
    const resolution = resolveLocalizedRoute(
      '/en-us/sections/section-20000',
      POLICY,
      projection,
    );
    expect(resolution.status).toBe('not-found');
  });

  it('builds a thousand addresses across both locales', () => {
    const built: string[] = [];
    for (let index = 0; index < 500; index += 1) {
      built.push(
        buildLocalizedRoute(
          POLICY,
          projection,
          `route:section-${index}` as never,
          'en-US',
        ),
        buildLocalizedRoute(
          POLICY,
          projection,
          `route:section-${index}` as never,
          'ar-EG',
        ),
      );
    }
    expect(built).toHaveLength(1000);
    expect(built[0]).toBe('/en-us/sections/first');
    expect(built[1]).toBe(
      '/ar-eg/%D8%A3%D9%82%D8%B3%D8%A7%D9%85/%D8%A7%D9%84%D8%A3%D9%88%D9%84',
    );
    expect(built.at(-2)).toBe('/en-us/sections/section-499');
    expect(built.at(-1)).toBe('/ar-eg/sections/section-499');
  });
});
