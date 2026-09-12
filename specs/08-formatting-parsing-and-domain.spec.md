# Formatting, parsing, and domain values

How a domain value is held, how it is rendered for a reader, how a reader's typing is read back into
one, and where the boundary between Atlas and an application's own data sits.

The standards edition behind every capability here, and the rule that the host's own implementation
is the engine, are `01-standards-profile.spec.md` sections 5 and 6. The formatting context travels
with the snapshot of `06-runtime-and-angular.spec.md` section 4. What may be rendered as trusted
markup is `09-safe-content-and-ux.spec.md`.

## 1. The invariant domain boundary

An Atlas release MUST store, transport, compare, cache, validate, and identify a domain value in
locale-invariant form. A localized string is presentation output, and an Atlas release MUST NOT let
one become authoritative money, a number, a date or time, a duration, a unit, an enum, a route, a
cache key, an authorization value, or a protocol field.

Message locale, formatting locale, time zone, calendar, numbering system, hour cycle, week rules,
measurement system, and default currency policy are separate explicit dimensions. A consumer
application's own user, organization, tenant, route, field, or operation policy decides their
precedence, and an Atlas release MUST NOT take any of them from the host machine's ambient
settings.

## 2. Canonical value contracts

An Atlas release defines a lossless typed form for each value kind it carries.

| Kind                            | Canonical form                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Instant                         | A point on the UTC timeline, transported as a signed base-ten epoch-nanosecond string with no exponent and no unit ambiguity.    |
| Plain date, time, and date-time | Explicit civil fields with no implicit zone or offset.                                                                           |
| Zoned date-time                 | An instant with a canonical time-zone identity and a calendar.                                                                   |
| Duration                        | Signed structured calendar and clock units rather than an assumed millisecond count.                                             |
| Decimal                         | A normalized base-ten string, optional minus, no exponent, no grouping, no plus sign, no negative zero, no noncanonical padding. |
| Money                           | An exact decimal with an explicit currency code.                                                                                 |
| Measurement                     | An exact amount with an explicit unit.                                                                                           |
| Percent or rate                 | An exact decimal with an explicit semantic scale.                                                                                |
| Percentage points               | An exact decimal value or delta, distinct from a percent or a rate.                                                              |

An Atlas release MUST normalize and validate these through public factories, and MUST admit a
platform date, a native temporal value, a transport object, a decimal library value, or a
domain-library value only through an explicit adapter that cannot confuse seconds with
milliseconds, civil time with an instant, a currency, a precision, or a unit.

Converting civil time to an instant requires an explicit zone and an explicit disambiguation
policy, and balancing a calendar-relative duration requires an explicit reference and zone where
the result can vary. An Atlas release MUST take time-zone identity, aliases, links, and conversions
from the pinned time-zone database recorded under `01-standards-profile.spec.md` section 4, and MUST
NOT let host presentation data redefine a stored time-zone identity.

An Atlas release MUST NOT perform accounting, exchange, tax, cash rounding, business precision, rate
calculation, percentage-point conversion, or implicit unit conversion. Those belong to the consumer
application's domain.

## 3. Formatting

An Atlas release supplies typed text and structured-parts formatting for the ECMA-402 capabilities
the host provides: numbers, dates and times and their ranges, relative time, lists, display names,
plural rules, durations, collation, segmentation, and locale metadata.

An Atlas release MUST feature-detect a capability before relying on it, and MUST return a typed
unsupported result, or use an explicitly installed adapter, where required behavior is absent or
inconsistent. An Atlas release MUST NOT approximate one silently.

An Atlas release MUST accept an instant at whatever precision it carries and format it to the
precision the requested options ask for, and MUST reserve a refusal for output that was genuinely
requested and cannot be produced, which no date-time option expresses below a millisecond. The
millisecond an instant occupies is the one containing it, so an instant before the epoch is never
displayed as later than it is.

Localized output is identical across every runtime in the supported envelope. An Atlas release MUST
format real content in each supported locale on each supported runtime and compare the results,
because a browser and a server that render the same page must not produce different text.

An Atlas release MUST use one immutable formatting snapshot across server rendering, hydration, and
browser evaluation, so hydrated output matches the server exactly, and MUST take an explicit
reference instant or clock for a clock-sensitive operation.

Message grammar and catalog-authored literals use the supplying catalog locale, including under
fallback. A user, field, route, or operation value uses the effective formatting context. An Atlas
release MUST NOT conflate the two.

An Atlas release MUST use the declared semantic scale when formatting a percent. The standards-native
fractional scale is the default, so a quarter formats as twenty-five percent; a percent-unit scale
is declared rather than inferred. Percentage points are a separate contract and an Atlas release MUST
NOT let one enter percent formatting implicitly.

A named formatting profile is typed, reusable, composable, and declared once. An Atlas release MUST
NOT let a narrow per-operation override mutate global state. Structured parts preserve the semantic kind, the source value
identity where that is safe, and the language and direction metadata, and an Atlas release MUST NOT
put trusted markup in one.

An Atlas release MUST key a cached formatter on its complete locale and options identity and MUST
bound that cache, so arbitrary option cardinality cannot grow memory without limit.

## 4. The formatting context

A formatting context is resolved in three layers, narrowest last: the application-wide context, then
the declared context for the locale being formatted, then the pinned locale data for that locale,
which is the standard's choice rather than an absent one.

An Atlas release MUST let a locale declare only what is a fact about how it is written: its
numbering system, its calendar, and its hour cycle. A time zone is not one of those, so an Atlas release MUST keep the
time zone application-wide, because it belongs to the reader or the deployment rather than to the
language, and one page is read in one zone whichever language it is in.

A context transferred from a server render applies to the locale it was rendered for. An Atlas
release MUST NOT let it become the default for another locale.

## 5. Relative time

Relative-time presentation is divided by owner, and an Atlas release MUST hold that division.

An Atlas release owns unit selection: the largest configured unit whose threshold the elapsed span
reaches, truncated toward zero so a phrase never claims a span is larger than it is, sign-preserving,
and reported without a sign at zero. A consumer application owns the thresholds, declaring the
smallest and largest units worth naming and the elapsed span past which relative phrasing stops, and
MUST NOT implement unit selection itself.

A span beyond that range is an explicit non-relative decision carrying the elapsed span. An Atlas
release MUST NOT report it as a formatting failure and MUST NOT substitute an absolute rendering,
because the format, the zone, and the wording of that rendering belong to the application.

## 6. Localized parsing

An Atlas release MUST NOT expose a universal permissive parser. Every localized parser is opt-in and
field-specific and states its locale, its expected value kind, its accepted syntax, its range and
precision, its currency, unit, or percent-scale policy, its calendar, time-zone, and disambiguation
policy, and its behavior on ambiguity.

Strict parsing is the commit default. A result is one of valid, incomplete, invalid, ambiguous,
out-of-range, unsupported-capability, or policy-rejected, and an Atlas release MUST carry an
invariant typed value only on the valid one.

An Atlas release MAY preserve incomplete localized text during composition or editing. An Atlas
release MUST NOT, on commit, select the first plausible interpretation, change a currency or a unit,
or resolve a daylight-saving ambiguity silently.

The numeric input profile covers localized digits, signs, grouping, decimal separators, and
explicitly contracted percent, currency, and unit forms. An Atlas release MUST reverse the field's
declared scale when parsing a percent, so localized twenty-five percent yields a quarter under
fractional semantics and twenty-five under a declared percent-unit profile. Percentage-point input
stays a separate contract.

Temporal parsing uses declared patterns or generated field profiles. An Atlas release MUST NOT use
the platform's permissive date parser, host coercion, a guessed field order, natural-language
guessing, or the host's implicit time zone as a correctness path.

An Atlas release MUST NOT locale-parse a domain code, an enum value, an identifier, a route or cache
key, an authorization value, a protocol field, or a machine timestamp.

## 7. Locale data, person names, and what stays domain-owned

An Atlas release exposes typed access to display names, plural rules, direction, calendars,
numbering systems, hour cycles, week information, collation, and segmentation under the pinned
profile. Locale-aware collation and case conversion are presentation and search aids, and an Atlas
release MUST NOT use either for a security decision or an identity comparison.

Person-name formatting follows the pinned CLDR person-name semantics and takes explicitly structured
data. An Atlas release MUST preserve the fields supplied, MUST distinguish the name's own language
and script from the surrounding locale, MUST NOT impose a universal given-and-family persistence
schema, and MUST NOT parse an unstructured name into authoritative components.

Postal-address schemas, canonicalization, deliverability, validation, and final layout stay with the
consumer application, as do telephone parsing, regional numbering metadata, canonicalization,
dialing behavior, and validity. An Atlas release localizes the labels, the instructions, and the
issue presentation around them, and MUST NOT define an address or telephone database, validator, or
provider contract.

An extension supplying a formatting or parsing adapter is paired with its inert descriptor at
runtime setup and is invoked by passing the installed adapter rather than a name for it, so a
misnamed adapter and a value it cannot format fail to compile. An Atlas release MUST resolve the
adapter through the calling context's own registry, MUST apply the descriptor's input bound before
invoking it, MUST supply the committed formatting snapshot, and MUST refuse a generated required
descriptor whose trusted binding is absent or not byte-for-byte compatible.

An extension MUST run synchronously and return bounded text or coherent structured parts. An Atlas
release MUST return an explicit unsupported-formatting result for a handler that is missing,
asynchronous, throwing, malformed, or over its bound, and MUST take a parsing adapter's result type
from the adapter rather than from the caller, because a caller-declared result type is an assertion
nothing checks. An extension MUST NOT weaken the strict result model or reach a consumer that did
not select it.

## 8. Forms, localized input, and issues

An Atlas release provides framework-neutral localized field parsing, presentation, and issue
contracts, with thin opt-in adapters for the supported Angular Forms APIs. The core behavior works
without a Forms adapter, and an Atlas release MUST keep an optional Forms value import out of the
primary entry point, under `02-packages-and-platform.spec.md` section 6.

A validator produces a stable invariant issue code with typed parameters that are safe to put in a
schema, and a generated mapping resolves a known issue to a compatible message contract.

An unknown, malformed, or unauthorized code stays an explicit unknown state. An Atlas release MUST
give it a safe generic presentation and a diagnostic, MUST NOT reject the transport merely because a
code is unknown, and MUST NOT coerce it into a known value.

Field parsing follows this document. The control value, the selection, an active composition, the
touched, dirty, and pending state, issue precedence, asynchronous validation, acceptance, and
submission stay owned by the form and domain system.

Visible messages derive reactively from invariant issue state and committed locale state. An Atlas
release MUST update the wording on a locale change while preserving the control value, the
selection, the composition, the dirty, touched, and pending state, the validation result, and the
parameters.

## 9. External issue codes

A consumer application may supply a stable machine code and typed safe parameters from a frontend
validator, a backend, an API, or another domain boundary. An Atlas release maps it to a localized
message in the active context, and MUST NOT call or control the originating system.

A code pairs with its message by name. An Atlas release MUST read a code as a sequence of words and
write them back as one lower-kebab message identifier, so the same failure reaches the same message
whichever casing or separator convention the originating system uses, and a service that changes how
it spells its codes does not orphan an application's translations. The transformation encodes
nothing about any particular error taxonomy.

Nothing is written per code. An Atlas release MUST NOT require a mapping line per code, because that
is a line every new code needs and eventually does not get, and what the reader then sees is a
generic apology instead of what went wrong. An explicit binding stays available for what a
convention cannot express, a code whose message lives elsewhere or several codes deliberately
collapsing to one, and an Atlas release MUST consult it first.

An Atlas release MUST accept a message found by name only when the message's own identity ends in
the derived identifier, because a message group is an ordinary value and the wrong one can be
supplied, and rendering a message about something else is worse than rendering the generic one.

The unknown branch is required rather than optional, because an application receives codes from a
system it does not deploy and there is always one it has not heard of yet.

Messages selected this way are named nowhere in source. An Atlas release MUST treat a reference to a
message group as a reference to every message in it, where the group is handed to something, and
MUST NOT count walking through a group to reach a single message or importing it, because counting
either would silence the unused-message advisory for every scope any file imports.

Raw exception or detail text is not interface copy, and an HTTP status is not a localization
identity. An Atlas release MUST NOT let localization reinterpret a failure as a success, weaken
authorization or validation, or replace the application's own policy.

## 10. Enums and consumer-supplied content

A known domain value maps exhaustively to a localized presentation. An unknown external value stays
a typed unknown state and maps to a safe fallback with a diagnostic, and an Atlas release MUST keep
machine equality and persistence on the invariant value rather than the localized label.

Source-controlled catalogs are the input path for code-owned messages. Pages, products, articles,
comments, editorial blocks, user-authored fields, content-derived metadata, and comparable records
stay in the consumer application's services, stores, signals, and components, with their
acquisition, schemas, persistence, authorization, lifecycle, and presentation.

An Atlas release MUST NOT call or couple itself to a consumer content system, translation system,
API, backend, database, vendor library, or data service, and MUST NOT let a consumer payload become
a message identifier, compiled data, a cache entry, or part of a localization snapshot.

A region supplying such content takes part through the participant contract of
`06-runtime-and-angular.spec.md` section 8, which carries safe identity, transition correlation,
target-locale context, readiness or outcome, and the locale actually supplying the region.

Only a locale-bound representation takes part in locale fallback. An acquisition, cancellation,
protocol, or coordination failure is an operational failure; exhausting the approved representation
policy is a requested-representation-unavailable outcome; and a valid empty, absent, or restricted
result is a domain outcome. An Atlas release MUST keep the three apart.

Language-independent, user-authored, intentionally multilingual, and unknown-language content stays
valid across a locale change. An Atlas release MUST preserve its known or unknown actual language
and direction and MUST NOT relabel it as fallback merely because it differs from the target locale.

## 11. Renderers Atlas does not own

In-app interactive notifications are localized through the same message, parameter, rich-content,
supplying-locale, accessibility, and transition contracts as any other interface. Notification
queues and delivery state stay with the consumer application.

Email, messaging, operating-system push text, documents, exports, and other final external artifacts
are localized by the renderer that creates and delivers them. The recipient's locale, time zone,
formatting policy, content, authorization, retries, delivery, and audit behavior sit outside the
Angular runtime, and an Atlas release MUST NOT call, host, or govern such a renderer. Standard
interchange is a translation-workflow capability under `01-standards-profile.spec.md` sections 10 to
12 rather than a promise that a non-Angular renderer consumes Atlas runtime artifacts.

Logs, metrics, analytics, security events, and protocol fields use invariant codes and structured
values, and an Atlas release MUST NOT put localized text in one. A localized presentation may be
derived from such an event at an explicit boundary without changing the event.

## 12. Primary references

- ECMA-402, ECMAScript Internationalization API Specification:
  `https://ecma-international.org/publications-and-standards/standards/ecma-402/`
- IANA Time Zone Database: `https://www.iana.org/time-zones`
- ISO 4217, Currency codes: `https://www.iso.org/iso-4217-currency-codes.html`
