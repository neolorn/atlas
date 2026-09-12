# Atlas documentation

Four kinds of page, each answering a different kind of question.

- [Tutorial](#tutorial) answers "teach me to use this".
- [How-to guides](#how-to-guides) answer "how do I do this task".
- [Reference](#reference) answers "what does this accept and return".
- [Explanation](#explanation) answers "why does it work this way".

## Tutorial

- [Your first localized route](tutorial.md): a new Angular application, two locales, a localized
  route, and a working switcher.

## How-to guides

Messages and locales:

- [How to add a locale](how-to/add-a-locale.md)
- [How to write a message](how-to/write-messages.md)
- [How to render a message](how-to/render-messages.md)
- [How to add a locale switcher](how-to/add-a-locale-switcher.md)
- [How to set a recovery message](how-to/set-a-recovery-message.md)

Addresses and servers:

- [How to localize your routes](how-to/localize-routes.md)
- [How to render on the server](how-to/render-on-the-server.md)
- [How to negotiate a locale on your own server](how-to/negotiate-on-your-own-server.md)
- [How to publish a sitemap](how-to/publish-a-sitemap.md)
- [How to tell crawlers your pages are translations](how-to/control-indexing.md)

Values and content:

- [How to format a value](how-to/format-values.md)
- [How to read typed input](how-to/read-typed-input.md)
- [How to serve localized assets](how-to/serve-localized-assets.md)

Running the project:

- [How to run generation in your build](how-to/run-generation-in-your-build.md)
- [How to translate catalogs](how-to/translate-catalogs.md)
- [How to test localized output](how-to/test-localized-output.md)
- [How to extend Atlas](how-to/extend-atlas.md)

## Reference

These pages are generated from the packages.

- [Command line](reference/cli.md): every command and flag, captured from the built CLI's own help.
- [Configuration](reference/configuration.md): every field `atlas.config.json` accepts.
- [Entry points](reference/entry-points.md): what each import specifier publishes.
- [Features](reference/features.md): every feature `provideLocalization` composes.
- [Diagnostics](reference/diagnostics.md): every code and what it means.
- [Compatibility](reference/compatibility.md): the versions you can install against, and the ones
  that are tested.

## Explanation

- [About how a locale is resolved](explanation/about-locale-resolution.md)
- [About compilation and generated contracts](explanation/about-compilation.md)
- [About the trust model for translated content](explanation/about-trusted-content.md)
- [About why the recovery message has no default](explanation/about-the-recovery-message.md)
- [About how a locale switch is a transaction](explanation/about-locale-switching.md)
- [About how routing derives addresses](explanation/about-addresses.md)
- [About canonical values](explanation/about-values.md)
- [About diagnostics and runtime outcomes](explanation/about-diagnostics.md)

## Policy

- [Versioning and compatibility](versioning.md): what the version number covers, and how a release
  reaches you.
