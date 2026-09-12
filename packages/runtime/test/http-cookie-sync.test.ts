import { describe, expect, it } from 'vitest';

import { createLocaleRequestHandler } from '../http/src/handler.js';
import {
  type LocaleUrlPolicy,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

/**
 * 7.3, written before the handler that can violate it.
 *
 * These two behaviours are requirements on code that did not exist when they were written, which is
 * the whole reason they are written first: a requirement on absent code has nothing to regress
 * against, so it cannot be added later "once the shape is clear" without becoming a description of
 * whatever was built. Atlas has never emitted a `Set-Cookie` at all, because
 * `cookieStore().write` returns immediately outside a browser and says why: setting a cookie on
 * the server means owning
 * the response, and until this handler Atlas did not. Owning it is what makes both of these
 * possible to get wrong.
 *
 * Neither is invented here. next-intl writes the cookie only when the locale differs, and excludes
 * background requests with `Sec-Fetch-Dest`. The first keeps a `Set-Cookie` off responses that did
 * not need one, which matters because a response carrying one is a response a shared cache treats
 * differently. The second is the one with teeth: without it, a browser prefetching a link in
 * another language silently changes what the visitor gets next time, and the visitor never clicked
 * anything.
 */

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
  localizedPaths: {
    'route:second': { 'en-US': 'second', 'ar-EG': 'second' },
  },
};

const handler = createLocaleRequestHandler({
  policy: POLICY,
  projection: PROJECTION,
  cache: { successMaxAge: 600, permanentRedirectMaxAge: 86_400 },
  cookie: { name: 'atlas-locale' },
  render: ({ locale }) =>
    new Response(`<!doctype html><html lang="${locale}"></html>`, {
      headers: { 'content-type': 'text/html' },
    }),
});

const get = (path: string, headers: Record<string, string> = {}) =>
  handler(new Request(`https://atlas.example${path}`, { headers }));

describe('the cookie the handler writes', () => {
  it('writes nothing when the request already carries the locale it resolved to', async () => {
    // The visitor is on `/ar-eg` with `ar-EG` remembered. There is nothing to remember that is not
    // already remembered, and a `Set-Cookie` here is a header on a response that did not need one.
    const unchanged = await get('/ar-eg/second', {
      cookie: 'atlas-locale=ar-EG',
    });

    expect(unchanged.headers.get('set-cookie')).toBeNull();
  });

  it('writes when the visitor has moved to a locale the cookie does not name', async () => {
    // The control for the case above, so "writes nothing" is not passing for a handler that never
    // writes at all.
    const changed = await get('/en-us/second', {
      cookie: 'atlas-locale=ar-EG',
    });

    expect(changed.headers.get('set-cookie')).toMatch(
      /(^|;\s*)atlas-locale=en-US(;|$)/u,
    );
  });

  it('writes for a visitor who has no cookie yet', async () => {
    const first = await get('/ar-eg/second');

    expect(first.headers.get('set-cookie')).toMatch(
      /(^|;\s*)atlas-locale=ar-EG(;|$)/u,
    );
  });
});

describe('what a background request may change', () => {
  /**
   * The header is `Sec-Fetch-Dest`, not `Purpose`.
   *
   * `Purpose: prefetch` is the older Chrome convention and is not what browsers send for a
   * speculative navigation today. A guard written against `Purpose` alone looks right, passes a
   * test written against `Purpose`, and does nothing in a browser. `Sec-Fetch-Dest` is what
   * next-intl checks and what is actually sent, so it is what these assert.
   */
  it('does not let a prefetch change the stored preference', async () => {
    const prefetched = await get('/en-us/second', {
      cookie: 'atlas-locale=ar-EG',
      'sec-fetch-dest': 'empty',
    });

    expect(prefetched.headers.get('set-cookie')).toBeNull();
  });

  it('does not let a prerender or a subresource change it either', async () => {
    for (const destination of ['document', 'iframe', 'empty', 'script']) {
      const response = await get('/en-us/second', {
        cookie: 'atlas-locale=ar-EG',
        'sec-fetch-dest': destination,
        'sec-purpose': 'prefetch;prerender',
      });

      // `Sec-Purpose` names it a speculative load whatever the destination is.
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('still writes for a real navigation, which is the control', async () => {
    // Without this the guard above passes for a handler that stopped writing cookies entirely.
    const navigation = await get('/en-us/second', {
      cookie: 'atlas-locale=ar-EG',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
    });

    expect(navigation.headers.get('set-cookie')).toMatch(
      /(^|;\s*)atlas-locale=en-US(;|$)/u,
    );
  });
});
