# Locale identity and resolution

What a locale is in Atlas, how one is declared, how Atlas decides which one a visitor gets, where
that decision is remembered, and what happens when a translation for it is missing.

The standards editions behind identity and matching are in `01-standards-profile.spec.md` section 3.
What a running application does with a resolved locale, and the snapshot that carries it, are in
`06-runtime-and-angular.spec.md`.

## 1. Ownership

Atlas owns the mechanism: identity, canonicalization, inheritance, matching, resolution order,
persistence contracts, fallback, and recovery. A consumer owns which locales exist, what they are
called in its product, which sources it consults and in what order, where a preference is stored,
and how complete a release has to be.

## 2. Locale declaration

A consumer declares its source locale, its default locale, its supported locales, and any aliases
once. The toolkit derives the typed locale table, the canonical alias map, the availability lookup,
and the runtime defaults from that declaration.

An Atlas release MUST derive every locale-dependent table from the one declaration.

## 3. Canonical identity

A locale identity is a well-formed Unicode BCP 47 identifier, canonicalized under RFC 5646, the
pinned LDML release, and the pinned ECMA-402 behavior. Canonicalization:

- normalizes casing;
- applies the registered deprecated aliases of the pinned data;
- rejects a malformed form such as `en_US` at a trusted configuration or authoring boundary.

Canonicalization MUST be deterministic across the toolkit, the server, and the browser. A difference
between runtimes MUST NOT change an identity anything compares, stores, or exchanges.

Likely-subtag maximization MAY inform matching and direction analysis. It MUST NOT rewrite a declared
identity, a catalog key, a URL value, a cache key, or a persisted preference.

A `-u-` extension is a formatting preference, validated separately, and is not part of a catalog's
identity. A transform, private-use, or other extension receives no meaning without an explicit
profile.

A catalog locale identity carries no extension and no private-use subtag at all. An Atlas release
MUST reject one where a catalog takes its identity, and therefore where a catalog key, a cache key, a
URL value, or a persisted preference does.

Untrusted locale text is bounded in length and complexity, and an Atlas release MUST NOT use it
directly as an identity, a path, a cache key, a protocol field, a stored value, or the payload of a
diagnostic.

## 4. Inheritance

Which locale a locale inherits from is pinned data, not a consumer's statement. Atlas takes each
parent from the pinned CLDR release under the inheritance rules of UTS #35 section 4.1.3: a locale
takes the parent that release declares for it; a locale it declares no parent for takes the tag with
its last subtag removed; and a locale it gives no parent below root inherits from nothing. A declared
parent may change the language, and an Atlas release MUST follow that rather than narrow the pinned
data.

A consumer that disagrees declares a parent for one locale. The declaration replaces one step of the
chain and leaves the rest pinned, and naming root says the locale inherits from nothing. It is read
at every step rather than only at the first, so a consumer may redirect a locale nobody serves that a
whole family inherits through.

A declaration for a locale that no configured locale inherits through is an error, and so is one
whose chain returns to a locale already in it.

## 5. Aliases

An alias is a consumer's own spelling of a locale: a name its product uses, or one its storage held
before Atlas. A relation the pinned data already states is derived rather than declared.

An alias that collides with a supported locale, shadows one, forms a cycle, or names a locale the
consumer does not support is an error, and an Atlas release MUST refuse the configuration rather
than pick a reading of it.

## 6. Encompassed languages

Two language subtags can name the same language. A request for one of them against a supported
locale spelled with the other is a match, and it is decided from the locked standards data rather
than from configuration: membership from the pinned IANA Language Subtag Registry snapshot, ordering
from the pinned CLDR release's language matching data, read at the language dimension only.

An Atlas release MUST NOT read the script or region dimensions of that data as distances. Those
distinctions are decided categorically by the matching steps in section 7.

## 7. Resolution sources

Atlas provides one resolver over four sources. A consumer declares which are live and in what order.

| Source    | Answers from                                                 |
| --------- | ------------------------------------------------------------ |
| `url`     | The locale the current address states, under the URL policy. |
| `stored`  | The configured persistence stores, in their declared order.  |
| `browser` | The request's or the browser's language preferences.         |
| `default` | The configured default locale.                               |

The first source that answers decides. An omitted source is not consulted at all. Every source except
`default` MAY decline, and answering the default in place of a source that declined would make every
later source unreachable.

When no order is declared, the order is `url`, `stored`, `browser`, `default`. The address leads
because a shared link has to open in the language it names.

Explicit selection is not one of the sources. It is a decision already taken rather than a preference
to be weighed, and an invalid one MUST return a typed failure and change no state.

A language range is matched against the supported locales by exhausting that range before the next
one is considered:

1. the range itself, after canonicalization and consumer aliases;
2. the range with trailing subtags dropped one at a time, which is RFC 4647 lookup;
3. any supported locale sharing the range's language and the script it is written in;
4. any supported locale written in that script whose language is the same language under another
   subtag, as section 6 defines.

Step 3 is required rather than optional, because lookup alone leaves a request for one region of a
language unmatched against a supported locale in another region. A request for Traditional Chinese
MUST NOT be answered in Simplified, so the script is compared. Scripts are compared after
likely-subtag maximization, because most real tags name no script. A range that expresses no
preference is not a match.

Resolution is sensitive to which source answered:

- an address and an explicit selection use exact canonical identity or a declared alias;
- a recognized noncanonical address is handled by the routing canonicalization contract in
  `07-routing-rendering-and-seo.spec.md`;
- malformed or unsupported locale intent in an address MUST NOT render another language at that
  address;
- a stored value that no longer canonicalizes to a supported locale is excluded, with a bounded
  diagnostic that MUST NOT echo the value;
- a language preference list honors its order and its quality values;
- automatic matching MUST NOT cross base languages or choose an incompatible script;
- a contradiction in trusted configuration MUST fail before use rather than degrade into a
  preference.

## 8. Persistence

Locale state works with no persistence at all. An Atlas release provides typed opt-in stores for
memory, a cookie, browser storage, and an authenticated profile. A consumer owns their order, their
names, their attributes, their lifetimes, their domain scope, their endpoints, their credentials,
their antiforgery, and any synchronization between applications.

Stores are read in the consumer's declared order and the first believable value wins. An Atlas
release MUST NOT reorder or merge them. A value is believed only while it still canonicalizes to a
currently supported locale.

Only a deliberate locale change is written. A locale that initialization resolved MUST NOT be written
back: persisting it would turn the first negotiated answer into a permanent one, and a later change
to the visitor's own preferences would stop having any effect. A write reaches every configured
store.

A persistence failure MUST NOT corrupt active state, and a write for an older decision MUST NOT
supersede a newer one.

Only the cookie store is readable while the server renders, so it is the only one that can fix the
language of the first response. The others can correct the language after hydration, which the
visitor sees. Cookie writing is done in the browser, because the response headers belong to the
consumer's server.

Persistence state is created per injector rather than per configuration, so a store declared in a
shared application configuration cannot carry one server-rendered request's preference into the next.

## 9. Fallback and strictness

When a translation is unavailable in the target locale, Atlas consults the locales that target
inherits from, nearest first, before it consults the source locale. The chain is walked to its end
rather than one step, because a locale inheriting through a locale nobody serves would otherwise
reach the source with its own language still unread. A member the consumer does not ship is not
consulted, having no catalog to answer with.

The first member carrying a valid compatible message supplies the result. That result keeps that
member's locale and direction, and it reports every locale consulted on the way to it.

When no member carries the message and a valid compatible source message exists, the default policy
renders the source-locale result, keeps its locale and direction, and reports a structured fallback
diagnostic. A consumer MAY set a strict policy instead, which refuses the source-locale result and
accepts an inherited one. A message supplied by a locale the target inherits from is that locale's
own answer under section 4, and it is what a completeness check counts, so refusing it at render
would make a project that passes the check a project a strict runtime cannot render.

Fallback MUST NOT accept invalid syntax, incompatible inputs, unsafe rich structure, or an
incompatible artifact, and MUST NOT emit a raw key, a parser detail, or an unexplained empty value.

## 10. Content that is not a fallback

Consumer-owned content is not a message, and an Atlas release MUST NOT apply message fallback to it.
A representation supplied in another locale is accepted only under an explicit consumer policy, and
it reports both the target locale and the locale that supplied it. Otherwise, unavailability in the
target locale stays an explicit outcome the consumer handles.

Content that is language-independent, user-authored, or deliberately multilingual is not a fallback
representation and stays valid across interface locales. It keeps its own language and direction,
per-segment metadata where it has any, or an explicit unknown state.

The unknown state is stated rather than left absent, and an Atlas release MUST classify these cases
so a consumer can tell them apart. Content carrying a resolvable script keeps its direction, even
where the language is undetermined. Content that is undetermined with no script to resolve, content
supplied with no tag, and content declared language-independent all resolve to a deferred direction
rather than an assumed one. A malformed tag remains an error.

A deferred direction instructs the renderer to apply the first-strong rule of UAX #9 to the content
in front of it. An Atlas release MUST NOT inspect that content or record a conclusion about it,
because assigning a direction to content whose direction is unknown states as fact something Atlas
has no basis for.

Atlas preserves a declared language and direction safely. It MUST NOT detect, translate, rewrite,
moderate, store, or decide the authoritative language of a consumer's content.

## 11. Recovery

Recovery is what renders when the localization runtime itself could not start or could not recover a
usable state.

The toolkit derives a minimal, independently loadable recovery payload from the ordinary configured
messages a consumer already writes, so no duplicate emergency catalog is authored.

An Atlas release MUST supply an accessible renderer for that payload, announced to assistive
technology, carrying the language and direction of the message it renders, and offering a retry. A
consumer owns the wording, the presentation, and where a retry leads.

## 12. Primary references

- RFC 5646, Tags for Identifying Languages: `https://www.rfc-editor.org/rfc/rfc5646`
- RFC 4647, Matching of Language Tags: `https://www.rfc-editor.org/rfc/rfc4647`
- RFC 9110 section 12.4.2, Quality Values: `https://www.rfc-editor.org/rfc/rfc9110`
- UTS #35 Part 1, Core, LDML 48.2: `https://www.unicode.org/reports/tr35/tr35-78/tr35.html`
- UAX #9, Unicode Bidirectional Algorithm: `https://www.unicode.org/reports/tr9/`
