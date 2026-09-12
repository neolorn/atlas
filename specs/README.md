# Atlas specifications

The normative description of what Atlas accepts, produces, refuses, and guarantees. Twelve
documents, each owning one subject, plus this index.

## 1. Introduction

Atlas is a localization framework for Angular applications, covering the rendering environments
Angular itself supports: browser, server rendering, prerendering, and hydration. It is delivered as
two packages, `@neolorn/atlas` for the runtime and `@neolorn/atlas-toolkit` for the compiler and its
command line.

An application declares which locales it serves and writes what its messages say. It owns its routes
and public URLs, its domain values and business rules, its content and the services that supply it,
its infrastructure, and its translation workflow.

Atlas owns the mechanisms that coordinate those and the contracts needed to use them safely: locale
identity and resolution, message authoring and compilation, generated type contracts, catalog
loading and caching, runtime state and transitions, Angular integration, routing and rendering
coherence, formatting and localized input, safe rich content, interchange, verification, and
diagnostics.

Two principles run through every document.

Configuration appears only for a capability an application has selected. An application that
localizes an ordinary set of messages declares its locales and nothing else. A capability nobody
selects costs no package, no bundle, no configuration field, no initialization, and no maintenance.

Atlas derives what it can determine. Locale tables, message and artifact identity, compatibility
fingerprints, resource measures, translation freshness, and the generated type contracts all come
from the declaration and the catalogs an application already writes. An Atlas release MUST NOT
require a second record of anything it derives: no locale registry beside the declaration, no alias
for a relation the locked data already states, no digest, version, or revision field in an authored
file, and no ledger of what changed. After one setup per application, adding, renaming, or removing
a route, a scope, or a message requires no further Atlas-related change. What stays an application's
to write is what Atlas cannot infer: the content, the binding of an interactive slot to a component,
and the registration of a dynamic content source.

## 2. Conformance language

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, NOT
RECOMMENDED, MAY, and OPTIONAL in these documents are to be interpreted as described in BCP 14
([RFC 2119], [RFC 8174]) when, and only when, they appear in all capitals, as shown here.

A sentence is normative if and only if it carries one of those keywords in capitals. Everything else
is description: it explains what Atlas does and why, and it binds nothing.

These documents use MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY. REQUIRED, RECOMMENDED, NOT
RECOMMENDED, and OPTIONAL appear only as adjectives, where a sentence reads better that way. SHALL
and SHALL NOT are not used, because they mean what MUST and MUST NOT mean.

A requirement that is scoped to an optional capability applies only where that capability is
implemented, shipped, or enabled. It does not become general by being stated.

## 3. Conformance targets

Every normative sentence names what it binds.

| Target                 | Is                                                                     |
| ---------------------- | ---------------------------------------------------------------------- |
| An Atlas release       | The published packages and everything in them.                         |
| A consumer application | An application that installs Atlas, for the capabilities it enables.   |
| A catalog              | An authored source or target catalog offered to the toolkit.           |
| An artifact            | Compiled output, a descriptor, or an interchange document Atlas reads. |
| An extension           | Consumer-authored code using a declared Atlas extension contract.      |

Most requirements bind an Atlas release. The ones that bind a consumer application state the
conditions under which Atlas's own guarantees hold.

## 4. Documents

Each subject has one owner. A document that touches another's subject refers to it rather than
restating its rules.

| Document                                    | Owns                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `01-standards-profile.spec.md`              | The pinned standards profile, the locale-data sources, the MessageFormat and XLIFF profiles, and dependency selection.   |
| `02-packages-and-platform.spec.md`          | Package topology, entry points, distribution format, dependency direction, and the supported host envelope.              |
| `03-locale-identity-and-resolution.spec.md` | Locale identity, inheritance, aliases, resolution order, persistence, fallback, and recovery.                            |
| `04-message-authoring-and-catalogs.spec.md` | The authored catalog format, message identity, typed inputs, rich slots, and generated handles.                          |
| `05-compiled-artifacts-and-trust.spec.md`   | Compiled representation, artifact identity, compatibility fingerprints, resource accounting, loading, and caching.       |
| `06-runtime-and-angular.spec.md`            | The public runtime surface, snapshots and locale roles, lifecycle, transitions, server rendering, hydration, and tests.  |
| `07-routing-rendering-and-seo.spec.md`      | Route identity, locale URL policies, dispatch safety, navigation outcomes, rendering modes, and localized metadata.      |
| `08-formatting-parsing-and-domain.spec.md`  | Canonical domain values, formatting, localized parsing, Forms integration, and consumer-supplied localized content.      |
| `09-safe-content-and-ux.spec.md`            | The trust model for translated content, rich output, Unicode and bidirectional safety, accessibility, and assets.        |
| `10-compiler-and-tooling.spec.md`           | Compiler inputs, static analysis, generated output, project configuration, the command line, and interchange operations. |
| `11-diagnostics-and-observability.spec.md`  | Diagnostic codes and their stability, runtime outcomes, observability sinks, privacy, and bounded cardinality.           |
| `12-verification.spec.md`                   | The conformance suites a release passes, the host combinations it executes, and how its checks are proved able to fail.  |

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174
