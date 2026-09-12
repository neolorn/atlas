# About the trust model for translated content

A translated string is content from outside your codebase. It was written by someone who is not on
your team, it arrived through a workflow you do not control, and it is rendered into your page. Atlas
treats it as data, and that decision is what bounds what a catalog entry can do.

## Messages and markup

`Read the {#strong}guide{/strong}.` is a message with a slot rather than a string containing HTML,
and nothing renders it as HTML.

There is no spelling of a catalog entry that introduces an element, an attribute, a script or a URL
into your page. A translator moves the slot to where their language puts the emphasis, and what the
slot becomes is decided in your code.

It also keeps the translation portable: a translation carrying your markup breaks when your markup
changes.

## Destinations

A slot that becomes a link takes its destination from your application, wrapped so the two kinds
cannot be confused. `internalDestination` is an address inside your application.
`externalDestination` is one outside it, and the rendered anchor is given what an external link
should carry.

A catalog supplies neither, so no URL can reach the page through a translated string.

## Bidirectional text

An Arabic sentence containing an English product name, or an English sentence containing an Arabic
one, needs isolation per [UAX #9](https://www.unicode.org/reports/tr9/) or the punctuation lands in
the wrong place. Atlas isolates what it interpolates, so a name inside a right-to-left sentence does
not drag the full stop to the other end of the line.

The document's `dir` follows the committed locale, and so does each switcher option's, which is why a
locale option is laid out in its own direction rather than the page's. The document's `lang` follows
it too, which is what a screen reader reads to choose a voice.

A widget rendered inside a host page that maintains its own `lang` and `dir` composes
`withoutDocumentLocale()`, and Atlas leaves the document alone. It is named for the withdrawal rather
than taking a flag, so the default behavior has no spelling of its own.

[Unicode](https://home.unicode.org/)'s own hazards are diagnostics at compile time rather than
surprises on the page: a catalog entry carrying an unpaired directional override, or characters that
make one string display as another, does not compile.

## Accessibility

`withLocaleAnnouncement` tells a screen reader that the page changed language. Without it the words
change with no announcement.

Every switcher option carries `lang` and `dir` of its own, so its name is pronounced in its own
language and laid out in its own direction. Each name is written in its own language, so a visitor
who cannot read the current page can still find theirs.

An option that is arriving carries `aria-busy`, and the one you are in carries `aria-current`, so the
state of a switch is available to something that is not looking at the styling.

## Assets

An image with words in it, a logo with a wordmark, a document: each changes with the locale, and each
is declared rather than guessed at. `neutralAsset` states that an asset does not change, so an asset
carrying words is never treated as neutral by omission. The alt text is a message like any other.

## Related

- [How to render a message](../how-to/render-messages.md)
- [How to serve localized assets](../how-to/serve-localized-assets.md)
- [How to translate catalogs](../how-to/translate-catalogs.md)
