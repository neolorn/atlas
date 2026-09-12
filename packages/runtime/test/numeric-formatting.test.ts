import { describe, expect, it } from 'vitest';

import {
  decimal,
  duration,
  formatDuration,
  formatMeasurement,
  formatMoney,
  formatNumber,
  formatNumberRange,
  measurement,
  money,
} from '../src/formatting.js';
import { type FormattingContext } from '@neolorn/atlas/core';

/**
 * The formatting path, checked against the platform's own idea of each locale.
 *
 * `formatting.ts` is the largest correctness surface in the runtime after `parsing.ts` and, until
 * this file, carried no mutation-verified coverage at all: every injection in either assurance
 * harness named `routing.ts`, `angular.ts`, `localization.ts` or the router's public API, and the
 * two modules where every numbering-system finding has lived had none.
 *
 * The property asserted here is the one a self-consistent formatter cannot fake. Atlas is asked to
 * render in a numbering system; the result is decoded back through the digits the platform says
 * that locale and numbering system use, and the decoded number must be the number that went in. A
 * formatter that quietly dropped `numberingSystem`, rendering `123` where `١٢٣` was asked for,
 * round-trips perfectly against itself and is wrong for every reader.
 *
 * Nothing is pinned. `expect(text).toBe('١٢٣')` would fail on the next CLDR update in exactly the
 * way a real regression fails, leaving whoever hits it to work out which it was.
 */

const ROWS: readonly {
  readonly name: string;
  readonly context: FormattingContext;
}[] = Object.freeze([
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
    name: 'fa-IR/arabext',
    context: Object.freeze({
      locale: 'fa-IR',
      timeZone: 'Asia/Tehran',
      calendar: 'gregory',
      numberingSystem: 'arabext',
      hourCycle: 'h23',
    }),
  },
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
  // The two rows that make this file test anything. The three above ask each locale for the
  // numbering system it already defaults to, so a formatter that discarded `numberingSystem`
  // entirely would satisfy all three, and did: the injection that removes the option went green
  // against them. A cross row is the only shape in which the option's presence is observable.
  {
    name: 'en-US/arab (not the locale default)',
    context: Object.freeze({
      locale: 'en-US',
      timeZone: 'UTC',
      calendar: 'gregory',
      numberingSystem: 'arab',
      hourCycle: 'h23',
    }),
  },
  {
    name: 'ar-EG/latn (not the locale default)',
    context: Object.freeze({
      locale: 'ar-EG',
      timeZone: 'Africa/Cairo',
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
    }),
  },
]);

/** The ten digits the platform says this locale and numbering system use. */
function digitsFor(context: FormattingContext): readonly string[] {
  const formatter = new Intl.NumberFormat(context.locale, {
    numberingSystem: context.numberingSystem,
    useGrouping: false,
  });
  const digits = Array.from({ length: 10 }, (_, digit) =>
    formatter.format(digit),
  );
  expect(new Set(digits).size, context.locale).toBe(10);
  return digits;
}

/** Every digit in `text`, read back to ASCII through `digits`. */
function decodeDigits(text: string, digits: readonly string[]): string {
  let out = '';
  for (const character of text) {
    const index = digits.indexOf(character);
    if (index >= 0) out += String(index);
  }
  return out;
}

/**
 * Digit characters in `text` that are not this locale's.
 *
 * The real invariant, and stated this way because it does not depend on any formatter default:
 * money renders two fraction digits and a measurement renders a unit, so "the decoded digits equal
 * the input" is only true for a plain number. "No digit from another numbering system appears" is
 * true for all of them, and it is what a dropped `numberingSystem` breaks.
 */
function foreignDigits(
  text: string,
  digits: readonly string[],
): readonly string[] {
  return [...text].filter(
    (character) => /\p{Nd}/u.test(character) && !digits.includes(character),
  );
}

describe('the numeric formatters render in the numbering system they were given', () => {
  for (const row of ROWS) {
    it(`renders decimal, money and measurement in ${row.name}'s digits`, () => {
      const digits = digitsFor(row.context);
      const cases = [
        ['number', formatNumber(decimal('1234'), row.context)],
        ['money', formatMoney(money(decimal('1234'), 'EGP'), row.context)],
        [
          'measurement',
          formatMeasurement(
            measurement(decimal('1234'), 'kilometer'),
            row.context,
          ),
        ],
      ] as const;

      for (const [kind, result] of cases) {
        expect(result.ok, `${row.name} ${kind}`).toBe(true);
        if (!result.ok) continue;
        const where = `${row.name} ${kind} -> ${result.value.text}`;
        expect(foreignDigits(result.value.text, digits), where).toEqual([]);
        // And it did render a number, so an empty or digitless result cannot pass the line above
        // by having nothing to object to.
        expect(decodeDigits(result.value.text, digits), where).toContain(
          '1234',
        );
      }
    });
  }

  it('asks at least one locale for a numbering system that is not its default', () => {
    // Without this the file can drift back to being vacuous by a route nothing shows: every row
    // requesting its own locale's default reads as thorough coverage and asserts that the option
    // exists, not that it is used. Read from the platform rather than listed, so a CLDR change that
    // makes one of these the default fails here instead of silently emptying the file.
    const crossed = ROWS.filter(
      ({ context }) =>
        new Intl.NumberFormat(context.locale).resolvedOptions()
          .numberingSystem !== context.numberingSystem,
    );
    expect(crossed.map(({ name }) => name).length).toBeGreaterThan(0);
  });

  it('does not render every numbering system the same way, so the check is not a no-op', () => {
    const rendered = ROWS.map((row) => {
      const result = formatNumber(decimal('1234'), row.context);
      expect(result.ok, row.name).toBe(true);
      return result.ok ? result.value.text : '';
    });
    // Without this, a formatter that ignored `numberingSystem` entirely would satisfy the loop
    // above in the one row whose digits are ASCII, and be caught only by the others, which is a
    // weaker claim than saying the rows must actually differ.
    expect(new Set(rendered).size).toBeGreaterThan(1);
  });

  it('reports an unsupported profile rather than throwing', () => {
    const result = formatMeasurement(
      measurement(decimal('1'), 'not-a-real-unit'),
      ROWS[0]!.context,
    );
    // Totality matters more than the particular diagnostic: a formatter that throws takes down the
    // render, and a locale's data is not something the caller can check in advance.
    expect(result.ok).toBe(false);
  });
});

/**
 * The numbering system reaches the surfaces that accept it and drop it.
 *
 * `NumberFormat.formatRange`, `NumberFormat.formatRangeToParts` and `DurationFormat.format` take a
 * `numberingSystem` option, ignore it, and report through `resolvedOptions().numberingSystem` that
 * they honoured it. Measured on ICU 78.3 across ar-EG, fa-IR, bn-BD, my-MM, ne-NP and mr-IN; every
 * other Intl surface honours the option and the `-u-nu-` extension identically, which is why Atlas
 * builds one tag for all of them.
 *
 * Every row here is crossed on purpose: the locale is asked for digits that are not its own. A
 * row asking a locale for its own default cannot observe any of this, which is the defect the
 * formatter suite above had until it was corrected.
 */
describe('a crossed numbering system reaches every numeric surface', () => {
  const CROSSED = Object.freeze([
    { name: 'ar-EG asked for latn', locale: 'ar-EG', numberingSystem: 'latn' },
    { name: 'fa-IR asked for latn', locale: 'fa-IR', numberingSystem: 'latn' },
    { name: 'en-US asked for arab', locale: 'en-US', numberingSystem: 'arab' },
  ] as const);

  for (const row of CROSSED) {
    const context: FormattingContext = Object.freeze({
      locale: row.locale,
      timeZone: 'UTC',
      calendar: 'gregory',
      numberingSystem: row.numberingSystem,
      hourCycle: 'h23',
    });

    it(`renders a range and a duration in ${row.name}'s digits`, () => {
      // Crossed, so this is not the locale's own set and a dropped option shows up as the
      // locale default appearing where these digits should be.
      const digits = digitsFor(context);
      const cases = [
        ['range', formatNumberRange(decimal('1'), decimal('2'), context)],
        [
          'duration',
          formatDuration(duration({ hours: 1, minutes: 30 }), context),
        ],
      ] as const;

      for (const [kind, result] of cases) {
        expect(result.ok, `${row.name} ${kind}`).toBe(true);
        if (!result.ok) continue;
        const where = `${row.name} ${kind} -> ${result.value.text}`;
        expect(foreignDigits(result.value.text, digits), where).toEqual([]);
        // And digits were actually rendered, so an empty result cannot satisfy the line above by
        // having nothing to object to.
        expect(
          decodeDigits(result.value.text, digits).length,
          where,
        ).toBeGreaterThan(0);
      }
    });
  }

  it('honours a crossed request on a locale that already carries a -u- extension', () => {
    // The case string concatenation cannot serve. `ar-EG-u-ca-islamic` + `-u-nu-latn` is two `u`
    // singletons, which RFC 5646 §2.2.6 forbids, and `Intl` rejects the tag outright, so a
    // formatter built that way throws for any consumer whose locale carries a calendar. Atlas
    // canonicalizes through `Intl.getCanonicalLocales`, which preserves extensions, so this is
    // reachable rather than theoretical.
    const context: FormattingContext = Object.freeze({
      locale: 'ar-EG-u-ca-islamic',
      timeZone: 'UTC',
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
    });
    const result = formatNumberRange(decimal('1'), decimal('2'), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(foreignDigits(result.value.text, digitsFor(context))).toEqual([]);
  });

  it('refuses a well-formed numbering system this runtime has no data for', () => {
    // Neither the option form nor the extension form reports one: both fall back to the locale
    // default and render. Silence here means a caller asks for digits that do not exist, is told
    // nothing, and is shown different ones.
    const context: FormattingContext = Object.freeze({
      locale: 'ar-EG',
      timeZone: 'UTC',
      calendar: 'gregory',
      numberingSystem: 'zzzz',
      hourCycle: 'h23',
    });
    for (const result of [
      formatNumber(decimal('1234'), context),
      formatNumberRange(decimal('1'), decimal('2'), context),
      formatDuration(duration({ hours: 1, minutes: 30 }), context),
    ]) {
      expect(result.ok).toBe(false);
    }
  });

  it('leaves a locale alone when no numbering system is asked for', () => {
    // The refusal above must not have made an absent numbering system into an error. Absent is the
    // ordinary case and means "whatever this locale uses".
    const context: FormattingContext = Object.freeze({
      locale: 'ar-EG',
      timeZone: 'UTC',
      calendar: 'gregory',
      hourCycle: 'h23',
    });
    const result = formatNumberRange(decimal('1'), decimal('2'), context);
    expect(result.ok).toBe(true);
  });
});
