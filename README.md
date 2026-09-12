# Atlas

### Standards-based localization framework for Angular (MessageFormat 2, CLDR, BCP 47, XLIFF 2.2)

[![npm version](https://img.shields.io/npm/v/@neolorn/atlas?style=flat-square)](https://www.npmjs.com/package/@neolorn/atlas)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![documentation](https://img.shields.io/badge/read_the-docs-red?style=flat-square)](./docs/README.md)

## Introduction

**Atlas** is an open-source localization framework for Angular applications, with support for [MessageFormat 2](https://www.unicode.org/reports/tr35/tr35-messageFormat.html) messages, localized routing, locale-aware formatting and parsing, server-side rendering and prerendering, and [XLIFF 2.2](https://docs.oasis-open.org/xliff/xliff-core/v2.2/xliff-core-v2.2.html) interchange. It is built on [Unicode CLDR](https://cldr.unicode.org/) locale data and designed to be standards-compliant, type-safe, and derived from the application's own sources rather than from hand-maintained registries.

Atlas is delivered as two packages. [`@neolorn/atlas`](./packages/runtime/) is the runtime: locale resolution, message evaluation, formatting through `Intl`, and the Angular integration for routing, forms, and server rendering. [`@neolorn/atlas-toolkit`](./packages/toolkit/) is the compiler and the `atlas` command line: it compiles YAML catalogs into typed modules under `#i18n`, analyzes the application's templates and routes to derive scopes and localized addresses, validates catalogs against the MessageFormat 2 specification, and exchanges translations in XLIFF.

For a detailed description of the architecture and the contracts between the two packages, see the [specifications](./specs/README.md).

## Features

- **Messages**
  - [MessageFormat 2](https://www.unicode.org/reports/tr35/tr35-messageFormat.html) syntax (LDML 48.2) with plural, ordinal, and select variants, number and date functions, and rich content slots bound to Angular components.
  - Catalogs authored in YAML, compiled into typed message handles; inputs and slots are checked by the TypeScript compiler.
  - Message scopes derived from template and route analysis, loaded on demand per route with bounded in-memory caching.
  - Locale fallback through the [CLDR parent locale](https://www.unicode.org/reports/tr35/tr35.html#Parent_Locales) chain, with per-locale overrides.
  - A recovery message and an accessible recovery renderer for the case where catalogs cannot be loaded.
  - Pseudo-localization for layout and expansion testing.
  - Evaluator verified against the MessageFormat working group's conformance test suite on every release.
- **Locales**
  - Locale identifiers per [RFC 5646](https://www.rfc-editor.org/rfc/rfc5646), canonicalized through `Intl.getCanonicalLocales`.
  - Negotiation per [RFC 4647](https://www.rfc-editor.org/rfc/rfc4647) lookup, extended with script matching and [CLDR language matching](https://www.unicode.org/reports/tr35/tr35.html#LanguageMatching) data.
  - Resolution from the URL, a persisted preference, `Accept-Language`, or a configured default, in a declared order.
  - Persistence through cookies, browser storage, or an authenticated profile.
  - Per-locale declarations for numbering system, calendar, and hour cycle.
  - Locale display names from pinned CLDR data, identical across engines and between server and client.
  - Language and direction handling for consumer-supplied content, including undetermined and multilingual content.
- **Routing**
  - Localized URLs under three policies: a locale prefix in the path, a domain per locale, or a single address space.
  - Per-locale route and parameter spellings, with canonicalization and permanent redirects for legacy addresses.
  - Locale-neutral roots and aliases for addresses that do not belong to one locale.
  - Canonical and `hreflang` metadata derived from the route projection, and sitemaps per [sitemaps.org](https://www.sitemaps.org/protocol.html) with the `hreflang` extension.
  - Indexing classes and cache headers per route, and a document title strategy.
  - A locale switcher directive that keeps the visitor on the current page, with `lang`, `dir`, `aria-current`, and `href` handled.
- **Rendering**
  - Server-side rendering, prerendering, and hydration with the first response in the visitor's locale.
  - Locale switching as a transaction: catalogs load first, then the document, routes, focus, and scroll position are updated together, with lifecycle hooks for overlays and transitions.
  - Document `lang` and `dir` management and screen-reader announcements on locale change.
  - Localized assets, selected per locale and direction.
  - A request handler for Node servers outside Angular, through `@neolorn/atlas/http`.
- **Formatting and parsing**
  - Numbers, currencies, percentages, units, dates, times, durations, relative times, lists, and person names, through `Intl` with pinned CLDR 48.2 data.
  - Canonical value types for decimals, money, dates, times, zoned date-times, measurements, and durations.
  - Locale-aware parsing of user input and an Angular Forms integration.
  - Collation and text segmentation.
- **Extensibility**
  - Five extension contracts, declared once and validated at build: message functions, identifier segments, rich slot kinds, formatting adapters, and parsing adapters.
  - Observability sinks for runtime outcomes, with bounded cardinality and no content in events.
- **Interchange and tooling**
  - XLIFF 2.2 export and import with translation-state tracking.
  - The `atlas` command line: `init`, `generate`, `check`, `watch`, `format`, `clean`, `uninstall`, and `migrate`, with options derived from the configuration schema.
  - Release-completeness checks per locale, with a per-locale in-progress declaration.
  - Diagnostics with stable codes and a generated [reference](./docs/reference/diagnostics.md); JSON Schemas published for every file format.
  - A testing entry point with deterministic control over catalog loading, locale transitions, and the test environment.
- **Packaging and safety**
  - A runtime with no dependencies beyond `tslib`, shipped as ESM with seven entry points; an unselected capability adds no code, no configuration, and no peer dependency.
  - Translated content is treated as data: it cannot introduce markup, scripts, or navigation targets.
  - Bidirectional text handling per [UAX #9](https://www.unicode.org/reports/tr9/), with isolation of interpolated values.
  - Compiled artifacts carry content digests and compatibility fingerprints and are admitted only after verification.
  - Resource ceilings on catalog size and evaluation depth, enforced at build and at runtime.

## Getting started

Install the runtime and the toolkit:

```sh install
npm install @neolorn/atlas
npm install --save-dev @neolorn/atlas-toolkit
```

Initialize the project and compile the catalogs:

```text
npx atlas init --source-locale en-US --default-locale en-US --locale en-US --locale ar-EG
npx atlas generate
```

Add a message to `i18n/shell/en-US.yaml`:

```yaml excerpt i18n/shell/en-US.yaml
messages:
  app-title: Hello, world
```

Use it in a template. The key `app-title` is exposed as `messages.appTitle`, and the compiler verifies that it exists:

```ts excerpt src/app/app.ts
    <h1>{{ messages.appTitle | localize }}</h1>
```

The [tutorial](./docs/tutorial.md) continues from here to a complete two-locale application with localized routes and a language switcher.

## Documentation

- [Tutorial](./docs/tutorial.md): a two-locale application from `ng new` to a localized route.
- [How-to guides](./docs/README.md#how-to-guides): step-by-step instructions for specific tasks.
- [Reference](./docs/README.md#reference): the command line, configuration, entry points, and diagnostics, generated from the packages.
- [Explanation](./docs/README.md#explanation): how locale resolution, compilation, routing, and the trust model work.
- [Specifications](./specs/README.md): the normative description of what Atlas accepts, produces, and guarantees.

All code examples in the documentation are executed against the published packages as part of every release.

## Compatibility

| Host       | Supported range                       |
| ---------- | ------------------------------------- |
| Angular    | `>=22.0.0 <23.0.0`                    |
| RxJS       | `>=7.4.0 <8.0.0`                      |
| Node.js    | `^22.22.3 \|\| ^24.15.0 \|\| ^26.0.0` |
| TypeScript | `>=6.0.2 <6.1.0` (toolkit)            |

Each release is verified on Chromium, Firefox, and WebKit and on every supported Node.js line. See [Compatibility](./docs/reference/compatibility.md) for the tested combinations.

## Support

Open an [issue](https://github.com/neolorn/atlas/issues/new/choose) for bug reports and questions. Security vulnerabilities are handled privately; see [SECURITY.md](./SECURITY.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the development setup, the verification suite, and the pull request process. This project adheres to the [Contributor Covenant](./CODE_OF_CONDUCT.md) code of conduct.

## License

This project is licensed under the [MIT License](./LICENSE).

## Copyright

Copyright (c) 2026 Hossam Ismail
