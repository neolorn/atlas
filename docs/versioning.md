# Versioning and compatibility

What the version number on an Atlas release covers, and how a release reaches you.

## One line, two packages

`@neolorn/atlas` and `@neolorn/atlas-toolkit` share a version. They are produced and verified
together, and the matching numbers say the pair in your install was tested as a pair. Upgrade them
together.

Matching versions are not a compatibility check for anything that leaves your build. A file your
project exchanges or keeps carries its own format identity, and that identity decides whether a
reader can open it. Two installs on the same Atlas version can disagree about a document whose own
format moved, and two installs on different Atlas versions can exchange one.

Atlas follows [Semantic Versioning](https://semver.org). A patch release fixes something without
changing what your code can call. A minor release adds. A major release breaks something and says
so.

## Supported versions

The contract on this page starts at 1.0.0. Nothing published before it is covered by it.

The `1.x` line is supported, and fixes are released on the current minor version. The same holds for
security fixes, which is what [SECURITY.md](../SECURITY.md) states.

## Prereleases

A release candidate is published as `1.1.0-rc.1` under the `next` dist-tag. Stable releases are
published under `latest`, so an install that names no version resolves to the newest stable release
and you opt into a candidate by asking for one:

```text
npm install @neolorn/atlas@next
npm install --save-dev @neolorn/atlas-toolkit@next
```

A candidate carries the same verification a stable release does. The surface it adds is settled by
the release it precedes, so a candidate can still change before that release.

## What the version number covers

These are the surfaces a release does not break without saying so:

- the package names and the entry points listed in [Entry points](reference/entry-points.md);
- the exported types, functions, classes, tokens, providers and signals, and what they do;
- the template and lifecycle behavior described in this documentation;
- the shape and meaning of `atlas.config.json`;
- the commands, options, exit codes and machine output of the `atlas` command;
- the diagnostic codes in [Diagnostics](reference/diagnostics.md), and the observability events;
- the extension and adapter contracts;
- the interchange format your catalogs travel in;
- the migration behavior a documented upgrade relies on.

A change that breaks a supported consumer at one of those is a breaking change, whether or not the
consumer was expected to rely on it.

## Surfaces outside the contract

Some things are visible in your `node_modules` and are still outside the contract:

- deep paths into a package that the entry point list does not name;
- internal modules, private types, and the algorithms behind a public function;
- caches, reports and work files;
- the physical path a generated file lands at, as long as the import you write for it is stable;
- the exact wording of a message written for a human to read, as opposed to the code beside it;
- which dependencies Atlas uses;
- file ordering, timestamps, and formatting.

A release that changes one of those is not labeled breaking. Safety, determinism and package
integrity are preserved across those changes.

## Generated files

Everything under your generated root is output. It regenerates, it carries an identity naming the
tooling that produced it, and it has no version of its own. There is no deprecation program for a
generated handle and no alias table keeping an old one alive.

Run `atlas generate` again after an upgrade. Generated output that is stale, or that was produced by
tooling which no longer matches, reports a diagnostic rather than being used. Install, import and
watch mode migrate nothing on their own.

An upgrade states when regeneration is required. Regeneration is not a migration: the sources are
yours, and the output comes back from them.

## Formats that outlive a release

Two things your project produces can be kept or sent somewhere and read back later: the interchange
documents your translators work in, and the machine output of the `atlas` command when you record
it.

Each carries its own identity and version, independent of the package version. An incompatible
change to one increments that format's own major version and arrives with a migration or a refusal.
A reader that cannot open a document says so.

Everything else Atlas generates regenerates with matching tooling and is not read across versions.

## Hosts and platforms

Every release declares the peer and engine ranges you can install against, and the narrower set of
combinations that were built and run. Both are on [Compatibility](reference/compatibility.md): a
range says what an install accepts, and a row says what was executed.

Support is stated as bounded ranges rather than as `Angular 22+` or `current Node`, so an upgrade
that leaves a range is one you can see coming.

Adding an Angular major or a Node line is a deliberate range change with verification behind it. An
application that works on an untested combination is evidence about that application.

## Locale data updates

Atlas pins the standards data it renders with, so the same input produces the same output for the
life of a release.

Updating that pin regenerates what it affects. A migration comes with the update only when it
changes what something means or how it is written. A standards update never changes locale identity,
matching, message evaluation, formatting behavior or interchange mapping inside a patch release. A
formatted date that changes shape is a release you were told about.

## Upgrading

An incompatible change to your configuration, your authored catalogs, a durable format, the package
layout, or a supported API arrives with one of two things: a migration you can run, or a bounded
procedure to follow where automation cannot preserve your intent safely.

A migration you run always:

- previews before it writes, so you see every change it intends first;
- validates all of that before it touches anything;
- runs as one transaction you can recover from;
- leaves your wording, your identities and your routes as they are;
- deletes nothing silently and suppresses nothing on your behalf;
- can be run twice where running it twice is legitimate.

Generated output is regenerated rather than migrated in place.

## Deprecation

Deprecation is proportional to how much a surface is used and what replacing it costs. Atlas runs no
fixed deprecation window and maintains no alias tables or compatibility shims.

Where a deprecation is warranted rather than a clean removal, it names the affected surface, gives a
replacement or explains the removal, and raises a diagnostic where the tooling can see the usage. It
also states the earliest release the surface can disappear in.

A security or correctness defect can force a faster removal. The release states why and what it
costs.

## Release notes

In proportion to what it contains, a release identifies the capabilities and fixes, the breaking
changes and deprecations, the migrations and any regeneration you need to run, the host and runtime
ranges it was tested against, the standards identity it pins, any change to a durable format, and
the limitations worth knowing about before you upgrade. It describes what changed for you.
