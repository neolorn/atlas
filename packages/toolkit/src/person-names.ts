/**
 * Rendering a person's name the way that name's own language renders it.
 *
 * `specs/08-formatting-parsing-and-domain.spec.md` section 7 takes structured data, preserves
 * the fields supplied, and keeps the name's own language and script separate from the locale of
 * the page around it, because a name does not change its order when the interface changes
 * language. Nothing here parses an unstructured name into components, and nothing here requires
 * an application to store a name as a given part and a family part.
 */

import {
  ATLAS_PERSON_NAME_DATA_PROFILE,
  ATLAS_PERSON_NAME_PATTERNS,
  ATLAS_PERSON_NAME_ROWS,
} from './person-names.generated.js';

/**
 * One locale's person-name profile: the 54-cell pattern cube plus the scalars around it.
 *
 * Every number except the last two entries indexes the accompanying pattern pool, or is -1 for a
 * cell the locale does not fill. Positional rather than named because there are hundreds of them
 * and the names would outweigh the data by an order of magnitude in generated source.
 */
export type AtlasPersonNameRow = readonly [
  tag: string,
  cells: readonly number[],
  initial: number,
  initialSequence: number,
  foreignSpace: number,
  nativeSpace: number,
  defaultLength: number,
  defaultFormality: number,
  givenFirstLocales: readonly string[],
  surnameFirstLocales: readonly string[],
];

export interface AtlasPersonNameProfileSet {
  readonly profile: typeof ATLAS_PERSON_NAME_DATA_PROFILE;
  readonly patterns: readonly string[];
  readonly rows: readonly AtlasPersonNameRow[];
}

/** The longest row tag that prefixes `tag` on a subtag boundary. Mirrors the runtime lookup. */
function resolveRow(
  rows: ReadonlyMap<string, AtlasPersonNameRow>,
  tag: string,
): AtlasPersonNameRow | undefined {
  let candidate = tag.toLowerCase();
  for (;;) {
    const row = rows.get(candidate);
    if (row !== undefined) return row;
    const boundary = candidate.lastIndexOf('-');
    if (boundary <= 0) return undefined;
    candidate = candidate.slice(0, boundary);
  }
}

const INDEX: ReadonlyMap<string, AtlasPersonNameRow> = new Map(
  ATLAS_PERSON_NAME_ROWS.map((row) => [row[0].toLowerCase(), row]),
);

/**
 * The person-name profiles a set of locales resolves to, and nothing else.
 *
 * Atlas carries the whole pinned release in this package because it cannot know which locales an
 * application will configure. The application's generated artifact carries only what its own
 * locales reach (typically two or three rows, against 379) because a table that is almost
 * entirely index for locales nobody uses is the one place Atlas would stop being
 * pay-for-what-you-use.
 *
 * **Rows keep their own tag, not the tag that asked for them.** A consumer configuring `ar-EG`
 * gets the row named `ar`, because `ar-EG` is identical to `ar` in this release: a fact about
 * CLDR 48.2, not a property to bake into an artifact. The runtime resolves `ar-EG` through the
 * same longest-prefix walk, so a release that separates the two produces an `ar-EG` row here
 * without anything else changing.
 *
 * A locale the release does not cover contributes no row. The runtime falls back to its compiled
 * root profile for those, which is published data rather than an invented field order.
 */
export function personNameProfilesFor(
  locales: readonly string[],
): AtlasPersonNameProfileSet {
  const selected = new Map<string, AtlasPersonNameRow>();
  for (const locale of locales) {
    const row = resolveRow(INDEX, locale);
    if (row !== undefined) selected.set(row[0], row);
  }

  // Re-interned against this subset: the full pool is 381 strings and a two-locale application
  // reaches a dozen of them.
  const pool: string[] = [];
  const poolIndex = new Map<string, number>();
  const intern = (index: number): number => {
    if (index < 0) return -1;
    const value = ATLAS_PERSON_NAME_PATTERNS[index] as string;
    const existing = poolIndex.get(value);
    if (existing !== undefined) return existing;
    poolIndex.set(value, pool.length);
    pool.push(value);
    return pool.length - 1;
  };

  const rows = [...selected.keys()].sort().map((tag) => {
    const row = selected.get(tag) as AtlasPersonNameRow;
    return Object.freeze([
      row[0],
      Object.freeze(row[1].map(intern)),
      intern(row[2]),
      intern(row[3]),
      intern(row[4]),
      intern(row[5]),
      row[6],
      row[7],
      Object.freeze([...row[8]]),
      Object.freeze([...row[9]]),
    ]) as AtlasPersonNameRow;
  });

  return Object.freeze({
    profile: ATLAS_PERSON_NAME_DATA_PROFILE,
    patterns: Object.freeze(pool),
    rows: Object.freeze(rows),
  });
}
