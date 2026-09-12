# Compatibility

The versions an install accepts, and the versions each release is run on. Every range is read
out of the package manifests.

This page is generated from the packages and is not edited by hand.

## Node

`^22.22.3 || ^24.15.0 || ^26.0.0`

The suites run at the lowest version of every line the range admits, and on the version this
repository develops on:

`22.22.3`, `24.15.0`, `24.18.0`, `26.0.0`.

## Angular, TypeScript and RxJS

| What                | Range                           |
| ------------------- | ------------------------------- |
| `@angular/core`     | `>=22.0.0 <23.0.0`              |
| `@angular/common`   | `>=22.0.0 <23.0.0`              |
| `rxjs`              | `>=7.4.0 <8.0.0`                |
| `@angular/compiler` | `>=22.0.0 <23.0.0` (build time) |
| `typescript`        | `>=6.0.2 <6.1.0` (build time)   |

Angular is a peer, not a dependency, so the copy that compiles your application is the copy Atlas
compiles against. There is never a second Angular in your tree because of Atlas.

## Peers you install only if you use them

`@angular/forms` at `>=22.0.0 <23.0.0`, needed if you import from `@neolorn/atlas/forms`.

`@angular/router` at `>=22.0.0 <23.0.0`, needed if you import from `@neolorn/atlas/router`.

`@angular/ssr` at `>=22.0.0 <23.0.0`, needed if you import from `@neolorn/atlas/ssr`.

Leave one out and the entry point that needs it is the only thing you cannot import. A
browser-only application installs none of the three.

## The combinations that are built and tested

| Row                             | Angular                     | TypeScript | RxJS    |
| ------------------------------- | --------------------------- | ---------- | ------- |
| Atlas development row           | `22.1.3` (tooling `22.1.7`) | `6.0.3`    | `7.8.2` |
| Angular patch compatibility row | `22.0.4`                    | `6.0.3`    | `7.8.2` |
| Lowest supported versions       | `22.0.0`                    | `6.0.2`    | `7.4.0` |

Each row builds a real application against the packages and runs it. The lower bound row's
versions are the floors of the ranges above, read from the same manifests, so the row moves when a
floor moves.

Angular ships its framework and its build tooling on separate patch trains, so the two sit at
different versions on the same day, and a row that pins only the framework leaves the tooling
unwatched.

## Browsers

Atlas targets what your Angular build targets. It adds no browser requirement of its own beyond
`Intl`, which every browser Angular supports has had for years.

What varies between browsers is the data behind `Intl`. Two browsers can format the same date
slightly differently in the same locale, so assert on what your application does with the result
rather than on the exact string, which is
[How to test localized output](../how-to/test-localized-output.md).

## When a version outside the range is installed

The toolkit checks the host before the compiler does anything and refuses with `ATL1806` rather
than attempting a best effort. A refusal names what it found and what it wanted, so the fix is
the install rather than a bisect.
