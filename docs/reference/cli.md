# Command line

Every command and every flag the `atlas` command line accepts. The text below is the output of
`--help` on the built CLI, captured by running it.

This page is generated from the packages and is not edited by hand.

Running these commands in a project is
[How to run generation in your build](../how-to/run-generation-in-your-build.md).

```text
Usage: atlas <command> [options]

Commands:
  init       Add compatible Atlas configuration and package setup
  generate   Compile and safely publish generated #i18n artifacts
  check      Validate authored inputs, analysis, and generated freshness
  format     Canonically format Atlas configuration and catalogs
  clean      Remove only verified Atlas-owned generated and work state
  uninstall  Remove Atlas from this owner, keeping authored catalogs
  watch      Reconcile changes in one foreground process
  migrate    Preview or apply one explicit Atlas-authored migration plan

Common options:
  --project <path>   Select an owner directory or atlas.config.json
  --json             Emit deterministic machine-readable JSON
  --dry-run          Preview init, generate, format, clean, uninstall, or migrate
  --help             Show this help
  --version          Show the toolkit version

Init options:
  --source-locale <locale>
      The locale the authored source catalogs are written in.
  --default-locale <locale>
      The locale served when a request asks for none Atlas supports.
  --locale <locale>   (repeatable)
      Every locale this project supports. Repeat for each one.
  --person-name-locale <locale>   (repeatable)
      Locales a person name may be written in, beyond the ones this project is translated into.
  --pseudo-locale <locale>[.<option>=<value>]   (repeatable)
      Locales derived from the source catalog rather than authored. Generated only by --pseudo.
      lengthFactor (number)
        Signed length change. Positive expands, negative elides vowels; absent leaves length alone.
      markers (boolean)
        Wrap the whole rendered message in boundary markers, so untranslated text has none.
  --formatting <locale>.<option>=<value>   (repeatable)
      How a locale is written, where the application disagrees with CLDR about that locale.
      numberingSystem (string)
        The digits this locale is written in, where they differ from the ones CLDR gives it.
      calendar (string)
        The calendar this locale is written in, where it differs from the one CLDR gives it.
      hourCycle (string)
        The hour cycle this locale is written in, where it differs from the one CLDR gives it.
  --in-progress <locale>.<option>=<value>   (repeatable)
      Locales still being translated. Their completeness findings never block a release.
      note (string)
        Why this locale is not complete yet. Quoted back in every finding it downgrades.
  --parent-locale <locale>=<locale>   (repeatable)
      Which locale a locale inherits from, where CLDR is wrong for this project. `und` means none.
  --alias <alias>=<locale>   (repeatable)
      Extra identifiers that resolve to a supported locale.

  A repeatable flag may appear more than once. Where a value contains "=", the left side is a
  path beneath the field: "eg=ar-EG" sets one entry, "en-XA.markers=true" sets one option of
  one entry. Every field atlas.config.json accepts is above; there is no other way to set one.

Uninstall options:
  --catalogs         Also remove authored catalogs (off by default)

Check options:
  --fix              Apply only semantic-preserving canonical formatting
  --require-complete Fail when a required target locale omits a source message
  --require-fresh    Fail when generated output does not match the sources
  --pseudo           Also generate the configured pseudo-locales (development only)

Migrate options:
  --plan <path>      Select one atlas-authored-change-plan/1 JSON file
  --project <owner>  Select the explicit migration owner (required)

Exit codes: 0 success, 1 diagnostics, 2 invocation/configuration, 3 environment, 130 interruption.
```

## Exit codes

A build reads the exit code rather than the output, because "your catalogs have a problem" and
"this invocation was wrong" are two different things to wake someone up for.

| Code  | Means                                         |
| ----- | --------------------------------------------- |
| `0`   | Success                                       |
| `1`   | Diagnostics were reported                     |
| `2`   | The invocation or the configuration was wrong |
| `3`   | The environment could not support the run     |
| `130` | Interrupted                                   |
