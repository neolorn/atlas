#!/usr/bin/env node
/**
 * The person-name pattern table the toolkit carries, from the vendored CLDR release.
 *
 *   node ./tools/generate-person-names.mjs           writes the table
 *   node ./tools/generate-person-names.mjs --check    fails if the checked-in table is stale
 *
 * The toolkit carries the whole release because it cannot know which locales a consumer will
 * configure; the consumer's generated artifact carries only the profiles its own locales resolve
 * to. Neither the vendored files nor this table reaches a browser.
 *
 * Two things this derivation does that are worth knowing before changing it.
 *
 * **Rows are kept only where longest-prefix would otherwise answer differently.** 766 locales
 * reduce to 379 rows, because `ar-EG` is identical to `ar` in this release and 27 other Arabic
 * rows are too. That is a fact about CLDR 48.2 and not a property to rely on, so the reduction is
 * verified rather than assumed: every one of the 766 source locales is resolved through the kept
 * rows and compared against its own file. A release that separates `pt-PT` from `pt` produces a
 * `pt-PT` row here without anyone noticing it had to.
 *
 * **Pattern strings are interned.** The release carries 381 distinct strings once the pattern
 * cells and the scalars (`initial`, `initialSequence` and the two space replacements) share
 * one pool. Written out per profile they would be a quarter of a megabyte of source saying the
 * same thing; interned the whole table is 96 KB.
 */

import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = resolve(
  workspaceRoot,
  'standards/data/cldr-person-names-48.2.0',
);
const outputPath = resolve(
  workspaceRoot,
  'packages/toolkit/src/person-names.generated.ts',
);
const rootOutputPath = resolve(
  workspaceRoot,
  'packages/runtime/src/person-names-root.generated.ts',
);

const check = process.argv.includes('--check');

/**
 * Identifies the derivation, not the release. A change to how these rows are shaped or read moves
 * this value, and a runtime handed a profile set it does not recognise says so rather than reading
 * the wrong offsets out of it.
 */
const PROFILE_SET_PROFILE = 'cldr-48.2/atlas-person-names-1';

/**
 * The cube axes, in the order the flat index below walks them.
 *
 * `sorting` is an order like the other two and not a flag: UTS #35 gives it its own patterns, and
 * an implementation that treats it as "surnameFirst with a comma" is inventing again.
 */
const ORDERS = ['givenFirst', 'surnameFirst', 'sorting'];
const LENGTHS = ['long', 'medium', 'short'];
const USAGES = ['referring', 'addressing', 'monogram'];
const FORMALITIES = ['formal', 'informal'];
const CELLS =
  ORDERS.length * LENGTHS.length * USAGES.length * FORMALITIES.length;

/** Flat index for one cell. Kept here so the runtime and the generator cannot drift apart. */
function cellIndex(order, length, usage, formality) {
  return (
    ((ORDERS.indexOf(order) * LENGTHS.length + LENGTHS.indexOf(length)) *
      USAGES.length +
      USAGES.indexOf(usage)) *
      FORMALITIES.length +
    FORMALITIES.indexOf(formality)
  );
}

const files = (await readdir(dataRoot)).filter((name) =>
  name.endsWith('.json'),
);
assert.equal(
  files.length,
  766,
  `${dataRoot} holds ${files.length} locale files; the pinned release has 766. ` +
    'standards/sources.lock.json names what belongs there.',
);

/** One locale's profile, flattened into the shape the table stores. */
function profileOf(document, tag) {
  const personNames = document.main?.[tag]?.personNames;
  assert.ok(personNames, `${tag}.json does not carry personNames for ${tag}`);
  const cells = new Array(CELLS).fill(null);
  for (const order of ORDERS) {
    for (const length of LENGTHS) {
      for (const usage of USAGES) {
        for (const formality of FORMALITIES) {
          const pattern =
            personNames.personName?.[order]?.[length]?.[usage]?.[formality];
          if (typeof pattern === 'string' && pattern.length > 0) {
            cells[cellIndex(order, length, usage, formality)] = pattern;
          }
        }
      }
    }
  }
  return {
    cells,
    // UTS #35 defaults both replacements to SPACE when the locale states neither.
    foreignSpace: personNames.foreignSpaceReplacement ?? ' ',
    nativeSpace: personNames.nativeSpaceReplacement ?? ' ',
    initial: personNames.initial ?? '{0}.',
    initialSequence: personNames.initialSequence ?? '{0} {1}',
    length: personNames.length ?? 'medium',
    formality: personNames.formality ?? 'formal',
    givenFirst: [...(personNames.givenFirst ?? [])],
    surnameFirst: [...(personNames.surnameFirst ?? [])],
  };
}

const profiles = new Map();
for (const file of files) {
  const tag = file.slice(0, -'.json'.length);
  profiles.set(
    tag,
    profileOf(JSON.parse(await readFile(resolve(dataRoot, file), 'utf8')), tag),
  );
}

const fingerprint = (profile) => JSON.stringify(profile);

/** The longest kept key that prefixes a tag on a subtag boundary. Mirrors the runtime lookup. */
function resolveThrough(kept, tag) {
  let candidate = tag;
  for (;;) {
    const row = kept.get(candidate);
    if (row !== undefined) return row;
    const boundary = candidate.lastIndexOf('-');
    if (boundary <= 0) return undefined;
    candidate = candidate.slice(0, boundary);
  }
}

// Shortest tags first, so a base language is always in place before its regional rows are judged.
const kept = new Map();
for (const tag of [...profiles.keys()].sort(
  (left, right) =>
    left.split('-').length - right.split('-').length ||
    left.localeCompare(right),
)) {
  const profile = profiles.get(tag);
  const inherited = resolveThrough(kept, tag);
  if (
    inherited === undefined ||
    fingerprint(inherited) !== fingerprint(profile)
  ) {
    kept.set(tag, profile);
  }
}

// The reduction is verified against the source, not against itself: every locale in the release
// must resolve through the kept rows to exactly the profile its own file carries.
for (const [tag, profile] of profiles) {
  const resolved = resolveThrough(kept, tag);
  assert.ok(resolved !== undefined, `${tag} resolves to no row at all`);
  assert.equal(
    fingerprint(resolved),
    fingerprint(profile),
    `${tag} resolves to a profile that is not its own; the row reduction dropped something real`,
  );
}

/**
 * `{ patterns, rows }` for a set of profiles, with its own intern pool.
 *
 * The whole table and the runtime's root floor go through this, so a per-consumer subset emitted
 * by the toolkit reads through exactly the same code as the floor compiled into the runtime.
 */
function encodeProfiles(selected) {
  const pool = [];
  const poolIndex = new Map();
  const intern = (value) => {
    const existing = poolIndex.get(value);
    if (existing !== undefined) return existing;
    poolIndex.set(value, pool.length);
    pool.push(value);
    return pool.length - 1;
  };
  const rows = [...selected.keys()].sort().map((tag) => {
    const profile = selected.get(tag);
    return [
      tag,
      profile.cells.map((cell) => (cell === null ? -1 : intern(cell))),
      intern(profile.initial),
      intern(profile.initialSequence),
      intern(profile.foreignSpace),
      intern(profile.nativeSpace),
      LENGTHS.indexOf(profile.length),
      FORMALITIES.indexOf(profile.formality),
      profile.givenFirst,
      profile.surnameFirst,
    ];
  });
  return { pool, rows };
}

const { pool, rows: encoded } = encodeProfiles(kept);
const rows = encoded.map(([tag]) => tag);

const rootProfile = profiles.get('und');
assert.ok(
  rootProfile !== undefined,
  'The release carries no `und` profile, so the runtime has no floor to fall back to.',
);
const { pool: rootPool, rows: rootRows } = encodeProfiles(
  new Map([['und', rootProfile]]),
);

const source = [
  '/** Generated from cldr-person-names-full 48.2.0 by tools/generate-person-names.mjs. */',
  // Single-quoted deliberately: Prettier owns this line, and emitting what it would write is the
  // difference between `verify:person-names` being a staleness gate and being a coin toss with
  // whoever ran the formatter last.
  `export const ATLAS_PERSON_NAME_DATA_PROFILE =\n  '${PROFILE_SET_PROFILE}' as const;`,
  '',
  '/**',
  ' * Cube axes, in the order the flat cell index walks them.',
  ' *',
  ' * `sorting` is an order like the other two rather than a flag. UTS #35 gives it its own',
  ' * patterns, and an implementation that treats it as surname-first with a comma is inventing.',
  ' */',
  '// prettier-ignore',
  `export const ATLAS_PERSON_NAME_ORDERS = ${JSON.stringify(ORDERS)} as const;`,
  '// prettier-ignore',
  `export const ATLAS_PERSON_NAME_LENGTHS = ${JSON.stringify(LENGTHS)} as const;`,
  '// prettier-ignore',
  `export const ATLAS_PERSON_NAME_USAGES = ${JSON.stringify(USAGES)} as const;`,
  '// prettier-ignore',
  `export const ATLAS_PERSON_NAME_FORMALITIES = ${JSON.stringify(FORMALITIES)} as const;`,
  '',
  '/**',
  ' * Distinct pattern strings, referenced by index from every row.',
  ' *',
  ' * Pattern cells and scalars share one pool: 381 strings for 379 rows, where writing them out',
  ' * per profile would be a quarter of a megabyte of source saying the same thing.',
  ' */',
  '// prettier-ignore',
  `export const ATLAS_PERSON_NAME_PATTERNS: readonly string[] = Object.freeze(${JSON.stringify(pool)});`,
  '',
  '/**',
  ' * One row per locale whose profile differs from what longest-prefix would otherwise answer.',
  ' *',
  ' * 766 locales reduce to these because most regional rows are identical to their base language in',
  ' * this release: all 28 Arabic rows are. That is a fact about CLDR 48.2 and not a property to',
  ' * rely on: the generator resolves every one of the 766 through these rows and compares against',
  ' * the source, so a release that separates a regional row produces one here without being asked.',
  ' *',
  ' * Each row is `[tag, cells, initial, initialSequence, foreignSpace, nativeSpace, defaultLength,',
  ' * defaultFormality, givenFirstLocales, surnameFirstLocales]`. Every number except the last two',
  ' * entries indexes `ATLAS_PERSON_NAME_PATTERNS`, or is -1 for a cell the locale does not fill.',
  ' */',
  '// prettier-ignore',
  'export const ATLAS_PERSON_NAME_ROWS: readonly (readonly [string, readonly number[], number, number, number, number, number, number, readonly string[], readonly string[]])[] = Object.freeze(',
  `${JSON.stringify(encoded)} as const);`,
  '',
].join('\n');

/**
 * The runtime's floor: CLDR root, and nothing else.
 *
 * `formatPersonName` is a published export that can be called with a hand-assembled context, the
 * same way `provideLocalizationSetup` can be called with a hand-assembled setup. Something has to
 * answer when no generated profile set was threaded through, and the two honest options are to
 * fail or to fall back to root. Root is real published data covering every field, modifier and
 * usage; the alternative Atlas shipped before this was a hand-written field order, which is the
 * thing this step exists to remove. It is one profile, so pay-for-what-you-use survives it.
 */
const rootSource = [
  '/** Generated from cldr-person-names-full 48.2.0 by tools/generate-person-names.mjs. */',
  '',
  '/**',
  ' * Cube axes, in the order the flat cell index walks them.',
  ' *',
  ' * The runtime reads these rather than restating them: the index is computed in two places and',
  ' * a disagreement between them would be a silent read of the wrong pattern, not an error.',
  ' */',
  '// prettier-ignore',
  `export const ATLAS_PERSON_NAME_ORDERS = ${JSON.stringify(ORDERS)} as const;`,
  '// prettier-ignore',
  `export const ATLAS_PERSON_NAME_LENGTHS = ${JSON.stringify(LENGTHS)} as const;`,
  '// prettier-ignore',
  `export const ATLAS_PERSON_NAME_USAGES = ${JSON.stringify(USAGES)} as const;`,
  '// prettier-ignore',
  `export const ATLAS_PERSON_NAME_FORMALITIES = ${JSON.stringify(FORMALITIES)} as const;`,
  '',
  '/**',
  ' * CLDR root, in the shape a generated profile set uses.',
  ' *',
  ' * Used when a formatting context carries no profile set. Root is not a good answer for any',
  ' * particular locale: it is the answer that is not invented.',
  ' */',
  '// prettier-ignore',
  'export const ATLAS_PERSON_NAME_ROOT: {',
  '  readonly profile: string;',
  '  readonly patterns: readonly string[];',
  '  readonly rows: readonly (readonly [',
  '    string, readonly number[], number, number, number, number, number, number,',
  '    readonly string[], readonly string[],',
  '  ])[];',
  '} = Object.freeze({',
  `  profile: ${JSON.stringify(PROFILE_SET_PROFILE)},`,
  `  patterns: Object.freeze(${JSON.stringify(rootPool)} as const),`,
  `  rows: Object.freeze(${JSON.stringify(rootRows)} as const),`,
  '});',
  '',
].join('\n');

const outputs = [
  [outputPath, source, `${rows.length} rows, ${pool.length} pattern strings`],
  [
    rootOutputPath,
    rootSource,
    `root floor, ${rootPool.length} pattern strings`,
  ],
];

let stale = 0;
for (const [path, contents, description] of outputs) {
  const existing = await readFile(path, 'utf8').catch(() => undefined);
  if (check) {
    if (existing !== contents) {
      console.error(`STALE ${path} (${description})`);
      stale += 1;
    }
    continue;
  }
  await writeFile(path, contents, 'utf8');
  console.log(
    `Wrote ${path}: ${description}, ${Buffer.byteLength(contents)} bytes.`,
  );
}

if (check) {
  assert.equal(
    stale,
    0,
    'A generated person-name module is stale. Run `pnpm run generate:person-names`.',
  );
  console.log(
    `Person-name modules current: ${rows.length} rows from ${files.length} locales, ` +
      `${pool.length} distinct pattern strings, plus the root floor.`,
  );
}
