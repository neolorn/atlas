# How to run generation in your build

Run `atlas check` before anything consumes generated output, and `atlas generate` when the sources
have changed. In a project that builds from a clean checkout, that is one script.

## Before you begin

You need a project that `atlas init` has set up.

## Add it to your build script

```text
"build": "atlas generate && ng build"
```

`generate` compiles the catalogs and writes the `#i18n` modules your application imports. `check`
validates the authored inputs and reports whether the generated output is still fresh.

## Fail on stale output

`atlas check --require-fresh` fails when the generated modules no longer match their sources. A stale
`#i18n` module still compiles and renders the messages it was generated from, so this belongs where
your build runs `generate`.

## Work with a watcher

`atlas watch` reconciles both in one foreground process, so a saved catalog is regenerated without a
second command.

## Read the exit code

`0` success, `1` diagnostics, `2` invocation or configuration, `3` environment, `130` interruption. A
build can tell a problem in your catalogs from a wrong invocation. `--json` makes any command emit a
deterministic machine-readable result, and `--dry-run` previews the ones that write.

## Compose the runtime without the generated wrapper

`#i18n` exports `provideLocalization`, which calls `provideLocalizationSetup(localizationSetup,
...features)` with your project's setup already bound. Call `provideLocalizationSetup` yourself and
pass `localizationSetup` by hand when you want to: it takes the same features and behaves
identically. Going through the generated wrapper means one less import and no chance of handing it a
setup from another project.

## Remove it

`atlas clean` removes what Atlas wrote and nothing else. `atlas uninstall` removes Atlas and keeps
the catalogs, which are yours.

## Related

- [About compilation and generated contracts](../explanation/about-compilation.md)
- [How to translate catalogs](translate-catalogs.md)
- [Command line](../reference/cli.md)
