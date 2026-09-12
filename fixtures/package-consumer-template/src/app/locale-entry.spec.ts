import { describe, expect, it } from 'vitest';

import { resolveLocalizedRoute, routeHttpDescriptor } from '@neolorn/atlas';

import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * The one place a path-prefix policy has to decide a locale for itself.
 *
 * Under `/en-us` and `/ar-eg` prefixes the URL says which locale it wants, and Atlas obeys it. The
 * exception is a URL with no prefix: `/`, or a link someone typed without one. That request states
 * no locale, so something has to choose, and `resolveLocalizedRoute` already accepted a resolution
 * context for exactly that purpose.
 *
 * It then dropped it. `resolveLocalizedRoute` passed the context to the locale-neutral branch and
 * not to the prefix branch, so a request resolved to `ar-EG` produced the byte-identical redirect
 * to `/en-us` as a request that resolved to nothing at all. Every visitor landed in English and
 * then had to switch by hand.
 *
 * The second half is cacheability, which follows from the first. The redirect was marked
 * `private, no-store` while carrying an answer that was the same for everybody, a wasted round
 * trip per visitor. Now the directive states what actually happened: constant answers are public,
 * and an answer that consulted this request's preference is this request's alone.
 */

describe('a URL that states no locale', () => {
  it('sends the visitor to the locale the request resolved to', () => {
    expect(
      resolveLocalizedRoute('/', routePolicy, appRouteProjection, {
        locale: 'ar-EG',
      }),
    ).toEqual({
      status: 'redirect',
      reason: 'locale-entry',
      httpStatus: 307,
      cache: 'private-no-store',
      locale: 'ar-EG',
      routeId: 'route:_index',
      location: '/ar-eg',
    });
  });

  it('builds the destination in that locale, not merely under its prefix', () => {
    // The article slug is locale-specific: `atlas-handbook` in English, `دليل-أطلس` in Arabic.
    // Prefixing the English segments would produce `/ar-eg/articles/atlas-handbook`, which is not
    // that route's Arabic URL, so the visitor would arrive and be redirected a second time, or land
    // on a 404. The destination has to be built in the destination's own locale.
    const resolution = resolveLocalizedRoute(
      '/articles/atlas-handbook',
      routePolicy,
      appRouteProjection,
      { locale: 'ar-EG' },
    );

    expect(resolution).toMatchObject({
      status: 'redirect',
      reason: 'locale-entry',
      locale: 'ar-EG',
      routeId: 'article',
    });
    if (resolution.status !== 'redirect') return;
    expect(resolution.location).toBe(
      `/ar-eg/articles/${encodeURIComponent('دليل-أطلس')}`,
    );
  });

  it('keeps query and fragment across the redirect', () => {
    const resolution = resolveLocalizedRoute(
      '/second?tab=one#details',
      routePolicy,
      appRouteProjection,
      { locale: 'ar-EG' },
    );

    if (resolution.status !== 'redirect')
      throw new Error('expected a redirect');
    expect(resolution.location).toBe('/ar-eg/second?tab=one#details');
  });

  it('falls back to the default locale when the preference is not supported', () => {
    // A preference is not a request. The URL `/` is perfectly valid, and answering 404 for a
    // site's home page because somebody's language tag was unusable is the worse failure by a
    // wide margin; the locale-neutral policy 404s here because there the tag *is* the request.
    const resolution = resolveLocalizedRoute(
      '/',
      routePolicy,
      appRouteProjection,
      {
        locale: 'xx-ZZ',
      },
    );

    expect(resolution).toMatchObject({
      status: 'redirect',
      locale: 'en-US',
      location: '/en-us',
    });
  });
});

describe('a URL that states its locale', () => {
  it('ignores the preference entirely', () => {
    // The prefix is the visitor's stated intent: a shared link, a bookmark, a search result. A
    // preference must never override it, or nobody can send anybody a link.
    expect(
      resolveLocalizedRoute('/en-us/second', routePolicy, appRouteProjection, {
        locale: 'ar-EG',
      }),
    ).toMatchObject({
      status: 'success',
      locale: 'en-US',
      routeId: 'route:second',
    });
  });
});

describe('what the redirect may be cached as', () => {
  /**
   * One address, two answers, one cache key.
   *
   * `/` states no locale. Which locale it sends a visitor to depends on a preference the cache
   * cannot see, and a cache key is the target URI unless the stored response names a varying
   * header. So the answer a preference produced and the answer it did not are one entry as far as
   * any shared cache is concerned. Marking either of them public authorises handing one visitor's
   * language to the next; marking only the other one private prevents nothing, because that request
   * is answered from the cache and never reaches this function.
   *
   * `Vary` is not the way out. Atlas is never given the request, the host reads the preference
   * and passes a locale in, so Atlas cannot name the header that varied. For a cookie-borne
   * preference `private` is the right answer regardless.
   *
   * These pinned the opposite until 6.1, on the argument that a redirect that consulted nothing is
   * the same answer for every visitor. It is. That was never the question: it shares an address
   * with the redirects that are not.
   */
  it('is never publicly cacheable, with or without a preference', () => {
    expect(
      resolveLocalizedRoute('/', routePolicy, appRouteProjection),
    ).toMatchObject({ cache: 'private-no-store', locale: 'en-US' });

    // Including the case that looks safest: `en-US` in, `en-US` out, an answer byte-identical to
    // the one above, and still not one a shared cache may hand to somebody else.
    expect(
      resolveLocalizedRoute('/', routePolicy, appRouteProjection, {
        locale: 'en-US',
      }),
    ).toMatchObject({ cache: 'private-no-store', locale: 'en-US' });
  });

  it('carries the directive through to the HTTP descriptor', () => {
    const constant = resolveLocalizedRoute(
      '/',
      routePolicy,
      appRouteProjection,
    );
    const negotiated = resolveLocalizedRoute(
      '/',
      routePolicy,
      appRouteProjection,
      { locale: 'ar-EG' },
    );

    expect(routeHttpDescriptor(constant)).toMatchObject({
      status: 307,
      location: '/en-us',
      cache: 'private-no-store',
    });
    expect(routeHttpDescriptor(negotiated)).toMatchObject({
      status: 307,
      location: '/ar-eg',
      cache: 'private-no-store',
    });

    // The control, so this pins locale entry rather than the descriptor being private about
    // everything. A canonical correction is the same answer for every request that reaches it
    // (the address is what is wrong, and no preference can change that) so it stays cacheable, and
    // for as long as the deployment says.
    expect(
      routeHttpDescriptor(
        resolveLocalizedRoute('/EN-US/second', routePolicy, appRouteProjection),
      ),
    ).toMatchObject({ status: 308, cache: 'consumer-defined-permanent' });
  });

  /**
   * Every case above uses an address this application serves, which is what hides the defect.
   *
   * Locale entry offered only when the unprefixed path matches a route leaves an address with no
   * locale and no page answering not-found where it stands. Under a prefix policy nothing is
   * mounted there: the outlet renders empty, the document takes no title, and the response claims
   * success. A visitor following an ordinary unprefixed link, which is what a hand-written `href`
   * produces, gets a blank page rather than a not-found page.
   *
   * Whether to send an address to a locale depends on the address having no locale. Whether a page
   * exists is the localized address's question, asked after arrival.
   */
  it('sends an address with no page to a locale, so a localized 404 can answer', () => {
    const anonymous = resolveLocalizedRoute(
      '/nothing-is-mounted-here',
      routePolicy,
      appRouteProjection,
    );

    expect(anonymous).toEqual({
      status: 'redirect',
      reason: 'locale-entry',
      httpStatus: 307,
      cache: 'private-no-store',
      locale: 'en-US',
      location: '/en-us/nothing-is-mounted-here',
    });

    // And to the locale the request resolved to, exactly as a known address would.
    expect(
      resolveLocalizedRoute(
        '/nothing-is-mounted-here',
        routePolicy,
        appRouteProjection,
        { locale: 'ar-EG' },
      ),
    ).toMatchObject({
      status: 'redirect',
      locale: 'ar-EG',
      cache: 'private-no-store',
      location: '/ar-eg/nothing-is-mounted-here',
    });
  });

  it('leaves a prefixed address that has no page to answer as a not-found', () => {
    // The counterpart. Once the address states its locale there is nothing left to decide, so it
    // is answered where it stands rather than redirected again.
    expect(
      resolveLocalizedRoute(
        '/ar-eg/nothing-is-mounted-here',
        routePolicy,
        appRouteProjection,
      ),
    ).toMatchObject({
      status: 'not-found',
      httpStatus: 404,
      presentationLocale: 'ar-EG',
    });
  });
});
