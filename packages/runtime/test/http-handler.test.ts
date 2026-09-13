import { describe, expect, it } from 'vitest';

import { createLocaleRequestHandler } from '../http/src/handler.js';
import {
  createLocaleNeutralPolicy,
  resolveLocalizedRoute,
  routeCacheHeaders,
  routeHttpDescriptor,
  type LocaleUrlPolicy,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

const CACHE = { successMaxAge: 600, permanentRedirectMaxAge: 86_400 } as const;

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

const handlerFor = (policy: LocaleUrlPolicy = POLICY) =>
  createLocaleRequestHandler({
    policy,
    projection: PROJECTION,
    cache: CACHE,
    cookie: { name: 'atlas-locale' },
    render: ({ locale }) =>
      new Response(`<!doctype html><html lang="${locale}"></html>`, {
        headers: { 'content-type': 'text/html' },
      }),
  });

const get = (
  path: string,
  headers: Record<string, string> = {},
  policy?: LocaleUrlPolicy,
) =>
  handlerFor(policy)(new Request(`https://atlas.example${path}`, { headers }));

/**
 * 4.13's handler half: a prerendered address whose segments are not ASCII.
 *
 * The build writes `ar-eg/\u0627\u0644\u062b\u0627\u0646\u064a/index.html` and a browser asks for it percent-encoded,
 * because that is the only form a URL can carry. Angular's own server engine registered the file
 * under the decoded key and looked it up under the encoded one, so it did not serve the file it
 * just built: reported as `angular/angular-cli#33966`, fixed by `baf1ca1` and released in 22.1.7,
 * which decodes before the lookup. The requirement on a host is stated in section 9 of
 * `specs/07-routing-rendering-and-seo.spec.md` and is unchanged by that: a static file server or
 * a content network has no
 * engine in front of it and still has to map the decoded path itself. This is the other half of the
 * item, which is what Atlas's own handler does when it is the host, and it decoded before the
 * lookup on the day it was written, which is why nothing here moves with the version.
 *
 * The addresses here are built with `encodeURIComponent` rather than written out encoded, so the
 * assertion cannot drift from what a browser would actually send, and the decoded spelling appears
 * once in the projection where it belongs.
 */
describe('a localized address whose segments are not ASCII', () => {
  const ARABIC = '\u0627\u0644\u062b\u0627\u0646\u064a';
  const NON_ASCII: RouteRuntimeProjection = {
    generated: {
      profile: 'atlas-route-projection/1',
      identity: 'sha256-AtlasBuiltLocaleAddressesTestIdentity012345',
      routes: [
        { id: 'route:_index', path: '', parameterNames: [] },
        { id: 'route:second', path: 'second', parameterNames: [] },
      ],
    },
    localizedPaths: { 'route:second': { 'en-US': 'second', 'ar-EG': ARABIC } },
  };

  const handler = createLocaleRequestHandler({
    policy: POLICY,
    projection: NON_ASCII,
    cache: CACHE,
    cookie: { name: 'atlas-locale' },
    render: ({ locale, resolution }) =>
      new Response(
        `<!doctype html><html lang="${locale}" data-path="${resolution.status === 'success' ? resolution.canonicalPath : ''}"></html>`,
        { headers: { 'content-type': 'text/html' } },
      ),
  });

  const fetchPath = (path: string) =>
    handler(new Request(`https://atlas.example${path}`));

  it('serves the encoded form, which is the only form a request can carry', async () => {
    const response = await fetchPath(`/ar-eg/${encodeURIComponent(ARABIC)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-language')).toBe('ar-EG');
    expect(await response.text()).toContain('lang="ar-EG"');
  });

  it('does not mistake a non-ASCII segment for something to decline', async () => {
    // The bypass is what would swallow this silently: an address Atlas declines never reaches the
    // renderer, and with no passthrough configured it answers 404, which is indistinguishable
    // from "no such page" unless it is asserted separately from the status above.
    const response = await fetchPath(`/ar-eg/${encodeURIComponent(ARABIC)}`);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  /**
   * There is no second spelling to canonicalize at this layer, and that is worth asserting rather
   * than assuming.
   *
   * Handing `resolveLocalizedRoute` the decoded string directly produces a 308 to the encoded form,
   * so it would be reasonable to expect the handler to do the same. It does not, because it cannot:
   * a `Request` is constructed from a URL, and the URL parser percent-encodes the path before the
   * handler ever reads it. The decoded spelling is not something a request can carry.
   *
   * Which is why the resolver's canonical form has to be the encoded one. If it canonicalized to
   * the decoded spelling, every request to a correct address would be redirected to an address no
   * request can express, and the redirect would be to itself.
   */
  it('cannot be reached in its decoded spelling, because a URL encodes it first', async () => {
    const response = await fetchPath(`/ar-eg/${ARABIC}`);
    expect(new URL(`https://atlas.example/ar-eg/${ARABIC}`).pathname).toBe(
      `/ar-eg/${encodeURIComponent(ARABIC)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-language')).toBe('ar-EG');
  });

  /** The control: the same handler, the same projection, an ASCII address in the other locale. */
  it('still serves an ASCII address, so 200 is not what it says to everything', async () => {
    const response = await fetchPath('/en-us/second');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-language')).toBe('en-US');
  });
});

/**
 * The bypass is read from the policy rather than written next to it.
 *
 * An application that hand-writes `routePolicy.localeNeutralRoots.includes(firstSegment)` plus a
 * dot-sniff has written the rule a second time, and every such copy is a different third way.
 * Atlas already holds the roots, so the handler consults them, which means adding a root to the
 * policy moves the bypass with it. A bypass that agrees with the policy only because both were
 * typed the same way agrees until one of them is edited.
 */
describe('what the handler declines to localize', () => {
  it('follows the policy when a root is added rather than a hardcoded list', async () => {
    // `media` is not a root here, so it localizes like anything else.
    const before = await get('/media/logo');
    expect(before.status).toBe(307);

    // The same address under a policy that names it. Nothing in the handler changed.
    const after = await get(
      '/media/logo',
      {},
      { ...POLICY, localeNeutralRoots: ['assets', 'media'] },
    );
    expect(after.status).toBe(404);
  });

  it('leaves a dotted asset path alone', async () => {
    expect((await get('/main-A1B2C3.js')).status).toBe(404);
    expect((await get('/assets/fonts/arabic.woff2')).status).toBe(404);
  });

  it('still localizes an ordinary address, which is the control', async () => {
    // Without this, every assertion above passes for a handler that bypasses everything.
    const ordinary = await get('/second');
    expect(ordinary.status).toBe(307);
    expect(ordinary.headers.get('location')).toBe('/en-us/second');
  });
});

/**
 * The constraint this step was given: the handler calls the descriptor, it does not reimplement it.
 *
 * Two paths computing one classification with different arithmetic is the caret defect and the
 * entry-cacheability defect both, and a handler that reimplements the classification passes every
 * test written against the handler. So what is asserted is not the handler's output but its
 * *derivation*: for each address, what the handler emitted must equal what the descriptor produces
 * for the same resolution, computed here through the public functions.
 *
 * This is not the whole check. A correct reimplementation would satisfy it today and drift
 * tomorrow, which is why the mutation lives in the assurance gate as well: changing the
 * classification in `routing.ts` has to change what the handler emits, or the handler is not
 * reading it.
 */
describe('where the handler gets its answers', () => {
  const addresses = [
    ['/', undefined],
    ['/second', undefined],
    ['/en-us/second', undefined],
    ['/ar-eg/second', 'ar-EG'],
    ['/EN-US/Second/', undefined],
    ['/en-us/nothing-here', undefined],
  ] as const;

  it('emits exactly what the descriptor says, for every outcome shape', async () => {
    for (const [path, preference] of addresses) {
      const response = await get(
        path,
        preference === undefined
          ? {}
          : { cookie: `atlas-locale=${preference}` },
      );

      const resolution = resolveLocalizedRoute(
        path,
        POLICY,
        PROJECTION,
        preference === undefined ? undefined : { locale: preference },
      );
      const descriptor = routeHttpDescriptor(resolution);
      const expected = routeCacheHeaders(descriptor, {
        ...CACHE,
        localePreference: 'cookie',
      });

      expect({
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        vary: response.headers.get('vary'),
        contentLanguage: response.headers.get('content-language'),
        location: response.headers.get('location'),
      }).toStrictEqual({
        status: descriptor.status,
        cacheControl: expected['cache-control'],
        vary: expected.vary ?? null,
        contentLanguage: descriptor.contentLanguage ?? null,
        location: descriptor.location ?? null,
      });
    }
  });

  it('covers more than one classification, or the agreement above is vacuous', () => {
    const seen = new Set(
      addresses.map(
        ([path, preference]) =>
          routeHttpDescriptor(
            resolveLocalizedRoute(
              path,
              POLICY,
              PROJECTION,
              preference === undefined ? undefined : { locale: preference },
            ),
          ).cache,
      ),
    );

    expect([...seen].sort()).toStrictEqual([
      'consumer-defined-permanent',
      'private-no-store',
      'public',
    ]);
  });
});

/**
 * And the layering, asserted rather than described: the handler derives `localePreference` because
 * it reads the request, where `routeCacheHeaders` has to be told.
 */
describe('the fact the handler derives and the descriptor is told', () => {
  it('treats every varying address as cookie-borne when it reads cookies at all', async () => {
    const neutral: LocaleUrlPolicy = createLocaleNeutralPolicy({
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
      localeNeutralRoots: ['assets'],
    });

    // No cookie on this request. Deriving the source per request would call this
    // `accept-language`, mark it shared-cacheable per language, and hand it to a visitor whose
    // answer came from a cookie: 6.1's defect, one level up.
    const anonymous = await get('/second', {}, neutral);
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
    expect(anonymous.headers.get('vary')).toBeNull();
  });

  it('is a shared variant per language when no cookie is read at all', async () => {
    const neutral: LocaleUrlPolicy = createLocaleNeutralPolicy({
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
      localeNeutralRoots: ['assets'],
    });
    const negotiating = createLocaleRequestHandler({
      policy: neutral,
      projection: PROJECTION,
      cache: CACHE,
      cookie: false,
      render: () => new Response('<!doctype html>'),
    });

    const response = await negotiating(
      new Request('https://atlas.example/second', {
        headers: { 'accept-language': 'ar-EG,en;q=0.8' },
      }),
    );

    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=600, must-revalidate',
    );
    expect(response.headers.get('vary')).toBe('Accept-Language');
    expect(response.headers.get('content-language')).toBe('ar-EG');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

/**
 * The outcome that has a status and no body.
 *
 * `hasBody` reads "not a redirect", and a malformed target is not a redirect, so the one outcome
 * the entry point documents as never reaching a renderer was the one reaching it. The status was
 * right either way, because it comes from the descriptor; what was wrong is that an application was
 * asked to render a page for an address Atlas had already refused, with a resolution carrying no
 * presentation of its own.
 *
 * These are the unsafe shapes a URL keeps. The ones it rewrites are checked through the adapter in
 * `http-node-adapter.test.ts`, because that is where they are lost.
 */
describe('a malformed target', () => {
  const targets = ['/en-us/%zz', '/en-us//double', '/en-us/a%2Fb'];

  it('is answered without a renderer being asked', async () => {
    const seen: { target: string; status: number; renders: number }[] = [];

    for (const target of targets) {
      let renders = 0;
      const handler = createLocaleRequestHandler({
        policy: POLICY,
        projection: PROJECTION,
        cache: CACHE,
        cookie: { name: 'atlas-locale' },
        render: () => {
          renders += 1;
          return new Response('<!doctype html>');
        },
      });

      const response = await handler(
        new Request(`https://atlas.example${target}`),
      );
      seen.push({ target, status: response.status, renders });
    }

    expect(seen).toStrictEqual(
      targets.map((target) => ({ target, status: 400, renders: 0 })),
    );
  });

  it('carries no body and no cookie', async () => {
    const handler = createLocaleRequestHandler({
      policy: POLICY,
      projection: PROJECTION,
      cache: CACHE,
      cookie: { name: 'atlas-locale' },
      render: () => new Response('<!doctype html>'),
    });

    const response = await handler(
      new Request('https://atlas.example/en-us/%zz'),
    );

    expect(await response.text()).toBe('');
    expect(response.headers.getSetCookie()).toStrictEqual([]);
  });
});
