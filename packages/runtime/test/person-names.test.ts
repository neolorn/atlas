import { describe, expect, it } from 'vitest';

import { type PersonNameProfileSet } from '@neolorn/atlas/core';
import { formatPersonName, personName } from '../src/formatting.js';

/**
 * The pattern machinery, against profiles written here rather than generated ones.
 *
 * Every profile in this file is built by hand, and every expectation is written out. Reading the
 * generated table for either would make each of these agree with itself: the table would supply
 * both the pattern and the answer, and a formatter that read the wrong cell, resolved the wrong
 * order or dropped the wrong literal would still be green. A check drawn from the same source as
 * its subject agrees by construction.
 *
 * The cube below is laid out by a nested loop spelled out here, in the axis order the generator
 * documents, and every cell carries a marker naming its own row and coordinates. That is the point
 * of the markers: the runtime computes the cell index with its own arithmetic and picks its own
 * row, and if either disagrees the failure message says what it actually read instead of merely
 * that the text is wrong. The row tag is in the marker because without it two rows carrying the
 * same patterns are indistinguishable, and the checks that exist to say *which* row answered
 * (the script switch, longest-prefix lookup) were green against a formatter that never switched.
 */

const ORDERS = ['givenFirst', 'surnameFirst', 'sorting'] as const;
const LENGTHS = ['long', 'medium', 'short'] as const;
const USAGES = ['referring', 'addressing', 'monogram'] as const;
const FORMALITIES = ['formal', 'informal'] as const;

interface RowSpec {
  readonly tag: string;
  pattern(
    order: (typeof ORDERS)[number],
    length: (typeof LENGTHS)[number],
    usage: (typeof USAGES)[number],
    formality: (typeof FORMALITIES)[number],
  ): string | undefined;
  readonly initial?: string;
  readonly initialSequence?: string;
  readonly foreignSpace?: string;
  readonly nativeSpace?: string;
  readonly defaultLength?: number;
  readonly defaultFormality?: number;
  readonly givenFirst?: readonly string[];
  readonly surnameFirst?: readonly string[];
}

function profileSet(rows: readonly RowSpec[]): PersonNameProfileSet {
  const patterns: string[] = [];
  const index = new Map<string, number>();
  const intern = (value: string): number => {
    const existing = index.get(value);
    if (existing !== undefined) return existing;
    index.set(value, patterns.length);
    patterns.push(value);
    return patterns.length - 1;
  };
  const encoded = rows.map((row) => {
    const cells: number[] = [];
    for (const order of ORDERS) {
      for (const length of LENGTHS) {
        for (const usage of USAGES) {
          for (const formality of FORMALITIES) {
            const pattern = row.pattern(order, length, usage, formality);
            cells.push(pattern === undefined ? -1 : intern(pattern));
          }
        }
      }
    }
    return [
      row.tag,
      cells,
      intern(row.initial ?? '{0}.'),
      intern(row.initialSequence ?? '{0} {1}'),
      intern(row.foreignSpace ?? ' '),
      intern(row.nativeSpace ?? ' '),
      row.defaultLength ?? 1,
      row.defaultFormality ?? 0,
      row.givenFirst ?? ['und'],
      row.surnameFirst ?? [],
    ] as const;
  });
  return {
    profile: 'cldr-48.2/atlas-person-names-1',
    patterns,
    rows: encoded,
  } as PersonNameProfileSet;
}

/**
 * Every cell names its own coordinates, so a misread cell says which one it read.
 *
 * The marker sits *between* the two fields on purpose: a leading literal is removed by the
 * missing-field rules before anything else happens, so a marker in front would vanish along with
 * the evidence.
 */
const marked = (tag: string, extra: Partial<RowSpec> = {}): RowSpec => ({
  tag,
  pattern: (order, length, usage, formality) =>
    `{given}[${tag}/${order}/${length}/${usage}/${formality}]{surname}`,
  ...extra,
});

const text = (result: ReturnType<typeof formatPersonName>): string => {
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.value.text;
};

const mary = personName('en', { given: 'Mary', surname: 'Hamish' });

describe('the cell the formatter reads is the cell that was asked for', () => {
  const set = profileSet([marked('en')]);

  it('reads the requested order, length, usage and formality', () => {
    expect(
      text(
        formatPersonName(
          mary,
          { locale: 'en' },
          {
            order: 'surname-first',
            length: 'short',
            usage: 'addressing',
            formality: 'informal',
          },
          set,
        ),
      ),
    ).toBe('Mary[en/surnameFirst/short/addressing/informal]Hamish');
  });

  it('reads sorting as its own order rather than surname-first', () => {
    expect(
      text(
        formatPersonName(
          mary,
          { locale: 'en' },
          { order: 'sorting', length: 'long', formality: 'formal' },
          set,
        ),
      ),
    ).toBe('Mary[en/sorting/long/referring/formal]Hamish');
  });

  it('falls back to the row default length and formality', () => {
    expect(text(formatPersonName(mary, { locale: 'en' }, {}, set))).toBe(
      'Mary[en/givenFirst/medium/referring/formal]Hamish',
    );
    expect(
      text(
        formatPersonName(
          mary,
          { locale: 'en' },
          {},
          profileSet([marked('en', { defaultLength: 2, defaultFormality: 1 })]),
        ),
      ),
    ).toBe('Mary[en/givenFirst/short/referring/informal]Hamish');
  });

  it('falls back to referring when the requested usage has no pattern', () => {
    // CLDR fills sorting for referring only, in every row of the pinned release.
    const sortingReferringOnly = profileSet([
      marked('en', {
        pattern: (order, length, usage, formality) =>
          order === 'sorting' && usage !== 'referring'
            ? undefined
            : `{given}[en/${order}/${length}/${usage}/${formality}]{surname}`,
      }),
    ]);
    expect(
      text(
        formatPersonName(
          mary,
          { locale: 'en' },
          { order: 'sorting', usage: 'addressing', length: 'long' },
          sortingReferringOnly,
        ),
      ),
    ).toBe('Mary[en/sorting/long/referring/formal]Hamish');
  });
});

describe('order resolution', () => {
  /**
   * The lists belong to the formatter, the tag looked up in them is the name's. Both rows here
   * carry the same patterns and opposite lists, so a formatter reading the name's own lists
   * instead of the formatter's returns the other answer rather than the same one.
   */
  // The two lists are copied by hand from CLDR 48: `en` names five surname-first languages and
  // Hungarian is not among them, `hu` names the same five and itself. A Hungarian name therefore
  // has two correct orders depending on who is reading it, which is the property a single global
  // set of surname-first languages cannot express and the reason this step exists.
  const set = profileSet([
    marked('en', {
      givenFirst: ['und', 'en'],
      surnameFirst: ['ja', 'ko', 'vi', 'yue', 'zh'],
    }),
    marked('hu', {
      givenFirst: ['und'],
      surnameFirst: ['hu', 'ja', 'ko', 'vi', 'yue', 'zh'],
    }),
  ]);

  it('gives one name two orders, because the two interfaces disagree about it', () => {
    const ferenc = personName('hu', { given: 'Ferenc', surname: 'Molnar' });
    expect(text(formatPersonName(ferenc, { locale: 'en' }, {}, set))).toBe(
      'Ferenc[en/givenFirst/medium/referring/formal]Molnar',
    );
    expect(text(formatPersonName(ferenc, { locale: 'hu' }, {}, set))).toBe(
      'Ferenc[hu/surnameFirst/medium/referring/formal]Molnar',
    );
  });

  it('walks the name tag up to its base language', () => {
    expect(
      text(
        formatPersonName(
          personName('ja-JP', { given: 'Ichiro', surname: 'Suzuki' }),
          { locale: 'en' },
          {},
          set,
        ),
      ),
    ).toBe('Ichiro[en/surnameFirst/medium/referring/formal]Suzuki');
  });

  it('defaults to given-first for a name locale neither list names', () => {
    expect(
      text(
        formatPersonName(
          personName('de', { given: 'Max', surname: 'Meyer' }),
          { locale: 'en' },
          {},
          set,
        ),
      ),
    ).toBe('Max[en/givenFirst/medium/referring/formal]Meyer');
  });

  it('lets an explicit order override the lists', () => {
    expect(
      text(
        formatPersonName(
          personName('hu', { given: 'Ferenc', surname: 'Molnar' }),
          { locale: 'en' },
          { order: 'given-first' },
          set,
        ),
      ),
    ).toBe('Ferenc[en/givenFirst/medium/referring/formal]Molnar');
  });
});

describe('row lookup', () => {
  const set = profileSet([
    marked('ar', { defaultLength: 0 }),
    marked('ar-SA', { defaultLength: 2 }),
  ]);

  it('resolves a regional tag through the longest prefix present', () => {
    // `ar-EG` has no row of its own; it must answer from `ar`, not from `ar-SA`.
    expect(text(formatPersonName(mary, { locale: 'ar-EG' }, {}, set))).toBe(
      'Mary[ar/givenFirst/long/referring/formal]Hamish',
    );
  });

  it('prefers the more specific row when one exists', () => {
    expect(text(formatPersonName(mary, { locale: 'ar-SA' }, {}, set))).toBe(
      'Mary[ar-SA/givenFirst/short/referring/formal]Hamish',
    );
  });

  it('matches a row regardless of tag casing', () => {
    expect(text(formatPersonName(mary, { locale: 'AR-eg' }, {}, set))).toBe(
      'Mary[ar/givenFirst/long/referring/formal]Hamish',
    );
  });
});

describe('the script switch', () => {
  const set = profileSet([
    marked('en'),
    marked('ja', { nativeSpace: '', foreignSpace: '・' }),
  ]);

  it('formats a foreign-script name with that locale profile when it is present', () => {
    const suzuki = personName('ja', { given: '一郎', surname: '鈴木' });
    // The `ja` row's own separator, which only the switched-to profile carries.
    expect(text(formatPersonName(suzuki, { locale: 'en' }, {}, set))).toBe(
      '一郎[ja/givenFirst/medium/referring/formal]鈴木',
    );
  });

  it('stays with the interface profile when the name locale has no row', () => {
    const park = personName('ko', { given: '지훈', surname: '박' });
    expect(text(formatPersonName(park, { locale: 'ja' }, {}, set))).toBe(
      '지훈[ja/givenFirst/medium/referring/formal]박',
    );
  });

  it('does not switch when the scripts already agree', () => {
    const max = personName('de', { given: 'Max', surname: 'Meyer' });
    const withDe = profileSet([
      marked('en'),
      marked('de', { defaultLength: 2 }),
    ]);
    expect(text(formatPersonName(max, { locale: 'en' }, {}, withDe))).toBe(
      'Max[en/givenFirst/medium/referring/formal]Meyer',
    );
  });
});

describe('space replacement', () => {
  const set = profileSet([
    marked('ja', {
      pattern: () => '{surname} {given}',
      nativeSpace: '',
      foreignSpace: '・',
    }),
  ]);

  it('uses the native replacement when the base languages match', () => {
    expect(
      text(
        formatPersonName(
          personName('ja', { given: '一郎', surname: '鈴木' }),
          { locale: 'ja' },
          {},
          set,
        ),
      ),
    ).toBe('鈴木一郎');
  });

  it('uses the foreign replacement when they do not', () => {
    expect(
      text(
        formatPersonName(
          personName('ko', { given: '지훈', surname: '박' }),
          { locale: 'ja' },
          {},
          set,
        ),
      ),
    ).toBe('박・지훈');
  });

  it('replaces the pattern spaces and not the ones inside a field', () => {
    expect(
      text(
        formatPersonName(
          personName('ko', { given: 'Mary Beth', surname: 'Van Horn' }),
          { locale: 'ja' },
          {},
          set,
        ),
      ),
    ).toBe('Van HornヾMary Beth'.replace('ヾ', '・'));
  });
});

describe('fields the name does not carry', () => {
  const pattern = (source: string): PersonNameProfileSet =>
    profileSet([marked('en', { pattern: () => source })]);

  it('drops the literals before the first populated field', () => {
    // The trailing `) ` survives, which is what makes this about the leading rule and not both.
    expect(
      text(
        formatPersonName(
          personName('en', { given: 'Mary', surname: 'Hamish' }),
          { locale: 'en' },
          {},
          pattern('{title} ({given}) {surname}'),
        ),
      ),
    ).toBe('Mary) Hamish');
  });

  it('drops the literals after the last populated field', () => {
    expect(
      text(
        formatPersonName(
          personName('en', { given: 'Mary', surname: 'Hamish' }),
          { locale: 'en' },
          {},
          pattern('{given} [{surname}] {credentials}'),
        ),
      ),
    ).toBe('Mary [Hamish');
  });

  it('removes a run of empty fields together with the literals between them', () => {
    // The `|` is the evidence. Filtering the empty fields out one at a time would leave it, and
    // the whitespace either side of it would coalesce around it rather than away with it, which
    // is why the separator here is not another space.
    expect(
      text(
        formatPersonName(
          personName('en', { given: 'Mary', surname: 'Hamish' }),
          { locale: 'en' },
          {},
          pattern('{given} <{given2}|{surname2}> {surname}'),
        ),
      ),
    ).toBe('Mary <> Hamish');
  });

  it('leaves one separator when a single field between two literals is empty', () => {
    expect(
      text(
        formatPersonName(
          personName('en', { given: 'Mary', surname: 'Hamish' }),
          { locale: 'en' },
          {},
          pattern('{given} {given2} {surname}'),
        ),
      ),
    ).toBe('Mary Hamish');
  });

  it('joins two literals rather than tidying them, when neither ends the other', () => {
    // ` ` and `, ` coalesce to ` , `: the rule is A + B with runs of whitespace collapsed, and
    // these two spaces are not adjacent. Asserting the tidy answer here would be asserting a
    // formatter nobody specified.
    expect(
      text(
        formatPersonName(
          personName('en', { given: 'Mary', surname: 'Hamish' }),
          { locale: 'en' },
          {},
          pattern('{given} {given2}, {surname}'),
        ),
      ),
    ).toBe('Mary , Hamish');
  });

  it('coalesces two literals when the second matches the end of the first', () => {
    expect(
      text(
        formatPersonName(
          personName('en', { given: 'Mary', surname: 'Hamish' }),
          { locale: 'en' },
          {},
          pattern('{given}, {given2}, {surname}'),
        ),
      ),
    ).toBe('Mary, Hamish');
  });
});

describe('field modifiers', () => {
  const pattern = (source: string): PersonNameProfileSet =>
    profileSet([marked('en', { pattern: () => source })]);

  it('uses a supplied informal form and falls back to the plain one', () => {
    const thomas = personName('en', {
      given: 'Thomas',
      'given-informal': 'Tom',
      surname: 'Meyer',
    });
    expect(
      text(
        formatPersonName(
          thomas,
          { locale: 'en' },
          {},
          pattern('{given-informal} {surname}'),
        ),
      ),
    ).toBe('Tom Meyer');
    const plain = personName('en', { given: 'Thomas', surname: 'Meyer' });
    expect(
      text(
        formatPersonName(
          plain,
          { locale: 'en' },
          {},
          pattern('{given-informal} {surname}'),
        ),
      ),
    ).toBe('Thomas Meyer');
  });

  it('falls back from core to the plain field but never from prefix', () => {
    const poel = personName('nl', { surname: 'Poel', given: 'Rein' });
    expect(
      text(
        formatPersonName(
          poel,
          { locale: 'en' },
          {},
          pattern('{given} {surname-prefix} {surname-core}'),
        ),
      ),
    ).toBe('Rein Poel');
  });

  it('derives a plain surname from a prefix and core the name carries separately', () => {
    const split = personName('nl', {
      given: 'Rein',
      'surname-prefix': 'van der',
      'surname-core': 'Poel',
    });
    expect(
      text(
        formatPersonName(
          split,
          { locale: 'en' },
          {},
          pattern('{given} {surname}'),
        ),
      ),
    ).toBe('Rein van der Poel');
    expect(
      text(
        formatPersonName(
          split,
          { locale: 'en' },
          {},
          pattern('{surname-core}, {given} {surname-prefix}'),
        ),
      ),
    ).toBe('Poel, Rein van der');
  });

  it('forms one initial per word and recombines them with initialSequence', () => {
    const anne = personName('en', {
      given: 'Anne Marie',
      surname: 'Bergqvist',
    });
    expect(
      text(
        formatPersonName(
          anne,
          { locale: 'en' },
          {},
          profileSet([
            marked('en', { pattern: () => '{given-initial} {surname}' }),
          ]),
        ),
      ),
    ).toBe('A. M. Bergqvist');
    expect(
      text(
        formatPersonName(
          anne,
          { locale: 'en' },
          {},
          profileSet([
            marked('en', {
              pattern: () => '{given-initial} {surname}',
              initial: '{0}·',
              initialSequence: '{0}{1}',
            }),
          ]),
        ),
      ),
    ).toBe('A·M· Bergqvist');
  });

  it('keeps the name own separator under retain', () => {
    const anne = personName('en', {
      given: 'Anne-Marie',
      surname: 'Bergqvist',
    });
    expect(
      text(
        formatPersonName(
          anne,
          { locale: 'en' },
          {},
          pattern('{given-initial} {surname}'),
        ),
      ),
    ).toBe('A. M. Bergqvist');
    expect(
      text(
        formatPersonName(
          anne,
          { locale: 'en' },
          {},
          pattern('{given-initial-retain} {surname}'),
        ),
      ),
    ).toBe('A.-M. Bergqvist');
  });

  it('takes one grapheme for a monogram, not one per word', () => {
    const anne = personName('en', {
      given: 'Anne Marie',
      surname: 'Bergqvist',
    });
    expect(
      text(
        formatPersonName(
          anne,
          { locale: 'en' },
          {},
          pattern('{given-monogram}{surname-monogram}'),
        ),
      ),
    ).toBe('AB');
  });

  it('applies allCaps and initialCap to the modified value', () => {
    const mario = personName('en', { given: 'mario', surname: 'de luca' });
    expect(
      text(
        formatPersonName(
          mario,
          { locale: 'en' },
          {},
          pattern('{given-allCaps} {surname}'),
        ),
      ),
    ).toBe('MARIO de luca');
    expect(
      text(
        formatPersonName(
          mario,
          { locale: 'en' },
          {},
          pattern('{given-initialCap} {surname-initialCap}'),
        ),
      ),
    ).toBe('Mario De luca');
  });

  it('leaves an unrecognised placeholder as literal text rather than dropping it', () => {
    expect(
      text(
        formatPersonName(
          mary,
          { locale: 'en' },
          {},
          pattern('{given} {nickname} {surname}'),
        ),
      ),
    ).toBe('Mary {nickname} Hamish');
  });
});

describe('data the runtime cannot read', () => {
  it('refuses a profile set from a derivation it does not know', () => {
    const foreign = {
      profile: 'cldr-99/atlas-person-names-7',
      patterns: ['{given}'],
      rows: [],
    } as unknown as PersonNameProfileSet;
    const result = formatPersonName(mary, { locale: 'en' }, {}, foreign);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostic.reason).toBe('integrity-mismatch');
  });

  it('falls back to the compiled root profile when no set is supplied', () => {
    // CLDR root, medium referring formal: `{title} {given} {given2} {surname} {surname2}
    // {credentials}`, with root defaulting to medium and formal.
    const full = personName('en', {
      title: 'Dr.',
      given: 'Mary',
      given2: 'Sue',
      surname: 'Hamish',
    });
    expect(text(formatPersonName(full, { locale: 'en' }))).toBe(
      'Dr. Mary Sue Hamish',
    );
  });

  it('falls back to root for a locale the supplied set does not carry', () => {
    const onlyJa = profileSet([marked('ja')]);
    expect(text(formatPersonName(mary, { locale: 'en' }, {}, onlyJa))).toBe(
      'Mary Hamish',
    );
  });
});

describe('the parts a formatted name is made of', () => {
  it('names each field and marks the literals with the formatting locale', () => {
    const set = profileSet([
      marked('en', { pattern: () => '{surname}, {given}' }),
    ]);
    const result = formatPersonName(mary, { locale: 'en' }, {}, set);
    expect(result.ok && result.value.parts).toEqual([
      { kind: 'surname', value: 'Hamish', language: 'en', direction: 'ltr' },
      { kind: 'literal', value: ', ', language: 'en', direction: 'ltr' },
      { kind: 'given', value: 'Mary', language: 'en', direction: 'ltr' },
    ]);
  });
});
