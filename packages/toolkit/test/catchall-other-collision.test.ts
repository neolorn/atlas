import { describe, expect, it } from 'vitest';

import {
  atlasCatchallOtherCollisions,
  parseAtlasMessage,
  type AtlasMessageVariant,
} from '../src/message-format.js';
import { ATLAS_CARDINAL_PLURAL_CATEGORIES } from '../src/plural-categories.generated.js';

/**
 * A message that cannot be written in a format whose cases are all named.
 *
 * XLIFF's Plural, Gender and Select module names each case, and `*` is not one of the names, so an
 * exporter targeting it has to spell the catch-all as a category. `other` is the only candidate,
 * and the mapping is lossy exactly when the message already has an `other`.
 *
 * The suite is built on parsed messages rather than hand-written variant objects, so what is
 * checked is the shape the parser actually produces from MF2 source. A hand-built fixture here
 * would agree with the check by construction and say nothing about any message a translator writes.
 */

function variantsOf(source: string) {
  const parsed = parseAtlasMessage(source);
  if (!parsed.ok) {
    throw new Error(
      `fixture did not parse: ${parsed.diagnostics.map(({ summary }) => summary).join('; ')}`,
    );
  }
  const model = parsed.value;
  if (!('variants' in model)) {
    throw new Error('fixture is not a select message');
  }
  return model.variants;
}

const select = (...variants: readonly string[]) =>
  ['.input {$count :number}', '.match $count', ...variants].join('\n');

describe('the premise: a catch-all is not a synonym for other', () => {
  /**
   * The whole check rests on this. If `*` and `other` selected identically, merging them would cost
   * nothing and none of the rest would be worth writing, so it is asserted against the pinned CLDR
   * data rather than argued.
   */
  it('is invisible in English, where every value is one or other', () => {
    expect([...(ATLAS_CARDINAL_PLURAL_CATEGORIES['en'] ?? [])].sort()).toEqual([
      'one',
      'other',
    ]);
  });

  it('is four categories wide in Arabic, which is where the two part company', () => {
    const arabic = ATLAS_CARDINAL_PLURAL_CATEGORIES['ar'] ?? [];
    expect([...arabic].sort()).toEqual([
      'few',
      'many',
      'one',
      'other',
      'two',
      'zero',
    ]);
    // With `one`, `other` and `*` present, these four reach the catch-all and nothing else does.
    expect(
      arabic.filter((category) => category !== 'one' && category !== 'other'),
    ).toHaveLength(4);
  });
});

describe('variants that would merge under the mapping', () => {
  it('names the pair when other and the catch-all are both present', () => {
    const collisions = atlasCatchallOtherCollisions(
      variantsOf(
        select('one {{1 item}}', 'other {{# items}}', '* {{# items}}'),
      ),
    );
    expect(collisions).toEqual([[1, 2]]);
  });

  it('says nothing when the catch-all is the only one of the two', () => {
    expect(
      atlasCatchallOtherCollisions(
        variantsOf(select('one {{1 item}}', '* {{# items}}')),
      ),
    ).toEqual([]);
  });

  it('says nothing about an other whose catch-all lands on a different tuple', () => {
    // MF2 requires a catch-all, so a message with `other` and no `*` cannot be written at all:
    // the parser refuses it. Two selectors are what make the case expressible: `other book` and
    // `* *` are both present and map to different tuples, so an `other` on its own is not a
    // collision.
    const twoSelectors = [
      '.input {$count :number}',
      '.input {$kind :string}',
      '.match $count $kind',
      'one book {{1 book}}',
      'other book {{# books}}',
      '* * {{# things}}',
    ].join('\n');
    expect(atlasCatchallOtherCollisions(variantsOf(twoSelectors))).toEqual([]);
  });
});

describe('what it must not report', () => {
  /**
   * Two variants with identical literal keys collide in MF2 itself, before any export is involved.
   * Reporting them here would make this check appear to work while it was answering a different
   * question, and would hide the fact that nothing else answers that one.
   */
  it('never sees duplicate literal keys, because MF2 itself refuses them', () => {
    const duplicated = parseAtlasMessage(
      select('one {{1 item}}', 'one {{a duplicate}}', '* {{# items}}'),
    );
    expect(duplicated.ok).toBe(false);
    if (duplicated.ok) return;
    // The reason, not the parser's slug for it: since 3.17 no diagnostic carries the third party's
    // vocabulary, and `diagnostic-wording.test.ts` owns the sentence.
    expect(duplicated.diagnostics.map(({ summary }) => summary)).toContain(
      'MessageFormat .match has two variants with the same keys.',
    );
  });

  it('leaves duplicate literal keys alone if it is handed them anyway', () => {
    // Built rather than parsed, precisely because the parser refuses it. The branch exists so that
    // a caller assembling variants some other way still gets an answer about catch-alls and not
    // about duplicates, and a branch no test can reach is one nobody knows the shape of.
    const duplicated = [
      { keys: [{ kind: 'literal', value: 'one' }], pattern: ['1 item'] },
      { keys: [{ kind: 'literal', value: 'one' }], pattern: ['a duplicate'] },
      { keys: [{ kind: 'catchall' }], pattern: ['# items'] },
    ] as const satisfies readonly AtlasMessageVariant[];
    expect(atlasCatchallOtherCollisions(duplicated)).toEqual([]);
  });

  it('leaves a message with no catch-all collision alone across two selectors', () => {
    const twoSelectors = [
      '.input {$count :number}',
      '.input {$kind :string}',
      '.match $count $kind',
      'one book {{1 book}}',
      'one * {{1 thing}}',
      '* book {{# books}}',
      '* * {{# things}}',
    ].join('\n');
    expect(atlasCatchallOtherCollisions(variantsOf(twoSelectors))).toEqual([]);
  });

  it('finds the collision across two selectors when one tuple repeats', () => {
    const twoSelectors = [
      '.input {$count :number}',
      '.input {$kind :string}',
      '.match $count $kind',
      'one book {{1 book}}',
      'one other {{1 other thing}}',
      'one * {{1 thing}}',
      '* * {{# things}}',
    ].join('\n');
    // `one other` and `one *` both become `one other`.
    expect(atlasCatchallOtherCollisions(variantsOf(twoSelectors))).toEqual([
      [1, 2],
    ]);
  });
});
