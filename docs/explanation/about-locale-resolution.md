# About how a locale is resolved

Every request that reaches your application is answered in one language. Resolution is how Atlas
chooses it, and it runs once before the first render and again whenever something that fed it
changes.

## Four sources, in a fixed order

Atlas asks four sources and takes the first answer:

1. The address, when the locale policy puts one there.
2. A persisted choice.
3. `Accept-Language`.
4. `defaultLocale`.

That order is what an application composing nothing gets. `withLocaleSources` inserts a source of
your own, for something the list cannot know: an account setting, a tenant's declared language, a
value in your session.

A source answers or declines. Declining passes the question along rather than ending it, so an
account setting that is empty for a signed-out visitor still lets the browser be asked. Design a
source of your own around that property: return nothing rather than a guess, and the sources behind
you still work.

## Precedence of the address

A URL that names a locale is a request for that exact page in that exact language, and it is the only
part of the decision one person can send to another. A stored preference that could override it would
make one link open differently for two people.

The cost is that a visitor who has chosen a language can still land on a page in another one by
following a link. Atlas takes that cost. The alternative changes what a URL means without saying so.

An address naming a locale you do not serve goes through the same negotiation as any other request,
and the visitor lands on the closest locale you do serve.

## Identity before comparison

A locale identity is a [BCP 47](https://www.rfc-editor.org/info/bcp47) tag, canonicalized through
`Intl.getCanonicalLocales` before anything compares it. `EN-us`, `en-US` and `en-Latn-US` are one
locale, so a browser spelling a tag differently from your configuration is not a miss and there is no
alias table to maintain.

Everything else about a locale is published data: its direction, its plural categories, its number
and date conventions, and what it inherits from. That is why adding a locale is adding a tag to
`locales` and writing its catalogs, with no per-locale configuration block.

## Matching what a client asked for

`Accept-Language` is a list of ranges with weights, and it rarely names a locale you serve exactly.
Atlas uses the lookup from [RFC 4647](https://www.rfc-editor.org/rfc/rfc4647), which truncates a
range from the right until it matches: `en-GB` finds `en`, and `pt` finds `pt-BR` when that is the
Portuguese you ship. Script matching and
[CLDR language matching](https://www.unicode.org/reports/tr35/tr35.html#LanguageMatching) data extend
it.

Where the standard stops, Atlas adds one step. A range that matched nothing by truncation is answered
by the first locale declared for the same language, so a browser sending `no` to a site shipping
`nb-NO` gets Norwegian rather than the default.

That step makes the order of the `locales` array meaningful: it decides which regional variant
represents a language when a client asks for the language alone. Standard lookup sends that visitor
to the default locale, which is the worse answer whenever you ship their language.

## Which locale supplies a message

Resolution chooses the locale a page is in. A second chain decides which locale answers a particular
message when the committed one omits it.

A locale that omits a message is answered by the locale it inherits from, and only then by the source
locale. The chain is
[CLDR's parent locale](https://www.unicode.org/reports/tr35/tr35.html#Parent_Locales) chain, walked to
its end rather than stopped after one step, so `en-AU` gives `en-001`, then `en`. You write an
Australian string only where Australian English differs.

A locale that inherits from nothing falls straight to the source. That includes a locale written in a
script its language does not usually take: `az-Arab` never falls to `az`, because `az` is written in
Latin, and a reader expecting the Arabic script would be shown Azerbaijani text in Latin letters.

A rendering result states which locale supplied it, and `attemptedLocales` lists every locale
consulted on the way, which is what to read when a string appears in the wrong language.

## Remembering a choice

Persistence turns a switch into a preference. `withPersistence(cookieStore())` is the usual answer,
and the reason is the render path rather than the storage: a server reads a cookie while it handles
the request, so the first response is already in the right language.

`localStorageStore` is browser-only and is read after the page exists, so the first paint is whatever
the address and the headers decided. On a client-rendered application that is invisible. On a
server-rendered one it is a flash of the wrong language.

`profileStore` is an interface rather than a store with a different name. Implement it when the
choice belongs in your account record, and the value follows the visitor across devices instead of
across tabs.

The cookie store validates its own configuration where you write it rather than leaving a browser to
drop the cookie later. `SameSite=None` without `Secure`, a `__Secure-` name without `Secure`, and a
`__Host-` name carrying a `Domain` are each invalid at that point.

## Overlay locale

`withOverlayLocale` renders one locale on top of the committed one without changing it. A reviewer
reads a page as it will appear in Arabic while the application, its state and its addresses stay
where they were. Resolution has not run for it, and the overlay has to be a locale you compiled.

Changing the committed locale after load is a different mechanism with its own guarantees, which is
[About how a locale switch is a transaction](about-locale-switching.md).

## Related

- [How to add a locale](../how-to/add-a-locale.md)
- [How to localize your routes](../how-to/localize-routes.md)
- [About how routing derives addresses](about-addresses.md)
