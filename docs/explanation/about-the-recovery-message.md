# About why the recovery message has no default

Every other feature in Atlas has a default. The recovery message does not, and `atlas generate`
reports `ATL1310` for an application runtime that composes none.

## Two failures

Two things can go wrong, and they are not the same thing. A message can be missing from a locale, or
the catalogs can fail to load at all.

The first is ordinary. A locale that omits a message is answered by the locale it inherits from and
then by the source locale, which is
[About how a locale is resolved](about-locale-resolution.md). Nothing reaches a visitor as an error.

The second is the failure. No catalog loaded, so there is no message to render and no fallback chain
to walk. The application has one sentence to show, and it has to have been written in advance.

## Where the wording comes from

The wording is the application's. A default would put Atlas's wording, in Atlas's register, in a
language Atlas chose, into every application that did not write one.

So it is authored like any other message, one plain key with no placeholders, and passed by handle.
The failure path is the one place there is nothing to interpolate from, which is why a message with
inputs is not accepted here.

## Where the cost lands

The alternative to a default is a build that stops. The omission is reported at generate time:
`atlas init` names the recovery message as one of two things it leaves for you to write, and
`generate` reports `ATL1310` while it is still missing.

## What a visitor does next

`recovery()` carries the message once localization has failed, and `lifecycle()` reports the state
the runtime is in. `retry()` makes another attempt rather than reloading, so application state
survives it: a visitor who has filled in a form does not lose it to a failed catalog fetch.

A failure carries a reason from a closed set rather than a sentence, so counting them is a matter of
grouping on a value, which is
[About diagnostics and runtime outcomes](about-diagnostics.md).

## Related

- [How to set a recovery message](../how-to/set-a-recovery-message.md)
- [About how a locale is resolved](about-locale-resolution.md)
- [Diagnostics](../reference/diagnostics.md)
