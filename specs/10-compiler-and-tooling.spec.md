# Compiler and tooling

How an application's catalogs and source become generated contracts and compiled artifacts, what the
command line does with them, and what the compiler is allowed to read on the way.

The authored catalog format is `04-message-authoring-and-catalogs.spec.md`. What compilation
produces and how a runtime admits it is `05-compiled-artifacts-and-trust.spec.md`. Diagnostic codes
and their stability are `11-diagnostics-and-observability.spec.md`. Dependency selection is
`01-standards-profile.spec.md` section 14.

## 1. Ownership

`@neolorn/atlas-toolkit` is a Node package, and it owns the compiler, static analysis, extraction,
validation, generation, migration, the programmatic API, the command line, and the default
standalone host. An Atlas release MUST NOT import, call, extend, or model itself around a consumer
application's compiler, repository tool, build system, workspace layout, or project service.

A consumer application invokes the built toolkit through its public API or its command line. A
project-owned orchestrator MAY call either, and an Atlas release MUST NOT let one redefine
compilation semantics or make Atlas depend on the project.

An Atlas release MUST make importing the toolkit start no compilation, no process mutation, no
watch, and no filesystem write, so a build script that imports it to read one type pays for nothing
else.

## 2. The compiler core and its hosts

The compiler core is deterministic and framework-neutral. It takes a structured request, the
configuration, the catalogs, the owner identity, and optionally an extension registry, an analysis
input and the previous compiler state, and it returns diagnostics, a semantic graph, an invalidation
decision, an output plan, and the generated artifacts. An Atlas release MUST NOT give that core
process state, networking, filesystem mutation, scheduling, or a watch lifecycle.

The standalone Node host owns project discovery, filesystem access, change collection, scheduling,
cache persistence, unchanged-output detection, transactions, and foreground watch. An Atlas release
MUST route the command line and every integration through the same core, so an answer does not
depend on which surface asked for it.

The Node, Angular, and TypeScript adapters are internal version boundaries. An Atlas release MUST
treat only high-level requests, results, configuration, documented diagnostics, and generated public
contracts as consumer-facing API.

An Atlas release MUST make a programmatic entry point that validates untrusted input accept an
unknown value and confirm it is text within a bounded length before any grammar, coercion, or byte
measurement reads it, and MUST report a value that is not text as a diagnostic naming the type
received and never the value. A declared parameter type is not that check, because these values
arrive from configuration files, command lines, and consumer build scripts, where no type is present
to enforce anything.

## 3. First generation

A clean first generation happens inside one compiler invocation, in one order:

1. parse and validate the configuration, the authored catalogs, and the inert extension descriptors,
   without reading generated modules as an authority;
2. synthesize the provisional locale, registry, scope, handle, input, family, and slot-contract
   modules in memory;
3. analyze the selected TypeScript and Angular graph through a virtual overlay that resolves the
   ordinary generated import specifiers to those provisional contracts;
4. recompute reachability, diagnostics, compiled artifacts, catalog-set descriptors, and the final
   generated contracts from the complete semantic graph;
5. publish only the final accepted output set, through one output transaction.

An Atlas release MUST NOT write the provisional overlay, import it at run time, cache it as an
authority, or expose it as a second generated interface. An Atlas release MAY let existing generated
files accelerate an equivalent incremental run once their completion manifest validates, and MUST
NOT let them decide what a clean run produces.

A consumer application that deletes its generated root and its work root MUST be able to restore
both with one successful generate, without commenting out an import, generating twice, checking in
generated files, or writing a registry by hand.

## 4. Inputs and discovery

Atlas-native YAML is the authoring authority. The compiler's inputs are the application's authored
catalogs, its configuration, its inert extension descriptors, the static TypeScript, template, and
route usage in the selected application graph, its declared local composition and override
contracts, and the explicit legacy or interchange inputs of a declared operation. An Atlas release
MUST let each input class contribute only its own declared facts, and MUST NOT let one redefine
catalog wording or message identity.

An extension input is application-local inert data. An Atlas release MUST NOT import or execute a
handler, renderer, adapter, or application module to discover anything, and MUST validate a
descriptor's schema, identity, namespace, profile, and fingerprint before it contributes a generated
type or semantic-registry compatibility data. An extension descriptor MUST NOT contain code or a
fingerprint of its own, because the fingerprint is derived and a supplied one would be a claim
nothing checked.

The host discovers the extension registry as one optional strict-JSON file beside the project
configuration, holding a profile marker and a list of closed, provider-namespaced, resource-bounded
descriptors. An absent file is an empty registry, and an Atlas release MUST NOT scaffold or require
an empty one.

The host discovers authored catalogs by convention inside one selected or unambiguously resolved
owner. An Atlas release MUST fail with the candidates where more than one owner or configuration is
plausible, and MUST NOT merge two projects because of the working directory. Discovery is bounded by
the package the working directory stands in: the nearest manifest upward, inclusive, is the
project's root, and an Atlas release MUST NOT select a configuration above that boundary, and MUST
name both the configuration it declined and the boundary it lies beyond.

An Atlas release MUST NOT take precedence from discovery order or path order, and MUST NOT accept a
configured external or remote catalog source. An Atlas release MUST exclude generated source,
compiled catalogs, catalog-set descriptors, caches, reports, pseudo-locales, interchange documents,
build output, declaration-only dependencies, ignored content, and unrelated projects unless an
explicit supported local role says otherwise, and MUST fail deterministically on a complete catalog
or message identity collision outside a declared compatible override layer.

A consumer application's pages, products, articles, comments, user-authored values, and other
runtime domain records MUST NOT become a compiler input, a generated message contract, a
reachability root, a catalog artifact, a cache entry, or output metadata, even where the application
stores them locally.

## 5. Static analysis

An Atlas release MUST analyze the selected project's actual compilation graph, its syntax trees,
symbols, types, and exact source spans, and MUST NOT treat a filename glob or a textual match as
semantic analysis. Where Angular analysis is enabled, an Atlas release MUST discover component
templates from component metadata and parse them through an Atlas-owned adapter, and MUST NOT infer
a template from a filename.

An Atlas release MUST recognize public Atlas symbols and generated-handle metadata rather than local
spelling or an import alias, and MUST follow a handle through a re-export, a constant alias,
destructuring, readonly property access, a finite tuple, record, or map, a provable literal-union
selection, a template local, control flow, and a generic forwarding helper that keeps the dependent
handle contract.

Analysis is bounded. An Atlas release MUST NOT execute application code, import a module for its
side effects, call a getter, a function, or a service, evaluate an arbitrary expression, or perform
a network lookup, and MUST report an unsupported unresolved use as an actionable diagnostic.

An Atlas release MUST NOT let a raw or interpolated string, an unchecked cast, an erased base value,
or an unbounded index become a message identity. A consumer application selecting a message
dynamically uses a generated finite collection, a prefix view, an open family, or an explicit legacy
adapter.

Route analysis derives the localized routing and metadata projection of
`07-routing-rendering-and-seo.spec.md` section 1 from public route configuration, the locale policy,
and minimal exceptional metadata. An Atlas release MUST NOT execute route code and MUST NOT require
a second route manifest.

## 6. Reachability and unused messages

Reachability is application-local. Its roots are statically recognized use, the configured recovery
messages, generated finite handle collections, referenced open families, approved local catalog
references, and the generated application configuration. An Atlas release MUST NOT treat package
availability, a public export, an external entry point, or a consumer domain record as a root.

A use inside a component template belongs to the component that owns the template. The template is
where the use is reported, because that is the file a developer opens to change it, and no module
imports a template file, so a question about the module graph is asked about the owning component.

An Atlas release MUST count a reference to a generated message group as a use of every message in
it, wherever the group is handed to something that could read any part of it, and MUST NOT count
walking through a group to reach one message or importing it. Messages selected by a value only the
running program holds are named nowhere in source, and counting either of those would make the
unused-message advisory permanently silent, and its silence indistinguishable from a clean catalog.

An Atlas release MUST follow catalog references, scope dependencies, overrides, and required assets
transitively, and MUST report an unknown reference, an incompatible dependency, an ambiguity, and a
prohibited cycle as errors.

An unused source message is a grouped, source-located advisory with an optional safe cleanup
preview. An Atlas release MUST NOT delete it, fail the compilation for it, write a tombstone, or
require a stale-identifier, waiver, use, or suppression ledger, and a consumer application MAY
select a stricter hygiene policy.

An Atlas release MUST NOT inspect the digits inside an authored catalog value. A catalog value is
the consumer application's content, and its digits may be prose or may be data: a stock-keeping
unit, a telephone number, a certification number, and a version string are literal digits that must
survive translation exactly as written, and no rule separates them from a quantity a locale would
render in its own numbering system.

## 7. Generated contracts

Generation produces the typed locale and configuration tables, the provider and scope registries
with each scope's first-render status, the application provider, the opaque message-handle trees,
collections, families, and rich-slot and input contracts, the compiled catalog chunks and catalog-
set descriptors, the application-contract and semantic-registry compatibility metadata, the route
and metadata projection, the recovery payload, and the declarations, source maps, ownership
metadata, and import map that go with them.

Generated output is deterministic, derived, and disposable. An Atlas release MUST NOT require a
consumer application to edit it, and MUST address it through the configured package-private import
base rather than a relative generated path or a compiler-only path alias.

A generated name carries no product prefix, because the import base is the consumer application's
private namespace and holds nothing but Atlas's output, so nothing inside it needs to say whose it
is.

An Atlas release MUST carry the provider, as a declaration, in the overlay that resolves those
imports while an owner is analyzed, because it is the import through which an application composes
the runtime, and an overlay without it reports that import unresolved and makes every application
look like one composing nothing. The declaration asserts nothing about its result and pulls in none
of the modules the real provider closes over.

An Atlas release MUST place the generated root inside the Angular application whose TypeScript graph
it analyzed, rather than beside an owner that merely contains that application, so it never creates
a source directory that belongs to no Angular project. An Atlas release MUST fail for an owner whose
TypeScript graph it cannot discover rather than skip it, because without a graph no call site is
analyzed, every message looks unused, and the run would publish an owner containing nothing and
report success.

Generated TypeScript follows the supported public TypeScript and Angular contract. An Atlas release
MUST NOT let a package source map or declaration carry a private or machine-absolute path from the
machine that generated it, or an embedded copy of consumer source.

## 8. Generated roots and the translation state

An Atlas release writes generated output to one conventional root inside the owner and its
disposable work state to another, and a consumer application MAY configure equivalents. An Atlas
release MUST keep the generated root and the work root separate from the authored catalogs, from
each other, from dependencies, and from ordinary build output.

The translation-state record belongs to neither root. It records, for each message and target
locale, the source and the translation as they stood when that translation was last accepted, which
is what lets a translation be reported stale once its source moves afterward. An Atlas release MUST
treat it as the consumer application's own durable project data rather than as derived output, and
MUST NOT place it under a root a project ignores by default, because a checkout without it reports
no stale translation rather than reporting that it cannot tell. Recomputing it would hash the
current source against the current translation and pronounce every translation current, which is the
one answer that is always wrong.

An Atlas release MUST write one sorted line per entry, so concurrent translation work conflicts per
message rather than across the file; MUST leave the recorded source fingerprint of a stale entry
unchanged, so the report survives later runs instead of clearing itself the first time it is seen;
and MUST NOT keep an entry for a message or a locale that no longer exists.

## 9. Output transactions

The compiler core plans output and the host writes it. Every owner has a generated completion
manifest and a disposable work journal. An Atlas release MUST lock the owner and the affected
package metadata for a mutating operation, revalidate the input fingerprints, stage the output,
compare canonical bytes, and then either publish one complete accepted generation or restore the
previous one.

An Atlas release MUST NOT depend on atomic replacement of a nonempty directory or on switching a
symbolic link. A changed file is written through a same-directory temporary sibling and the safest
same-volume replacement the host offers, with the prior state recoverable, and a sharing failure
gets a bounded retry and then a safe rollback.

The completion manifest is the commit marker and carries the identity and digest inventory of the
complete accepted set. An Atlas release MUST accept generated output only where the marker and the
applicable output identities agree before and after it is consumed, and MUST treat an absent,
changing, or mismatched marker as a bounded retry or a stale-generation failure. An Atlas release
MUST NOT let a supported watch, build, or editor integration treat an intermediate filesystem event
as a completed generation.

An Atlas release MUST NOT rewrite or touch a file whose bytes are unchanged, and MUST leave the
completion manifest untouched where the complete plan is unchanged. An Atlas release MUST derive
stale generated files from the desired set and remove them only inside a verified Atlas-owned root,
so no author maintains a list of them.

An owner's identity is the project and the location it writes to, never what it generated, so a
marker stays valid across every change to the output. An Atlas release MUST refuse an unmarked,
mismatched, mixed-ownership, linked, escaping, substituted, or ambiguous root, MUST report both
identities and the command that resolves them on a mismatch, and MUST reopen and revalidate
ownership, containment, casing, and link behavior before every mutation without following a link. A
clean operation on an absent root does nothing.

Canonical internal paths use forward slashes. An Atlas release MUST reject traversal, a
case-insensitive collision, a reserved name, a non-round-tripping encoding, and root aliasing, and
MUST NOT write into a consumer application's build output or another tool's output tree.

## 10. Project configuration

Each Atlas owner has exactly one versioned, declarative, non-executable configuration file at its
selected root, or is given that path explicitly. An application that owns no local catalog and
selects no Atlas capability needs no configuration, no provider, no scope, and no empty registry.

The configuration is closed. It declares the schema version, the source locale, the default locale,
and the supported locales, and optionally the locales a person name may be written in, the
pseudo-locales, the per-locale formatting facts, the locales still being translated, the parent
locales where the project disagrees with the pinned data, and the aliases. An Atlas release MUST
reject a property outside that set, MUST NOT accept a message or scope registry in it, and MUST NOT
accept a secret, a credential, a runtime user or tenant value, or environment-mutable state.

Every settable property carries a description, and an Atlas release MUST derive the initialization
command's option table from the schema rather than from a separate list, so an option the schema
accepts is one the help output names and a drifted table fails the build rather than shipping an
install line that is silent about a field.

An Atlas release MUST NOT support executable configuration or a second parallel configuration
source, and MUST fail with the candidates where upward discovery is ambiguous. An Atlas release MUST
NOT let an application inherit or merge a neighboring configuration by directory accident.

A consumer application selects its recovery copy through a typed provider feature using ordinary
generated handles, and an Atlas release MUST treat those handles as reachability roots and generate
the minimal independent recovery payload from their existing catalogs, so no project maintains a
marker, a raw-key list, a duplicate emergency catalog, or a parallel recovery registry. For an owner
that selects an application runtime, an Atlas release MUST report a missing or invalid recovery root
as a protected correctness error in both generation and a bare check, so build wiring runs one
deterministic command and never infers a production mode from environment state.

## 11. The command line

The executable offers initialization, generation, checking, formatting, cleaning, uninstalling,
migration, and watch.

Initialization adds compatible missing Atlas-owned setup and refuses a conflict. An Atlas release
MUST allow an interactive initialization only on a terminal, and MUST prompt only for the source
locale, the default locale, the complete supported-locale list, and any aliases before previewing
the exact plan. A noninteractive invocation supplies one option for every field the configuration
accepts; an Atlas release MUST exit with the invocation failure code and print the exact complete
invocation where a required one is missing, and MUST NOT perform a network lookup or guess a
regional locale.

Generation writes only owned plans. A bare check is read-only and offline-deterministic. In a check
that applies fixes, an Atlas release MUST apply only previewable semantics-preserving changes, and
MUST NOT invent wording, change an identity, delete a message, create a suppression, or migrate
topology. Migration is the only command an Atlas release MAY allow to change established topology,
configuration shape, generated layout, the import base, or Atlas-owned package metadata.

Formatting edits the authored document rather than rebuilding it from the semantic model. Rebuilding
is right for generated output, where nothing is the consumer application's, and wrong for a file a
person wrote, because anything the model does not carry, comments first among them, is gone by the
time the file is written. An Atlas release MUST NOT change key order, flatten a block scalar, or
remove quoting whose absence would change what a value means, and MUST refuse an unquoted spelling
it is not certain of, because the cost of being wrong is a catalog that parses to something else.

Cleaning removes verified owned build output and nothing else. Uninstalling removes Atlas from an
owner: the generated output and cache, the generated import-map entries, the Atlas package scripts,
and the project configuration. An Atlas release MUST leave the authored catalogs in place unless
their removal is requested by name, and MUST leave in place and report an import specifier or a
script that has been changed since Atlas wrote it. These are two commands rather than one command
with a flag, because a flag that turns removing build output into removing the tool eventually runs
in a pipeline by accident.

An Atlas release MUST offer a dry run wherever one is meaningful, MUST put every mutating command
through the output transaction, and MUST NOT prompt for a semantic choice in a noninteractive run.

## 12. Diagnostics and exit codes

Diagnostic severities are error, warning, and info. An Atlas release MUST NOT let a correctness,
security, compatibility, interface, ownership, or containment error be suppressed or downgraded.

Friendly behavior is the default: a bare check MUST fail only on an error, and an Atlas release MUST
keep a source-freshness finding for a contract-compatible target, an unused message, and any enabled
heuristic finding non-blocking. Strict completeness, freshness, hygiene, and custom thresholds are
opt-in policies, and an Atlas release MUST NOT let one weaken a protected error.

Strict completeness is one policy over one family. A locale with no catalog for a scope, a catalog
omitting a source message, a message omitting a required plural or ordinal category, and a
translation authored against a superseded source are one question asked at four granularities, and
an Atlas release MUST give them the same severity under the policy.

A locale is complete once its whole inheritance chain is counted. A catalog that omits a message a
locale it inherits from carries is not short of that message, and a locale shipping no catalog
beside one it inherits from is not short of a catalog. An Atlas release MUST report what is missing
against the locale that would have supplied it, once, and MUST make what the policy counts and what
the runtime renders the same answer, so a project that passes the gate is a project a strict runtime
renders.

Which locales the policy covers is a consumer application's declaration, made per locale in its
configuration: every locale is required to be complete unless it is declared still in progress, and
an Atlas release MUST keep every finding for a declared locale at advisory severity and carry the
declared reason into it. Whether a given run enforces the policy stays an invocation decision,
because the expectation belongs to the project and the enforcement belongs to the run.

Every diagnostic carries a stable documented code, and `11-diagnostics-and-observability.spec.md`
owns the codes themselves. Human output is concise, deduplicated, source-located, and actionable. An
Atlas release MUST render a human diagnostic as one line and MUST reduce text from a third-party
parser or validator to its sentence before carrying it, because a code frame, a stack, or an
embedded source excerpt reaches a one-line renderer as raw control characters and repeats the
position the diagnostic already states.

Machine output is deterministic versioned JSON. An Atlas release MUST write only JSON to standard
output and operational text to standard error, MUST NOT emit terminal escapes to a non-terminal, and
MUST report machine spans as zero-based end-exclusive UTF-16 offsets and human positions as
one-based.

The exit codes are:

|  Code | Meaning                                                        |
| ----: | -------------------------------------------------------------- |
|   `0` | Success below the failure threshold.                           |
|   `1` | Diagnostics reached the failure threshold.                     |
|   `2` | Invalid invocation or configuration.                           |
|   `3` | An internal or environment failure prevented a trusted result. |
| `130` | Interrupted.                                                   |

An Atlas release MUST resolve them in that order of priority, interruption first and success last,
so a run that was interrupted while already failing does not report the failure as its outcome.

A consumer application MAY narrow a suppressible advisory by code and by owner, scope, or portable
path. An Atlas release MUST NOT require a reason, an assignee, a ticket, an expiry, an approval, a
waiver registry, or a suppression ledger.

## 13. Incremental state and watch

Incremental state is an optimization. An Atlas release MUST produce byte-identical authoritative
output from a clean generation with the work root deleted and the same semantic inputs.

Cache identity uses canonical content, semantic dependencies, the owner, provider, scope, and
locale, the standards, schema, and interface identities, the relevant application configuration, and
the local extension fingerprints. An Atlas release MUST NOT put a timestamp, an event order, an
absolute path, or a process identity in it.

Cache entries are owner-partitioned, bounded, disposable, and integrity-checked, and an Atlas
release MUST ignore and recompute corrupt or incompatible state rather than fail on it.

Watch is an explicit foreground process. An Atlas release MUST NOT require a daemon, an account, a
service, an install hook, or a background workspace process for it. Startup performs a full
reconciliation; filesystem events are hints, so an Atlas release MUST debounce, reread content,
detect a missed or overflowed event, and widen to a full bounded reconciliation where it is
uncertain. The latest accepted input wins, every accepted generation goes through the output
transaction, and an Atlas release MUST NOT let watch poll a remote resource or migrate topology.

## 14. Build integration and the first run

A consumer application uses the built runtime and toolkit packages through their public exports, and
MUST NOT compile Atlas repository source or deep-import a private or generated module.

A consumer application's own scripts ensure generation is fresh before a typecheck, build, test,
server render, prerender, or packaging step that consumes generated contracts. An Atlas release MUST
supply composable commands for that and MUST NOT install a lifecycle hook, mutate a consumer
application's build implicitly, or require a private Angular builder hook or a consumer compiler
dependency.

An Atlas release MUST make generation succeed at every point in an ordinary first run, including
before a single catalog is authored, because a project with no messages is a valid project and it is
the state every project is in the moment after initialization. Initialization creates the catalog
directory and writes nothing into it, and generation on that project emits the generated modules and
reports, at the lowest severity, that there are no messages yet and where the first one goes.

An Atlas release MUST NOT make an install hook, a daemon, a preliminary generation pass, a commented
import, a checked-in generated file, a manual registry, an edit to a generated file, or a parallel
catalog manifest part of that run.

## 15. XLIFF exchange

Authored YAML stays authoritative, and XLIFF is a deterministic interchange view under the profile
of `01-standards-profile.spec.md` sections 10 to 12.

An Atlas release MUST preserve, in an export, the complete identity, the locales, the source
fingerprint, the context, the MessageFormat structure, the typed inputs and functions, the rich
slots and inline codes, the target state, and any Atlas data required to return without loss.

An Atlas release MUST match an import on protected complete identity alone, and MUST NOT match by
wording, by similarity, by file order, or by a rewritten third-party identifier. An Atlas release
MUST validate each independently processable unit and MAY accept valid units while others stay stale
or invalid, and MUST reject the whole document where the structure is ambiguous, the XML is unsafe,
or the units cannot be separated.

A compatible target from an older source revision is a stale candidate for the current operation
rather than a permanent ledger entry, and accepted content becomes ordinary catalog data. An Atlas
release MUST NOT flatten MessageFormat, corrupt an inline code, drop required metadata, invent
wording, or mark content approved on its own.

## 16. Pseudo-locales

An Atlas release generates deterministic nonproduction pseudo-locales from configuration alone, with
no authored target catalog and no consumer source change. An Atlas release MUST preserve inputs,
selectors, slots, invariant values, URLs, and grapheme safety, rewriting only the literal parts of a
parsed message, so a placeholder is never accented, padded, or elided.

Three behaviors are configured independently, and an Atlas release MUST NOT offer them as a fixed
set of modes: the direction, carried by an explicit script subtag in the locale tag itself so it
resolves through the same script table every locale uses; a signed length factor, where a positive
value expands and a negative one contracts and absence means no length change; and boundary markers,
which delimit each rendered message so a hard-coded string is visible by being untransformed. An
Atlas release MUST NOT ship a default length factor, because a generic figure is a number nobody
measured.

A pseudo-locale is identified by a tag whose script subtag carries its direction and whose region
subtag is one of the permanently unassigned user-assigned codes, exported as a named constant so a
consumer application never types one. An Atlas release MUST keep the base language that of the
source catalog, because the point is for a developer to see their own screens transformed, and a
pseudo-locale in another language tests translation coverage instead.

An Atlas release MUST NOT introduce a private-use subtag for this. A catalog locale identity may not
carry an extension or a private-use subtag, because a subtag with no application semantics would let
two catalogs differ only in a part no lookup reads. This is worth stating because the private-use
form is accepted by the platform's canonicalization, survives likely-subtag maximization, and
resolves the right direction: it is refused by Atlas alone, and only where a catalog is created.

Declaring a pseudo-locale does not generate it. An Atlas release MUST take the request on the build
command rather than from the environment, so one configuration serves the development build that
wants pseudo-locales and the production build that must not contain them, and an environment
variable set once on a build runner cannot reach the production build.

The transform runs at build time and produces an ordinary compiled catalog. An Atlas release MUST
NOT run it in the runtime and MUST NOT ship it from a runtime entry point, so excluding a
pseudo-locale from a production build is an absence rather than a guard. A derived catalog is
otherwise indistinguishable from a translation, so prerendering, server rendering, lazy scopes, and
locale switching work on it without knowing the concept exists.

## 17. Refactoring and migrations

A rename or a move uses resolved Atlas identities together with semantic analysis, previews every
affected source, generated, and public-contract change, and commits transactionally. An Atlas
release MUST NOT offer a regex-only replacement as a correctness path.

A semantic diff classifies added, removed, identity-changed, contract-changed, source-changed,
translation-changed, stale-source, and fallback-impact changes while ignoring formatting and
generated noise. It is generated review evidence, and an Atlas release MUST NOT turn it into a
maintained ledger.

Deleting a message removes the active definition and the regenerated output after reference
validation. An Atlas release MUST NOT require a tombstone, a retired-identifier registry, a waiver,
an alias, or a non-reuse ledger.

A durable configuration, schema, protocol, or authored-data migration is explicit, version-aware,
deterministic, previewable, idempotent where that applies, and recoverable. Generated artifacts
regenerate. An Atlas release MUST NOT let installation, import, generation, or watch migrate an
authored file silently.

## 18. Primary references

- JSON Schema 2020-12: `https://json-schema.org/draft/2020-12/schema`
- TypeScript compiler API and public language services: `https://www.typescriptlang.org/docs/`
- Angular compiler and build documentation: `https://angular.dev/tools/cli`
