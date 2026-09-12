# About how a locale switch is a transaction

`changeLocale(locale)` prepares everything the arriving locale needs and commits only when all of it
is ready. Until then the page stays exactly as it was.

## Preparing before committing

A locale change touches the messages, the document's `lang` and `dir`, the address under a URL policy
that carries the locale, focus, scroll position, and whatever else registered as a participant.
Applying those as each becomes ready produces a page in two languages, an address that disagrees with
the words under it, and a screen reader announcing a change that has half happened.

The catalogs are the slow part, and they are the part that can fail. Preparing them first means the
failure mode is "nothing moved", which is a state the visitor was already in and can act on.

## What commits together

When the switch commits, the messages, the document's `lang` and `dir`, the address, focus and scroll
position move together, and so does anything registered through `registerParticipant`.

A participant is asked to prepare for the arriving locale and the commit waits for it. A content
store, a search index, a client for a system that returns localized text: each has to fetch again
before the new locale is shown, and showing the new page before they have is the same defect as
showing half a catalog. A participant that fails fails the switch.

`participants()` reports what each one is doing, which is what to render when a switch is slow enough
to show progress for.

Lifecycle hooks run around the commit, for overlays and view transitions that need to know the moment
the page changes.

## A switch and a navigation

A switch is not a navigation. The Router's URL is still the route you are on. Only the address the visitor sees carries the locale,
and only under a policy that puts it there.

## Application state

A switch reuses the running application rather than reloading the document, so state survives it: a
visitor who changes language mid-form keeps what they typed.

## Hydration

Server-rendered HTML is claimed by hydration rather than rewritten. Content produced under one locale
and hydrated under another keeps the words the server chose, and no later change detection corrects
it, because the binding's stored value is already the new one.

`renderedLocale()` reports the locale the server-rendered document was written in, and `undefined` in
a browser that rendered the page itself. The runtime reads it to decide whether to claim server HTML
or build it fresh. A mismatch is otherwise invisible: the page looks right, it is in the wrong
language, and nothing throws.

## Where the guarantee ends

A policy that puts the locale in the origin cannot hold it, because application state does not cross
origins. There, a change is reported as a redirect and the document moves instead. That is one of the
costs of choosing that policy, and it is weighed in
[About how routing derives addresses](about-addresses.md).

## Related

- [How to add a locale switcher](../how-to/add-a-locale-switcher.md)
- [How to render on the server](../how-to/render-on-the-server.md)
- [How to extend Atlas](../how-to/extend-atlas.md)
- [How to test localized output](../how-to/test-localized-output.md)
