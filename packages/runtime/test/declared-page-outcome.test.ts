/**
 * What a page discovers about itself, and whether it reaches the response.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 5 gives two of its three outcome classes
 * facts an address cannot supply: whether the entity an address names is absent, and whether it was
 * permanently removed. Resolution answers neither, so a page that loaded the record declares it, and
 * the declaration travels from the render to the response over the request the two already share.
 *
 * The cases here are the half below Angular: what the channel does, what the handler composes from
 * it, and what it refuses. The declaration is written here the way the Angular service writes it,
 * through `ɵrememberPageOutcome` against the render's own request, so these cases exercise the same
 * channel rather than a stand-in for it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLocaleRequestHandler,
  declarePageOutcome,
  declareOperationalFailure,
  type LocaleRenderer,
} from '../http/src/handler.js';
import {
  pageAbsent,
  pageGone,
  pageOperationalFailure,
  pageOutcomeHttpDescriptor,
  routeHttpDescriptor,
  ɵopenPageOutcomeChannel,
  ɵrememberPageOutcome,
  ɵtakePageOutcome,
  type LocaleUrlPolicy,
  type PageOutcomeDeclaration,
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
    identity: 'sha256-AtlasDeclaredPageOutcomeTestIdentity0123456',
    routes: [
      { id: 'route:_index', path: '', parameterNames: [] },
      { id: 'route:second', path: 'second', parameterNames: [] },
    ],
  },
  localizedPaths: { 'route:second': { 'en-US': 'second', 'ar-EG': 'second' } },
};

const handlerWith = (render: LocaleRenderer) =>
  createLocaleRequestHandler({
    policy: POLICY,
    projection: PROJECTION,
    cache: CACHE,
    cookie: { name: 'atlas-locale' },
    render,
  });

/** A page that discovers its own outcome mid-render, which is what the Angular service does. */
const pageDeclares =
  (declaration: PageOutcomeDeclaration): LocaleRenderer =>
  ({ request, locale }) => {
    ɵrememberPageOutcome(request, declaration);
    return new Response(`<!doctype html><html lang="${locale}">page</html>`, {
      headers: { 'content-type': 'text/html' },
    });
  };

/** The control: a render that declares nothing, which is every page that found what it wanted. */
const rendersPage: LocaleRenderer = ({ locale }) =>
  new Response(`<!doctype html><html lang="${locale}">page</html>`, {
    headers: { 'content-type': 'text/html' },
  });

const get = (handler: ReturnType<typeof handlerWith>, path: string) =>
  handler(new Request(`https://atlas.example${path}`));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the channel a declaration travels over', () => {
  it('carries nothing until the handler has opened it', () => {
    const request = new Request('https://atlas.example/en-us/second');

    // The distinction the whole diagnostic rests on. A render handed a request the handler is not
    // holding declares into nothing, and the response it produces is identical to the response of
    // a render that declared nothing at all.
    expect(ɵrememberPageOutcome(request, pageAbsent())).toBe(false);
    expect(ɵtakePageOutcome(request)).toBeUndefined();
  });

  it('carries a declaration made against the request the handler opened', () => {
    const request = new Request('https://atlas.example/en-us/second');
    ɵopenPageOutcomeChannel(request);

    expect(ɵrememberPageOutcome(request, pageGone())).toBe(true);
    expect(ɵtakePageOutcome(request)).toEqual({ outcome: 'gone' });
  });

  it('gives the declaration to one read and closes', () => {
    const request = new Request('https://atlas.example/en-us/second');
    ɵopenPageOutcomeChannel(request);
    ɵrememberPageOutcome(request, pageAbsent());

    expect(ɵtakePageOutcome(request)).toEqual({ outcome: 'absent' });
    // Section 5 gives a declaration the render that made it and nothing else, so a second read at
    // the same address finds nothing and a declaration cannot be answered twice.
    expect(ɵtakePageOutcome(request)).toBeUndefined();
  });

  it('refuses a status no response could carry', () => {
    // Refused where it is named rather than where the response is built, so the call that is wrong
    // is the call that fails.
    expect(() => pageOperationalFailure(0)).toThrow(RangeError);
    expect(() => pageOperationalFailure(600)).toThrow(RangeError);
    expect(pageOperationalFailure(503)).toEqual({
      outcome: 'operational-failure',
      status: 503,
    });
  });
});

describe('the response a declared outcome produces', () => {
  it('answers an absence with the status the table gives an absent entity', async () => {
    const response = await get(
      handlerWith(pageDeclares(pageAbsent())),
      '/en-us/second',
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('page');
  });

  it('answers a removal with the status the table gives a permanent removal', async () => {
    const response = await get(
      handlerWith(pageDeclares(pageGone())),
      '/en-us/second',
    );

    expect(response.status).toBe(410);
  });

  it('answers an operational failure with the status the application named', async () => {
    const response = await get(
      handlerWith(pageDeclares(pageOperationalFailure(503))),
      '/en-us/second',
    );

    expect(response.status).toBe(503);
  });

  it('leaves a render that declared nothing exactly as it was', async () => {
    const response = await get(handlerWith(rendersPage), '/en-us/second');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=600, must-revalidate',
    );
    expect(response.headers.get('x-robots-tag')).toBeNull();
  });

  it('keeps the locale the address resolved to', async () => {
    const response = await get(
      handlerWith(pageDeclares(pageAbsent())),
      '/ar-eg/second',
    );

    // The page is missing, not the language. A reader who asked in Arabic is told in Arabic.
    expect(response.headers.get('content-language')).toBe('ar-EG');
  });

  it('withdraws a missing page from indexing and from shared caches', async () => {
    const served = await get(handlerWith(rendersPage), '/en-us/second');
    const declared = await get(
      handlerWith(pageDeclares(pageAbsent())),
      '/en-us/second',
    );

    expect(served.headers.get('cache-control')).toBe(
      'public, max-age=600, must-revalidate',
    );
    expect(declared.headers.get('cache-control')).toBe('private, no-store');
    expect(declared.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('does not reach the next request to the same address', async () => {
    const handler = handlerWith(
      (() => {
        let first = true;
        return ({ request, locale }) => {
          if (first) {
            first = false;
            ɵrememberPageOutcome(request, pageAbsent());
          }
          return new Response(`<html lang="${locale}"></html>`, {
            headers: { 'content-type': 'text/html' },
          });
        };
      })(),
    );

    expect((await get(handler, '/en-us/second')).status).toBe(404);
    // A new request is a new key, and the entry the first one used was taken when it was read.
    expect((await get(handler, '/en-us/second')).status).toBe(200);
  });
});

describe('a declaration at an address Atlas did not serve', () => {
  it('leaves the refusal standing and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = handlerWith(pageDeclares(pageOperationalFailure(503)));

    // `/en-us/missing` resolves to `not-found`, which is Atlas's own answer about the address.
    // An application declaring maintenance does not know which addresses Atlas refused, so the
    // narrower rule holds and the refusal is what the reader gets.
    const first = await handler(
      new Request('https://atlas.example/en-us/missing'),
    );
    const second = await handler(
      new Request('https://atlas.example/en-us/other'),
    );

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('operational failure');
  });
});

describe('a renderer that states the outcome instead of the page', () => {
  it('declares an absence with a document of its own', async () => {
    const response = await get(
      handlerWith(() =>
        declarePageOutcome(
          pageAbsent(),
          new Response('<html>gone missing</html>', {
            headers: { 'content-type': 'text/html' },
          }),
        ),
      ),
      '/en-us/second',
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('gone missing');
  });

  it('declares an outcome with nothing to draw', async () => {
    const response = await get(
      handlerWith(() => declarePageOutcome(pageGone())),
      '/en-us/second',
    );

    expect(response.status).toBe(410);
    expect(await response.text()).toBe('');
  });

  it('replaces what the page declared from inside the render', async () => {
    const response = await get(
      handlerWith(({ request }) => {
        ɵrememberPageOutcome(request, pageAbsent());
        return declarePageOutcome(pageOperationalFailure(503));
      }),
      '/en-us/second',
    );

    // The renderer saw the render finish; the component in the middle of it did not.
    expect(response.status).toBe(503);
  });

  it('keeps the shape a renderer written before this existed already returns', () => {
    const declaration = declareOperationalFailure(
      new Response('maintenance', { status: 503 }),
    );

    expect(declaration.operationalFailure.status).toBe(503);
    expect(declaration.pageOutcome).toEqual({
      outcome: 'operational-failure',
      status: 503,
    });
  });
});

describe('the descriptor a declaration produces', () => {
  const resolved = routeHttpDescriptor({
    status: 'success',
    locale: 'ar-EG',
    direction: 'rtl',
    routeId: 'route:second',
    parameters: {},
    canonicalPath: 'second',
    query: [],
    indexing: 'indexable',
  });

  it('gives an absence the same classification the table gives a 404', () => {
    const declared = pageOutcomeHttpDescriptor(pageAbsent(), resolved);
    const resolvedMissing = routeHttpDescriptor({
      status: 'not-found',
      httpStatus: 404,
      presentationLocale: 'ar-EG',
    });

    // Asserted against the descriptor rather than restated, so a declared absence and a resolved
    // one cannot drift into two answers for one status.
    expect(declared.status).toBe(resolvedMissing.status);
    expect(declared.cache).toBe(resolvedMissing.cache);
    expect(declared.robots).toBe(resolvedMissing.robots);
    expect(declared.contentLanguage).toBe('ar-EG');
  });

  it('leaves the indexing of the address alone for an operational failure', () => {
    const declared = pageOutcomeHttpDescriptor(
      pageOperationalFailure(503),
      resolved,
    );

    // Section 12 lets a declaration narrow an indexing class and not widen one, and a failure
    // states nothing about whether the address should be indexed: it states that this render did
    // not produce the page.
    expect(declared.status).toBe(503);
    expect(declared.cache).toBe('private-no-store');
    expect(declared.robots).toBeUndefined();
  });
});
