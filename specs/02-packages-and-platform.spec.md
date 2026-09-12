# Packages and platform

What Atlas ships, how it is divided, what a consumer installs, and where it runs. This document owns
package topology, entry points and the conditions under which one exists, the distribution format,
dependency direction, behavior at install and import time, the host ranges, the boundary against a
compiler host, and what a distributable has to prove before it counts as verified.

The standards editions behind any of this are in `01-standards-profile.spec.md`. What the exported
surface does is owned by the documents that own those subjects.

## 1. Package topology

Atlas ships two packages of one release line, versioned together and with separate exports and
separate dependency graphs.

| Package                  | Environment                          | Holds                                                                                                               |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `@neolorn/atlas`         | Browser and Angular server rendering | Runtime state, catalog evaluation and loading, formatting, Angular integration, request handling, testing supports. |
| `@neolorn/atlas-toolkit` | Node development tooling             | The catalog compiler, static analysis, code generation, interchange, project commands, and the `atlas` executable.  |

Node-only code, Node-only dependencies, Node globals, and compiler APIs MUST NOT enter
`@neolorn/atlas` or a consumer's browser bundle. Angular server rendering is a runtime concern, and
an Atlas release MUST NOT require the toolkit to be installed for it.

A package exposes implemented behavior. A capability that is being considered creates no package, no
entry point, no dependency, and no compatibility obligation until it exists.

## 2. Runtime entry points

`@neolorn/atlas` publishes seven entry points:

| Entry point              | Carries                                                                   | Exists because                           |
| ------------------------ | ------------------------------------------------------------------------- | ---------------------------------------- |
| `@neolorn/atlas`         | The runtime and its Angular integration.                                  | It is the package.                       |
| `@neolorn/atlas/core`    | Atlas's vocabulary, locale profiles, and route classification.            | It loads without Angular.                |
| `@neolorn/atlas/http`    | The locale request handler and its Node adapter.                          | It loads without Angular.                |
| `@neolorn/atlas/router`  | Localized routing and `provideLocalizedRouter(...)`.                      | It carries an optional peer.             |
| `@neolorn/atlas/forms`   | The localized input control.                                              | It carries an optional peer.             |
| `@neolorn/atlas/ssr`     | `provideLocalizedServerRendering(...)`.                                   | It carries an optional peer.             |
| `@neolorn/atlas/testing` | Test composition, controllable loading and participants, a render helper. | It must stay out of a production bundle. |

A secondary entry point exists for one of three reasons, and for no other: it carries an optional
peer dependency the primary must not require; it loads in an environment the primary cannot; or it
holds code a production bundle must not contain. An Atlas release MUST NOT subdivide the primary
entry point on any other ground. That a surface is large, or that some consumer might want less of
it, is not one of the three.

`core` and `http` are the environment case. Every other entry point of this package fails to load
outside a browser or an Angular server, because importing the primary in plain Node throws on the
Angular platform it carries. These two import no Angular at all, so a worker, a serverless function,
or a server that is not the Angular one can hold Atlas's classification without holding Angular. The
primary re-exports the core surface, so a consumer using the primary need not know the entry point
exists.

`testing` is the bundling case. It ships the runtime composition a test needs, deterministic control
over deferred catalog loads and participants, in-memory catalog loaders, a rendered-text helper, and
an environment reset. It MUST NOT ship the pseudo-localization transform, which is build-time work
under `10-compiler-and-tooling.spec.md`: shipping it in a runtime entry point would put it in a
production bundle behind a flag.

A consumer MUST import only declared package exports. Deep imports, internal paths, generated
private paths, source paths, and source-tree aliases are unsupported.

## 3. Entry-point isolation

An Angular-free entry point MUST NOT import `@angular/*` in its JavaScript or in its type
declarations. A type-only import is erased from the bundle and kept in the `.d.ts`, which produces
an entry point that runs where Angular is absent and cannot be typechecked there. Both halves are
verified by installing the package where `@angular/*` does not resolve.

An entry point MUST NOT reach into another entry point's sources by a relative path. Anything reached
relatively is compiled into the reaching bundle, so a file imported relatively in one place and by
specifier in another is published twice, and a duplicated class breaks `instanceof` across the
boundary. Cross-entry-point use goes through the published specifier, and it is verified against the
built distributables rather than against the sources, where a duplicate is not visible.

A base entry point MUST NOT depend on an entry point above it. The primary re-exports the core; the
core knows nothing of the primary, and that direction is what yields one copy rather than two.

## 4. Toolkit entry points

`@neolorn/atlas-toolkit` publishes a side-effect-free programmatic API, the JSON Schemas of its
public file formats, its own `package.json`, and the `atlas` executable.

Importing the toolkit API MUST NOT execute a command, mutate the process, install a hook, scan a
project, write a file, start a watcher, or perform network access. Command execution begins only
through the declared executable.

The schemas are exports rather than files inside the package, so that a consumer validating an Atlas
file against the schema Atlas actually used can resolve it by name rather than by a path into the
installed directory.

## 5. Distribution format

`@neolorn/atlas` MUST be distributed in Angular Package Format with partial Angular compilation. Its
distributable MUST carry:

- ESM output in the format the supported Angular line requires;
- an explicit export map naming every entry point;
- generated TypeScript declarations, with declaration maps;
- source maps whose paths are portable and reveal nothing about the machine that built them;
- accurate side-effect metadata;
- whatever the consuming Angular compiler needs to complete compilation.

Full-Ivy distribution and consumption of Atlas TypeScript source are prohibited. An Atlas release
uses Angular's supported library packaging pipeline; a replacement for it MUST prove the same format,
export integrity, partial compilation, declaration quality, and consumer compatibility before it is
used.

`@neolorn/atlas-toolkit` is an ordinary built Node package with explicit exports, declarations,
executable metadata, and accurate side-effect metadata. It is never packaged as browser runtime code.

Both distributables MUST remain installable by any npm-compatible package manager.

## 6. Runtime dependency topology

The Angular packages `@neolorn/atlas` imports, and RxJS, are peer dependencies supplied by the
consumer. `@angular/common` and `@angular/core` are required peers; `@angular/forms`,
`@angular/router`, and `@angular/ssr` are optional, because each is reachable only from the secondary
entry point that integrates with it.

An optional integration MUST NOT put its peer, or its implementation dependency, on the primary entry
point. A browser-only consumer installs neither the peer nor the code.

An Atlas release MUST NOT bundle or privately own a second Angular or RxJS instance. A consumer's
installed framework is the one that runs.

Only a package the runtime actually requires may appear in its dependency graph. What that graph
contains today is stated in `01-standards-profile.spec.md` section 14.

## 7. Toolkit dependency topology

The toolkit divides its graph three ways. Ordinary implementation dependencies are its own. Version
sensitive host APIs, which are TypeScript and the applicable Angular compiler packages, are peer
dependencies supplied by the consumer. Node compatibility is declared as an engines range rather than
as a dependency.

A consumer installs the toolkit as one development package. It MUST NOT have to assemble Atlas's
compiler machinery from parts.

## 8. Install and import behavior

Installing an Atlas package MUST NOT run a migration, a generation step, or any other work of its
own. A runtime module MUST be free of side effects on import, and importing `@neolorn/atlas` MUST
NOT:

- load locale data or a catalog;
- start a timer, watcher, worker, or network request;
- read or mutate the document, the Router, storage, or global state;
- register a platform effect or application state;
- install a service worker or a persistence mechanism.

Initialization happens only through the public providers a consumer calls.

Package metadata MUST let a consumer's build remove what it does not use. Testing code, optional
integrations, toolkit code, Node-only dependencies, unused locales, and unselected providers MUST
stay unreachable from a production graph that does not select them.

## 9. Host compatibility envelope

An Atlas release declares the ranges it is installable within and the rows it has been verified on,
and MUST NOT present the first as the second.

The declared ranges are the `peerDependencies` and `engines` fields of `packages/runtime/package.json`
and `packages/toolkit/package.json`. Those fields are what a consumer's package manager reads when it
decides whether an install is allowed, so they are the ranges themselves rather than a record of
them. Every other statement of a supported range, in a gate, a verification row, a generated page or
a sentence, MUST be read from those manifests, and changing what Atlas supports MUST be done by
changing a manifest.

One copy is written rather than read, and it is the exception this rule needs. The host admission
profile the toolkit ships decides inside a consumer's install, where no Atlas manifest is present to
read, so it carries the Angular and TypeScript ranges as values. It MUST be pinned against the
manifests by package verification, so a manifest that moves without it fails rather than ships.

Verification runs a built-package consumer on the development row, on an Angular patch row, and on
the row that sits at the declared lower bound of Angular, TypeScript, and RxJS at once, in the
Chromium, Firefox, and WebKit engines, and it runs the suites on each Node version the engines range
admits. A combination inside a declared range that nothing has executed is installable and not
verified, and an Atlas release MUST NOT describe it as supported.

An Atlas release MUST NOT claim a host outside these ranges, and MUST NOT imply that verifying one
combination verifies every combination a range admits.

The toolkit MUST detect an unsupported Angular or TypeScript host before it does compiler work and
fail with an actionable diagnostic, rather than attempt a best-effort private compatibility.

## 10. Compiler-host boundary

Toolkit integration with Angular and TypeScript MUST use documented, supported APIs behind
Atlas-owned adapters.

Use of an undocumented or private compiler API requires an explicit decision that names the exact
compatible host pin, the adapter that isolates it, the regression evidence for it, its effect on the
supported ranges, and how it will be replaced. A private API MUST NOT become a dependency a consumer
can reach.

## 11. Built-package verification

An Atlas release is verified through its built distributables and their declared exports. A source
import or a deep path proves nothing about a distributable, because neither is what a consumer
resolves.

Verification MUST establish, for each package:

- the distribution format and, for the runtime, partial compilation;
- the export map, the declarations, the declaration maps, and the side-effect metadata;
- that one Angular and one RxJS instance are present in a consumer's graph;
- that TypeScript and the package manager resolve every declared subpath;
- that the browser and the server rendering paths both work;
- that the toolkit is absent from a browser bundle;
- that testing code and unselected optional capabilities are absent from a consumer that does not
  select them;
- that no consumer path, machine-absolute path, temporary location, or generated consumer path
  appears in published metadata, maps, or declarations.

Atlas's own source-map paths and embedded source text are allowed to appear, because they describe
Atlas. A consumer's do not, and a map, a declaration, or any other published file MUST NOT carry an
absolute local path.
