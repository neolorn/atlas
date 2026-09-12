# About compilation and generated contracts

Atlas compiles catalogs instead of looking messages up at runtime. The output is TypeScript your
application imports, and the properties that follow from that decision run through the rest of the
system.

## What the two commands own

`atlas init` writes `atlas.config.json`, maps `#i18n` in `package.json`, creates `i18n/`, and adds
the `atlas:generate`, `atlas:check`, `atlas:format`, `atlas:clean` and `atlas:watch` scripts. It
stops on anything that would conflict rather than overwriting it, so running it in a project that
already has an `i18n/` directory reports what it found.

`atlas generate` compiles the catalogs and writes the `#i18n` modules. Those modules are output: they
are not checked in, they carry an ownership marker, and `atlas clean` removes them and nothing else.

Three of them are worth knowing by name.

`#i18n` exports `provideLocalization`, your project's own provider, with the locale set and the
catalogs already bound.

`#i18n/shell` exports `messages`, the handles for the `shell` scope. There is one module per scope,
named for the scope.

`#i18n/routes` exports the route projection, which is what makes a localized address resolve to a
route.

## Composition

An application configuration names the features it selected and nothing else:

```ts excerpt src/app/app.config.ts
export const appConfig: ApplicationConfig = {
  providers: [
    provideLocalizedRouter(routes),
    provideLocalization(
      withRouting({ policy: routePolicy, projection: appRouteProjection }),
      withRecoveryMessage({
        message: messages.recoveryMessage,
        retryLabel: messages.recoveryRetry,
      }),
      withPersistence(cookieStore()),
    ),
  ],
};
```

Leaving a feature out selects its default rather than switching anything off. An application that
composes `provideLocalization()` with nothing still negotiates a locale, loads its catalogs and
renders. It has no recovery message, which is the one feature with no default:
[About why the recovery message has no default](about-the-recovery-message.md).

The generated `provideLocalization` calls `provideLocalizationSetup(localizationSetup, ...features)`.
The wrapper exists so that a project cannot hand the runtime a setup from a different project.

## Scopes

A scope is a directory of catalogs and a module. A scope nothing has rendered is not in the bundle a
visitor downloaded, and scopes are loaded on demand per route, with a bounded in-memory cache behind
them. Splitting messages by where they appear is what keeps a page from paying for messages it never
shows.

Which scopes a route needs is derived from template and route analysis rather than declared, so a
component that starts rendering a message is a component whose scope is already accounted for.

## Freshness

Generated output that no longer matches its sources still compiles, and renders the messages it was
generated from. The type system does not catch it, because the stale module is internally
consistent.

`atlas check --require-fresh` is what catches it, and it belongs where your build runs `generate`. A
translation written against a source message that has since changed is the same failure one level up,
reported by `--require-complete` as one of the four ways a locale is not finished.

## Artifact verification

A compiled catalog carries a content digest and compatibility fingerprints. The runtime recomputes
the digest in the domain the toolkit wrote it in and admits the catalog only when both agree, so a
catalog served from the wrong build or altered in transit is not rendered.

Resource ceilings apply on both sides: catalog size and evaluation depth are bounded at build and
again at runtime, so a catalog that is large enough to be a problem is a diagnostic rather than a
page that never finishes.

## Related

- [How to run generation in your build](../how-to/run-generation-in-your-build.md)
- [How to translate catalogs](../how-to/translate-catalogs.md)
- [About the trust model for translated content](about-trusted-content.md)
- [Configuration](../reference/configuration.md)
