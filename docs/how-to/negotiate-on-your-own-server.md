# How to negotiate a locale on your own server

`@neolorn/atlas/http` answers one question for a process that is not an Angular server: which locale
this request is in. A request goes in, a locale comes out.

## Before you begin

Angular's server rendering already negotiates per request, which is
[How to render on the server](render-on-the-server.md). Reach for this entry point when the process
handling the request is a plain Node server, a worker, or an edge function.

## Call the handler

`createLocaleRequestHandler` takes the same policy and projection the application composed, the
locale set from your generated configuration, and the freshness numbers this deployment chose. It
returns a function from a `Request` to a `Response`.

```ts src/app/negotiation.spec.ts
import { describe, expect, it } from 'vitest';

import { createLocaleRequestHandler } from '@neolorn/atlas/http';
import { localizationSetup } from '#i18n';

import { appRouteProjection, routePolicy } from './localization.routes';

const handler = createLocaleRequestHandler({
  policy: routePolicy,
  projection: appRouteProjection,
  // The build's own locale set, so a policy naming a locale this build did not generate
  // publishes no address for it.
  configuration: localizationSetup.configuration,
  cache: { successMaxAge: 300, permanentRedirectMaxAge: 86_400 },
  // This deployment reads no cookie, which is what leaves a response shared-cacheable per
  // language. Reading one is a value here rather than an omission.
  cookie: false,
  render: ({ locale }) =>
    new Response(`<!doctype html><html lang="${locale}"></html>`, {
      headers: { 'content-type': 'text/html' },
    }),
});

const get = (path: string, headers: Record<string, string> = {}) =>
  handler(new Request(`https://example.com${path}`, { headers }));

describe('the request handler', () => {
  it('sends an entry address to the language the visitor asked for', async () => {
    const response = await get('/second', {
      'accept-language': 'ar-EG,en;q=0.8',
    });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/ar-eg/second');
  });

  it('serves a localized address as it stands', async () => {
    const response = await get('/en-us/second');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-language')).toBe('en-US');
  });

  it('answers with a locale this build generated, and no other', async () => {
    const response = await get('/second', { 'accept-language': 'fr-FR' });

    expect(response.headers.get('location')).toBe('/en-us/second');
  });

  it('states what a shared cache may do with each answer', async () => {
    const localized = await get('/en-us/second');
    const entry = await get('/second', { 'accept-language': 'ar-EG' });

    expect(localized.headers.get('cache-control')).toBe(
      'public, max-age=300, must-revalidate',
    );
    // The address a visitor was sent to was chosen for that visitor, so it is not one a shared
    // cache may hand to the next.
    expect(entry.headers.get('cache-control')).toBe('private, no-store');
  });
});
```

The locale it answers with is one you declared. The negotiation is the lookup the application
performs and its answer is drawn from the set you compiled, so a language you do not serve resolves
to one you do.

It also writes what a shared cache may do with each answer, from the same classification
`routeCacheHeaders` publishes, which is
[How to tell crawlers your pages are translations](control-indexing.md).

`toNodeListener`, `toWebRequest` and `writeNodeResponse` adapt between Node's request and response
objects and the web ones, for a server that speaks the former.

## Where it is used

A redirect at the edge, sending a visitor who asked for `/` to the address for the language they
asked for, before any application runs.

An API that returns localized text and has to answer in the caller's language without rendering a
page.

A cache key. A response that varies by language has to say so, and the negotiated locale is the value
to key on and to name in `Vary`.

## Limits on the handler

It renders nothing of its own and loads no catalogs. It holds no state between requests, so two
requests are two negotiations, which is what makes it safe in a process handling many at once.

## Parse a header yourself

`parseAcceptLanguage` is exported from the main entry point for the cases where you want the ranges
and their weights rather than a decision. `negotiateLocale` is the decision, and it is what the
handler calls.

Prefer the handler. The header is a list of ranges with weights, the lookup is
[RFC 4647](https://www.rfc-editor.org/rfc/rfc4647)'s, and the step that answers a range no truncation
matched is what keeps a browser sending `no` from landing on your default instead of the Norwegian
you ship. That step is
[About how a locale is resolved](../explanation/about-locale-resolution.md).

## Related

- [How to render on the server](render-on-the-server.md)
- [How to tell crawlers your pages are translations](control-indexing.md)
- [About how a locale is resolved](../explanation/about-locale-resolution.md)
