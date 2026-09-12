# How to publish a sitemap

`projectSitemap` builds the sitemap files from the projection your routes already use. Serving them
is yours, and so is the `Sitemap:` line in `robots.txt` that points at them.

## Before you begin

Compose `withRouting`, which is [How to localize your routes](localize-routes.md).

## Build the files

`projectSitemap` needs what the head needs, plus the origin the site is published at and which routes
become which pages. The second is your render table's own list: a parameterized route needs its
parameter values enumerated, and those values are already written there.

```ts src/app/sitemap.spec.ts
import { describe, expect, it } from 'vitest';

import { projectSitemap } from '@neolorn/atlas/core';
import { configuration } from '#i18n';

import { appRouteProjection, routePolicy } from './localization.routes';

const SITE_ORIGIN = 'https://example.com';

// The set your server answers from. It does not vary by request, so it is built once.
const sitemapFiles = new Map(
  projectSitemap({
    policy: routePolicy,
    projection: appRouteProjection,
    configuration,
    origin: SITE_ORIGIN,
    routes: [{ routeId: 'route:_index' }],
  }).map((file) => [`/${file.name}`, file.contents]),
);

describe('the sitemap', () => {
  it('is one file at the address a crawler is given', () => {
    expect([...sitemapFiles.keys()]).toEqual(['/sitemap.xml']);
  });

  it('publishes the index page at its address in every locale', () => {
    const xml = sitemapFiles.get('/sitemap.xml') ?? '';

    expect(xml).toContain(`${SITE_ORIGIN}/en-us`);
    expect(xml).toContain(`${SITE_ORIGIN}/ar-eg`);
  });

  it('carries an alternate for every locale the page exists in', () => {
    const xml = sitemapFiles.get('/sitemap.xml') ?? '';

    expect(xml).toContain('hreflang="en-US"');
    expect(xml).toContain('hreflang="ar-EG"');
  });
});
```

Build the set once. What it lists is what this build generated, which is settled before the first
request arrives. Give it the origin your router is configured with rather than the request's host, so
the addresses in the file and the addresses in every page's head are one set.

Atlas returns the files rather than writing them. An address is composed from six values:

- the locale URL policy;
- the route projection;
- the parameter codecs;
- the parameter values that turn a parameterized route into pages;
- the origin this build answers at;
- the mount point it is served under.

Every one of those is a value your application holds when it runs, and `atlas generate` reads source
text.

## Serve the files

Past 50,000 URLs or 50 MB the set splits, and the name you gave stays the address a crawler was
given: that file becomes the index and the pages move into `sitemap-1.xml` and its siblings. Both
limits come from [the sitemap protocol](https://www.sitemaps.org/protocol.html), and bytes are
counted because a site of long addresses reaches the size before it reaches the count.

Publish every file in the returned list and point `robots.txt` at the first.

## Declare what a page claims about itself

`loc` and the alternates are computed. `changefreq`, `priority` and `lastmod` are claims about
content, so a route makes them through its own data:

```text
withRouting({
  policy: routePolicy,
  projection: appRouteProjection,
  sitemap: {
    field: 'section',
    values: {
      landing: { changefreq: 'daily', priority: 1 },
      reference: { changefreq: 'monthly', priority: 0.5 },
    },
    lastmodField: 'updated',
  },
}),
```

`field` names a field on the Angular route's own `data`, and `values` states what each of its values
claims. It is a field name and a table of literals because this is read from your source text at
generate time, and Atlas never runs your code to find out. A route whose class the table does not
list claims nothing, and an entry with an address and its alternates is already complete.

`lastmodField` names a second data field carrying a W3C date. Atlas emits it only from a value a
route declares. A build time is a date the page did not change on, and a search engine reads that
element only when it can verify it.

A value the protocol would reject reports `ATL1412` at generate time rather than being dropped: a
`changefreq` outside the seven it lists, a `priority` that is not a number between 0 and 1, or a
`lastmod` that is not a date.

## Under a policy that puts the locale in the origin

The sitemap protocol allows one host per file, so each build calls `projectSitemap` once for its own
origin and the alternates keep pointing at the others. That is
[How to render on the server](render-on-the-server.md), where one build answers at one origin.

## Related

- [How to tell crawlers your pages are translations](control-indexing.md)
- [About how routing derives addresses](../explanation/about-addresses.md)
