import { personNames } from '#i18n/person-names';
import {
  formatPersonName,
  personName,
  type FormattingContext,
  type PersonNameFormatOptions,
  type PersonNameValue,
} from '@neolorn/atlas';
import { describe, expect, it } from 'vitest';

/**
 * Person-name formatting, through the built package and the generated artifact.
 *
 * What an application renders is asserted where it renders. Person-name formatting changed
 * rendered output, so the assertions are here rather than in the runtime suite.
 *
 * Every expectation below is written out by hand from the pinned CLDR release,
 * never read back from `#i18n/person-names`. Deriving them from the same table the formatter
 * reads would make each case agree with itself: the table would supply the pattern and the
 * answer both, and a formatter that picked the wrong row or the wrong cell would stay green.
 * The patterns each case exercises are quoted above it so the expectation can be checked against
 * the release without running anything.
 *
 * This application configures `en-US` and `ar-EG`, so its generated artifact carries the `en` and
 * `ar` profiles and nothing else.
 */

/** Written as an escape so a copy through an editor cannot quietly make it a Latin comma. */
const ARABIC_COMMA = '\u060C';

const english: FormattingContext = { locale: 'en-US' };
const arabic: FormattingContext = { locale: 'ar-EG' };

const render = (
  value: PersonNameValue,
  context: FormattingContext,
  options: PersonNameFormatOptions = {},
): string => {
  const result = formatPersonName(value, context, options, personNames);
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.value.text;
};

const mary = personName('en', {
  title: 'Dr.',
  given: 'Mary',
  given2: 'Sue',
  surname: 'Hamish',
});

describe('the generated artifact carries the configured locales and no more', () => {
  it('holds one row per configured locale, under the tag CLDR gives it', () => {
    // `ar-EG` and `en-US` resolve to `ar` and `en`: identical to their base language in this
    // release, so no row of their own. 379 rows exist; this application ships two.
    expect(personNames.rows.map((row) => row[0])).toEqual(['ar', 'en']);
  });

  it('declares the derivation the runtime knows how to read', () => {
    expect(personNames.profile).toBe('cldr-48.2/atlas-person-names-1');
  });
});

describe('an English name in the English interface', () => {
  it('uses the informal referring pattern by default', () => {
    // en defaults to medium and informal; givenFirst/medium/referring/informal is
    // `{given-informal} {surname}`, and no informal given was supplied.
    expect(render(mary, english)).toBe('Mary Hamish');
  });

  it('uses the long formal pattern when asked for one', () => {
    // givenFirst/long/referring/formal is
    // `{title} {given} {given2} {surname} {generation}, {credentials}`.
    expect(render(mary, english, { length: 'long', formality: 'formal' })).toBe(
      'Dr. Mary Sue Hamish',
    );
  });

  it('addresses formally by title and surname', () => {
    // givenFirst/medium/addressing/formal is `{title} {surname}`.
    expect(
      render(mary, english, { usage: 'addressing', formality: 'formal' }),
    ).toBe('Dr. Hamish');
  });

  it('sorts by surname', () => {
    // sorting/medium/referring/informal is `{surname}, {given-informal}`.
    expect(render(mary, english, { order: 'sorting' })).toBe('Hamish, Mary');
  });

  it('takes one letter for a monogram', () => {
    // givenFirst/medium/monogram/informal is `{given-informal-monogram-allCaps}`.
    expect(render(mary, english, { usage: 'monogram' })).toBe('M');
  });

  it('initials the surname in the short informal form', () => {
    // givenFirst/short/referring/informal is `{given-informal} {surname-initial}`,
    // with en`s initial pattern `{0}.`.
    expect(
      render(mary, english, { length: 'short', formality: 'informal' }),
    ).toBe('Mary H.');
  });

  it('uses an informal given name when the name carries one', () => {
    const thomas = personName('en', {
      given: 'Thomas',
      'given-informal': 'Tom',
      surname: 'Meyer',
    });
    expect(render(thomas, english)).toBe('Tom Meyer');
    expect(
      render(thomas, english, { length: 'long', formality: 'formal' }),
    ).toBe('Thomas Meyer');
  });
});

describe('an Arabic name in the Arabic interface', () => {
  const mohamed = personName('ar', { given: 'محمد', surname: 'المصري' });

  it('resolves ar-EG through the ar row rather than falling back to root', () => {
    // ar surnameFirst/medium/referring/formal is `{surname}، {given} {given2-initial}`:
    // ARABIC COMMA. Root`s is `{surname} {surname2} {title} {given} {given2} {credentials}`, which
    // renders the same two words with no comma at all, so the comma is what says which row
    // answered.
    expect(
      render(mohamed, arabic, {
        order: 'surname-first',
        length: 'medium',
        formality: 'formal',
      }),
    ).toBe(`المصري${ARABIC_COMMA} محمد`);
  });

  it('drops the trailing punctuation of fields the name does not carry', () => {
    // ar defaults to long and formal; givenFirst/long/referring/formal is
    // `{title} {given} {given2} {surname} {generation}، {credentials}`. Everything after the
    // surname is empty, and the Arabic comma goes with it.
    expect(render(mohamed, arabic)).toBe('محمد المصري');
  });

  it('formats an Arabic name inside the English interface with the Arabic profile', () => {
    // The name script is Arabic and the interface script is Latin, so the formatting locale
    // becomes the name`s, and this application generated `ar`, so it has the data to do it.
    // ar/givenFirst/medium/referring/formal is `{title} {given} {given2-initial} {surname}`.
    expect(
      render(mohamed, english, { length: 'medium', formality: 'formal' }),
    ).toBe('محمد المصري');
  });
});

describe('a name whose locale the application did not configure', () => {
  it('orders a Hungarian name given-first, because English says so about Hungarian names', () => {
    // The list that decides this is the *interface*`s. CLDR 48 gives en a surnameFirst list of
    // ja, ko, vi, yue and zh: Hungarian is not in it. Atlas`s hand-written table had `hu` in a
    // single global list and rendered this the other way round, in every interface at once.
    const ferenc = personName('hu', { given: 'Ferenc', surname: 'Molnár' });
    expect(render(ferenc, english)).toBe('Ferenc Molnár');
  });

  it('orders a Japanese name surname-first, because English says so about Japanese names', () => {
    // en surnameFirst/medium/referring/informal is `{surname} {given-informal}`. The application
    // configured no Japanese locale, so there is no `ja` profile to switch to and the separator
    // is English`s space rather than Japanese`s empty one.
    const suzuki = personName('ja', { given: '一郎', surname: '鈴木' });
    expect(render(suzuki, english)).toBe('鈴木 一郎');
  });
});

describe('formatting without the generated artifact', () => {
  it('falls back to the CLDR root profile rather than to an invented field order', () => {
    // Root medium referring formal is
    // `{title} {given} {given2} {surname} {surname2} {credentials}`.
    const result = formatPersonName(mary, english);
    expect(result.ok && result.value.text).toBe('Dr. Mary Sue Hamish');
  });

  it('refuses data from a derivation it does not read', () => {
    const result = formatPersonName(
      mary,
      english,
      {},
      {
        profile: 'cldr-99/atlas-person-names-7',
        patterns: [],
        rows: [],
      },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostic.reason).toBe('integrity-mismatch');
  });
});
