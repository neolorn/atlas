# Entry points

What each import specifier publishes, and what it is for. The lists are read out of the built
packages.

This page is generated from the packages and is not edited by hand.

## `@neolorn/atlas`

Everything an application component and its bootstrap need.

Publishes 211 name(s).

Composable from here: `provideLocalizationSetup`, `withExtensions`, `withFormattingContext`, `withLocaleAnnouncement`, `withLocaleSources`, `withLocalizationClock`, `withObservability`, `withOverlayLocale`, `withPersistence`, `withRecoveryMessage`, `withRelativeTimePolicy`, `withRouting`, `withoutDocumentLocale`.

## `@neolorn/atlas/core`

The value builders, the contracts and the address helpers, with no Angular injector involved. This is what a library or a test helper imports.

Publishes 221 name(s).

## `@neolorn/atlas/forms`

Localized input parsing and the directive that binds it to a form control.

Publishes 3 name(s). Needs `@angular/forms`, which is an optional peer: install it when you import from here.

## `@neolorn/atlas/http`

The interceptor that carries the committed locale on outgoing requests.

Publishes 15 name(s).

## `@neolorn/atlas/router`

Localized routing: the router setup, the link directive, and the address projection behind them.

Publishes 12 name(s). Needs `@angular/router`, which is an optional peer: install it when you import from here.

Composable from here: `provideLocalizedRouter`.

## `@neolorn/atlas/ssr`

Server rendering: per-route render modes, and the locale the server renders in.

Publishes 2 name(s). Needs `@angular/ssr`, which is an optional peer: install it when you import from here.

Composable from here: `provideLocalizedServerRendering`.

## `@neolorn/atlas/testing`

The test harness. It replaces the parts of the runtime a test cannot wait for, and nothing else.

Publishes 8 name(s).

Composable from here: `provideLocalizationTesting`.

## `@neolorn/atlas-toolkit`

The compiler behind the `atlas` command, as a library. An application does not import this; a build script that needs the compiler without the command line does.

Publishes 175 name(s).

## Anything else

A path that is not listed here is not published. A deep import into a package resolves in some
setups and not in others, and what it reaches is free to change in a patch release, so nothing
on this page is reachable any other way.
