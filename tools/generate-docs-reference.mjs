/**
 * The reference pages that are read out of a source of truth rather than written.
 *
 * Five pages, and none of them is a description of something else that has to be kept in step with
 * it.
 *
 * The command line page is the built CLI's own `--help`, captured by running it. That is the exact
 * text a reader sees in their terminal, which is what makes it worth publishing: a page that
 * paraphrased the help would be a second wording of the same thing, and the two would agree until
 * a flag moved.
 *
 * The configuration page is the schema staged into the built package. Every field,
 * its type, whether it is required, and the sentence describing it all come from the schema, which
 * is also what validates the file and what `atlas init --help` prints its flags from. A key added
 * to the schema appears here on the day it lands.
 *
 * The entry point page is the `exports` map of each built manifest, and what each entry point
 * publishes is read out of the declaration file that entry names. What a reader needs beyond that
 * is a sentence saying what the entry point is for, and a sentence cannot be read out of anything,
 * so it is written here and checked against the discovered set: an entry point added to a manifest
 * fails this generator until someone says what it is for, which is the only part of the page a
 * person has to write.
 *
 * The features page is the set of exports whose declared return type makes them composable, which
 * is the scan `verify:guide-coverage` reads to decide what needs a page. A feature added today is on
 * this page today, and what each one selects is a written sentence checked against the discovered
 * set in both directions.
 *
 * The compatibility page is the peer ranges and the engines field, which are what an install reads,
 * together with the versions the matrix actually runs. Both halves come from `supported-versions`,
 * so the page cannot claim support for a version no row proves, and cannot omit one the packages
 * admit.
 *
 * `--check` re-renders all five and fails when what is checked in differs, which is the same
 * mechanism the diagnostics table and the init option table use.
 *
 * One table is not generated and is pinned instead. The README states the supported ranges rather
 * than linking to them, because someone deciding whether to adopt Atlas reads that page and nothing
 * else. That makes it a second copy of a claim whose original is a manifest, and a second copy is
 * held against its original here: a manifest that moves without the README fails this stage rather
 * than shipping a page that promises a range Atlas no longer supports.
 *
 * The CLI is run with its working directory outside this repository. Running it here would look for
 * an owner to act on and find one, and no page is worth that.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { consumerProfiles } from './package-consumer-profiles.mjs';
import {
  composableExports,
  isComposable,
  publishedNames,
  toolkitDeclaration,
} from './published-surface.mjs';
import {
  compareVersions,
  developmentNode,
  nodeFloors,
  nodeRange,
  optionalPeers,
  peerRange,
  runtimePeers,
} from './supported-versions.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtToolkit = resolve(workspaceRoot, 'dist/toolkit');
const referenceRoot = resolve(workspaceRoot, 'docs/reference');
const check = process.argv.includes('--check');

const GENERATED_NOTE =
  'This page is generated from the packages and is not edited by hand.';

/* ------------------------------------------------------------------ *
 * The command line.                                                   *
 * ------------------------------------------------------------------ */

// Outside the repository, because the CLI acts on the directory it is run in.
const elsewhere = mkdtempSync(join(tmpdir(), 'atlas-help-'));
const help = execFileSync(
  process.execPath,
  [resolve(builtToolkit, 'cli.js'), '--help'],
  { cwd: elsewhere, encoding: 'utf8' },
)
  .replaceAll('\r\n', '\n')
  .trimEnd();

assert.ok(
  help.includes('Usage: atlas <command> [options]'),
  'The built CLI printed something that is not its help text.',
);

// The version line changes on every release and says nothing a reader of this page needs, and
// carrying it would make this file part of the release diff for no reason.
const helpBody = help.replace(/^Atlas toolkit [^\n]*\n\n/u, '');

const cliDocument = `${[
  '# Command line',
  '',
  'Every command and every flag the `atlas` command line accepts. The text below is the output of',
  '`--help` on the built CLI, captured by running it.',
  '',
  GENERATED_NOTE,
  '',
  'Running these commands in a project is',
  '[How to run generation in your build](../how-to/run-generation-in-your-build.md).',
  '',
  '```text',
  helpBody,
  '```',
  '',
  '## Exit codes',
  '',
  'A build reads the exit code rather than the output, because "your catalogs have a problem" and',
  '"this invocation was wrong" are two different things to wake someone up for.',
  '',
  '| Code | Means |',
  '| ---- | ----- |',
  '| `0` | Success |',
  '| `1` | Diagnostics were reported |',
  '| `2` | The invocation or the configuration was wrong |',
  '| `3` | The environment could not support the run |',
  '| `130` | Interrupted |',
]
  .join('\n')
  .trimEnd()}\n`;

/* ------------------------------------------------------------------ *
 * The configuration.                                                  *
 * ------------------------------------------------------------------ */

// The staged schema file rather than the module that exports it. It is the same schema, it is what
// a consumer's editor reads out of their install, and it is a JSON document with no dependencies of
// its own to resolve from here.
const schemaPath = resolve(
  builtToolkit,
  'schemas/configuration.v1.schema.json',
);
let schema;
try {
  schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
} catch (error) {
  throw new Error(
    `Could not read ${schemaPath}. This generator reads the built package rather than the source, so run pnpm run build first. (${error?.message ?? error})`,
  );
}

assert.ok(
  schema?.properties !== undefined,
  'The staged configuration schema describes no properties.',
);

const required = new Set(schema.required ?? []);

/** What a field accepts, said the way the schema says it. */
function shapeOf(field) {
  if (field.enum !== undefined) {
    return field.enum.map((value) => `\`${value}\``).join(' or ');
  }
  if (field.type === 'array') {
    return `a list of ${shapeOf(field.items ?? {})}`;
  }
  if (field.type === 'object') {
    const values = field.additionalProperties;
    if (values === undefined || typeof values === 'boolean') return 'an object';
    return `a map of ${shapeOf(values)}`;
  }
  if (Array.isArray(field.type)) return field.type.join(' or ');
  return field.type ?? 'any value';
}

const fields = Object.entries(schema.properties)
  .filter(([name]) => name !== 'schemaVersion')
  .map(([name, field]) => ({
    name,
    shape: shapeOf(field),
    required: required.has(name),
    description: field.description ?? '',
  }));

assert.ok(
  fields.length > 0,
  'The configuration schema described no settable field.',
);

const configurationDocument = `${[
  '# Configuration',
  '',
  'Every field `atlas.config.json` accepts. The table is read from the schema that validates the',
  'file and produces the flags of `atlas init --help`.',
  '',
  GENERATED_NOTE,
  '',
  'What the locale fields mean for a visitor is',
  '[About how a locale is resolved](../explanation/about-locale-resolution.md).',
  '',
  '| Field | Accepts | Required | What it is |',
  '| ----- | ------- | -------- | ---------- |',
  ...fields.map(
    ({ name, shape, required: isRequired, description }) =>
      `| \`${name}\` | ${shape} | ${isRequired ? 'yes' : 'no'} | ${description} |`,
  ),
  '',
  '## The version field',
  '',
  '`schemaVersion` is written by `atlas init` and read by everything that opens the file. It is not',
  'a field you set: it says which shape the rest of the file is in, and a version this release does',
  'not understand is refused rather than guessed at.',
]
  .join('\n')
  .trimEnd()}\n`;

/* ------------------------------------------------------------------ *
 * The entry points.                                                   *
 * ------------------------------------------------------------------ */

/**
 * What each published entry point is for.
 *
 * The list of entry points is discovered. These sentences are not, and cannot be: nothing in a
 * declaration file says why the entry point exists. Checked against the discovered set below in
 * both directions, so neither a new entry point without a sentence nor a sentence for an entry
 * point that no longer ships can pass.
 */
const PURPOSE = Object.freeze({
  '@neolorn/atlas':
    'Everything an application component and its bootstrap need.',
  '@neolorn/atlas/core':
    'The value builders, the contracts and the address helpers, with no Angular injector involved. This is what a library or a test helper imports.',
  '@neolorn/atlas/forms':
    'Localized input parsing and the directive that binds it to a form control.',
  '@neolorn/atlas/http':
    'The interceptor that carries the committed locale on outgoing requests.',
  '@neolorn/atlas/router':
    'Localized routing: the router setup, the link directive, and the address projection behind them.',
  '@neolorn/atlas/ssr':
    'Server rendering: per-route render modes, and the locale the server renders in.',
  '@neolorn/atlas/testing':
    'The test harness. It replaces the parts of the runtime a test cannot wait for, and nothing else.',
  '@neolorn/atlas-toolkit':
    'The compiler behind the `atlas` command, as a library. An application does not import this; a build script that needs the compiler without the command line does.',
});

const runtimeManifest = JSON.parse(
  readFileSync(resolve(workspaceRoot, 'dist/runtime/package.json'), 'utf8'),
);
const toolkitManifest = JSON.parse(
  readFileSync(resolve(workspaceRoot, 'dist/toolkit/package.json'), 'utf8'),
);

// Which entry point actually reaches an optional peer. The manifest says which peers are optional;
// the declaration file says which entry point imports it. Neither half is written here, so an entry
// point that starts importing an optional peer says so on this page that day.

/** One row per published entry point, in the order a reader meets them. */
function entryPointRows() {
  const rows = [];
  for (const [subpath, target] of Object.entries(runtimeManifest.exports)) {
    if (subpath.endsWith('.json')) continue;
    const types = typeof target === 'object' ? target.types : undefined;
    if (types === undefined) continue;
    const text = readFileSync(
      resolve(workspaceRoot, 'dist/runtime', types),
      'utf8',
    );
    const imported = new Set(
      [...text.matchAll(/from '([^']+)'/gu)].map(([, source]) => source),
    );
    rows.push({
      specifier: `@neolorn/atlas${subpath === '.' ? '' : subpath.slice(1)}`,
      names: publishedNames(text),
      text,
      needs: optionalPeers.filter((peer) => imported.has(peer)),
    });
  }
  const toolkit = toolkitDeclaration();
  rows.push({
    specifier: '@neolorn/atlas-toolkit',
    names: publishedNames(toolkit),
    text: toolkit,
    needs: [],
  });
  return rows;
}

const entryPoints = entryPointRows();

assert.ok(
  entryPoints.some(({ specifier }) => specifier === '@neolorn/atlas'),
  'The built manifests publish no primary entry point, so this page would be rendered from nothing.',
);
assert.deepEqual(
  entryPoints.map(({ specifier }) => specifier).sort(),
  Object.keys(PURPOSE).sort(),
  'The entry points this build publishes and the ones described above are not the same set. An entry point needs a sentence saying what it is for before it can appear on this page.',
);

// The composable half, which is what a reader looks an entry point up for. The same test the guide
// coverage gate applies, so a page cannot list a capability the gate does not require a guide for.
for (const row of entryPoints) {
  row.composables = [...row.names]
    .filter((name) => isComposable(row.text, name))
    .sort();
}

assert.ok(
  entryPoints.some(({ composables }) => composables.length > 0),
  'No published export returns a feature or a set of providers, so the return type scan has stopped matching.',
);

const entryPointDocument = `${[
  '# Entry points',
  '',
  'What each import specifier publishes, and what it is for. The lists are read out of the built',
  'packages.',
  '',
  GENERATED_NOTE,
  '',
  ...entryPoints.flatMap(({ specifier, names, needs, composables }) => [
    `## \`${specifier}\``,
    '',
    PURPOSE[specifier],
    '',
    `Publishes ${names.size} name(s).${
      needs.length > 0
        ? ` Needs ${needs.map((peer) => `\`${peer}\``).join(' and ')}, which is an optional peer: install it when you import from here.`
        : ''
    }`,
    '',
    ...(composables.length > 0
      ? [
          `Composable from here: ${composables.map((name) => `\`${name}\``).join(', ')}.`,
          '',
        ]
      : []),
  ]),
  '## Anything else',
  '',
  'A path that is not listed here is not published. A deep import into a package resolves in some',
  'setups and not in others, and what it reaches is free to change in a patch release, so nothing',
  'on this page is reachable any other way.',
]
  .join('\n')
  .trimEnd()}\n`;

/* ------------------------------------------------------------------ *
 * The features.                                                       *
 * ------------------------------------------------------------------ */

/**
 * What each composable feature selects.
 *
 * The set is discovered. These sentences are not, and cannot be: a declaration file says what a
 * feature returns and never what it is for. Checked against the discovered set below in both
 * directions, so neither a feature without a sentence nor a sentence for a feature that no longer
 * ships can pass.
 */
const SELECTS = Object.freeze({
  provideLocalizationSetup:
    'The runtime, taking the generated setup and the features this application selected. The generated `provideLocalization` calls it with your setup already bound.',
  provideLocalizationTesting:
    'The runtime for a test, replacing the parts a test cannot wait for and nothing else.',
  provideLocalizedRouter:
    'Replaces `provideRouter`. Resolves a localized address to the route behind it.',
  provideLocalizedServerRendering:
    'Negotiates the locale for each request and prepares the scopes that request needs, before the render.',
  withExtensions:
    'Registers formatting and parsing adapters for a value type your domain has and `Intl` does not.',
  withFormattingContext:
    'Sets what every formatter starts from: the numbering system, the calendar, the time zone, and the currency display.',
  withLocaleAnnouncement:
    'Announces a locale change to a screen reader, which is otherwise a silent event.',
  withLocaleSources:
    'Inserts a locale source of your own into the order Atlas asks in.',
  withLocalizationClock:
    'Decides what `now` is for relative time. `fixedClock` makes a test reproducible.',
  withObservability: 'Sends runtime outcomes to a sink you supply.',
  withOverlayLocale:
    'Renders one locale on top of the committed one without changing it, for reviewing a translation in place.',
  withPersistence:
    "Stores a visitor's chosen locale in a cookie, in browser storage, or in your own profile record.",
  withRecoveryMessage:
    'The sentence a visitor reads when no catalog loads at all. The one feature with no default.',
  withRelativeTimePolicy:
    'Sets the thresholds that decide which unit a relative time is said in.',
  withRouting:
    'Gives every page an address in every locale, from a URL policy and a route projection.',
  withoutDocumentLocale:
    "Leaves the document's `lang` and `dir` alone, for a widget rendered inside a host page that owns them.",
});

// The main entry point wins a name published from more than one, because that is where a reader
// looking for a feature imports it from.
const featureEntryPoints = new Map();
for (const { specifier, composables } of [...entryPoints].sort((left, right) =>
  left.specifier.localeCompare(right.specifier, 'en'),
)) {
  for (const name of composables) {
    if (!featureEntryPoints.has(name)) featureEntryPoints.set(name, specifier);
  }
}

// Against the scan the coverage gate reads, so a page and a gate cannot disagree about what a
// feature is.
const composableNames = [...composableExports().keys()].sort();
assert.deepEqual(
  [...featureEntryPoints.keys()].sort(),
  composableNames,
  'The features page and the guide coverage gate disagree about which exports are composable.',
);
assert.deepEqual(
  Object.keys(SELECTS).sort(),
  composableNames,
  'Every composable export needs one sentence here, and every sentence needs an export that still ships.',
);

const featureDocument = `${[
  '# Features',
  '',
  'Every export that can be passed to `provideLocalization`. Leaving one out selects its default;',
  '`withRecoveryMessage` is the one with no default. The list is read out of the built',
  'declarations.',
  '',
  GENERATED_NOTE,
  '',
  '| Feature | Entry point | Selects |',
  '| ------- | ----------- | ------- |',
  ...composableNames.map(
    (name) =>
      `| \`${name}\` | \`${featureEntryPoints.get(name)}\` | ${SELECTS[name]} |`,
  ),
]
  .join('\n')
  .trimEnd()}\n`;

/* ------------------------------------------------------------------ *
 * The compatibility.                                                  *
 * ------------------------------------------------------------------ */

// The entry point that reaches each optional peer, read the same way the entry point page reads it.
const peerReaders = new Map(
  optionalPeers.map((peer) => [
    peer,
    entryPoints
      .filter(({ needs }) => needs.includes(peer))
      .map(({ specifier }) => specifier),
  ]),
);

const runNodeVersions = [...new Set([...nodeFloors, developmentNode])].sort(
  compareVersions,
);

const compatibilityDocument = `${[
  '# Compatibility',
  '',
  'The versions an install accepts, and the versions each release is run on. Every range is read',
  'out of the package manifests.',
  '',
  GENERATED_NOTE,
  '',
  '## Node',
  '',
  `\`${nodeRange}\``,
  '',
  'The suites run at the lowest version of every line the range admits, and on the version this',
  'repository develops on:',
  '',
  `${runNodeVersions.map((version) => `\`${version}\``).join(', ')}.`,
  '',
  '## Angular, TypeScript and RxJS',
  '',
  '| What | Range |',
  '| ---- | ----- |',
  ...['@angular/core', '@angular/common', 'rxjs']
    .map((name) => `| \`${name}\` | \`${peerRange(name)}\` |`)
    .concat(
      ['@angular/compiler', 'typescript'].map(
        (name) => `| \`${name}\` | \`${peerRange(name)}\` (build time) |`,
      ),
    ),
  '',
  'Angular is a peer, not a dependency, so the copy that compiles your application is the copy Atlas',
  'compiles against. There is never a second Angular in your tree because of Atlas.',
  '',
  '## Peers you install only if you use them',
  '',
  ...[...peerReaders].flatMap(([peer, readers]) => [
    `\`${peer}\` at \`${runtimePeers[peer]}\`, needed if you import from ${readers
      .map((specifier) => `\`${specifier}\``)
      .join(' or ')}.`,
    '',
  ]),
  'Leave one out and the entry point that needs it is the only thing you cannot import. A',
  'browser-only application installs none of the three.',
  '',
  '## The combinations that are built and tested',
  '',
  '| Row | Angular | TypeScript | RxJS |',
  '| --- | ------- | ---------- | ---- |',
  ...[...consumerProfiles.values()].map(
    ({ label, angular, angularTooling, typescript, rxjs }) =>
      `| ${label} | \`${angular}\`${
        angularTooling !== undefined && angularTooling !== angular
          ? ` (tooling \`${angularTooling}\`)`
          : ''
      } | \`${typescript}\` | \`${rxjs}\` |`,
  ),
  '',
  "Each row builds a real application against the packages and runs it. The lower bound row's",
  'versions are the floors of the ranges above, read from the same manifests, so the row moves when a',
  'floor moves.',
  '',
  'Angular ships its framework and its build tooling on separate patch trains, so the two sit at',
  'different versions on the same day, and a row that pins only the framework leaves the tooling',
  'unwatched.',
  '',
  '## Browsers',
  '',
  'Atlas targets what your Angular build targets. It adds no browser requirement of its own beyond',
  '`Intl`, which every browser Angular supports has had for years.',
  '',
  'What varies between browsers is the data behind `Intl`. Two browsers can format the same date',
  'slightly differently in the same locale, so assert on what your application does with the result',
  'rather than on the exact string, which is',
  '[How to test localized output](../how-to/test-localized-output.md).',
  '',
  '## When a version outside the range is installed',
  '',
  'The toolkit checks the host before the compiler does anything and refuses with `ATL1806` rather',
  'than attempting a best effort. A refusal names what it found and what it wanted, so the fix is',
  'the install rather than a bisect.',
]
  .join('\n')
  .trimEnd()}\n`;

/* ------------------------------------------------------------------ *
 * The one range table a person writes.                                *
 * ------------------------------------------------------------------ */

/** What each row of the README's compatibility table has to say, read from the manifests. */
const README_RANGES = new Map([
  ['Angular', peerRange('@angular/core')],
  ['RxJS', peerRange('rxjs')],
  ['Node.js', nodeRange],
  ['TypeScript', peerRange('typescript')],
]);

/**
 * The ranges the README states, by host.
 *
 * Read by row rather than by rendering the table, because the prose around it is written and is
 * nobody's to generate. A cell states its range in a code span, and Node's range carries escaped
 * pipes because a bare one would end the cell.
 */
function readmeRanges() {
  const readme = readFileSync(resolve(workspaceRoot, 'README.md'), 'utf8')
    .replaceAll('\r\n', '\n')
    .concat('\n## ');
  const section = /\n## Compatibility\n([\s\S]*?)\n## /u.exec(readme);
  assert.ok(
    section !== null,
    'README.md has no Compatibility section, so the ranges it states cannot be held against anything.',
  );
  const rows = new Map(
    [...section[1].matchAll(/^\| *([^|]*?) *\| *`([^`]+)`[^|]*\|$/gmu)].map(
      ([, host, range]) => [host, range.replaceAll('\\|', '|')],
    ),
  );
  assert.ok(
    rows.size > 0,
    'README.md states no range in its Compatibility section, and that table is what this pins.',
  );
  return rows;
}

/* ------------------------------------------------------------------ *
 * Written, or checked.                                                *
 * ------------------------------------------------------------------ */

// Formatted the way every other document here is formatted. A generator that emitted markdown
// Prettier wanted to change would put two checks in the repository that cannot both pass.
const prettierOptions = {
  ...((await resolveConfig(resolve(referenceRoot, 'cli.md'))) ?? {}),
  parser: 'markdown',
};
const formatted = (text) => format(text, prettierOptions);

const written = [
  [resolve(referenceRoot, 'cli.md'), await formatted(cliDocument)],
  [
    resolve(referenceRoot, 'configuration.md'),
    await formatted(configurationDocument),
  ],
  [
    resolve(referenceRoot, 'entry-points.md'),
    await formatted(entryPointDocument),
  ],
  [resolve(referenceRoot, 'features.md'), await formatted(featureDocument)],
  [
    resolve(referenceRoot, 'compatibility.md'),
    await formatted(compatibilityDocument),
  ],
];

if (check) {
  for (const [target, expected] of written) {
    let current;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      throw new Error(
        `${relative(workspaceRoot, target)} is missing. Run pnpm run generate:docs-reference.`,
      );
    }
    assert.equal(
      current.replaceAll('\r\n', '\n'),
      expected,
      `${relative(workspaceRoot, target)} is not what its source of truth produces now. Run pnpm run generate:docs-reference.`,
    );
  }
  process.stdout.write(
    `Atlas docs reference verified: the command line page is the built CLI's own help, the ` +
      `configuration page is ${fields.length} field(s) read from the schema, the entry point ` +
      `page is ${entryPoints.length} entry point(s) read from the built manifests, the features ` +
      `page is ${composableNames.length} composable export(s) read from the built declarations, and the ` +
      `compatibility page is ${runNodeVersions.length} Node version(s) and ${consumerProfiles.size} ` +
      `build row(s) read from what the packages declare.\n`,
  );
} else {
  await mkdir(referenceRoot, { recursive: true });
  for (const [target, contents] of written) {
    await writeFile(target, contents, 'utf8');
  }
  process.stdout.write(
    `Atlas docs reference written: ${written.length} page(s), ${fields.length} configuration field(s), ${entryPoints.length} entry point(s), ${consumerProfiles.size} build row(s).\n`,
  );
}

const stated = readmeRanges();
for (const [host, declared] of README_RANGES) {
  assert.equal(
    stated.get(host),
    declared,
    `README.md offers ${host} at ${stated.get(host) ?? 'no stated range'}, and the packages declare ${declared}. The manifests are what an install reads, so the table is what changes.`,
  );
}
assert.deepEqual(
  [...stated.keys()].sort(),
  [...README_RANGES.keys()].sort(),
  'README.md states a range for a host nothing here reads from a manifest, or drops one it does. Every row of that table is a manifest read back.',
);

if (check) {
  process.stdout.write(
    `Atlas README compatibility pinned: ${README_RANGES.size} range(s) stated there are the ranges the packages declare.\n`,
  );
}
