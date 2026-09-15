# How to tell crawlers your pages are translations

A localized site has to state that its pages are translations of each other rather than duplicates.
With `withRouting` composed, the head carries that already, and route data decides which pages are
listed at all.

## Before you begin

Compose `withRouting`, which is [How to localize your routes](localize-routes.md).

## What the head carries

Every localized page carries a canonical link for itself and an `hreflang` link for each locale it
exists in. You write nothing per page.

An `x-default` is published alongside them when the projection carries one, which tells a crawler
where a visitor whose language you do not serve should land.

## Localize the title

A route's title is a message handle, so the title changes with the locale in the same transition as
everything else on the page.

A title whose sentence takes a value carries the value beside it, bound with `documentMessage`:

```text
provideLocalizedRouter(routes, {
  documentMetadata: {
    'route:article': {
      title: documentMessage(messages.document.article.title, { section: 'Guides' }),
    },
  },
}),
```

A title with nothing in it that varies stays the bare handle. A handle naming a message that takes
values, with none bound to it, is refused when the router is provided: resolved as it stands, that
title reaches the tab and the search result with its placeholders unfilled.

## Keep a page out of the index

Classify the route in its own `data`:

```text
export const routes: Routes = [
  { path: '', pathMatch: 'full', component: Home },
  { path: 'second', component: Second, data: { atlasIndexing: 'internal' } },
];
```

Then name the field and state what each of its values means:

```text
withRouting({
  policy: routePolicy,
  projection: appRouteProjection,
  indexing: {
    field: DEFAULT_ROUTE_INDEXING_FIELD,
    values: { internal: 'non-indexable', account: 'private' },
  },
}),
```

`DEFAULT_ROUTE_INDEXING_FIELD` is `atlasIndexing`. A project that already classifies its routes names
the field it already has. Only the exceptions need naming: a route whose field is absent, or whose
value the table does not list, is indexable.

Both blocks are read from your source text at generate time, which is why this is a field name and a
table of literals rather than a predicate.

The indexing field is read by both the page metadata and the sitemap, so a route is classified in one
place.

## Withdraw a page that turned out not to be there

An address resolves before anything loads the record it names. Whether the article exists, whether it
was taken down for good, and whether the load itself failed are three answers only the page has, so
the page states them. Inject `LocalizedPageOutcome` and declare one of `pageAbsent()`, `pageGone()`
or `pageOperationalFailure(status)`:

```text
export class ArticleRoute {
  private readonly outcome = inject(LocalizedPageOutcome);

  constructor() {
    void this.articles.load(this.slug).then((article) => {
      if (article === undefined) this.outcome.declare(pageAbsent());
    });
  }
}
```

Declaring after the page is on screen is the ordinary case, because the load finishes after
activation. Atlas rebuilds the head when the declaration arrives.

What it withdraws is what the address implied. A page declared absent or removed publishes no
canonical link and no `hreflang` alternates, and carries `noindex`: an alternate link states that the
same page exists in another language, so leaving one on a page that is not there makes that claim in
every language at once. A declared operational failure withdraws none of it. It says this render did
not produce the page, which is about one response rather than about the address.

On a server the declaration also reaches the response, which is
[How to negotiate a locale on your own server](negotiate-on-your-own-server.md). In the browser there
is no response to reach and Atlas invents none.

What the page is called while it is missing is yours. Read `context.pageOutcome` in the `document`
callback and return the wording for it.

## Name the pages that reach no route

Three answers a visitor can get have no route to look a title up by: an address you do not serve, one
whose entity your route table declares permanently removed, and one naming a locale you do not
support. Declare a document for each, keyed by what happened:

```text
provideLocalizedRouter(routes, {
  outcomeDocuments: {
    'not-found': {
      title: messages.document.notFound.title,
      description: messages.document.notFound.description,
    },
    gone: { title: messages.document.gone.title },
    'unsupported-locale': { title: messages.document.unsupportedLocale.title },
  },
}),
```

Without them the head of a missing page is whatever the previous page left in it, title and
description and canonical link together, which tells a reader and a crawler they are somewhere they
are not. They are message handles like every other title, so a missing translation is reported by
`atlas check --require-complete` rather than serving one language's wording under another's.

## Set cache headers per route

`routeCacheHeaders` takes the classification Atlas derived for a resolved route and the freshness
numbers this deployment chose, and returns the headers to write:

```ts src/app/caching.spec.ts
import { describe, expect, it } from 'vitest';

import { routeCacheHeaders } from '@neolorn/atlas';
import type { RouteCacheFreshness, RouteHttpDescriptor } from '@neolorn/atlas';

// How long this deployment's shared caches hold a response Atlas has said may be shared, and where
// this deployment reads a visitor's language preference.
const freshness: RouteCacheFreshness = {
  successMaxAge: 300,
  permanentRedirectMaxAge: 86_400,
  localePreference: 'accept-language',
};

function headersFor(descriptor: RouteHttpDescriptor): Record<string, string> {
  const written: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    routeCacheHeaders(descriptor, freshness),
  )) {
    if (value !== undefined) written[name] = value;
  }
  return written;
}

describe('the headers a route class implies', () => {
  it('lets a shared cache hold one variant per language', () => {
    const headers = headersFor({
      status: 200,
      cache: 'varies-by-locale-preference',
    });

    expect(headers['cache-control']).toBe(
      'public, max-age=300, must-revalidate',
    );
    expect(headers['vary']).toBe('Accept-Language');
  });

  it('keeps a private response out of a shared cache', () => {
    const headers = headersFor({ status: 200, cache: 'private-no-store' });

    expect(headers['cache-control']).toBe('private, no-store');
    expect(headers['vary']).toBeUndefined();
  });

  it('holds a permanent correction for as long as this deployment said', () => {
    const headers = headersFor({
      status: 308,
      location: '/en-us/second',
      cache: 'consumer-defined-permanent',
    });

    expect(headers['cache-control']).toBe('public, max-age=86400');
  });
});
```

`routeHttpDescriptor` produces the descriptor from a resolved route, and the handler in
`@neolorn/atlas/http` calls both for you, which is
[How to negotiate a locale on your own server](negotiate-on-your-own-server.md).

`localePreference` is the one fact Atlas cannot derive, because it never sees the request. Reading
the preference from `Accept-Language` leaves a successful response shared-cacheable per language, and
`Vary: Accept-Language` says so. Reading it from a cookie does not, and the answer is
`private, no-store`.

The result is a map by header name rather than one string, so a consumer writes the set with one loop
and gains a header a later release adds without changing a line.

## Related

- [How to publish a sitemap](publish-a-sitemap.md)
- [How to localize your routes](localize-routes.md)
- [About how routing derives addresses](../explanation/about-addresses.md)
