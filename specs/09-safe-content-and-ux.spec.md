# Safe content and user experience

What a translation is allowed to do, what a renderer does with what it produces, and what the
interface around it owes a reader: direction, focus, announcement, and the assets beside the text.

The authored catalog format and the slot contract a translator writes against are
`04-message-authoring-and-catalogs.spec.md` sections 6 and 8. Artifact identity, integrity, and the
resource ceilings are `05-compiled-artifacts-and-trust.spec.md`. The scroll and focus restore across
a change of reading direction is `07-routing-rendering-and-seo.spec.md` section 8.

## 1. Trust and authority

An Atlas release MUST treat authored and translated content as untrusted input, including content
stored in a repository the consumer application controls, because a translation arrives through
people and tools that the repository's permissions say nothing about. Build trust follows bounded
parsing and complete validation, and an Atlas release MUST NOT extend it to content that has not
passed both.

Atlas code is trusted. So is a consumer application's renderer, slot binding, destination, action,
message function, loader, and policy implementation, because a consumer application writes them in
its own source and ships them in its own build. A catalog MUST NOT acquire that authority by any
route, and an Atlas release MUST NOT offer one.

A local artifact becomes eligible for activation only after the identity, compatibility, integrity,
and resource checks of `05-compiled-artifacts-and-trust.spec.md` section 4 succeed.

## 2. Inert output

Catalog content is data. An Atlas release MUST NOT let it execute JavaScript or WebAssembly, import
code, request dependency injection, compile a template, instantiate a component or a directive,
reach the DOM, the filesystem, the network, the process, storage, or a global, or produce an event
handler, a callback, a style, a class, a permission, a sanitizer, a trusted value, or an executable
expression.

An Atlas release MUST NOT use `eval`, the `Function` constructor, string-to-template compilation,
or any equivalent runtime code generation on any path, so a strict content security policy costs a
consumer application nothing to adopt.

A plain message evaluates to escaped text or to typed text parts. An Atlas release MUST NOT treat
that text as HTML, a URL, a style, a class, a DOM property, or a browser trusted value, and MUST
NOT provide an interface that hands it to one.

## 3. Rendering a rich message

A rich message evaluates to immutable renderer-neutral parts, and the parts keep the language and
direction of the catalog that supplied them.

Every slot in those parts is bound in trusted code. An Atlas release MUST require a binding for each
slot the parts carry and MUST refuse the message where a binding is absent or of the wrong kind: a
`link` slot takes a link binding, an `action` slot takes an action binding, and any other slot takes
a template or a text binding. A refusal names the slot and the supplying locale, because a missing
binding is a programming error and the message that reaches a reader instead of the text is the one
a developer has to act on.

A `link` binding carries an application-owned typed destination and renders anchor semantics. An
`action` binding carries an application-owned handler and renders button semantics with an explicit
button type. An Atlas release MUST NOT let a catalog choose a URL, an origin, a scheme, a target, a
link relationship, a callback, a command, or an event.

Every rich contract projects to plain text. An Atlas release MUST preserve localized text, formatted
values, and the children of a container slot in that projection, and MUST NOT let a destination, a
handler, or protected binding data appear in it.

## 4. Styling and components

Styling part of a message uses a semantic slot or a message-local slot implemented in trusted
consumer code. That covers color, emphasis, a design-system component, or a purpose-built one, and
an Atlas release MUST NOT let a catalog choose CSS, a class, a color, a design token, a component,
or behavior.

An Atlas release MUST NOT provide a catalog-addressable component registry, because a catalog that
can name a component can name any component in the application. A consumer application keeps broad
rendering freedom through typed bindings, and a catalog keeps linguistic placement.

## 5. HTML interoperability

Arbitrary HTML is not a message surface, and an Atlas release MUST NOT accept one in a catalog.

Where a legacy corpus makes an adapter necessary, that adapter MUST be explicit and isolated, MUST
use a separately approved parser and sanitizer with a closed allowlist, MUST produce safe semantic
output, and MUST preserve Angular sanitization, the content security policy, Trusted Types, server
rendering, hydration, and accessibility. An adapter MUST NOT weaken the text and parts contracts and
MUST NOT turn remote content into an executable template.

## 6. Content security policy and Trusted Types

An Atlas release MUST operate with no inline script, no unsafe evaluation, no sanitizer bypass, no
permissive Trusted Types policy, and no runtime template compilation, under a policy that denies
everything by default and allows script only from the application's own origin and its inline
hashes, denies attribute-position script, denies plugin content, and requires Trusted Types for
script.

Where an optional integration needs a trusted browser sink, the consumer application owns the narrow
policy and the review it takes. An Atlas release MUST keep the ordinary text and structured-parts
paths free of that dependency, so an application that does not enable the integration inherits none
of it.

## 7. Parsers, Unicode, and authored controls

An Atlas release MUST parse YAML, JSON, XML and XLIFF, MessageFormat, and local manifests with
bounded non-executing parsers, MUST NOT let a parsed document trigger filesystem or network
resolution, and MUST refuse a document type declaration and an external entity in XLIFF.

An Atlas release MUST validate Unicode scalar structure wherever text becomes an identity, refusing
an unpaired surrogate and a noncharacter, and MUST refuse a control character that no interface text
contains. An Atlas release MUST refuse a confusable structural token or a control capable of
spoofing a source file, a route, a diagnostic, or generated code.

The ceilings on encoded and decoded size, nesting, nodes, selectors, variants, references,
expansion, recursion, slots, evaluation steps, output parts, and diagnostics are
`05-compiled-artifacts-and-trust.spec.md` section 7, and neither an artifact nor an extension can
raise one.

### 7.1 Authored bidirectional controls

Translator-supplied text is untrusted input, and these characters are invisible: neither a reviewer
reading a diff nor a translator pasting from another tool can see what they do. An Atlas release
MUST refuse an authored catalog value that contains any of the following.

| Refused                                               | What it does                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A directional override or embedding, U+202A to U+202E | Forces a direction on the text around it, so a value can reorder the sentence it sits in.            |
| An unbalanced directional isolate, U+2066 to U+2069   | Opened and never closed, or closed without being opened; the run it was meant to contain never ends. |
| U+FEFF                                                | A byte-order mark that has ended up inside a value rather than content anyone typed.                 |

An Atlas release MUST accept a balanced directional isolate, which contains a direction instead of
leaking it and is what a translator needs around a left-to-right product name inside right-to-left
prose. An Atlas release MUST accept a directional mark (U+200E, U+200F, U+061C), which affects one
adjacent character and cannot reorder a run, and the zero-width space and word joiner (U+200B,
U+2060), which have ordinary typographic uses.

An Atlas release MUST say what the refused character does rather than only that one was found,
because the reader cannot see it.

This governs authored catalogs. A value arriving at run time from a backend, a form, or another
consumer-owned source is not authored content, and section 8 contains it instead.

## 8. Isolation at the presentation boundary

An interpolated value can reposition the text around it, so an Atlas release MUST isolate it in the
formatter rather than leave each call site to remember. The structured surface carries that
isolation as an element and the plain-text surface carries it as directional isolate characters
around the value. An Atlas release MUST NOT make one of those surfaces weaker than the other,
because choosing a rendering surface is not a choice about safety.

An Atlas release MUST isolate a right-to-left value in either direction of message, MUST isolate a
value of unknown direction with a first-strong isolate so the renderer's own rule decides, and MUST
isolate a left-to-right value in a right-to-left message. It MUST NOT isolate a left-to-right value
in a left-to-right message unless the author asked for it, because the characters are invisible to a
reader and visible to every string comparison a consumer application writes, and inserting them
where they change nothing costs those comparisons and buys nothing.

The direction of a value Atlas formatted is the direction of the locale it was formatted for. For a
value Atlas did not format, an Atlas release has no locale to take a direction from, so it MAY read
the value's own content to decide, and MUST accept an explicit author declaration in its place. This
is a deliberate departure from MessageFormat 2, which says directionality should not be determined
by introspecting a character sequence and offers the operand's locale instead: an interpolated value
inherits the message's locale, so consulting it answers with the message's own direction every time
and isolates nothing.

Isolation applies to rendered output. An Atlas release MUST NOT write a directional control into a
stored value or return one from a value contract.

## 9. Accessibility

Every user-facing primitive an Atlas release supplies, and every reference integration it ships,
MUST conform to WCAG 2.2 level AA for the behavior it implements. An Atlas release supplies
semantics, state, diagnostics, and testing hooks, and a consumer application still owns the
accessibility of the application around them.

Text a person reads sometimes lives in an attribute, and an attribute is where the ordinary ways of
placing a message in a template run out, because a host binding cannot use a pipe at all. An Atlas
release MUST provide a way to place a message in attribute position directly, and MUST restrict it
to a closed set of attributes whose value is presented rather than fetched, executed, or resolved.
An Atlas release MUST refuse an attribute outside that set, because `href`, `src`, `formaction`,
and every event attribute are positions where a string stops being text and becomes a navigation or
a program, and routing translated content into one of them MUST NOT be a one-word template change.
An Atlas release MUST write the named attribute alone and leave every other attribute as the author
wrote it.

A slot renderer owns the semantic element, keyboard behavior, focus behavior, accessible
relationships, the constraints on interactive content, and a meaningful label. Localized order is
reading order. A target catalog MUST NOT cause a required semantic action to disappear, and an Atlas
release MUST refuse the message rather than render an interface that has lost one.

## 10. Document language and direction

An Atlas release derives language, script, region, writing direction, and locale display metadata
from canonical context and the pinned data of `01-standards-profile.spec.md` section 4.

The core runtime is headless. In its Angular integration, an Atlas release MUST keep the document
element's language and direction, and the declared localized head metadata, in step with the
committed snapshot across server rendering, hydration, and every transition, without being asked,
because a page whose text is Arabic and whose direction is left to right is broken in a way no
application intends. A consumer
application that does not own the document MAY withdraw that, and an Atlas release MUST make the
withdrawal an explicit statement rather than a flag whose other value changes nothing.

An Atlas release MUST give a fallback segment, a quotation, a name, a formatted external value, and
any other change of language explicit language and direction metadata, so a renderer can scope the
language and isolate the run.

Content whose language is undetermined has no direction to state. An Atlas release MUST report an
undetermined tag with no script subtag, and an absent tag, as unknown and defer the direction to the
renderer's first-strong rule; MUST report a tag that carries no linguistic content as
language-independent and defer in the same way; and MUST NOT assign a writing direction to either.
A tag that resolves to a script keeps that script's direction, including where the language is
undetermined and the script is not.

An Atlas release exposes direction signals, logical direction tokens, diagnostics, and optional
static checks, and MUST NOT rewrite a consumer application's CSS. A consumer application SHOULD
write logical CSS properties and MUST classify a genuinely physical direction explicitly.

## 11. The locale-change announcement

A screen reader given no notice that the page changed language reads the new text with the old
pronunciation rules, and a consumer application cannot opt into a fix for a problem it cannot hear.
An Atlas release MUST therefore announce a locale change without being asked, into a live region it
owns, and MUST announce it only after the transition commits.

The default announcement is the new locale's own name in that locale, which is what a person
switching into it reads. A consumer application MAY replace the wording, and an Atlas release MUST
treat that as a replacement of the wording alone rather than of the decision to announce. A
replacement that supplies no wording is still a replacement of the wording. An application
announcing the change through a region of its own supplies none, so the change is not announced
twice, and an Atlas release MUST accept that rather than treat an empty replacement as a mistake.

An Atlas release MUST NOT announce an entire page, a pending locale, a failed switch as a success,
or every translated node. Withdrawing document ownership withdraws the announcement with it, because
a region appended to the document body is document ownership.

## 12. Focus, composition, and motion

Across a locale switch that stays on the same view, an Atlas release MUST preserve focus on the
control that started it, where that control is still in the document and nothing else has taken
focus in the meantime. The
restore is scheduled during the commit and applied a frame or more later, by which time a visitor
may have pressed another control, tabbed away, or clicked into a field, so where anything other than
the document body or the document element holds focus at that moment, somebody chose it, and an
Atlas release MUST leave that choice alone. Restoring regardless takes focus off what the visitor is
using, one frame after they acted, and it is what a visitor switching locale twice in a row by
keyboard experiences.

An Atlas release MUST NOT mutate a form value, a selection, or an active text composition across the
switch. A selection offset is a position in a particular string, so an Atlas release MUST restore
offsets only where the text they were measured against is unchanged, and a consumer application's
component that rewrites its own value across the commit owns the mapping for that value.

Route-level focus movement follows the consumer application's accessible navigation policy. An
Atlas release MUST NOT move focus for a change of reading direction alone.

An Atlas release MUST NOT require a transition animation. A consumer application's motion MUST honor
a reduced-motion preference and MUST NOT delay correctness, focus, or the commit.

## 13. Overlays and portals

An overlay, portal, dialog, or other out-of-tree system takes localization context through an opt-in
adapter. An Atlas release MUST create that adapter once per injector rather than once per
configuration, because under server rendering there is one injector per request and one application
configuration for the process: an adapter created where the feature is declared is shared by every
concurrent request, and the first request to finish disposes it for all of them.

An Atlas release MUST update a coordinated overlay's content and direction with the primary commit
and MUST NOT leave one holding a mixed-locale state. An Atlas release MAY let an overlay a consumer
application declared progressive complete on its own, and only while that overlay reports truthful
readiness, outcome, supplying language, and direction; its pending, replacement, and failure
presentation stays the consumer application's.

An Atlas release MUST NOT select an overlay framework and MUST NOT add an overlay dependency to the
primary entry point.

## 14. Typography, icons, and assets

An Atlas release exposes locale and script metadata and resolves an optional consumer-defined
typographic profile by script, then by language, then by a declared default. It MUST NOT bundle or
download a font and MUST NOT rewrite a consumer application's design system.

An icon mirrors only where a consumer application has classified it as direction-relative and the
direction is right to left. An Atlas release MUST leave a direction-neutral icon, a physically
directional one, a logo, media, a number, a culturally meaningful symbol, and an unclassified icon
unchanged, because mirroring one of those produces an image that means something else.

An application's images, media, files, and documents are locale-neutral by default, and an Atlas
release MUST NOT enroll one in a locale transition unless the application declared a localized
variant for it. A declared descriptor is neutral, variant-bearing, or fixed-language, and its source
value is opaque trusted consumer data: an Atlas release MUST NOT construct, parse, or fetch it, and
MUST NOT accept it from a catalog.

Variant selection takes one canonical target locale and an explicit consumer-ordered fallback list
of at most thirty-two locales beside it. An Atlas release MUST NOT guess a fallback chain, and MUST
return either a ready result naming the representation it selected and whether it fell back, or an
unavailable result naming the exhausted policy.

A government, legal, official, historical, registration, tax, certificate, or comparable authentic
artifact preserves its original content and its actual language unless the authority behind it
supplies a distinct localized variant, and an Atlas release MUST NOT treat authenticity as a missing
translation. Alternative text, captions, transcripts, labels, and other descriptive metadata
localize independently of the asset and keep their own supplying language.

Acquisition, authorization, storage, caching, and payload state for a dynamic asset stay with the
consumer application. An Atlas release MUST reconstruct a participant report from bounded status,
outcome, identity, and representation metadata alone, and MUST NOT give that report a payload, a
URL, an authorization, a storage, or a cache field.

## 15. Extension safety

A custom function, slot kind, loader, parser, or integration receives only the localization
capabilities its contract declares. An extension MUST NOT opt out of validation, resource limits,
request isolation, the content security policy, accessibility, or transaction semantics, and an
Atlas release MUST NOT provide a way to.

A descriptor is inert data and a binding is trusted code. An Atlas release MUST resolve a binding
through the calling context's own registry, so a binding belonging to another context or never
installed in this one is refused, and MUST refuse a generated required descriptor whose trusted
binding is absent or not byte-for-byte compatible.

A diagnostic about a security refusal MUST name a stable bounded cause category, and an Atlas
release MUST NOT put a secret, a credential, a cookie, a token, a source or message body, a
parameter, a slot payload, or unsafe text in one. The codes themselves and their stability are
`11-diagnostics-and-observability.spec.md`.

## 16. Primary references

- WCAG 2.2, W3C Recommendation 12 December 2024: `https://www.w3.org/TR/WCAG22/`
- WAI-ARIA 1.2, W3C Recommendation 6 June 2023: `https://www.w3.org/TR/wai-aria-1.2/`
- UAX #9, Unicode Bidirectional Algorithm: `https://www.unicode.org/reports/tr9/`
- Content Security Policy Level 3, W3C Working Draft: `https://www.w3.org/TR/CSP3/`
- Trusted Types, W3C Working Draft: `https://www.w3.org/TR/trusted-types/`
- Angular security guide: `https://angular.dev/best-practices/security`
