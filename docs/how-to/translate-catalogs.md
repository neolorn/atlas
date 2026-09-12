# How to translate catalogs

Export the source catalogs to
[XLIFF 2.2](https://docs.oasis-open.org/xliff/xliff-core/v2.2/xliff-core-v2.2.html), hand the
documents to translators, and import what comes back. What travels is the message and the notes you
wrote beside it.

## Before you begin

You need catalogs, which is [How to write a message](write-messages.md).

## Export and import

`exportAtlasXliff22` produces an interchange document per locale, carrying each message with the
`description` and `context` you authored, so a translator has the notes rather than a bare string.
`importAtlasXliff22` reads the same document back and tracks the translation state of each unit.

Nothing about your build, your routes or your project goes into the document, and nothing in the
document can introduce markup or a destination into your page, which is
[About the trust model for translated content](../explanation/about-trusted-content.md).

## Check what is finished

A locale that is not finished has four shapes: no catalog for a scope, a catalog missing a message, a
message missing a plural form its language needs, and a translation written against a source message
that has since changed.

```text
npx atlas check --require-complete
```

All four stop the run under `--require-complete` and are ordinary warnings without it, because during
development the source language lands first and the translations follow. An inherited answer counts
as an answer.

## Ship a locale that is not ready

Name the locale rather than turning the gate off for every locale.

`atlas.config.json` takes an `inProgress` entry naming the locale and a note, which
`atlas init --in-progress` writes for you. That locale's findings are still printed, with your note
quoted into them, and they stop blocking.

The note is required, and it is what tells the next person whether the exemption still holds.

## Review a translation in place

`withOverlayLocale` renders a locale on top of the one that is committed, without changing it. A
reviewer opens the page as it will read in Arabic while the application, its state and its addresses
stay where they are.

It is not a way to serve a locale you have not declared. What it overlays has to be a locale you
compiled.

## What is checked in

The catalogs and `atlas.config.json` are yours and are checked in. Everything under the generated
root is output: it carries an ownership marker, it regenerates, and `atlas clean` removes it. A
hand-edited generated file is overwritten by the next `generate`.

## Related

- [How to run generation in your build](run-generation-in-your-build.md)
- [About compilation and generated contracts](../explanation/about-compilation.md)
- [Command line](../reference/cli.md)
