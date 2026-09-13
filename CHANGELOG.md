# Changelog

All notable changes to Atlas are recorded here, for `@neolorn/atlas` and `@neolorn/atlas-toolkit`,
which share a version.

Every version below 1.0.0 was an internal development milestone and was never published.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The 0.x line is the alpha
stage, then the betas, then the release candidates that carry the changes breaking an earlier call.

## [1.0.1] - 2026-09-13

Two fixes to the request handler in `@neolorn/atlas/http`, both found from a consumer's side, and
the specification correction that goes with them. Nothing is added and nothing is removed; a
deployment that serves requests through `createLocaleRequestHandler` should take this release.

### Fixed

- A structurally unsafe request target reaches the classifier as it arrived. `toWebRequest` built a
  Fetch `Request`, and constructing one parses its URL, which resolves dot segments and rewrites a
  backslash. `/en/%2e%2e/%2e%2e/etc/passwd` therefore reached the handler as `/etc/passwd`: the
  address the traversal was aiming at, repaired, with nothing left to refuse. The 400 that section
  5 of the routing specification requires was unreachable for any deployment using the adapter, and
  `/en/./about` was served as a page. The target is now carried from the adapter to the classifier
  as it arrived, and is classified before dispatch, so an unsafe address under a locale-neutral
  root is refused rather than handed to whatever serves files.

- A malformed target no longer reaches a renderer. The handler asked the application to render
  every outcome that was not a redirect, and a refused target is not a redirect, so an application
  was asked to draw a page for an address Atlas had already refused, with a resolution carrying a
  diagnostic rather than a route. The status was correct either way; what was wrong is that the
  renderer ran at all. `RenderableResolution` no longer includes the malformed outcome, which is
  what the entry point's documentation already said.

### Changed

- `specs/07-routing-rendering-and-seo.spec.md` sections 4 and 5. Section 4 states that where an
  Atlas release is itself the request boundary the rejection is the release's own, and that a
  parsed URL is not the target that arrived. Section 5 states that a refused target never reaches
  the renderer, and resolves a contradiction it carried: the fixed status table governs routing
  outcomes, while an operational failure is the consumer application's own and the status that
  reports one is the consumer application's to declare. No release supplies a way to declare one
  yet, which is now recorded as the gap it is rather than left implied.

## [1.0.0] - 2026-09-12

The first public release. `@neolorn/atlas` and `@neolorn/atlas-toolkit` are published to npm under
the MIT license, at the surface the release candidates settled: template selectors without the
product prefix, a formatting pipe for each canonical value kind, the four project verbs on the
programmatic surface, and only what a call reaches exported. The public API is stable from here.

## [1.0.0-rc.2]

### Added

- `init`, `uninstall`, `clean` and `format` on the programmatic surface, beside `generate`, `check`
  and `watch`, with their options and result types.

### Changed

- The published surface is what a call reaches. Declarations nothing arrives at from an entry point
  are no longer exported.

### Removed

- `ATLAS_XLIFF_EXTENSION_NAMESPACE`.

## [1.0.0-rc.1]

### Added

- A formatting pipe for each canonical value kind: `localizedDecimal`, `localizedMoney`,
  `localizedMeasurement`, `localizedPercent`, `localizedPercentagePoints`, `localizedInstant`,
  `localizedPlainDate`, `localizedPlainTime`, `localizedPlainDateTime`, `localizedZonedDateTime`
  and `localizedDuration`. Each takes only the options its own value leaves open.

### Changed

- Every template selector drops the product prefix. `atlas-localized-message` is
  `localized-message`, `[atlasLabel]` is `[localizedLabel]`, `[atlasLocaleChoice]` is
  `[localeChoice]`, `atlas-localization-recovery` is `localization-recovery`, and
  `input[atlasLocalizedInput]` is `input[localizedInput]`.
- `withRecoveryMessage` takes an options object rather than a bare message.

### Fixed

- The retry control in the recovery surface takes a message, and renders in the page's own language
  rather than in English.

## [1.0.0-beta.2]

### Added

- The MIT license, with the notice inside both packages.

### Changed

- Both packages publish to the public registry.

## [1.0.0-beta.1]

### Added

- A locale falls back to the locale it inherits from before falling back to the source, walked to
  the end of the chain. `parentLocales` in `atlas.config.json` replaces one hop, and `und` as the
  value says a locale has no parent.
- `projectSitemap` returns the sitemap files, built from the page projection the head is built
  from. Past the protocol's limits the set splits into an index and numbered siblings, and the name
  given stays the address a crawler was given.
- A route states its own `changefreq`, `priority` and `lastmod` through `withRouting`, read from a
  field on the route's own data. `ATL1412` refuses a value the protocol would reject.
- `resetLocalizationTestEnvironment` puts the shared test environment back between spec files.

### Changed

- `atlas check --require-complete` counts a locale complete once its whole inheritance chain is
  counted.
- Angular tooling 22.1.7 is supported.
- A route projection is checked and arranged once when Atlas is handed it, rather than validated
  and walked again for every address built or resolved.

## [0.23.0]

### Added

- `formatting` in `atlas.config.json`: each locale declares the numbering system, calendar or hour
  cycle it is written with.
- `DIAGNOSTICS.md` inside the toolkit, derived from the codes the toolkit can report.

### Changed

- `atlas check --require-complete` blocks on every finding that says a locale is unfinished,
  including `ATL1306`, a scope with no catalog for that locale at all.
- A stricter run reports every finding it can still observe.
- The switcher label for a locale is decided in the build, and reads the same on every browser.
- Message codes are divided by what a message is wrong about rather than by which stage refused it.
- `planAtlasMessageRefactor` takes the message usages rather than a whole analysis.

## [0.22.2]

### Changed

- The steps of a locale change run in one stated order: the document language and direction, the
  address bar, the head, the captured interaction, then the announcement.

### Fixed

- A locale is advertised in the head, and offered by the switcher, only at an address that serves
  it.
- An application served under a sub-path reads the locale from its own address.
- An application served under a sub-path publishes its canonical and alternate URLs at the sub-path
  it is served from.
- A switcher option points inside the deployment it is rendered in.
- The address bar spells the current route in the committed locale after a history move, not only
  after a locale change.
- Adding a scope to a working project no longer fails the next `atlas generate`.
- `atlas init` run below a configured project no longer initializes the parent. Discovery stops at
  the package it is standing in.
- A browser asking for a language written under another subtag is matched, so `no` reaches `nb-NO`
  without an alias written by hand.

## [0.22.1]

### Changed

- A locale URL policy whose kind the router cannot express is refused, rather than warned about and
  served in part.
- A host policy whose origins do not name the origin the build answers at is refused.

### Fixed

- A redirect the resolver answers is followed when a visitor arrives from inside the application.
- Switching to a locale carried by another origin goes to that origin, rather than committing the
  locale and leaving the reader on the old page.

## [0.22.0]

### Added

- `ATL1411` refuses a `routerLink` whose leading segment the project claims for a locale, at build
  rather than as a console warning after the click.

## [0.21.1]

### Changed

- A refused message says what is wrong with it rather than repeating the parser's own label.

### Fixed

- Options written on `:string`, `:datetime`, `:date` and `:time` are read rather than accepted and
  ignored.
- `und` carries the language subtag both standards give it.

## [0.21.0]

### Added

- A registered message function can say what MessageFormat lets a selector say: its own option
  names, which keys it matches, which of two matching keys it prefers, and the options it inherits
  from its operand.

## [0.20.1]

### Changed

- A diagnostic written for a person is one line.
- A rejected message key, a parse failure and a project with no catalogs each say what to do next.

### Fixed

- `atlas generate` succeeds on a project with no messages yet.
- A `.match` over a function that formats but does not select is refused.

## [0.20.0]

### Added

- `localeChoices`: the configured locales as switchable options in one signal, each choice carrying
  the address of the current route in that locale.
- `atlas init` sets every field the configuration accepts, including `personNameLocales` and
  `pseudoLocales`.

### Removed

- `localeSelector()`. `localeChoices` and `changeLocale` replace it.

### Fixed

- A diagnostic reporting something absent points at the nearest thing that is in the file.

## [0.19.2]

### Fixed

- A scope finishing its load publishes through the same door as a locale change.
- A scope load belongs to the snapshot it was requested against.
- A snapshot no longer reports a route address belonging to a locale it is not in.

## [0.19.1]

### Changed

- A numeric option this runtime cannot honor is refused, rather than parsed, shipped and ignored.

### Fixed

- A literal number operand formats instead of throwing while rendering.
- A reference to a declaration renders the value that declaration produced, with the options it was
  given.
- `:integer` discards the operand options it cannot honor instead of throwing.

## [0.19.0]

### Added

- Variants that collide when a catch-all is written as `other` are detected before an export loses
  one of them.

### Removed

- The cache argument on the standalone formatting functions, which now share one cache.

## [0.18.1]

### Fixed

- An address handed to the router directly reaches the same route as one the browser supplies.
- The reader's inline position is restored to where they were rather than to its mirror image when
  the writing direction changes.
- The restored position holds when the engine reveals a focused element after a direction change.
- A prerendered address written in a non-Latin script is served.
- An address the route projection has no route for commits the locale its own prefix states.

## [0.18.0]

### Added

- A flat translation that drops a value the source renders is refused on import.
- `ATL1409` reports a route whose leading segment the project has already claimed for a locale.

## [0.17.0]

### Added

- `@neolorn/atlas/core`: the classification, the vocabulary and the locale profiles, importing no
  Angular.
- `@neolorn/atlas/http`: a handler that takes a request and returns a response with the redirect,
  the status, the language header, the indexing header, the cacheability and the preference cookie
  already decided.
- A route publishes its own metadata: an Open Graph block when the deployment supplies an image, a
  localized title that survives the navigation that sets it, and its address in every locale.

## [0.16.1]

### Fixed

- Focus returns to where the visitor was, not to whatever they moved to while the locale was
  committing.
- A response whose body varies by locale says so.

## [0.16.0]

### Added

- Atlas emits the cache directives its own routing determines, and takes from the application only
  the lifetime it has no basis to guess.

### Changed

- An address that carries a different answer per preference is private.

### Fixed

- The caret after a locale change is restored by one owner, counting characters as a reader sees
  them rather than as code units.

## [0.15.0]

### Added

- A participant can answer that it has no content of its own in a locale, rather than failing the
  transition.

### Changed

- A locale URL policy is narrowed to the locales the build has, once.

## [0.14.1]

### Fixed

- `atlas generate --pseudo` works for an application that registers a message extension.
- An address is published only for a locale the build actually has.
- A page renders in a locale the application has no content of its own in.

## [0.14.0]

### Added

- `pseudoLocales` in `atlas.config.json`, with `atlas generate --pseudo` deciding whether a build
  contains them.

### Changed

- A pseudo-locale's behaviors combine freely. Length change, accents, boundary markers and
  direction are independent settings rather than two fixed combinations.

## [0.13.0]

### Added

- `provideLocalizedRouter` replaces the four routing calls with one. It wraps `provideRouter`,
  derives the locale branches from the route projection, installs the localized location strategy
  and keeps the address in step.
- `provideLocalizedServerRendering`, on `@neolorn/atlas/ssr`, installs server rendering from the
  projection the client already has.
- Each locale's spelling of an address appears in the route table, and a localized address can be
  prerendered.
- `ATL1405` reports a route that renders nothing, carrying none of `component`, `loadComponent`,
  `redirectTo`, `children` or `loadChildren`.
- `ATL1406` reports a route that hides addresses from the projection, by computing its own path or
  by loading its children from a file it only references.
- A warning when the application replaces the router configuration or the location strategy that
  the localized router provides.

### Changed

- A route parameter codec is required to read back the spelling it writes.
- The address that carries no locale is suppressed by Atlas rather than by a fallback route in the
  application.
- An application no longer restates Atlas's own defaults in its composition. The default order of
  locale sources is the default.

### Fixed

- A captured interaction is released on a locale change that no navigation follows.

## [0.12.0]

### Added

- `personNameLocales` in `atlas.config.json`: an application declares the languages the names it
  renders are written in.

### Changed

- `formatPersonName` formats from published patterns rather than from a field order. Sorted order,
  monograms and formal address follow the locale.

## [0.11.1]

### Fixed

- A plural rule keyed by more than one subtag is matched.
- The quality parameter in a browser's language header is read whatever its case, and language
  range lookup follows its specification.
- A cookie configuration the browser would discard is refused rather than written.

## [0.11.0]

### Added

- Exported XLIFF is validated against the schema it claims, and the identifiers Atlas writes into
  it are legal for that schema.

### Changed

- Variant selection and value isolation follow what MessageFormat says. A function answers whether
  it matches and which key it prefers as separate questions, and a resolved value carries its own
  direction.
- The strong right-to-left class is derived from the Unicode bidirectional property rather than
  from a hand-written block list.

## [0.10.1]

### Removed

- Four exports that nothing outside the packages could usefully call.

### Fixed

- A message handle that declares no inputs can be called without an inputs argument.
- A numbering system is requested through the locale rather than through an option.
- A declared numbering system reaches every numeric placeholder in a message.

## [0.10.0]

### Added

- `atlas check --require-fresh` fails on generated output that is out of date.

## [0.9.3]

### Changed

- Angular 22.1.3 is supported, with the framework and the tooling declared as separate version
  ranges.

### Removed

- `@angular/compiler-cli` as a required peer of the toolkit.
- The deferred-content directive.
- The pseudo-localization helper for asserting against pseudo-localized output.

### Fixed

- The completeness gate reads whether a message selects cardinally or ordinally, instead of
  demanding cardinal categories from an ordinal message.
- The formatting mark a locale writes beside a sign is read back, and a negative number in those
  locales parses.
- A command's exit code follows the severity of what it found.

## [0.9.2]

### Removed

- The compatibility arguments on the feature functions. `withDocumentLocale()` is now
  `withoutDocumentLocale()`, which takes none.

### Fixed

- The locale announcement reaches a screen reader without the application rendering anything for
  it.
- An address with no locale is sent to one even where no page exists there, rather than a blank
  page answered as success.
- The reader's place is restored after the router has finished moving the page.

## [0.9.1]

### Fixed

- A scope used only from component templates is deferred with the route that defers it.
- A deferred scope is loaded when its route activates.
- Setting localization up no longer reports a false error in the application's providers array.
- An address the route projection cannot name is answered by the application's own routing rather
  than as a localization failure.
- A route projection with no parameterized routes is accepted.

## [0.9.0]

### Added

- `withRouting`: routing declared in one place. Routes default to indexable, and the application
  names the route-data field that marks the exceptions.
- `[atlasLabel]`: a message in attribute position, for `aria-label`, `title`, `placeholder` and
  `alt`.
- `presentIssue` pairs a backend failure code to a message by name.
- `localizedServerRoutes` derives the prerender table from the routes and the locales.
- `atlas uninstall` removes Atlas from a project. `clean` keeps its usual meaning of removing build
  output, and authored catalogs survive both.

### Changed

- Published names say what a thing does rather than carrying the product name.
- A route identity survives edits that keep the address. Renaming a parameter no longer orphans the
  messages keyed on that route.
- `atlas.config.json` carries one version marker.

### Removed

- `withBootstrapScopes` and `withInitialLocale`. The first is derived from the route tree, the
  second is the default order of locale sources.

### Fixed

- `atlas format` keeps the comments in an authored catalog.
- A block deferred until interaction hydrates in the locale that is committed.

## [0.8.0]

### Added

- `provideLocalization` is generated into the application's own `#i18n` with the configuration,
  catalog set, loaders, recovery payload and startup scopes already closed over. Setting Atlas up
  is one import and one call.
- A report when an application runtime selects no recovery message.
- An advisory listing source messages nothing in the application uses.

### Changed

- Only the messages the first render needs are downloaded. The rest arrive with the route that uses
  them.

## [0.7.0]

### Added

- A message keeps its input contract when it crosses into a template. A misspelled key, a missing
  value, or a value of the wrong type fails at build.
- `defineRouteProjection` keeps the route identities and parameter names the generated projection
  knows. An unknown identity, a missing parameter or a misspelled parameter name fails at build.
- `atlas init` creates a package manifest for an application that has none. A workspace with more
  than one application is a supported layout.

### Changed

- A formatting or parsing adapter is addressed by the adapter rather than by a name the compiler
  cannot check.

### Fixed

- An instant finer than a millisecond formats, rather than being refused outright.

## [0.6.1]

### Fixed

- Navigating to a locale builds the destination page in that locale, rather than painting it in the
  previous one and correcting it a moment later.
- A value that is not text is refused where a locale alias or a provider identity is expected.

### Security

- The overlay adapter is created once per request rather than once per process. One request's
  overlays cannot take another request's language, and disposing one context cannot dispose them
  for every request still in flight.

## [0.6.0]

### Added

- The locale is decided once, from one ordered chain: the address, a stored choice, the browser,
  then the default. `withLocaleSources` reorders it.
- A remembered choice is written only after a change that succeeded.

## [0.5.1]

### Fixed

- An address with no locale redirects into the locale that was resolved, spelled in that locale.

## [0.5.0]

### Added

- `ATL1307` reports a target locale that omits a message, and names the locale that stands in for
  it.
- `ATL1308` reports the plural categories a target locale leaves out, and says those counts fall
  through to the catch-all.
- A translation whose source has changed since it was written is reported, and stays reported until
  the translation is updated.
- Content with no known direction has an explicit unknown state.
- Notes and context written beside a message reach the translator as notes in the exported
  document, and survive the round trip back.

### Changed

- Relative time picks the largest unit the span reaches, truncated toward zero. Outside the range
  the application declares, the answer is an explicit decision not to be relative, carrying the
  elapsed span.

### Security

- Authored catalogs refuse directional overrides and embeddings, unbalanced isolates, and the byte
  order mark. Balanced isolates and directional marks are kept.

## [0.4.1]

### Fixed

- A finding in a catalog reports the line and column it sits on.
- A date formatted with a textual month renders the month.
- A project carrying more of its own type errors than Atlas reports at once can still generate.
- A catalog is admitted once per process rather than once per server request.
- A catalog that fails at startup shows the recovery surface instead of an empty page.

### Security

- A component template path pointing outside the selected project is reported rather than opened.

## [0.4.0]

### Added

- A localization failure carries the original error as its cause, a closed reason naming what kind
  of thing failed underneath, and the identity of the message that broke.

## [0.3.2]

### Fixed

- Analysis runs under the application's own compiler configuration. A workspace with path aliases
  or its own strictness can generate. Findings in the application's own source are advisories, and
  findings inside a generated module still fail.

## [0.3.1]

### Fixed

- The toolkit's published surfaces refuse input they cannot honor.

### Security

- Hardening across the runtime and the toolkit, with failures reported rather than swallowed.

## [0.3.0]

### Added

- Translations leave and return as XLIFF.
- A pseudo-locale, to find text that never reached a catalog.
- Catalog lifecycle operations for a message across its whole locale set.
- Locale URL policies: a path prefix, an alias, a locale-neutral root, or a host.
- Application-local extensions, for an application's own formatting and parsing.
- Localized assets, for an asset that differs by locale.

## [0.2.0]

### Added

- Numbers, dates, times, durations and the other canonical value kinds format from the locale
  rather than from the call site.
- Compiled catalogs are loaded and evaluated, in the browser and on the server.
- The locale changes while the application is running, and the lifecycle, the document and the
  loaded scopes follow it.
- The Angular surface: a pipe and a component for putting a message on the page, with testing
  helpers beside them.
- A recovery surface for when catalogs cannot be loaded.
- Optional adapters for forms and for the router.
- A generated route projection the runtime reads.
- Participants, which join a locale change and are waited for before it commits.
- A hydrated page and a localized entity route agree on the locale they are in.

## [0.1.0]

### Added

- Messages are authored in one catalog format per locale, carrying MessageFormat semantics.
- The toolkit reads the application's own source and generates typed contracts for the messages it
  uses.
- Catalogs compile to artifacts that are identical for identical input.
- The `atlas` command line drives a project.
