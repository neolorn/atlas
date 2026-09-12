# Atlas diagnostics

Every code `@neolorn/atlas-toolkit` can report, and what it means. A diagnostic carries its own
summary saying what happened at the place it happened; this says what the code is about.

**Generated.** The list comes from the `AtlasDiagnosticCode` union and the sentences from the
table beside it, and the gate re-renders this file and fails when it differs. Do not edit it here:
edit `packages/toolkit/src/diagnostic-reference.ts`, which the compiler checks against the union in
both directions.

**Severity is not listed, on purpose.** Several codes carry the severity a run decides: the
completeness family and `ATL1704` are advisory or blocking depending on the command's switches and
the project's own declarations, so a severity written here would be wrong for exactly the codes
most worth looking up. What a run does with a finding is decided on severity, and the finding says
which one it carries.

## The project configuration

### ATL1001

`atlas.config.json` is not one readable JSON value: a syntax error, a repeated key, more than one value, or the configuration byte ceiling.

### ATL1002

`atlas.config.json` is readable JSON, and one of its values is not what the configuration schema allows.

### ATL1003

A locale identifier is malformed. Every place a locale is written is canonicalized first (`locales`, `personNameLocales`, a pseudo-locale tag, a `formatting` or `inProgress` key, an alias target, a catalog's own locale) and a tag the platform would accept can still be refused, including one carrying extensions or private-use subtags.

### ATL1004

A locale identifier is well formed and declared where it cannot be used: it duplicates another after canonicalization, or it names a locale this project does not serve.

### ATL1005

A locale alias is malformed. An alias is a lowercase ASCII identifier of letters, digits and hyphens: a name for a URL rather than a locale tag.

### ATL1006

A locale alias points somewhere it must not: it shadows a supported locale, or it targets a locale the project does not serve.

### ATL1007

A declared parent locale cannot be inherited from: it is the locale itself, or the chain it starts comes back to a locale already in that chain.

## The catalog file

### ATL1101

A catalog file is not the YAML Atlas accepts: invalid, oversized, or more than one document; anchors, aliases, merge keys, directives, non-string keys or non-Core scalars; a root that is not a mapping; malformed Unicode or unauthorized invisible and bidi controls; or the node, depth and message ceilings.

### ATL1102

A catalog is well-formed YAML, and one of its entries is not what the catalog schema allows.

### ATL1103

A catalog repeats a key, or its text carries a bidi construction Atlas refuses.

### ATL1104

A provider, scope or message identity written in a catalog is malformed.

### ATL1105

A target catalog declares `inputs` or `slots`. Those belong to the source catalog, and a target inherits them.

## The message

### ATL1201

A message is not valid MessageFormat 2 syntax, or exceeds the message byte ceiling.

### ATL1202

A message parses and its data model is invalid: a duplicate declaration, variant or option name, a variant key mismatch, a missing fallback variant, or a selector that reaches no annotation. Which of the two stages found it does not decide the code: the specification's division does.

### ATL1203

A message calls a function outside the Atlas 1 profile, which is the UTS #35 default registry.

### ATL1204

A message writes a function option outside the profile, or gives an option a value the profile does not allow.

### ATL1205

A message gives a function an operand it cannot take. Its own code rather than `ATL1204`'s, because a wrong option and a wrong operand have different fixes.

### ATL1206

A `.match` selects on a function that formats but does not select.

## The catalog set

### ATL1301

The catalogs of one scope do not form a set: a locale the project does not declare, a duplicate catalog, no source catalog, an empty scope, or a catalog whose role does not match its locale.

### ATL1302

A message's inputs are not usable: an unknown or unrefinable portable type, incompatible operand uses, an enum value the type cannot hold, a refinement matching no inferred input, an explicitly empty message declaring inputs, or the per-message input ceiling.

### ATL1303

A message's rich slots do not form a valid structure: unclosed or mismatched, nested where nesting is refused, used both paired and standalone, of an unregistered or undeterminable kind, refined past what the source supports, or the per-message slot ceiling.

### ATL1304

A translation does not honour the source message's contract: it invents a message, changes or invents an input, or omits a required rich slot. Also a recovery identity that does not select an existing plain message with no inputs.

### ATL1305

Generated names collide, or an open family is not well formed: two identities projecting to one generated path, a repeated placeholder, a template with no fixed part, members whose contracts differ, or a message two families both match.

### ATL1306

A scope has no catalog at all for a locale the project serves; the source locale is used in its place. One of the four completeness findings: advisory unless the run requires complete targets and the project has not declared that locale still in progress.

### ATL1307

A target catalog omits a message the source has; the source locale is used in its place. Escalates with the rest of the completeness family.

### ATL1308

A translation omits a plural or ordinal category its locale's grammar has, so those counts fall through to the catch-all. Escalates with the rest of the completeness family.

### ATL1309

A translation was written against an older source message and may no longer match it. Raised against the translation record rather than the catalogs, and escalates with the rest of the completeness family.

### ATL1310

This owner composes the Atlas application runtime and selects no recovery message, so a failed bootstrap has nothing to say.

### ATL1311

A scope defines source messages that nothing in the application reaches.

## The application

### ATL1401

TypeScript refused the application or its configuration while Atlas was analyzing it.

### ATL1402

An Angular component template could not be read or was refused: a symbolic link, a path resolving outside the selected owner, or a template Angular's own parser rejected.

### ATL1403

The analysis exceeded its source-file or byte ceiling, or was asked to resolve something outside the generated `#i18n` namespace.

### ATL1404

A route's identity cannot be used: declared in a form the localization runtime refuses, not derivable from what the route declares, colliding with another route's, or the owner declaring two route-indexing fields.

### ATL1405

A route renders nothing: it carries none of `component`, `loadComponent`, `redirectTo`, `children` or `loadChildren`.

### ATL1406

A route hides addresses from the projection, by computing its own `path` or by loading its children from a file it only references. Those addresses stay outside the localized route table and are served at their canonical form in every locale.

### ATL1407

A route loads a file through a lazy boundary that something in the initial bundle also imports statically, so the split does not happen.

### ATL1408

The configuration and the locale URL policy disagree: a configured locale with no address, an address with no catalogs, two different default locales, or more than one policy for Atlas to read.

### ATL1409

A route's leading segment is one this owner has already claimed for a locale, so the route and the locale compete for the same address.

### ATL1410

A component template spells out something about a locale that Atlas already knows and can hand it: the language subtag, the direction, or the locale's name in its own language.

### ATL1411

A component template writes a `routerLink` whose leading segment is one this owner claims for a locale.

### ATL1412

A sitemap declaration cannot be used as written: a changefreq outside the seven the protocol lists, a priority that is not a number literal between 0 and 1, a lastmod that is not a W3C date, or the owner declaring two route sitemap fields.

## The compiled artifacts

### ATL1501

A compiled artifact cannot be produced from the accepted graph: a recovery identity that resolves to no single plain message, or a catalog absent from the graph.

### ATL1502

A compiled catalog exceeds the IR node or depth ceiling.

### ATL1503

The output plan or the completion manifest is invalid: a malformed or colliding output path, an attempt to replace the reserved completion marker, or a manifest whose header, entries or plan digest do not hold.

## The generated output

### ATL1601

The generated root is not Atlas's to write: no completion and ownership manifest, an unowned file inside it, or an owner identity that is not this one.

### ATL1602

An output or authoring transaction did not complete. The message says whether the prior state was restored, because a failure that rolled back and one that could not are different situations.

### ATL1603

Generated output does not match its completion manifest: a file missing, a file changed, or the manifest itself moving while the output was being inspected.

## The command

### ATL1701

The command cannot act on how it was invoked: an unknown or malformed argument, or a noninteractive `atlas init` with a required option missing.

### ATL1702

The project could not be selected or read: no Atlas configuration inside the package boundary, a selection that is a symbolic link or not a directory, or an owner `package.json` that is missing, unreadable or not an object.

### ATL1703

An environment operation failed, or a disposable one was skipped: a corrupt or incompatible incremental cache, a cache that could not be persisted, a formatting refused because semantic equality was not proven, or a watcher that could not start or reconcile.

### ATL1704

Generated output is stale against the compilation that would produce it. Advisory unless the run requires fresh output.

### ATL1705

`package.json` does not carry what Atlas needs, or carries something that conflicts with it: the `#i18n` import mappings, the scripts `atlas init` writes, or init arguments that contradict the existing `atlas.config.json`.

### ATL1706

`atlas init` finished, and is naming the two things that are now the owner's to write: the first catalog, and a recovery message.

## Interchange, authoring, and the host

### ATL1801

An XLIFF document is not readable XML, or exceeds the Atlas byte ceiling.

### ATL1802

An XLIFF export or import cannot be performed at all: catalogs that are not the source and target of one scope, a file or unit id that is not an `xs:NMTOKEN`, a document that is not the Atlas 2.2 profile, or a source message whose markup has no XLIFF inline representation.

### ATL1803

An XLIFF unit cannot be imported as a translation: placeholders the source does not have or that the translation never renders, a segment state Atlas does not accept, notes it does not store, a unit outside the authoritative source catalog or stale against it, or an attempt to change what the authoring catalog owns.

### ATL1804

A pseudo-localization request is invalid: a length factor outside its range, a message that does not parse, or a catalog that is not a source catalog.

### ATL1805

An authored change plan, an application-local extension registry, or a semantic refactor was refused: invalid or oversized input, an invalid or duplicate operation, an undeclared or nonportable option, or a refactor whose source is unavailable and whose destination already exists.

### ATL1806

The host is outside Atlas's supported range: Node.js, TypeScript, or the Angular compiler.
