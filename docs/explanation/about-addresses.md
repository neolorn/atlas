# About how routing derives addresses

A localized address and an Angular route are two different things. The route is what your application
matches on; the address is what a visitor sees and shares. Atlas derives the second from the first
and one policy, and everything a crawler reads comes out of the same derivation.

## One projection, three consumers

The route projection states which routes have localized addresses. The head's canonical and
`hreflang` links, the sitemap's entries, and the addresses a switcher puts on its options are all
computed from it.

All three are derived from that one source, so they cannot disagree. Three lists maintained
separately would agree until one of them was edited.

The projection starts from the generated one, so a route added later is covered without a second list
to maintain, and per-locale route and parameter spellings live beside it.

## Writing a link as a route

A link spelled `/ar-eg/second` stops being true the moment the visitor switches. Worse, clicking it
does not do what it says: the Router receives the address as written, the locale prefix is resolved
away before anything matches, and the page renders in whichever locale is committed rather than the
one the link named.

Writing the route and letting the policy spell the address is the only form that stays correct
through a switch.

## What each policy costs

A locale prefix in the path is one origin, one deployment, one certificate, and an address a person
can read. It is the default choice.

The same policy can spell the default locale with its prefix or without it. Without it, the default
locale is one page at one address. With it, every locale looks the same, which is easier to reason
about and gives the source language an address of its own.

A domain per locale serves each language from its own host. It fits a deployment where each language
has its own content and its own analytics, and it costs what separate origins cost: application state
does not cross them, so a locale change becomes a redirect rather than a transition, and each build
answers at one origin.

A single address space puts the locale nowhere and leaves every page at one address in whatever
locale was negotiated. It fits pages behind a sign-in that are never shared or indexed. A crawler has
nothing to distinguish translations by, which is the cost of the policy.

## Addresses that belong to no locale

`localeNeutralRoots` keeps a path root at one address in every locale, for a sign-in callback, a
webhook receiver, or anything a third party has already recorded the address of. Aliases cover the
legacy spellings, canonicalized with permanent redirects so the old address keeps working and the new
one is the one that gets indexed.

## Metadata claims

`loc` and the alternates are computed, because they follow from the projection. `changefreq`,
`priority`, `lastmod` and indexability are claims about content that only the application can make,
so they are read from a field on the Angular route's own `data` at generate time.

Atlas never runs your code to find them. That is why the declaration is a field name and a table of
literals rather than a function: `generate` reads source text.

Atlas emits `lastmod` only from a value a route declares. A build time is a date the page did not
change on, and a search engine reads that element only when it can verify it.

## Related

- [How to localize your routes](../how-to/localize-routes.md)
- [How to publish a sitemap](../how-to/publish-a-sitemap.md)
- [How to tell crawlers your pages are translations](../how-to/control-indexing.md)
- [About how a locale is resolved](about-locale-resolution.md)
