# Features

Every export that can be passed to `provideLocalization`. Leaving one out selects its default;
`withRecoveryMessage` is the one with no default. The list is read out of the built
declarations.

This page is generated from the packages and is not edited by hand.

| Feature                           | Entry point              | Selects                                                                                                                                                         |
| --------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provideLocalizationSetup`        | `@neolorn/atlas`         | The runtime, taking the generated setup and the features this application selected. The generated `provideLocalization` calls it with your setup already bound. |
| `provideLocalizationTesting`      | `@neolorn/atlas/testing` | The runtime for a test, replacing the parts a test cannot wait for and nothing else.                                                                            |
| `provideLocalizedRouter`          | `@neolorn/atlas/router`  | Replaces `provideRouter`. Resolves a localized address to the route behind it.                                                                                  |
| `provideLocalizedServerRendering` | `@neolorn/atlas/ssr`     | Negotiates the locale for each request and prepares the scopes that request needs, before the render.                                                           |
| `withExtensions`                  | `@neolorn/atlas`         | Registers formatting and parsing adapters for a value type your domain has and `Intl` does not.                                                                 |
| `withFormattingContext`           | `@neolorn/atlas`         | Sets what every formatter starts from: the numbering system, the calendar, the time zone, and the currency display.                                             |
| `withLocaleAnnouncement`          | `@neolorn/atlas`         | Replaces the wording of the locale-change announcement Atlas already makes. Returning nothing leaves the announcing to a live region of your own.               |
| `withLocaleSources`               | `@neolorn/atlas`         | Inserts a locale source of your own into the order Atlas asks in.                                                                                               |
| `withLocalizationClock`           | `@neolorn/atlas`         | Decides what `now` is for relative time. `fixedClock` makes a test reproducible.                                                                                |
| `withObservability`               | `@neolorn/atlas`         | Sends runtime outcomes to a sink you supply.                                                                                                                    |
| `withOverlayLocale`               | `@neolorn/atlas`         | Renders one locale on top of the committed one without changing it, for reviewing a translation in place.                                                       |
| `withPersistence`                 | `@neolorn/atlas`         | Stores a visitor's chosen locale in a cookie, in browser storage, or in your own profile record.                                                                |
| `withRecoveryMessage`             | `@neolorn/atlas`         | The sentence a visitor reads when no catalog loads at all. The one feature with no default.                                                                     |
| `withRelativeTimePolicy`          | `@neolorn/atlas`         | Sets the thresholds that decide which unit a relative time is said in.                                                                                          |
| `withRouting`                     | `@neolorn/atlas`         | Gives every page an address in every locale, from a URL policy and a route projection.                                                                          |
| `withoutDocumentLocale`           | `@neolorn/atlas`         | Leaves the document's `lang` and `dir` alone, for a widget rendered inside a host page that owns them.                                                          |
