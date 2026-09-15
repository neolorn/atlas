# How to render on the server

Resolve the locale before anything renders, so the first response is in the visitor's language and
hydration claims that HTML rather than rewriting it.

## Before you begin

`@neolorn/atlas/ssr` is a separate entry point with `@angular/ssr` as an optional peer. A
browser-only application installs neither the peer nor this code.

## Compose the server providers

```text
providers: [provideLocalizedServerRendering()],
```

It goes in your server configuration, beside Angular's own server providers. It adds the per-request
work: negotiating the locale for the request, preparing the scopes that request needs, and making
the result available to the render.

The localization a request renders under is scoped to that request, so two concurrent renders never
share a committed locale. Catalogs are admitted once per process rather than once per request:
verifying a catalog does not depend on who asked for it.

## Know which locale the HTML was written in

`renderedLocale()` returns the locale the server-rendered document was written in, and the runtime
reads it to decide whether hydration claims that HTML or builds it fresh. What a locale mismatch does
to hydrated content is
[About how a locale switch is a transaction](../explanation/about-locale-switching.md).

## Prerender

Prerendering writes the pages ahead of time, one per address, which under a localized URL policy
means one per route per locale. The addresses come from the projection the head and the sitemap use,
so what is prerendered and what is advertised are one list.

A prerendered page has no request and therefore no negotiation. Its locale is the one its address
states, which is why a locale that appears nowhere in your addresses cannot be prerendered
separately.

A parameterised route says which pages to write through `prerender`. Write the values where the
table is, or give a function the build calls for them:

```text
{
  routeId: 'article',
  renderMode: RenderMode.Prerender,
  prerender: async () =>
    (await articles.published()).map((article) => ({ slug: article.id })),
}
```

Both forms are serialized per locale through the route's codecs, so one entry writes
`/en-us/articles/atlas-handbook` and `/ar-eg/articles/دليل-أطلس`. The function is called once for
the route rather than once per locale, and a value with no spelling in some locale fails the build
rather than being left out of that language.

## Serve a domain per locale

Under a policy that puts the locale in the origin, `provideLocalizedRouter(routes, { origin })` names
which origin this build is. It must be one of the policy's own, and the build prerenders that
origin's locale only. The head still advertises the others. Serving several domains means a build per
domain.

That policy also needs the server told the same list of domains. `@angular/ssr` answers a `Host`
header it does not recognize with `400`, before your application runs, and it recognizes loopback and
nothing else by default. `allowedLocaleHosts(routePolicy)` derives the list, so `allowedHosts` is the
policy rather than a second copy of it. It returns an empty list for the policies that serve one
origin, so the line is the same whichever policy you end up with.

## Related

- [How to negotiate a locale on your own server](negotiate-on-your-own-server.md)
- [How to publish a sitemap](publish-a-sitemap.md)
- [About how routing derives addresses](../explanation/about-addresses.md)
- [About how a locale switch is a transaction](../explanation/about-locale-switching.md)
