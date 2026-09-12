# How to localize your routes

Give every page an address in every locale you serve, and make that address resolve back to the same
route. Your Angular routes are unchanged.

## Before you begin

Run `atlas generate` at least once, so `#i18n/routes` exists.

## Declare a policy and a projection

Create `src/app/localization.routes.ts` with two exports:

```ts excerpt src/app/localization.routes.ts
export const routePolicy = createPathPrefixLocalePolicy({
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
});

export const appRouteProjection = defineRouteProjection({
  generated: routeProjection,
});
```

The policy states how a locale appears in a URL. The projection states which routes have localized
addresses, and it starts from the generated one, so a route you add later is covered without a second
list.

## Compose them

Add both to `provideLocalization`, and replace `provideRouter` with `provideLocalizedRouter`:

```ts excerpt src/app/app.config.ts
    provideLocalizedRouter(routes),
    provideLocalization(
      withRouting({ policy: routePolicy, projection: appRouteProjection }),
```

## Write links as routes

Write the route. The locale is resolved:

```ts excerpt src/app/app.routes.ts
    <a routerLink="second">{{ messages.openSecond | localize }}</a>
```

A link spelled `/ar-eg/second` stops being true the moment the visitor switches, and the Router
receives the address as written: the prefix is resolved away before anything matches, so the page
renders in whichever locale is committed rather than the one the link named.

## Choose a policy

Four creators, all exported from `@neolorn/atlas`:

| Creator                           | Puts the locale                   | Fits a deployment where                     |
| --------------------------------- | --------------------------------- | ------------------------------------------- |
| `createPathPrefixLocalePolicy`    | In the first path segment         | one origin serves every locale              |
| `createDefaultLocalePrefixPolicy` | In the first path segment, always | every locale is prefixed, the default too   |
| `createHostLocalePolicy`          | In the origin                     | one host per language, one build per origin |
| `createLocaleNeutralPolicy`       | Nowhere                           | pages sit behind a sign-in, never indexed   |

`createPathPrefixLocalePolicy` is the default choice. It takes `omitDefaultPrefix` to serve the
default locale without its prefix. `createDefaultLocalePrefixPolicy` takes the same options without
that one, because it always writes the prefix.

Each policy costs something different, and a host policy changes what a locale switch is, which is
[About how routing derives addresses](../explanation/about-addresses.md).

## Keep a section out of the locale prefix

Every policy takes `localeNeutralRoots`, a list of path roots that keep one address in every locale.
Use it for a sign-in callback, a webhook receiver, or anything a third party has already recorded the
address of.

## Serve a prefixed address from a static host

Under a path policy the first segment of every address is a locale, so a host that serves files by
path has no file at `/ar-eg` and answers 404. Point the host's fallback at `index.html`, the same
setting any router-driven Angular application needs, and the application reads the locale out of the
address it was opened at. `ng serve` does this already, so the first place the setting is missing is
usually a deployment of the build.

A server-rendered application answers the address itself and needs no fallback; [How to render on
the server](render-on-the-server.md) covers that path.

## Related

- [About how routing derives addresses](../explanation/about-addresses.md)
- [About how a locale is resolved](../explanation/about-locale-resolution.md)
- [How to tell crawlers your pages are translations](control-indexing.md)
- [How to render on the server](render-on-the-server.md)
