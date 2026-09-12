# Configuration

Every field `atlas.config.json` accepts. The table is read from the schema that validates the
file and produces the flags of `atlas init --help`.

This page is generated from the packages and is not edited by hand.

What the locale fields mean for a visitor is
[About how a locale is resolved](../explanation/about-locale-resolution.md).

| Field               | Accepts            | Required | What it is                                                                                   |
| ------------------- | ------------------ | -------- | -------------------------------------------------------------------------------------------- |
| `sourceLocale`      | string             | yes      | The locale the authored source catalogs are written in.                                      |
| `defaultLocale`     | string             | yes      | The locale served when a request asks for none Atlas supports.                               |
| `locales`           | a list of string   | yes      | Every locale this project supports. Repeat for each one.                                     |
| `personNameLocales` | a list of string   | no       | Locales a person name may be written in, beyond the ones this project is translated into.    |
| `pseudoLocales`     | a map of an object | no       | Locales derived from the source catalog rather than authored. Generated only by --pseudo.    |
| `formatting`        | a map of an object | no       | How a locale is written, where the application disagrees with CLDR about that locale.        |
| `inProgress`        | a map of an object | no       | Locales still being translated. Their completeness findings never block a release.           |
| `parentLocales`     | a map of string    | no       | Which locale a locale inherits from, where CLDR is wrong for this project. `und` means none. |
| `aliases`           | a map of string    | no       | Extra identifiers that resolve to a supported locale.                                        |

## The version field

`schemaVersion` is written by `atlas init` and read by everything that opens the file. It is not
a field you set: it says which shape the rest of the file is in, and a version this release does
not understand is refused rather than guessed at.
