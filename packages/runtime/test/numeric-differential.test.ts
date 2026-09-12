import { describe, expect, it } from 'vitest';

import { decimal } from '../src/formatting.js';
import {
  formatLocalizedInput,
  parseLocalizedInput,
} from '../src/localized-input.js';
import {
  type FormattingContext,
  type LocalizedInputProfile,
} from '@neolorn/atlas/core';

/**
 * Atlas's numeric rendering, checked against the platform's own idea of each locale.
 *
 * `localized-input-profiles.spec.ts` proves the round trip for all eleven profile kinds, at one
 * value per kind, through the directive. That is the integration claim and it is the right one. It
 * leaves a narrower question open: **is the rendering itself right, or merely self-consistent?** A
 * formatter that emitted Latin digits in every locale, or dropped a group separator, or put the
 * decimal separator where the group separator belongs, would round-trip perfectly against its own
 * parser and fail every reader.
 *
 * The only honest answer to that is a differential against something Atlas did not write, which
 * here is `Intl` itself, and specifically `Intl.NumberFormat.prototype.formatToParts`, which is a
 * different question to the platform than "format this number". Parts name each piece: which
 * characters are this locale's digits, which is its group separator, which is its decimal
 * separator. Nothing about Atlas's rendering is assumed; it is decoded using what the platform says
 * the locale's conventions are, and the decoded value must be the value that went in.
 *
 * **No pinned strings, and the reason matters more than the rule.** Writing
 * `expect(text).toBe('١٬٢٣٤٫٥')` pins one ICU edition's Arabic-Indic rendering of one number. When
 * a Node or browser update ships new CLDR data, that assertion fails, and it fails identically to a
 * real regression, so the person on the other end has to reconstruct which it was. Every
 * expectation here is a *property*: decode-what-you-encoded, parse-what-you-formatted,
 * same-answer-twice. Those hold in every ICU edition, which is what makes a failure informative.
 *
 * **Generated and seeded.** The values are drawn from a xorshift32 seeded by a constant in this
 * file, so every run everywhere draws the same values in the same order. A property that fails on
 * inputs nobody can reproduce is a rumour.
 *
 * **Why this is a unit test and not a feature-lab spec.** It was written as one, in the consumer
 * fixture, against the built package, and every assertion in it is a call to two pure functions
 * with three plain arguments. Nothing here needs Angular, a component, a provider or a locale
 * commit. Running it there cost a package build, a fixture materialize and a browser suite; running
 * it here costs about a third of a second, and the mutation that guards it dropped from roughly
 * twenty seconds to about three. A pure invariant is asserted in one place, and this is the
 * place.
 *
 * What stayed behind is the part that is not pure. `localized-input-profiles.spec.ts` still drives
 * all eleven profile kinds through the published directive across a locale change, against the
 * built package, which is the claim only the lab can make.
 *
 * `specs/12-verification.spec.md` section 8 asks for formatting and parsing to be checked
 * against an authority Atlas did not write, because a formatter that is only self-consistent
 * round-trips perfectly and fails every reader.
 */

function createRandom(seed: number) {
  let state = seed >>> 0 || 0x9e3779b9;
  return {
    next(): number {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x1_0000_0000;
    },
    integer(maximumExclusive: number): number {
      return Math.floor(this.next() * maximumExclusive);
    },
  };
}

const SEED = 0x5eed1;
const CASES = 150;

/**
 * Two locales whose numeric conventions disagree in every way that matters, plus the numbering
 * system each is asked for. ar-EG with `arab` is the case that separates a localized renderer from
 * an en-US renderer wearing a locale tag: different digits, a different decimal separator, a
 * different group separator, and right-to-left text around them.
 */
const ROWS: readonly {
  readonly name: string;
  readonly context: FormattingContext;
}[] = Object.freeze([
  {
    name: 'en-US/latn',
    context: Object.freeze({
      locale: 'en-US',
      timeZone: 'UTC',
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
    }),
  },
  {
    name: 'ar-EG/arab',
    context: Object.freeze({
      locale: 'ar-EG',
      timeZone: 'Africa/Cairo',
      calendar: 'gregory',
      numberingSystem: 'arab',
      hourCycle: 'h23',
    }),
  },
  {
    name: 'de-DE/latn',
    context: Object.freeze({
      locale: 'de-DE',
      timeZone: 'Europe/Berlin',
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
    }),
  },
]);

/**
 * Locales offered to the sign-decoration test, which keeps only the ones the platform says
 * decorate. Deliberately broader than the three rows above, and deliberately not a list of "the
 * right-to-left locales", which locales decorate is CLDR's answer to give, not this file's.
 */
const CANDIDATE_LOCALES: readonly string[] = Object.freeze([
  'ar',
  'ar-AE',
  'ar-EG',
  'ar-IQ',
  'ar-MA',
  'ar-SA',
  'ckb',
  'ckb-IQ',
  'de-DE',
  'en-US',
  'fa',
  'fa-AF',
  'he',
  'he-IL',
  'ks',
  'ps',
  'ps-AF',
  'sd',
  'ug',
  'ur',
  'ur-IN',
  'ur-PK',
]);

interface Conventions {
  /** This locale's ten digits, in order, as the platform reports them. */
  readonly digits: readonly string[];
  readonly group: string;
  readonly decimalSeparator: string;
  readonly minusSign: string;
  /**
   * The formatting controls this locale writes around a number: U+061C, U+200E, U+200F and the
   * isolates. Presentation, not value, so the decoder skips them.
   *
   * Learned, not listed. A written character class here would be the same hand-maintained copy of
   * CLDR that this file exists to catch Atlas keeping.
   */
  readonly marks: ReadonlySet<string>;
}

/**
 * What the platform says this locale's numeric conventions are.
 *
 * Read out of `formatToParts` rather than written down, which is the whole point: a table of
 * separators in this file would be a second copy of CLDR, maintained by hand, wrong the moment
 * either copy moved.
 */
function conventions(context: FormattingContext): Conventions {
  const formatter = new Intl.NumberFormat(context.locale, {
    numberingSystem: context.numberingSystem,
    useGrouping: true,
    maximumFractionDigits: 3,
  });
  const parts = formatter.formatToParts(-1234567.5);
  const group = parts.find((part) => part.type === 'group')?.value;
  const decimalSeparator = parts.find((part) => part.type === 'decimal')?.value;
  const minusSign = parts.find((part) => part.type === 'minusSign')?.value;

  // Digits come from formatting 0-9 individually, because a single formatted number does not
  // necessarily contain all ten.
  const plain = new Intl.NumberFormat(context.locale, {
    numberingSystem: context.numberingSystem,
    useGrouping: false,
  });
  const digits = Array.from({ length: 10 }, (_, digit) => plain.format(digit));

  // Ask the platform which controls it writes, rather than telling it. Both signs, because seven
  // locales write one on each side of the sign and some write none on a positive.
  const marks = new Set<string>();
  for (const sample of [-1234567.5, 1234567.5]) {
    for (const part of formatter.formatToParts(sample)) {
      if (part.type !== 'literal') continue;
      for (const character of part.value) {
        if (/\p{Cf}/u.test(character)) marks.add(character);
      }
    }
  }

  // If the platform cannot describe the locale, the differential has no oracle and the test would
  // silently degrade into asserting nothing.
  expect(group, context.locale).toBeTypeOf('string');
  expect(decimalSeparator, context.locale).toBeTypeOf('string');
  expect(minusSign, context.locale).toBeTypeOf('string');
  expect(new Set(digits).size, context.locale).toBe(10);

  return Object.freeze({
    digits: Object.freeze(digits),
    group: group as string,
    decimalSeparator: decimalSeparator as string,
    minusSign: minusSign as string,
    marks,
  });
}

/**
 * Atlas's rendering, read back through the platform's conventions into a plain ASCII decimal.
 *
 * Returns `undefined` for any character the locale does not account for, which is a failure and is
 * asserted as one rather than quietly dropped.
 */
function decode(text: string, convention: Conventions): string | undefined {
  let out = '';
  for (const character of text) {
    if (character === convention.group) continue;
    // A renderer that writes the locale's formatting controls is doing the right thing, and a
    // decoder that choked on them would be testing itself.
    if (convention.marks.has(character)) continue;
    if (character === convention.minusSign) {
      out += '-';
      continue;
    }
    if (character === convention.decimalSeparator) {
      out += '.';
      continue;
    }
    const digit = convention.digits.indexOf(character);
    if (digit < 0) return undefined;
    out += String(digit);
  }
  return out;
}

/** `-0012.500` and `-12.5` are the same number; the decoder returns the former shape. */
function canonicalNumeric(value: string): string {
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const [whole = '', fraction = ''] = body.split('.');
  const trimmedWhole = whole.replace(/^0+(?=\d)/u, '') || '0';
  const trimmedFraction = fraction.replace(/0+$/u, '');
  const magnitude =
    trimmedFraction.length > 0
      ? `${trimmedWhole}.${trimmedFraction}`
      : trimmedWhole;
  return magnitude === '0' ? '0' : `${negative ? '-' : ''}${magnitude}`;
}

/** Values spanning the grouping boundary, the sign, and the fraction-digit ceiling. */
function generateDecimal(random: ReturnType<typeof createRandom>): string {
  const digits = 1 + random.integer(9);
  let whole = String(1 + random.integer(9));
  for (let index = 1; index < digits; index += 1) {
    whole += String(random.integer(10));
  }
  const fractionDigits = random.integer(4);
  let fraction = '';
  for (let index = 0; index < fractionDigits; index += 1) {
    fraction += String(random.integer(10));
  }
  const sign = random.integer(4) === 0 ? '-' : '';
  return fraction.length > 0
    ? `${sign}${whole}.${fraction}`
    : `${sign}${whole}`;
}

const PROFILE: LocalizedInputProfile = Object.freeze({
  kind: 'decimal',
  maximumFractionDigits: 3,
  allowGrouping: true,
});

describe('Atlas renders numbers the way the platform says the locale does', () => {
  for (const row of ROWS) {
    it(`decodes back to the value that went in, in ${row.name}`, () => {
      const random = createRandom(SEED);
      const convention = conventions(row.context);

      for (let index = 0; index < CASES; index += 1) {
        const source = generateDecimal(random);
        const formatted = formatLocalizedInput(
          decimal(source),
          PROFILE,
          row.context,
        );
        expect(formatted.ok, source).toBe(true);
        if (!formatted.ok) continue;

        const decoded = decode(formatted.value.text, convention);
        // An undefined decode means Atlas emitted a character this locale does not use for
        // numbers, which is the failure a self-consistent round trip cannot see.
        expect(decoded, `${source} -> ${formatted.value.text}`).toBeTypeOf(
          'string',
        );
        expect(
          canonicalNumeric(decoded as string),
          `${source} -> ${formatted.value.text}`,
        ).toBe(canonicalNumeric(source));
      }
    });

    it(`parses back what it formatted, in ${row.name}`, () => {
      const random = createRandom(SEED);
      for (let index = 0; index < CASES; index += 1) {
        const source = generateDecimal(random);
        const formatted = formatLocalizedInput(
          decimal(source),
          PROFILE,
          row.context,
        );
        if (!formatted.ok) continue;

        const parsed = parseLocalizedInput(
          formatted.value.text,
          PROFILE,
          row.context,
        );
        expect(parsed.status, formatted.value.text).toBe('valid');
        if (parsed.status !== 'valid') continue;

        // The round trip at scale rather than at one value. `verifyFormattedInput` already refuses
        // to format when its own re-parse disagrees, so what this adds is the *set* of values that
        // property has been asserted over: grouping boundaries, negative signs, and the
        // fraction-digit ceiling, in three locales.
        expect(
          canonicalNumeric((parsed.value as { value: string }).value),
          source,
        ).toBe(canonicalNumeric(source));
      }
    });

    it(`renders the same value the same way every time, in ${row.name}`, () => {
      const random = createRandom(SEED);
      for (let index = 0; index < CASES; index += 1) {
        const source = generateDecimal(random);
        const once = formatLocalizedInput(
          decimal(source),
          PROFILE,
          row.context,
        );
        const twice = formatLocalizedInput(
          decimal(source),
          PROFILE,
          row.context,
        );
        expect(once.ok, source).toBe(twice.ok);
        if (!once.ok || !twice.ok) continue;
        // Formatter caching is an optimisation, and an optimisation that returns a different
        // answer on the second call is a defect that only shows up under load.
        expect(twice.value.text, source).toBe(once.value.text);
      }
    });
  }

  /**
   * The sign is the one part of a number the platform decorates.
   *
   * `Intl` writes a formatting control next to the sign in a quarter of the locales it has data
   * for: U+061C ARABIC LETTER MARK in `ar-EG`, U+200E LEFT-TO-RIGHT MARK in `he-IL`, U+200F in
   * `ckb-IQ`, and in seven locales one on *each* side of it. It carries no value and it is reported
   * as a `literal` part, so a parser that expects the sign at the front of the string does not find
   * it there. The consequence is not a cosmetic one: Atlas refuses to render what it cannot read
   * back, so a negative number became unrenderable in every one of those locales at once.
   *
   * The generated rows above would catch this only when a negative happens to be drawn in a
   * right-to-left row, which is luck rather than coverage. This asserts it directly, and the set of
   * locales is *discovered* rather than listed: the platform is asked which locales decorate the
   * sign, and every one of them has to round-trip. A hand-written list would go stale against CLDR
   * in exactly the way the defect did.
   */
  it('round-trips a negative in every locale the platform decorates the sign in', () => {
    const numericParts = new Set(['integer', 'group', 'decimal', 'fraction']);
    const decorated = CANDIDATE_LOCALES.filter((locale) => {
      const parts = new Intl.NumberFormat(locale, {
        useGrouping: false,
        signDisplay: 'always',
      }).formatToParts(-1);
      const firstDigit = parts.findIndex((part) => numericParts.has(part.type));
      return parts
        .slice(0, firstDigit < 0 ? parts.length : firstDigit)
        .some((part) => part.type === 'literal' && /\p{Cf}/u.test(part.value));
    });

    // Without this the test passes vacuously on a platform build with narrower ICU data, which is
    // the failure mode of every test that filters its own inputs.
    expect(decorated.length).toBeGreaterThan(0);

    for (const locale of decorated) {
      const context: FormattingContext = {
        locale,
        timeZone: 'UTC',
        calendar: 'gregory',
        hourCycle: 'h23',
      };
      for (const source of ['-1', '-0.5', '-93.9']) {
        const formatted = formatLocalizedInput(
          decimal(source),
          PROFILE,
          context,
        );
        expect(formatted.ok, `${locale} ${source}`).toBe(true);
        if (!formatted.ok) continue;

        const parsed = parseLocalizedInput(
          formatted.value.text,
          PROFILE,
          context,
        );
        expect(parsed.status, `${locale} ${formatted.value.text}`).toBe(
          'valid',
        );
        if (parsed.status !== 'valid') continue;
        expect(
          canonicalNumeric((parsed.value as { value: string }).value),
          `${locale} ${formatted.value.text}`,
        ).toBe(canonicalNumeric(source));
      }
    }
  });

  it('does not render every locale the same way, so the differential is not a no-op', () => {
    const random = createRandom(SEED);
    const value = decimal(generateDecimal(random));
    const rendered = ROWS.map((row) => {
      const result = formatLocalizedInput(value, PROFILE, row.context);
      expect(result.ok, row.name).toBe(true);
      return result.ok ? result.value.text : '';
    });
    // Without this, a renderer that ignored the locale entirely would satisfy every property above:
    // it would decode correctly, parse back, and be stable.
    expect(new Set(rendered).size).toBeGreaterThan(1);
  });
});
