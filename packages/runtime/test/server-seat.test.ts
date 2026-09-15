/**
 * The seat that answers an address, for the questions only a response can answer.
 *
 * Section 12 of `specs/06-runtime-and-angular.spec.md` puts a server seat in
 * `@neolorn/atlas/testing` and requires it to answer through the request handler a deployment uses
 * rather than through a second implementation of the same rules, without a socket, a built bundle
 * or a browser. What is asserted here is that it does: the status table, the cacheability, the
 * narrow rule about a declaration at a refused address, and the target arriving as written are all
 * the handler's, and the seat adds the reading.
 */

import { describe, expect, it } from 'vitest';

import {
  answeredHead,
  createLocalizedServerSeat,
} from '../testing/src/server-seat.js';
import {
  declarePageOutcome,
  type LocaleRequestHandlerOptions,
} from '../http/src/public-api.js';
import {
  pageAbsent,
  pageGone,
  pageOperationalFailure,
  ɵrememberPageOutcome,
  type LocaleUrlPolicy,
  type RouteRuntimeProjection,
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
    identity: 'sha256-AtlasServerSeatTestProjectionIdentity012345',
    routes: [
      { id: 'route:_index', path: '', parameterNames: [] },
      { id: 'route:second', path: 'second', parameterNames: [] },
    ],
  },
  localizedPaths: { 'route:second': { 'en-US': 'second', 'ar-EG': 'thani' } },
};

const CACHE = { successMaxAge: 600, permanentRedirectMaxAge: 86_400 } as const;

const documentFor = (locale: string): string =>
  `<!doctype html><html lang="${locale}" dir="ltr"><head>` +
  `<title>Ali &amp; Co</title>` +
  `<meta name="description" content="A page that says so">` +
  `<meta property="og:url" content="https://atlas.example/en-us/second">` +
  `<link rel="canonical" href="https://atlas.example/en-us/second">` +
  `<link rel="alternate" hreflang="ar-EG" href='https://atlas.example/ar-eg/thani'>` +
  `<link rel="alternate" hreflang="x-default" href="https://atlas.example/en-us/second">` +
  `</head><body></body></html>`;

const seatFor = (
  render: LocaleRequestHandlerOptions['render'] = ({ locale }) =>
    new Response(documentFor(locale), {
      headers: { 'content-type': 'text/html' },
    }),
) =>
  createLocalizedServerSeat({
    policy: POLICY,
    projection: PROJECTION,
    cache: CACHE,
    cookie: false,
    origin: 'https://atlas.example',
    render,
  });

describe('an address answered through the seat', () => {
  it('hands back the status, the headers and what the address resolved to', async () => {
    const answered = await seatFor().request('/en-us/second');

    expect(answered.status).toBe(200);
    expect(answered.headers.get('content-language')).toBe('en-US');
    expect(answered.headers.get('cache-control')).toBe(
      'public, max-age=600, must-revalidate',
    );
    expect(answered.resolution.status).toBe('success');
    expect(answered.locale).toBe('en-US');
    expect(answered.pageOutcome).toBeUndefined();
    expect(answered.declined).toBe(false);
  });

  it('answers an entry address with the redirect the table gives', async () => {
    // No renderer is called for a redirect, so `resolution` here is the half a test cannot reach
    // by wrapping the renderer: it is reported by the handler rather than observed from inside one.
    const answered = await seatFor().request('/second', {
      headers: { 'accept-language': 'ar-EG' },
    });

    expect(answered.status).toBe(307);
    expect(answered.headers.get('location')).toBe('/ar-eg/thani');
    expect(answered.resolution.status).toBe('redirect');
    expect(answered.body).toBe('');
  });

  it('refuses a structurally unsafe target rather than the address it repairs to', async () => {
    // The target travels as written. Built through `new Request(...)` it would arrive as
    // `/etc/passwd`, which resolves to no route and answers 404, and the traversal would be
    // reported as an ordinary missing page.
    const answered = await seatFor().request('/en-us/%2e%2e/%2e%2e/etc/passwd');

    expect(answered.status).toBe(400);
    expect(answered.resolution.status).toBe('malformed');
  });

  it('reports an address Atlas declined rather than answering for it', async () => {
    const answered = await seatFor().request('/assets/main-A1B2C3.js');

    expect(answered.declined).toBe(true);
    expect(answered.status).toBe(404);
  });

  it('asks an absolute address on its own origin', async () => {
    const answered = await seatFor().request(
      'https://atlas.example/ar-eg/thani',
    );

    expect(answered.status).toBe(200);
    expect(answered.headers.get('content-language')).toBe('ar-EG');
  });
});

describe('a page outcome declared behind the seat', () => {
  it('is carried at an address that resolved to a route', async () => {
    const answered = await seatFor(() =>
      declarePageOutcome(pageAbsent()),
    ).request('/en-us/second');

    expect(answered.status).toBe(404);
    expect(answered.pageOutcome?.declared.outcome).toBe('absent');
    expect(answered.pageOutcome?.carried).toBe(true);
    expect(answered.headers.get('cache-control')).toBe('private, no-store');
  });

  it('is observable when the page declared it rather than the renderer', async () => {
    // What `LocalizedPageOutcome.declare` does from inside an Angular render, which is the arm the
    // renderer's own return says nothing about. Section 5 carries it over a channel no response
    // exposes, so the seat is the only place outside the release that can see it was carried.
    const answered = await seatFor(({ request, locale }) => {
      ɵrememberPageOutcome(request, pageOperationalFailure(503));
      return new Response(documentFor(locale), {
        headers: { 'content-type': 'text/html' },
      });
    }).request('/en-us/second');

    expect(answered.status).toBe(503);
    expect(answered.pageOutcome?.declared).toEqual({
      outcome: 'operational-failure',
      status: 503,
    });
    expect(answered.pageOutcome?.carried).toBe(true);
  });

  it('is reported as not carried at an address the handler refused', async () => {
    // Both answers are 404 and the response cannot tell them apart, which is the reason the seat
    // reports the declaration and whether it stood.
    const answered = await seatFor(() =>
      declarePageOutcome(pageGone()),
    ).request('/en-us/no-such-page');

    expect(answered.status).toBe(404);
    expect(answered.pageOutcome?.declared.outcome).toBe('gone');
    expect(answered.pageOutcome?.carried).toBe(false);
  });
});

describe('the head of an answered document', () => {
  it('reads the title, the description, the canonical and the cluster', async () => {
    const answered = await seatFor().request('/en-us/second');
    const { head } = answered;

    expect(head.title).toBe('Ali & Co');
    expect(head.lang).toBe('en-US');
    expect(head.dir).toBe('ltr');
    expect(head.description).toBe('A page that says so');
    expect(head.canonical).toBe('https://atlas.example/en-us/second');
    expect(head.properties['og:url']).toBe(head.canonical);
    expect(head.alternates.map((link) => link.hreflang)).toEqual([
      'ar-EG',
      'x-default',
    ]);
    expect(head.links.filter((link) => link.rel === 'canonical')).toHaveLength(
      1,
    );
  });

  it('does not read markup written inside a script, a style or a comment', () => {
    const head = answeredHead(
      `<html><head><link rel="canonical" href="/real">` +
        `<script type="application/ld+json">{"a":"<link rel=\\"canonical\\" href=\\"/script\\">"}</script>` +
        `<style>/* <link rel="canonical" href="/style"> */</style>` +
        `<!-- <link rel="canonical" href="/comment"> -->` +
        `</head></html>`,
    );

    expect(head.links.map((link) => link.href)).toEqual(['/real']);
  });

  it('decodes the character references a serializer writes', () => {
    const head = answeredHead(
      `<head><title>5 &lt; 6 &amp; &#65; &#x42;</title>` +
        `<meta name="description" content="&quot;quoted&quot;"></head>`,
    );

    expect(head.title).toBe('5 < 6 & A B');
    expect(head.description).toBe('"quoted"');
  });

  it('answers with nothing rather than guessing where a head has none of it', () => {
    const head = answeredHead('<html><head></head><body>text</body></html>');

    expect(head.title).toBeUndefined();
    expect(head.canonical).toBeUndefined();
    expect(head.alternates).toEqual([]);
  });
});
