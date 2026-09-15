# Routing, rendering, and SEO

Where a localized page lives, what identifies it across locales, what a request to it receives, and
what the document then says about itself to a crawler.

Locale identity and the resolution order behind a first request are
`03-locale-identity-and-resolution.spec.md`. The transaction a locale switch runs is
`06-runtime-and-angular.spec.md` section 7. The analysis that produces the route projection is
`10-compiler-and-tooling.spec.md`.

## 1. Ownership and the route projection

Atlas owns route-locale policy, route identity, the projection built from it, the outcome
contracts, and the metadata channels that have to agree. An application owns its route
declarations, its paths, its hosts, its edge and cache infrastructure, its content, and what its
pages mean.

Angular route declarations are the authored source. An Atlas release MUST derive one deterministic
localized route and metadata projection from them, and MUST NOT require a consumer application to
maintain a second route manifest beside them.

An analysis sees only the declarations written where it can read them. A route assembled at run
time, spread in from elsewhere, or returned by a helper is invisible to it. An Atlas release MUST
report which declarations hide addresses from the projection and MUST NOT fail the build for it,
because hiding routes from static analysis is a legitimate shape for an application to have.

## 2. Route identity and parameters

Every localized route has an identity independent of its visible path text. An Atlas release MUST
derive that identity from the route's full path, keeping literal segments as their text and
collapsing every parameter segment to one mark, so renaming a parameter changes no identity. An
Atlas release MUST NOT machine-translate route text.

Two addresses that would resolve to one identity are a collision. An Atlas release MUST report both
and project neither, and MUST report an address it cannot name within the identity grammar the same
way. A consumer application answers either by declaring an identity explicitly, which stays
available where a path and its identity genuinely diverge.

A dynamic path value is typed domain data with a declared codec. For every locale the policy names,
an Atlas release MUST check that serializing a value and parsing the result back succeeds and
serializes to the same text, MUST run that check on every build, and MUST refuse where the address
is built, naming the route, the parameter, and the locale. The comparison is over text, because a
codec may parse to a value Atlas has no equality for, and because a codec that reads its own output
back as a different value passes a check that only asks whether parsing succeeded.

The reciprocal case is not a failure. An inbound address whose parameter the codec declines to
parse means the route does not match, and an Atlas release MUST hand that address back unchanged
for the application to answer.

A spelling that is a function of the value comes from the codec. A spelling stored beside the
record cannot, because producing it is a fetch, so a consumer application declares it: per
parameter, the spelling in each locale the record has one for. An Atlas release MUST fall back to
the codec for a locale the declaration omits, and MUST drop a locale with no spelling from the
alternate cluster rather than guess one.

A declaration belongs to one navigation. An Atlas release MUST stamp it with the navigation that
made it, MUST replace the standing declaration outright when a navigation commits, including when
the arriving page declares nothing, and MUST answer a reader that names a navigation rather than a
reader that asks for whichever declaration is current. Both halves are load-bearing: the first
alone still answers a stale value to a reader asking the wrong question, and the second alone still
holds a value no page on screen has.

A declaration usually arrives after the page does, because the fetch that produces the spellings
finishes after the navigation. An Atlas release MUST project the document again when a declaration
arrives, not only when a navigation commits.

A declared spelling is application data. An Atlas release MUST require it to be a safe path segment
that parses under the route's own codec, and MUST NOT impose the codec's round-trip check on it,
because in another locale the parameter's value is that locale's spelling and requiring the two to
match would reject every correct declaration.

Route identity is a closed set in the typed surface. An Atlas release MUST fail compilation for a
URL built against an identity that does not exist or a parameter contract that is unsatisfied,
rather than throw from a function whose declared result is a string, and MUST require a projection
containing a parameterized route to supply that route's codecs.

## 3. Locale URL policies

An Atlas release publishes three policy kinds: a locale path prefix, locale-specific origins, and
locale-neutral addresses. A consumer application declares the policy exactly once, and an Atlas
release MUST NOT accept it from a second provider, because the URL locale source, the canonical
URLs, the reciprocal alternates, the redirects, and the Router adapter all read that one
declaration.

Under the path-prefix preset an Atlas release derives the defaults from the declared locales and
the route graph: one canonical prefix per locale, the canonical locale tag lowercased as the
segment, ASCII-case variants recognized only for canonical correction, lowercase static segments,
and no trailing slash except at the origin root. A consumer application declares only genuine
deviations, such as a shorter public segment, an alias, an omitted default prefix, a
locale-specific path, or a locale-neutral namespace.

An Atlas release MUST refuse a policy kind it does not serve at configuration time, naming the
kinds it does serve, and MUST NOT warn and continue, because a diagnostic that starts anyway is
silent in production and leaves the application in a state no rule describes.

The policy states intent and the build decides which locales exist. An Atlas release MUST intersect
the declared policy with the generated configuration once, into a narrowed policy, and MUST resolve,
publish, and provide from that value alone, so a site added later inherits the intersection rather
than repeating it. A locale the policy names and the build did not generate gets no prerendered
file, no server route, no alternate claim, and no client route branch, and an Atlas release MUST
treat its prefix as unsupported locale intent and ignore a remembered preference naming it. An
Atlas release MUST refuse outright a configuration that omits the policy's own default locale,
because filtering that one leaves an application with no addresses at all.

Both directions of disagreement are errors: a configured locale with no address has translations
nothing can reach, and an addressed locale the build never generated is one the application says it
serves and does not. A generated nonproduction locale is the one exemption in both directions,
because its existence is decided by the build while the policy is a source file that is the same in
every build.

Under a locale-specific origin policy the locale is carried by the origin, and three things follow.
An Atlas release MUST be told which origin this build answers at, MUST require it to be one of the
policy's own including its scheme, and MUST refuse a missing or unnamed origin at configuration,
because otherwise every request answers 400, a prerender writes no files, and the build still
succeeds. One build then prerenders one origin's locale while the document advertises addresses
that build does not produce, which is where those locales live. A locale switch is a document
navigation, because no application state crosses an origin.

An Atlas release MUST advertise or link a locale only where arriving at the address with nothing
said about preference yields that locale. That is one observation rather than a property of the
policy kind, it is the only kind of visitor a crawler is, and it is also what a reader gets from a
link opened in a new tab, copied, or returned to tomorrow. Under a prefix
or origin policy every address passes by construction. Under a locale-neutral policy one policy
gives three answers: a route every locale spells alike is negotiated and only the locale it
negotiates to is served there; a route with a localized path is a genuine per-locale address and is
advertised; and a route whose slug is spelled per locale answers a permanent redirect to the
default spelling, because the codec maps both spellings to one entity and leaves nothing for
canonicalization to keep.

## 4. Dispatch and path safety

After the host has validated the request target, locale-neutral protocol namespaces dispatch to
their owners before presentation routing. Presentation routing then evaluates canonical locale
input, recognized noncanonical locale input, reserved unsupported locale intent, and unprefixed
route candidates in the configured order.

A consumer application's host MUST reject a structurally unsafe target, meaning invalid encoding,
an encoded separator, a control character, a duplicate separator, a backslash, a dot segment, or
another ambiguous form, at its earliest boundary, before Angular routing, server rendering, locale
resolution, catalog loading, or a domain lookup. An Atlas release MUST NOT repair or reflect one. An Atlas
release supplies validators for safely parsed values; raw request-target rejection stays the host's.

Where an Atlas release is itself that boundary, in its own request handler and the adapter that
feeds it, the rejection is the release's own and it MUST classify the target as it arrived. A
parsed URL is not that target. Parsing resolves dot segments and rewrites a backslash, so a release
that carries only a parsed URL from the boundary to the classifier has repaired the target before
anything classified it, and what it then refuses or serves is the address the unsafe one was aiming
at rather than the one that arrived. The classification runs before dispatch, so an address a
locale-neutral root would have claimed is validated rather than handed to its owner unread.

Presentation routing has two entrances and an Atlas release MUST delocalize at both, through one
function: the localized location strategy for an address the browser supplies, and the localized
URL handling strategy for an address the application hands the router. Every address the route
matcher sees is therefore canonical whatever its source, so a route's guards, resolvers, data,
title, and route-scoped providers are reached by every navigation that reaches the route.

## 5. Navigation and HTTP outcomes

Three outcome classes stay distinct, as they do in
`11-diagnostics-and-observability.spec.md` section 3: an
operational failure, a requested localized representation that is unavailable, and a valid
consumer-domain outcome. An Atlas release MUST preserve a consumer-domain outcome without
reinterpreting it, and MUST NOT turn a missing translation into a missing entity.

An Atlas release builds the response and a consumer application supplies the body. The request
handler answers every outcome without a body of its own, and for an outcome with a body it calls
the application's renderer and composes the two: the status is the one Atlas resolved for the
address, a header Atlas derived replaces a header of the same name the renderer set, and a
set-cookie header is appended rather than replaced, because both sides may have a reason to write
one. A renderer is optional. An Atlas release MUST NOT let an address the locale policy declines
reach that composition, because it is not an outcome; it goes to the deployment's own handling. A
refused target MUST NOT reach it either: a structurally unsafe target has no presentation, it
carries a diagnostic rather than a route, and asking an application to draw a page for one asks it
to draw an address the release has just refused.

The status table is fixed. An Atlas release MUST answer preference-dependent locale entry with 307
for safe methods, deterministic canonical correction or declared replacement with 308, unsupported
explicit locale intent with 404 at the requested URL, a missing route or an absent entity with the
localized 404 at the requested URL, a declared permanent removal with no replacement with 410, and
a structurally unsafe target with 400 before presentation routing. An Atlas release MUST NOT render
another language as the locale that was asked for.

That table governs routing outcomes and nothing else. An operational failure is not one: it is the
consumer application's own, as section 3 of `11-diagnostics-and-observability.spec.md` classes it,
and serving maintenance or reporting a render that failed is ordinary rather than exceptional. The
status that reports one is therefore the consumer application's to declare.

Two of the three outcome classes depend on facts an address cannot supply. A routing outcome from
the table above depends partly on what the address states and partly on what only the page knows:
whether the entity the address names is absent, and whether it has been permanently removed. An
operational failure depends on nothing the address states. An Atlas release MUST supply a
declaration that carries both, and a release that supplies none leaves a consumer application with
no way to state either at an address that resolved.

One declaration, made in either of two places. A page states what it discovered while rendering,
and a renderer states what it decided with no page rendered at all, which is what serving
maintenance and reporting a failed render both are. An Atlas release MUST accept the declaration
from both and MUST give them one type, because the two differ only in where the declaration is
made. A release that gave them separate shapes would require an application moving a check from a
renderer into a page to rewrite what the check declares.

The two arms are not spelled the same way. An operational failure carries its own status, because
the release has no table for it. A routing outcome carries the fact and not the status: an Atlas
release MUST take the absence of an entity and its permanent removal as facts and MUST derive the
status from the table above, because the table above is the release's and an application writing a
status into a declaration would be restating a rule the release already applies.

An Atlas release MUST accept a declaration as a result distinct from the response a renderer
otherwise returns, so a renderer that returns an ordinary response is unaffected and no status
arrives as a declaration by accident. An Atlas release MUST NOT read a status a renderer did not
declare as a declaration, because an accidental failure and a deliberate one arriving as the same
value cannot be told apart.

A declaration is also made from inside a render, which is where the fact is discovered. An Atlas
release MUST carry it from the render to the response over a channel the two already share, MUST
NOT carry it in a header or anywhere else a client can write or a response can expose, and MUST
treat a render that declared nothing as the address's own outcome rather than as a declaration of
success. Where the render and the handler do not share that channel there is no declaration to
read, and an Atlas release MUST report that during development rather than answer from the table as
though the page had said nothing, because the two produce the same response and only the first is a
wiring fault.

A declaration governs the render that made it and nothing else. An Atlas release MUST NOT let a
declaration reach a second render at the same address, a second navigation, or a second request,
which is the rule section 2 already states for a parameter-spelling declaration and holds here for
the same reason.

Where the two can disagree the narrower rule holds: an Atlas release MUST carry a declaration where
the address resolved to a route it serves, and MUST send the status the table above gives wherever
the address resolved to anything else, because a consumer application declaring an outcome cannot
know which addresses the release answered from the table, and a rule it cannot reason about is not
one it can apply. An Atlas release MUST report a declaration it did not carry where a developer
will see it during development, naming the address, what was declared, and what was sent, and MUST
NOT report it more than once for one such pair, because the addresses it can arrive at are
unbounded and supplied by the request.

A carried operational failure is not the address's representation, so an Atlas release MUST
classify the response carrying it as private and not stored, whatever the address's own
classification is. A carried routing outcome is the address's representation and keeps the
classification the table gives that outcome.

A declaration has no response to reach on a client navigation, and an Atlas release MUST NOT
synthesize one. What it governs there is the document and the route context, under section 12.

A declaration made during prerendering has no request to answer. Both arms describe a page the
build cannot write: an absence states that a page the build was told to render does not exist, and
an operational failure states that the render meant to produce it did not succeed. An Atlas release
MUST fail the build for either and MUST NOT write the page. Section 9 already forbids prerendering
a route whose existence cannot be proven at build time, and a file written from a failed render is
served afterwards as a successful one, with no status left to say otherwise.

An Atlas release MUST build a locale-entry redirect's destination in the locale it resolved to, so
the redirect lands on a canonical URL in one hop. An address that already states its locale is authoritative,
and an Atlas release MUST NOT let a resolved preference override it.

Entry-redirect cacheability is a property of the address. A cache key is the target URI unless a
stored response names a varying header, and an entry address states no locale, so both of its
answers share one key. An Atlas release MUST classify an entry redirect as private and not stored
whether or not a preference was consulted, because marking either answer publicly cacheable lets a
shared cache hand one visitor's language to the next, and marking the other private prevents
nothing once the first is held under the same key.

Under a locale-neutral policy no address states a locale, so an Atlas release MUST classify a
successful response as varying by locale preference, including a response that consulted nothing,
because it shares a key with one that did. An Atlas release MUST NOT classify a redirect produced
under that policy as varying, because what a redirect returns is its location and that is the
matched route's canonical text, the same for every locale.

Whether a shared cache may hold a varying response depends on where the deployment reads the
preference, which is the one fact here an Atlas release cannot observe. A consumer application MUST
declare that source. A preference read from a request language header is content negotiation and
takes a varying header; a preference read from a cookie is not, and takes a private directive,
because a cache keyed on a whole cookie stores a variant per visitor.

A locale named in a programmatic navigation is an address rather than an instruction. An Atlas
release MUST resolve it to the canonical route and render it in the committed locale, and MUST
report the call in development, naming the address as written, the canonical address, and the
operation that does change locale.

An address the projection does not contain resolves to no route identity. An Atlas release MUST
commit the locale, yield no route context, and supply no body of its own, because which page
answers a missing address belongs to the application. The head is not part of that body. An Atlas
release MUST write the head of a response at such an address under section 12: a response whose
title is empty and whose description belongs to whichever page was on screen before it fails the
coherence requirement of section 15.

## 6. Canonicalization, query, and fragment

An Atlas release MUST answer with 308 only where strict parsing proves the request is a
user-independent one-to-one variant of one final canonical URL, and MUST combine compatible host,
locale, static-segment, slash, alias, and query corrections into a single hop. An Atlas release MUST
NOT case-fold or rewrite a dynamic identity except through its codec or a declared mapping.

A same-route locale switch preserves safely parsed bounded query parameters and the fragment by
default. An Atlas release MUST NOT copy raw URL text, and MUST NOT let a query or fragment value
choose an origin, an executable destination, a catalog identity, or a trust decision.

Canonical, alternate, and sitemap URLs omit the fragment and omit query parameters by default. A
bounded typed query value joins canonical identity only where a route declares a stable indexable
representation, and an Atlas release MUST NOT promote accepted transient query state into cache,
telemetry, or indexing identity on its own.

## 7. Locale switching

Switching is not a navigation. An Atlas release MUST commit a locale transaction and let the
address bar follow it, leaving the route, its parameters, and its history entry unchanged by the
switch itself, and a consumer application MUST change locale through the localization API rather
than by navigating to a localized address.

An Atlas release MUST publish a snapshot only through a transaction, including when a single scope
finishes loading, so every commit observer sees the same kind of event.

Switching has one surface. An Atlas release MUST publish the configured locales as options carrying
the tag, the bare language subtag, the writing direction, the locale's own name in its own
language, and whether it is current or arriving, MUST write the option's language, direction, and
current state onto the control the application binds, and MUST render no markup of its own. A
consumer application writes the loop and the markup, and MUST NOT spell a locale out in a template.

That name comes from Atlas's pinned locale data and travels in the generated configuration, one
string per configured locale. An Atlas release MUST NOT read it from the host's own display-name
implementation where the pinned release has one, because the engines disagree: over sixteen locales
on the four engines Atlas gates on, three differed, and a server-rendered label then changed under
the visitor on hydration. A locale the pinned release has no name for carries none, and the engine
answers for that one.

Where the current route lives in another locale is one fact. An Atlas release MUST derive the
per-locale path of the resolved route once per navigation and publish it, and MUST form the head's
alternate cluster and a switcher option's address from that one value. The head resolves the path
against the configured origin and keeps only what section 10 lets it claim; a switcher option
applies none of that, because it is a control a visitor operates rather than a claim about what
exists, so it has an address on a route that is not indexable and in an application that has
configured no origin. An Atlas release MUST write that address to the link's own address attribute
and to nothing else.

An explicit successful selection creates one history entry. An Atlas release MUST replace the
current entry for a canonical correction, MUST NOT change the address or persistence on a failed or
superseded commit, and MUST confine a progressive region's failure to that region.

## 8. Scroll and focus across a direction change

A locale switch that changes the document's reading direction MUST preserve the visitor's logical
scroll position on both axes, and an Atlas release is what preserves it.

Every engine drops the inline position, because changing the root direction reverses the inline
axis. An Atlas release MUST capture the logical distance from the inline start before the commit
and restore it re-signed for the direction the document is in afterwards, in the same frame that
restores focus and selection. An Atlas release MUST NOT read the document's scroll range at capture
or at restore, because a scroll call clamps to the range on its own and a document that has not
finished growing then costs the visitor accuracy rather than correctness.

One engine also moves the block position, and only under one condition. In the engines Playwright
1.61.1 supplies, Chromium 149 and Firefox 151 leave it untouched across a direction change and
WebKit 26.5 does not: with an element focused as the direction changes it scrolls to reveal that
element, which moves both axes. A bisect isolates the trigger exactly, a focused element together
with a direction change being sufficient and nothing else necessary, and a focus call that asks the
engine not to scroll is honored on all three, so the focus call is not what moves the page.

Writing the position once is therefore not enough, so an Atlas release MUST hold it: for a bounded
window after the restore, a viewport movement Atlas did not request and the visitor did not make is
undone by re-applying the captured position. Six bounds close that window, and an Atlas release
MUST apply all six.

| Bound                                                                             | Value                                          |
| --------------------------------------------------------------------------------- | ---------------------------------------------- |
| Armed only when the commit changes the writing direction and an element has focus | the condition the bisect isolated              |
| Closes when the commit has settled                                                | two consecutive frames with nothing to correct |
| Frame budget                                                                      | six frames                                     |
| Elapsed ceiling                                                                   | 150 milliseconds                               |
| The visitor takes over                                                            | a wheel, touch, pointer, or key event          |
| A later commit supersedes this one                                                | the commit sequence                            |

The window has to close before anything else is scrolling. From inside the restore a deliberate
scroll by the application is indistinguishable from the engine's movement, so a window still open
when the application scrolls would undo the application's scrolling, and a bound expressed only in
frames does not achieve that on a page producing frames slowly or not at all.

An Atlas release MUST NOT restore a position an application sets for itself afterwards, and a
consumer application setting one should expect to be working against scroll anchoring on a document
just relaid out in the opposite direction.

## 9. Rendering modes and prerendering

An Atlas release supports client rendering, server rendering, prerendering, and hybrid
applications, and each requirement here applies only where the consumer application selects that
mode. Render mode stays the application's declaration, because it is a decision about freshness and
authorization, and an Atlas release MUST relay the framework's own render mode values without
interpreting them.

A prerendered route has no request, so no locale can be negotiated for it and every locale's copy
is a separate address that has to exist in the build. An Atlas release MUST derive that expansion
from the route projection and the narrowed policy, so a consumer application states a route's
render mode once rather than once per locale.

Server rendering is installed with one call taking the locale URL policy, the route projection, the
generated configuration the client was configured with, and the per-route render mode declarations.
An Atlas release MUST check the route identities in those declarations against the projection
rather than accept free strings, and MUST NOT reach for a non-public framework token to read the
policy and the projection from injection, because the server table is built at module scope before
any injector exists and the framework's installer takes a concrete table at call time.

Parameter values to render ahead of time are written once as domain values and serialized per
locale through the route's codecs. An Atlas release MUST fail the build for a value with no
representation in some locale rather than omit it, because omitting it ships a page that exists in
one language and is missing in another.

A set of values that has to be fetched cannot be written where the render table is declared, and a
release that took only values written in place would limit prerendering to sets small enough to
write out. An Atlas release MUST accept the values from a function the build calls as well as from
a set written in place, and MUST serialize both the same way. Serializing both the same way is the
requirement rather than a convenience: an emitted address states its path and its render mode and
not the locale it belongs to, so an application left to complete the expansion itself would have to
recover the locale from the path text before it could choose a codec, which is the serialization
the release already performs.

A localized address is frequently non-ASCII. The build writes a prerendered page at the decoded
spelling of its address while a browser requests it percent-encoded, so a host that compares the
two as text finds nothing. A consumer application's host MUST resolve a request for a directory to
the index document inside it, matching on the decoded path. Where an Atlas release is itself the
host, it MUST decode before lookup. The requirement is on the host because a static file server, a
content network, or any deployment that answers before a rendering engine sees the request still
has to map the decoded path itself.

A public indexable page should produce meaningful localized server HTML through server rendering or
eligible prerendering. A private client-rendered application still requires locale and startup
readiness before visible UI. An Atlas release MUST NOT force prerendering onto a route whose
existence, authorization, or freshness cannot be proven at build time.

## 10. Canonical, alternate, and x-default

Each successful indexable locale representation has exactly one self-canonical URL.

A published URL is three things composed: the origin this build answers at, which comes from
configuration and carries no path; the mount point the application is served from, which the
deployment already declares to its platform and an Atlas release reads rather than asks for again;
and the address the locale URL policy spells for the route. An Atlas release MUST compose every URL
it publishes or writes into a document from those three and nothing else, so the address a crawler
is given and the address this build resolves are two readings of one fact. An address that is
already absolute keeps its own origin and is mounted on its own path.

Eligible locale variants of one route identity form a reciprocal complete alternate cluster with
canonical language tags. A variant is eligible when three things hold: the policy addresses it, the
build generated it, and the address serves it. An Atlas release MUST require all three, because
none implies another and an alternate link is a public claim that the same page exists in another
language.

An Atlas release MAY advertise a locale-neutral entry resolver as the unmatched-visitor default
only where it deterministically resolves visitors into the localized cluster without serving a
competing localized representation. An Atlas release MUST NOT emit a canonical or alternate cluster for an
unsupported-locale, malformed, missing, gone, private, or otherwise non-indexable response.

## 11. Sitemaps

A sitemap contains only canonical production representations and agrees with the route projection,
the indexing class, the alternates, and the deployment's origin.

Delivery is the consumer application's, because an address is not knowable before the deployment
is: a published URL is composed from the policy, the projection, the codecs, the parameter values
that turn a pattern into pages, the origin, and the mount point, and all six are values the
application holds when it runs. An Atlas release MUST produce the complete file set with each
file's name, contents, kind, URL count, and size, and a consumer application writes or serves it
and states the sitemap line in its robots file.

An Atlas release MUST split a set on both of the protocol's limits, fifty thousand URLs and fifty
megabytes uncompressed measured in the bytes served, because with a reciprocal alternate cluster in
every entry the size limit is reached before the count. When a split happens the file the
application published becomes the index and the pages move into numbered files beside it, so the
address a crawler was given does not change.

An Atlas release MUST emit a last-modified value only from a value a route declares, and MUST NOT
derive one from a build time or a file time, because it is the one optional element a search engine
reads and it reads it only where it can be verified. Change frequency and priority are emitted
because the format defines them and are advisory.

An Atlas release MUST validate the files against the published schemas, pinned alongside the other
normative data. Both sitemap schemas close their content model with a strict wildcard, which
demands a global element declaration for a foreign element, so an Atlas release keeps one schema of
its own whose entire content is the two imports that put both namespaces into a single compiled
set. An index file is validated against the index schema directly, because the two sitemap schemas
share a target namespace.

## 12. The document head

An Atlas release owns the head of every response it answers, and what goes in it comes from three
places. A route declares its own title and description once, against the route identity. A consumer
application supplies what a catalog cannot hold, per navigation, from what the resolution says. A
page declares what neither could know, during the render that discovered it. An Atlas release MUST
read all three, MUST apply them in that order with a later field replacing an earlier one, and MUST
NOT require a consumer application to supply a field at more than one of them.

The title and the description are sentences a visitor reads, so they are authored as messages
rather than in a metadata format of their own. An Atlas release MUST resolve a declared message
with the inputs declared beside it, MUST refuse a declaration naming a message that takes inputs
with none bound to it, and MUST refuse it where the declaration is built rather than where the page
is visited. A release that accepted one and resolved it with no inputs would write the message with
its placeholders unfilled, and nothing would report it.

A page's declaration arrives after the navigation that carries it has committed, because the fetch
that produces it finishes after activation. An Atlas release MUST re-project the document when one
arrives rather than leave the head as it was built, MUST stamp it with the navigation that made it,
MUST replace a committed declaration outright when a navigation commits, including when the
arriving page declares nothing, and MUST discard the declaration of a navigation that was
cancelled. These are the rules section 2 states for a parameter-spelling declaration, and they hold
here because the hazard is the same: a head describing the previous page.

The head is written whole. An Atlas release MUST remove everything it wrote for the previous
document before writing the next, so no head carries a mixture of two pages, and MUST NOT require a
consumer application to clear a field by declaring it empty.

What the address implies is derived rather than merged. The canonical URL and the alternate cluster
of section 10, the social block of section 13, and the robots metadata of section 14 are read from
the outcome in force for this render rather than carried over from the projection, so a declared
absence or removal withdraws what the projection would have claimed. An Atlas release MUST
recompute them after a declaration and MUST NOT leave a canonical or an alternate standing on a
response the page has declared absent or removed, because an alternate link is a public claim that
the same page exists in another language and section 10 already forbids one on a missing or gone
response.

An indexing class may be narrowed by a declaration and MUST NOT be widened by one. A page may
declare that it is not to be indexed today; it MUST NOT declare itself indexable where the route's
own class under section 14 says otherwise, because that class is a property of the address and a
page that could raise it could publish an address the application withheld.

A response with no route identity has no route-keyed declaration to read, and that does not make
its head the application's to write by hand. A consumer application declares one document per
outcome class instead of per route: for an address that named no route, for one whose entity was
declared removed, and for a locale the deployment does not serve. An Atlas release MUST read those
declarations for a response of the matching class, MUST author them as messages so that catalog
completeness answers for them under the same diagnostic as every other message rather than under a
second mechanism, and MUST report a class with no declaration when a response of that class is
answered, because the response is otherwise served with no title.

## 13. Social metadata

Social preview metadata is completed jointly. A consumer application supplies what only it knows,
the preview image, its alternative text, the site name, and the card format. An Atlas release
supplies the localized title and description, the canonical URL, and the locale identity with its
eligible alternates, and MUST emit no social block until the application has supplied an image,
because the format requires one.

An Atlas release MUST write the social locale in the underscore form that format specifies rather
than the language tag used elsewhere in the document, MUST resolve the territory from the maximized
locale profile where the format is silent, MUST omit a script subtag the format has nowhere to put,
and MUST emit no locale value at all when no territory can be determined, because a consumer of the
markup cannot distinguish a malformed value from an unrecognized territory.

An Atlas release MUST NOT list a page's own locale among its social alternates. This is the
opposite of the alternate cluster in section 10: there the set answers which addresses serve this
page, and here it answers which other languages this page is also available in. Both come from the
same eligible-variant set, so the divergence belongs to the two formats rather than to the data.

Open Graph properties are addressed by property and card metadata by name. An Atlas release MUST
emit a card tag only where the card format has no Open Graph equivalent, because the card processor
falls back to Open Graph.

## 14. Indexing classes

An Atlas release models three indexing classes, indexable, non-indexable, and private, and they
drive the robots metadata, the robots header, canonical and alternate eligibility, and sitemap
inclusion. Routes are indexable by default and a consumer application marks only the exceptions.

A consumer application names the route-data field carrying that classification, together with the
values in it that mean each class, so a project that already classifies its routes points Atlas at
the field it has. An Atlas release MUST read a field name it was given rather than one of its own
invention, MUST treat a value the declaration does not list as indexable, and MUST supply a
documented default field for a project that declares none.

An Atlas release MUST read that declaration from the provider file's source text when the owner is
compiled, and MUST NOT execute consumer code to obtain it, which is why the declaration is a field
name and a table of literals rather than a predicate.

Sitemap claims are declared the same way and read at the same moment: a named field whose values
map to what the class claims, with a second named field carrying the last-modified date. An Atlas
release MUST refuse a value the protocol would reject when the owner is compiled rather than drop
it, because a silently omitted claim turns a mistyped one into a page that says nothing. There is
no default class here: a value the table does not list claims nothing.

An Atlas release MUST emit a non-indexable directive through both the server-rendered metadata and
the HTTP header where the host integration supports both. A robots directive is defense in depth
and MUST NOT be relied on by a consumer application as authentication or confidentiality, and a
robots file does not replace it, canonicalization, or authorization.

## 15. Error presentation and coherence

An Atlas release MAY render an unsupported-locale response in a last known supported presentation
locale while stating that the requested locale was not activated. An Atlas release MUST NOT mutate locale persistence,
advertise the unsupported locale, or reflect arbitrary path values into links on one.

An ordinary missing route under a supported locale uses that locale for the root language and
direction, the accessible content, the title, and any trusted recovery destination, and an Atlas
release MUST keep it a 404 rather than redirect to a homepage or a guessed route. An unknown
unprefixed route is a direct 404 rather than a locale negotiation, and an Atlas release MUST emit
no canonical or alternate relationship for it.

A completed coordinated representation tells one story. The canonical route locale, the content
language, the root language and direction, the visible messages, the title and description, the
social metadata, the localized structured-data fields, the route projection, the catalog snapshot,
and the hydration state identify the same representation. The root language and direction come from
the document effects of `06-runtime-and-angular.spec.md` section 1, and a consumer application that
withdraws them owns this claim itself.

A progressive transition may contain independently delayed regions, language-independent values,
user-authored content, or intentionally multilingual content. An Atlas release MUST preserve each
region's actual language, direction, readiness, and outcome rather than relabel it as the primary
locale.

Machine identifiers, URLs, schema names, enum values, currencies, instants, and numeric values stay
machine data. A human-language field uses its message result or its participant result, and an
Atlas release MUST NOT admit a consumer payload into the localization snapshot.

## 16. Security and cache boundaries

An Atlas release MUST take canonical origins and redirect targets from trusted configuration rather
than from a request-controlled host or header, and MUST NOT let a locale switch create an open
redirect, host injection, cache poisoning, provider crossover, or leakage between request contexts.

An Atlas release MUST emit the cache directives it fully determines and MUST take the durations it
cannot choose as arguments, because whether a shared cache may hold a response is a conclusion
about Atlas's own routing while how long to hold it is a number Atlas has no basis to pick. The
classification stays available on its own for an application composing the header itself, and
setting the header stays the host's.

An Atlas release MUST express what it emits as a set of headers by name rather than one header's
text, so an application writes the set with one loop and gains a header a later release adds
without changing a line. Where a classification's correctness would depend on the duration supplied
with it, the classification is wrong.

## 17. Primary references

- RFC 3986, Uniform Resource Identifier (URI): Generic Syntax:
  `https://www.rfc-editor.org/rfc/rfc3986`
- RFC 9110, HTTP Semantics: `https://www.rfc-editor.org/rfc/rfc9110`
- Sitemaps XML format 0.90: `https://www.sitemaps.org/protocol.html`
- Google Search Central, Localized versions of your pages:
  `https://developers.google.com/search/docs/specialty/international/localized-versions`
- The Open Graph protocol: `https://ogp.me/`
