# Runtime and Angular

What a running application gets from `@neolorn/atlas`: how a message is evaluated, what the
localization state holds, how a locale change is prepared and committed, and how all of it behaves
under the rendering modes Angular supports.

Compiled catalogs arrive and are admitted under `05-compiled-artifacts-and-trust.spec.md`. Routing
is `07-routing-rendering-and-seo.spec.md`, formatting and localized input are
`08-formatting-parsing-and-domain.spec.md`, and what a runtime reports about itself is
`11-diagnostics-and-observability.spec.md`.

## 1. Composition

An application composes the runtime once, at its own root, by calling the generated
`provideLocalization` from its generated namespace. That function already closes over the
configuration, the local catalog set, the catalog loaders, the recovery message, and the route
projection, so a consumer application assembles none of them by hand. `provideLocalizationSetup`
takes the same setup explicitly, for an application with a reason to compose it itself. An Atlas
release MUST accept feature providers as the only other argument to either.

A feature provider exists for a decision Atlas cannot determine. The features are the locale
sources and their order, persistence stores, routing, the recovery message, the formatting context,
extension bindings, withdrawal of the document effects, the locale announcement, the clock, the
relative-time policy, the overlay adapter, and the observability sink.

Behavior no application would decline is on without being asked. An Atlas release MUST apply the
document language and direction, restore focus, selection, and scroll position across a locale
change, and announce the change to assistive technology, all without a provider, and MUST offer a
withdrawal of the document effects for an application rendering inside a host page that owns the
document itself. The announcement provider replaces the wording of an announcement that already
happens.

Import-time and injection-time behavior is `02-packages-and-platform.spec.md` section 8. A feature
acts only where its provider is installed.

## 2. Handles and evaluation

Every ordinary translation surface takes a generated handle rather than a free-form key. The handle
carries the provider, the scope, the message identity, the input contract, the slot names, the
result kind, and the generated ABI, as `04-message-authoring-and-catalogs.spec.md` section 9
projects them.

An Atlas release MUST evaluate a handle synchronously once the scope holding it is ready, and MUST
NOT start a catalog load, a network request, or any other deferred work from an evaluation call.

Plain evaluation returns text. Structured evaluation returns immutable parts and requires a binding
for every slot the handle declares. An Atlas release MUST NOT convert a structured result into
trusted markup on its own; `09-safe-content-and-ux.spec.md` owns what may be trusted.

Every result carries the locale that was asked for, the locales that were attempted, the locale that
actually supplied it, the language and direction of that locale, whether the answer is a fallback,
and any diagnostics. An Atlas release MUST report the supplying locale on the result rather than
assume it is the committed primary locale.

Synchronous evaluation against a runtime that is not ready, or against a scope that is not loaded,
is a programmer error. An Atlas release MUST raise a typed error naming the scope, and MUST NOT load
the scope implicitly or return the identifier as text.

## 3. Angular reactivity and templates

An Atlas release MUST work in a zoneless, OnPush application through Angular's documented signal and
scheduling contracts, and MUST NOT depend on `zone.js`, a manual change-detection sweep, or an
undocumented lifecycle order.

Reactive evaluation returns memoized readonly signals whose dependencies include the snapshot
identity and the reactive inputs. A component inside an already ready snapshot may use the
synchronous methods instead.

The template surfaces are the generated component fields, the message pipe, the formatting pipes
(eleven, one for each canonical value kind), the standalone structured-message component, the label
directive for a message in attribute position, the locale-choice directive, the recovery component,
and the localized-input directive in the forms entry point. The structured-message component takes a
handle with its exact typed inputs and trusted slot bindings and performs no loading.

Every pipe reads the ambient snapshot, so an Atlas release MUST declare each one impure. A pipe that
resolves an ambient locale cannot also be pure. The message pipe is plain-text only. A formatting
pipe is typed to one canonical value kind and to the options that kind leaves open, MUST render an
empty string when its formatter reports, and MUST report that diagnostic through the observability
sink.

## 4. The snapshot and the three locale roles

The committed snapshot is immutable and holds an identity, the primary locale, the document
direction, the required scopes, the loaded scopes, whether the state is degraded, the generated ABI,
the standards profile, the catalog-set identity of each provider, the complete formatting context,
and the route projection when routing is installed. An Atlas release MUST NOT admit a consumer
record, a participant payload, an acquisition result, or a credential into a snapshot.

Three locales are distinct and an Atlas release MUST keep them so.

| Role             | Is                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Primary locale   | The committed locale of the document, the root message context, and the default formatting context.      |
| Target locale    | The locale a transition is preparing. It is pending state and is never inferred from the primary locale. |
| Supplying locale | The locale a single result, part, or region actually came from.                                          |

Required scopes and loaded scopes are also distinct. A scope may be loaded without being required by
the current view, and an Atlas release MUST NOT commit a snapshot whose required scopes are not all
ready in the primary locale.

Readonly signals expose the lifecycle, readiness, the committed snapshot, the pending target, per
scope and per participant state, degradation, and the last transition result. An Atlas release MUST
NOT let a consumer application mutate that state or construct a snapshot it will accept.

## 5. Lifecycle

A runtime is uninitialized, initializing, ready, transitioning, or failed. Fallback or stale content
is a flag on a valid ready snapshot rather than a state of its own, and a recoverable transition
failure returns to the previous ready snapshot.

Initialization resolves the authoritative locale, loads every startup scope, builds one complete
snapshot, and publishes it once. An Atlas release MUST coalesce equivalent concurrent
initialization, and MUST NOT publish a partial runtime.

When no initial snapshot can be built, an Atlas release MUST expose a typed failure and the
generated recovery payload. Section 11 of `03-locale-identity-and-resolution.spec.md` owns the
renderer for that payload. An explicit retry starts a new attempt.

## 6. Contexts and request isolation

One context per application root, or per server request, is the ordinary case. A child context may
be created for a route or a component subtree; it inherits what it does not state, owns its own
lifetime, and an Atlas release MUST NOT let it mutate or leak into its parent, a sibling, or another
request.

The target and primary locale, persistence state, participant registrations, transition state, and
installed effect adapters are context-local. An Atlas release MUST create an adapter that holds
request state in the context that owns it rather than in the application configuration, because one
configuration object serves every concurrent server-rendered request and the first context destroyed
would dispose the adapter for all of them. An Atlas release MUST share nothing else between contexts except
validated immutable catalog artifacts whose identity proves them interchangeable.

## 7. Locale transitions

A locale change is one transaction. Its mode is coordinated or progressive.

In coordinated mode an Atlas release MUST validate the request, resolve the route and formatting
context, load and admit every required scope, wait for every required participant, build one
candidate snapshot, and keep the current view rendered and usable until that candidate commits.

In progressive mode an Atlas release MAY commit the primary locale and the ready scopes while
registered regions finish independently, and MUST expose each region's transition identity,
readiness, outcome, supplying locale, and direction. An Atlas release MUST NOT decide whether such a
region shows a placeholder, keeps its old content, hides itself, retries, or substitutes something
else.

A transition ends in exactly one outcome: committed, cancelled, superseded, failed, or redirected. A
redirect is the answer when the target locale is served by another origin, and it carries the
address rather than a diagnostic, because nothing failed.

An Atlas release MUST coalesce equivalent in-flight requests, MUST let the latest distinct intent
win, and MUST NOT let a superseded transition commit, persist, or overwrite the diagnostics of the
current one. Superseded work is cancelled where cancellation is possible and invalidated by
transition identity in every case.

In coordinated mode an Atlas release MUST leave the prior address, view, snapshot, document state,
focus, and persistence unchanged when a transition is cancelled, a guard rejects it, or its
preparation fails. In progressive mode an Atlas release MUST confine a region's failure to that
region and MUST NOT roll back an already valid commit.

## 8. Participants

A region whose content belongs to the application rather than to a catalog takes part in the
transaction by registering a participant. An Atlas release MUST hand a participant the target
locale, the effective formatting context, the transition identity, and a cancellation signal, and
nothing else about the transition.

A participant keeps its payload in the consumer application's own services, stores, signals, and
components. It reports readiness, the representation it actually supplies, and bounded safe
identity. An Atlas release MUST NOT read, copy, cache, or transfer that payload.

A report is one of four kinds: ready, with the representation supplied; unavailable, meaning the
content exists in no locale; a consumer-domain outcome the application classifies; or an operational
failure. An Atlas release MUST preserve the last two without reinterpreting either, and MUST NOT
turn a missing translation into a domain outcome or a domain outcome into a localization failure.

A representation states whether it is locale-bound, language-independent, user-authored,
multilingual, of a fixed language, or of unknown language, and carries the language and direction
that go with it. A consumer application that serves content from a locale other than the target one
MUST report ready with that locale as the supplying locale rather than report unavailable, so the
region can declare the language it is really in.

A participant is required or progressive. A required participant reporting unavailable or failed
fails the transition. A consumer application MAY set a cancellable deadline on a participant; expiry
is an operational failure and MUST NOT authorize an incomplete coordinated commit. Catalog loading
itself has no elapsed-time limit.

## 9. Scope readiness

Which scopes the first render loads is derived from the route tree Atlas already analyzes. A scope
every use of which sits behind a lazy boundary loads with the route that needs it; a scope used
anywhere eager, or used nowhere Atlas can see, is a startup scope. An Atlas release MUST NOT require
a consumer application to list startup scopes or per-route scopes.

Startup means loaded for the locale the page started in, so an Atlas release MUST have every scope
the current view renders ready in the target locale before a coordinated commit, startup scopes
included.

Each scope reports its readiness: the scope, the target locale, whether it is idle, loading, ready,
or failed, which locales supplied it, and the transition it belongs to. An Atlas release MUST hold a
newly activated scope behind its readiness boundary or keep its previous compatible content, MUST
NOT publish a partial scope, and MUST NOT present a catalog from an unrelated locale as the
committed target.

## 10. Server rendering, transfer, and hydration

Server rendering and prerendering use a request-local context. An Atlas release MUST NOT emit a
meaningful localized representation before the primary locale and the startup scopes of that request
are ready.

The server transfers the primary locale, the formatting context, the admitted catalogs, the
participant records, and the route projection when routing is installed. The rules that bound and
revalidate that transfer are `05-compiled-artifacts-and-trust.spec.md` section 2. An Atlas release
MUST adopt the transferred primary locale, catalog set, route projection, direction, and formatting
context before any later transition, MUST NOT renegotiate the locale during hydration, and MUST NOT
reload a catalog the transfer already carried.

The locale the server rendered in is reported separately from the committed one, and is absent when
the browser rendered the document.

Content behind a deferred hydration boundary is rendered on the server and adopted when its trigger
fires, which may be after a locale has committed. Angular's ordinary update pass then finds the
stored binding value no longer matching the committed locale and writes the current value over the
claimed DOM, so an Atlas release MUST NOT ship a repair for a deferred block. What has to hold is
stated here as a rule so that a framework change leaving a claimed boundary stale would be caught:
an Atlas release MUST keep localized content inside a hydration boundary part of the committed
representation, and a consumer application MUST NOT place localized content behind a boundary that
public Angular APIs cannot hydrate or replace coherently.

## 11. Effects, persistence, and disposal

The route, the root language and direction, the core messages, the formatting context, and the
overlay language are coherence-critical and stage with the snapshot they belong to. Title and
metadata join the commit where document coherence requires it.

An Atlas release MUST run persistence, the announcement, and comparable non-visual effects after the
commit they belong to, MUST carry the transition identity into each, and MUST NOT let an older
completion overwrite a newer selection. An Atlas release MUST report a persistence failure and MUST
NOT roll back an otherwise valid commit for one.

An optional effect's failure is contained to that effect. When a coherence-critical effect fails, an
Atlas release MUST either prevent the commit or trigger complete recovery, and MUST NOT leave false
document state behind either.

Destroying a context cancels its pending work and releases its effects, listeners, subscriptions,
loader references, pinned cache entries, and participant registrations. An Atlas release MUST NOT
let that disposal reach another context or a consumer application's own store.

## 12. The testing surface

`@neolorn/atlas/testing` exports seven things: the testing providers, an in-memory catalog loader
factory, a controllable participant, a controller over deferred catalog loads and participant
attempts, a rendered-text helper, an environment reset, and a server seat. An Atlas release MUST
provide deterministic control over deferred loading and participant outcomes through them, without a
network call and without shared global state.

The server seat answers an address the way a deployment would and hands back what was answered. What
a consumer application has to be able to assert about its own use of Atlas is the response: the
status, the headers, and the head. None of the three is reachable from a component seat, because
each is decided by the request handler rather than by the page, so a consumer application with only
a component seat writes a server of its own, builds it, starts it on a port, and reads its answers
back over a socket. An Atlas release MUST supply the seat, MUST answer through the same request
handler a deployment uses rather than through a second implementation of the same rules, and MUST
NOT require a listening socket, a built bundle, or a browser to use it.

An Atlas release MUST make a declared page outcome observable through that seat. Section 5 of
`07-routing-rendering-and-seo.spec.md` requires the declaration to travel over a channel no response
exposes and no client can write, so nothing outside the release can otherwise observe whether it was
carried.

The environment reset is there because an Angular test host reuses one DOM across spec files, which
gives every file in a worker the same address bar, cookie jar, and web storage, and Atlas resolves
the locale from the address when routing is installed and from a store when persistence is. An Atlas
release MUST export that reset and MUST use it in its own documented testing recipe.

Pseudo-locales are not part of this surface. A test that wants one loads a generated pseudo-locale
catalog like any other catalog, because the transform runs at build time under
`10-compiler-and-tooling.spec.md` and the runtime cannot tell a pseudo-locale from a translation.

## 13. Primary references

- Angular 22, Zoneless: `https://angular.dev/guide/zoneless`
- Angular 22, Signals: `https://angular.dev/guide/signals`
- Angular 22, Hydration: `https://angular.dev/guide/hydration`
- Angular 22, Incremental hydration: `https://angular.dev/guide/incremental-hydration`
