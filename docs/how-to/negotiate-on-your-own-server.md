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

## Declare a status of your own

A rendered response carries the status Atlas resolved for its address. Serving maintenance, or
reporting a render that failed, is your application's answer about its own condition rather than
something about the address, so you state it. `declareOperationalFailure` wraps the response you
were going to return, and the wrapper is what makes the status a statement: a 500 nobody meant and
a 503 somebody chose arrive as the same number otherwise.

```ts src/app/maintenance.spec.ts
import { describe, expect, it } from 'vitest';

import {
  createLocaleRequestHandler,
  declareOperationalFailure,
} from '@neolorn/atlas/http';
import { localizationSetup } from '#i18n';

import { appRouteProjection, routePolicy } from './localization.routes';

const handler = createLocaleRequestHandler({
  policy: routePolicy,
  projection: appRouteProjection,
  configuration: localizationSetup.configuration,
  cache: { successMaxAge: 300, permanentRedirectMaxAge: 86_400 },
  cookie: false,
  render: () =>
    declareOperationalFailure(
      new Response('<!doctype html><html lang="en-US">Back shortly</html>', {
        status: 503,
        headers: { 'content-type': 'text/html', 'retry-after': '600' },
      }),
    ),
});

describe('a deployment serving maintenance', () => {
  it('answers 503 at an address it serves', async () => {
    const response = await handler(
      new Request('https://example.com/en-us/second'),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('600');
  });

  it('does not turn an address that does not exist into one', async () => {
    const response = await handler(
      new Request('https://example.com/en-us/no-such-page'),
    );

    expect(response.status).toBe(404);
  });

  it('is not left in a shared cache to outlive the outage', async () => {
    const response = await handler(
      new Request('https://example.com/en-us/second'),
    );

    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
```

The declaration travels at an address the handler serves. At one it answered from its own status
table, a 404 or a 410, that status stands and the declaration is reported once in development
naming both. You are declaring something about your application, and your application has no way to
know which addresses the handler refused; the rule that leaves those alone is the one you can write
against.

## Answer for a record that is not there

An address resolves before anything loads the record it names, so `/en-us/articles/anything` is a
route the handler serves and a page your application may not have. `declarePageOutcome` states which:
`pageAbsent()` for a record that does not exist, `pageGone()` for one taken down for good. Those two
carry the fact rather than a status, because the status for each is already fixed and restating it
would be writing out a rule the handler applies anyway.

```ts src/app/missing-record.spec.ts
import { describe, expect, it } from 'vitest';

import {
  createLocaleRequestHandler,
  declarePageOutcome,
} from '@neolorn/atlas/http';
import { pageAbsent, pageGone } from '@neolorn/atlas/core';
import { localizationSetup } from '#i18n';

import { appRouteProjection, routePolicy } from './localization.routes';

type RecordState = 'published' | 'missing' | 'retired';

const handlerFor = (state: RecordState) =>
  createLocaleRequestHandler({
    policy: routePolicy,
    projection: appRouteProjection,
    configuration: localizationSetup.configuration,
    cache: { successMaxAge: 300, permanentRedirectMaxAge: 86_400 },
    cookie: false,
    render: ({ locale }) => {
      if (state === 'missing') return declarePageOutcome(pageAbsent());
      if (state === 'retired') return declarePageOutcome(pageGone());
      return new Response(`<!doctype html><html lang="${locale}"></html>`, {
        headers: { 'content-type': 'text/html' },
      });
    },
  });

const statusAt = async (state: RecordState, path: string): Promise<number> =>
  (await handlerFor(state)(new Request(`https://example.com${path}`))).status;

describe('one address, and a record in three states', () => {
  it('answers the address the record is published at', async () => {
    expect(await statusAt('published', '/en-us/second')).toBe(200);
  });

  it('answers a missing record at the address it was asked for', async () => {
    expect(await statusAt('missing', '/en-us/second')).toBe(404);
  });

  it('tells a crawler to drop an address that is gone for good', async () => {
    expect(await statusAt('retired', '/en-us/second')).toBe(410);
  });

  it('leaves an address the handler never served alone', async () => {
    expect(await statusAt('retired', '/en-us/no-such-page')).toBe(404);
  });
});
```

A page can state the same three from inside an Angular render, through `LocalizedPageOutcome` in
`@neolorn/atlas/router`, which is
[How to tell crawlers your pages are translations](control-indexing.md). The declaration reaches the
handler over the request the two already share, so nothing is carried in a header a client could
write or a response could expose.

Rendering a route ahead of time is different. A prerendered page has no response to carry a
declaration to, and a file written from a render that declared an absence is served afterwards as a
successful page, so declaring one during a build fails the build instead. Render that route on
demand.

A response carrying a declaration is private and not stored, whatever the address is normally
classified as, so a content network does not hold your maintenance page under the page's own key
and keep serving it after you recover.

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
