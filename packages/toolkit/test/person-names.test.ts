import { describe, expect, it } from 'vitest';

import {
  ATLAS_PERSON_NAME_PATTERNS,
  ATLAS_PERSON_NAME_ROWS,
} from '../src/person-names.generated.js';
import { personNameProfilesFor } from '../src/person-names.js';

/**
 * What an application's generated artifact carries, and why it is not the table.
 *
 * The tags below are written out by hand (`en-US` reaching `en`, `ar-EG` reaching `ar`) rather
 * than read back from the generated rows, because a selection asserted against the same table
 * it selected from agrees whatever it selected.
 *
 * The one place the generated table is read is the last test, and it is read as the *other* side
 * of a comparison: the subset must answer for every requested locale exactly what the whole table
 * would have answered. That is a check between two artifacts rather than a check of one against
 * itself, and it is the property the emission exists to preserve.
 */

const tags = (locales: readonly string[]): readonly string[] =>
  personNameProfilesFor(locales).rows.map((row) => row[0]);

describe('the profiles a set of locales reaches', () => {
  it('emits the base-language row a regional tag resolves to, not the tag itself', () => {
    // Neither `en-US` nor `ar-EG` differs from its base language in CLDR 48.2, so neither has a
    // row of its own. Emitting them as their own rows would bake this release's coincidence into
    // an application's artifact.
    expect(tags(['en-US', 'ar-EG'])).toEqual(['ar', 'en']);
  });

  it('collapses several locales that reach the same row', () => {
    expect(tags(['en-US', 'en-AU', 'en'])).toEqual(['en']);
  });

  it('keeps a regional row when the release actually separates one', () => {
    // `en-GB` is not `en`: CLDR 48 gives British English the initial pattern `{0}` where `en`
    // has `{0}.`, so `J. R. R.` is `J R R` there. A subsetter that assumed regional tags always
    // collapse into their base language would silently put full stops back.
    expect(tags(['en-US', 'en-GB'])).toEqual(['en', 'en-GB']);
    expect(tags(['es', 'es-419'])).toEqual(['es', 'es-419']);
  });

  it('emits nothing for a locale the release does not cover', () => {
    expect(tags(['zxx'])).toEqual([]);
    expect(tags([])).toEqual([]);
  });

  it('is stable in tag order regardless of the order asked for', () => {
    expect(tags(['ja', 'ar', 'en'])).toEqual(tags(['en', 'ja', 'ar']));
    expect(tags(['ja', 'ar', 'en'])).toEqual(['ar', 'en', 'ja']);
  });
});

describe('what the emitted set costs', () => {
  it('interns against the subset rather than carrying the whole pool', () => {
    const set = personNameProfilesFor(['en-US', 'ar-EG']);
    expect(set.patterns.length).toBeLessThan(
      ATLAS_PERSON_NAME_PATTERNS.length / 4,
    );
    // Every index a row carries has to point inside this set's own pool, not the table's.
    for (const row of set.rows) {
      for (const cell of [...row[1], row[2], row[3], row[4], row[5]]) {
        expect(cell).toBeLessThan(set.patterns.length);
        expect(cell).toBeGreaterThanOrEqual(-1);
      }
    }
  });

  it('carries a fraction of the table for a handful of locales', () => {
    const whole = JSON.stringify({
      patterns: ATLAS_PERSON_NAME_PATTERNS,
      rows: ATLAS_PERSON_NAME_ROWS,
    }).length;
    const emitted = JSON.stringify(
      personNameProfilesFor(['en-US', 'ar-EG']),
    ).length;
    expect(emitted * 20).toBeLessThan(whole);
  });
});

describe('the subset answers what the whole table would have', () => {
  /**
   * The property the emission has to preserve, stated against the table rather than against the
   * subset: for every locale asked for, the row the subset resolves to must be the row the full
   * table resolves to. A subset that dropped a needed row, kept the wrong one, or re-keyed a row
   * under the tag that asked for it fails here.
   */
  const resolveThrough = (
    rows: readonly (readonly [string, ...unknown[]])[],
    tag: string,
  ): string | undefined => {
    let candidate = tag.toLowerCase();
    for (;;) {
      const found = rows.find(([rowTag]) => rowTag.toLowerCase() === candidate);
      if (found !== undefined) return found[0];
      const boundary = candidate.lastIndexOf('-');
      if (boundary <= 0) return undefined;
      candidate = candidate.slice(0, boundary);
    }
  };

  it('resolves every requested locale to the same row the table would', () => {
    const requested = [
      'en-US',
      'ar-EG',
      'ar',
      'ja',
      'hu-HU',
      'es-419',
      'zh-Hant-TW',
      'pt-BR',
      'nl',
      'ko',
    ];
    const set = personNameProfilesFor(requested);
    for (const locale of requested) {
      expect([locale, resolveThrough(set.rows, locale)]).toEqual([
        locale,
        resolveThrough(ATLAS_PERSON_NAME_ROWS, locale),
      ]);
    }
  });

  it('resolves a locale nobody asked for to nothing, not to a neighbour', () => {
    const set = personNameProfilesFor(['ar-EG']);
    expect(resolveThrough(set.rows, 'hu')).toBeUndefined();
    expect(resolveThrough(ATLAS_PERSON_NAME_ROWS, 'hu')).toBe('hu');
  });
});

describe('the locales a declaration adds', () => {
  it('adds the declared locale to the rows the configured ones reach', () => {
    expect(tags(['en-US', 'ar-EG'])).toEqual(['ar', 'en']);
    expect(tags(['en-US', 'ar-EG', 'ja'])).toEqual(['ar', 'en', 'ja']);
  });

  /**
   * The data fact that makes the declaration worth making.
   *
   * `ja` joins a surname and a given name with nothing; `en` joins them with a space. An
   * application that formats a Japanese name without the `ja` row gets the ordering right,
   * English's own list says Japanese names are surname-first, and the spacing wrong, and
   * nothing reports it. These two values are the difference between `\u9234\u6728\u4e00\u90ce`
   * and `\u9234\u6728 \u4e00\u90ce`.
   */
  it('carries the space replacements that make the difference visible', () => {
    const set = personNameProfilesFor(['en', 'ja']);
    const spaces = Object.fromEntries(
      set.rows.map((row) => [
        row[0],
        [set.patterns[row[4]], set.patterns[row[5]]],
      ]),
    );
    expect(spaces['en']).toEqual([' ', ' ']);
    expect(spaces['ja']).toEqual(['\u30FB', '']);
  });
});
