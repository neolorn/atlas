import { describe, expect, it } from 'vitest';

import type { CompiledInputContract } from '../src/catalog-runtime.js';
import { render } from './message-harness.js';
import type { FormattingContext } from '@neolorn/atlas/core';

/**
 * What the date family's options do to a rendering, measured by what changes when the instant does.
 *
 * An evaluator that builds its `Intl.DateTimeFormat` options from a hand-written branch reading
 * four of them, with a compiler that checks none, accepts and discards every other option:
 * `{$when :date fields=weekday}` compiles, renders a full date, and gives the author nothing to
 * notice.
 *
 * **Nothing here pins a CLDR string.** `expect(text).toBe('Sat')` fails on the next ICU update in
 * exactly the way a real regression fails, and leaves whoever hits it to work out which it was.
 * What is asserted instead is the meaning of the option name, which is the standard's own statement
 * and does not move: `fields=month-day` names two fields, so two instants render alike exactly when
 * their month and day agree, whatever this platform's month and day happen to look like. That is
 * also why the check cannot agree with the implementation by construction: it is derived from the
 * option's name, not from the mapping the option's name is turned into.
 */

const WHEN: readonly CompiledInputContract[] = Object.freeze([
  { name: 'd', type: 'date-time', optional: false, nullable: false },
]);

const UTC: FormattingContext = Object.freeze({
  locale: 'en-US',
  timeZone: 'UTC',
});

const at = (
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
  second = 0,
): Date => new Date(Date.UTC(year, month - 1, day, hour, minute, second));

const pairsOf = <T>(items: readonly T[]): readonly (readonly [T, T])[] => {
  const pairs: (readonly [T, T])[] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      pairs.push([items[i] as T, items[j] as T]);
    }
  }
  return pairs;
};

/**
 * The four date fields and the three time fields the option names name, read off the instant in the
 * zone it will be rendered in. `getUTC*` is that zone, because every rendering below is in UTC
 * unless the message says otherwise.
 */
const FIELD: Readonly<Record<string, (date: Date) => number>> = Object.freeze({
  year: (date) => date.getUTCFullYear(),
  month: (date) => date.getUTCMonth(),
  day: (date) => date.getUTCDate(),
  weekday: (date) => date.getUTCDay(),
  hour: (date) => date.getUTCHours(),
  minute: (date) => date.getUTCMinutes(),
  second: (date) => date.getUTCSeconds(),
});

const agreeOn = (names: readonly string[], a: Date, b: Date): boolean =>
  names.every(
    (name) =>
      (FIELD[name] as (d: Date) => number)(a) ===
      (FIELD[name] as (d: Date) => number)(b),
  );

/**
 * The property both option families share: an option that names fields shows those fields and no
 * others, so two instants render alike **exactly** when the named fields agree.
 *
 * Both directions matter and they fail differently. A rendering that differs where the named fields
 * agree is showing a field nobody asked for. A rendering that agrees where a named field differs is
 * not showing a field that was asked for: the accepted-and-never-read failure, in the only form
 * that survives a formatter which is self-consistently wrong.
 */
const assertShowsExactly = (
  text: (date: Date) => string,
  named: readonly string[],
  instants: readonly Date[],
): void => {
  for (const [a, b] of pairsOf(instants)) {
    const same = text(a) === text(b);
    expect(
      same,
      named.join('-') +
        ' rendered ' +
        JSON.stringify(text(a)) +
        ' and ' +
        JSON.stringify(text(b)) +
        ' for ' +
        a.toISOString() +
        ' and ' +
        b.toISOString(),
    ).toBe(agreeOn(named, a, b));
  }
};

describe('the fields a date option asks for', () => {
  const DAYS: readonly Date[] = Object.freeze([
    at(2026, 9, 5),
    at(2026, 9, 12),
    at(2027, 9, 5),
    at(2026, 10, 5),
    at(2026, 10, 12),
    at(2025, 9, 5),
  ]);

  const FIELD_VALUES: readonly string[] = Object.freeze([
    'weekday',
    'day-weekday',
    'month-day',
    'month-day-weekday',
    'year-month-day',
    'year-month-day-weekday',
  ]);

  it.each(FIELD_VALUES)(
    ':date fields=%s shows those fields and no others',
    (value) => {
      assertShowsExactly(
        (date) =>
          render(
            'When: {$d :date fields=' + value + '}',
            WHEN,
            { d: date },
            UTC,
          ),
        value.split('-'),
        DAYS,
      );
    },
  );

  it.each(FIELD_VALUES)(
    ':datetime dateFields=%s shows those fields and no others',
    (value) => {
      assertShowsExactly(
        (date) =>
          render(
            'When: {$d :datetime dateFields=' + value + ' timePrecision=hour}',
            WHEN,
            { d: date },
            UTC,
          ),
        value.split('-'),
        DAYS,
      );
    },
  );

  /**
   * *"The `fields` option is optional, with the default value being `year-month-day`."* An unwritten
   * option is not a different option, and the walk in the gate reads this one as inert for exactly
   * that reason: `fields=year-month-day` renders like the bare form because it is the bare form.
   */
  it('defaults to year-month-day when nothing is written', () => {
    const date = at(2026, 9, 5);
    expect(render('When: {$d :date}', WHEN, { d: date }, UTC)).toBe(
      render('When: {$d :date fields=year-month-day}', WHEN, { d: date }, UTC),
    );
  });
});

describe('the precision a time option asks for', () => {
  const TIMES: readonly Date[] = Object.freeze([
    at(2026, 9, 5, 23, 30, 45),
    at(2026, 9, 5, 23, 30, 7),
    at(2026, 9, 5, 23, 45, 45),
    at(2026, 9, 5, 21, 30, 45),
    at(2026, 9, 5, 21, 45, 7),
  ]);

  const SHOWN: Readonly<Record<string, readonly string[]>> = Object.freeze({
    hour: Object.freeze(['hour']),
    minute: Object.freeze(['hour', 'minute']),
    second: Object.freeze(['hour', 'minute', 'second']),
  });

  it.each(Object.keys(SHOWN))(
    ':time precision=%s shows down to that field',
    (value) => {
      assertShowsExactly(
        (date) =>
          render(
            'At: {$d :time precision=' + value + '}',
            WHEN,
            { d: date },
            UTC,
          ),
        SHOWN[value] as readonly string[],
        TIMES,
      );
    },
  );

  it.each(Object.keys(SHOWN))(
    ':datetime timePrecision=%s shows down to that field',
    (value) => {
      assertShowsExactly(
        (date) =>
          render(
            'At: {$d :datetime timePrecision=' + value + '}',
            WHEN,
            { d: date },
            UTC,
          ),
        SHOWN[value] as readonly string[],
        TIMES,
      );
    },
  );

  it('defaults to minute when nothing is written', () => {
    const date = at(2026, 9, 5, 23, 30, 45);
    expect(render('At: {$d :time}', WHEN, { d: date }, UTC)).toBe(
      render('At: {$d :time precision=minute}', WHEN, { d: date }, UTC),
    );
  });
});

describe('the options that change how a field is written rather than which', () => {
  const DATE = at(2026, 9, 5, 23, 30, 45);
  const rendered = (source: string, context: FormattingContext = UTC): string =>
    render(source, WHEN, { d: DATE }, context);

  /**
   * *"The `length` option ... MUST be one of `long`, `medium`, `short`."* Three lengths asking for
   * the same fields have to be three renderings, or one of them is a word the author wrote for
   * nothing.
   */
  it('writes the same fields three ways for the three lengths', () => {
    const texts = ['long', 'medium', 'short'].map((length) =>
      rendered('When: {$d :date fields=year-month-day length=' + length + '}'),
    );
    expect(new Set(texts).size, texts.join(' / ')).toBe(3);
  });

  it('writes the same fields three ways for the three dateLengths', () => {
    const texts = ['long', 'medium', 'short'].map((length) =>
      rendered('When: {$d :datetime dateLength=' + length + '}'),
    );
    expect(new Set(texts).size, texts.join(' / ')).toBe(3);
  });

  /**
   * *"The `timeZoneStyle` option ... `long` ... `short`."* The option adds a field rather than
   * changing one, so the bare form is the third rendering and all three have to differ.
   */
  it('adds the zone, two ways, where the bare form has none', () => {
    const texts = [
      rendered('At: {$d :time}'),
      rendered('At: {$d :time timeZoneStyle=short}'),
      rendered('At: {$d :time timeZoneStyle=long}'),
    ];
    expect(new Set(texts).size, texts.join(' / ')).toBe(3);
  });

  /**
   * `hour12` is the one option whose two values name their own output: the same instant is 23 on one
   * clock and 11 on the other. It is also the one whose string had to be converted, because
   * `"false"` is truthy and passing it through gives a twelve-hour clock to an author who asked in
   * writing for a twenty-four-hour one.
   */
  it('reads hour12 as the clock it names', () => {
    expect(rendered('At: {$d :time hour12=false}')).toContain('23');
    expect(rendered('At: {$d :time hour12=true}')).toContain('11');
    expect(rendered('At: {$d :time hour12=true}')).not.toContain('23');
  });

  /**
   * *"Date/time override options are options that allow an expression to override values set by the
   * current locale, or provided by the formatting context."* `hour12` and the context's `hourCycle`
   * describe the same thing, so the message writing one has to mean the context's is not sent.
   */
  it('lets hour12 override the context hour cycle in both directions', () => {
    const twelve: FormattingContext = Object.freeze({
      ...UTC,
      hourCycle: 'h12',
    });
    const twentyFour: FormattingContext = Object.freeze({
      ...UTC,
      hourCycle: 'h23',
    });
    expect(rendered('At: {$d :time}', twelve)).toContain('11');
    expect(rendered('At: {$d :time hour12=false}', twelve)).toContain('23');
    expect(rendered('At: {$d :time}', twentyFour)).toContain('23');
    expect(rendered('At: {$d :time hour12=true}', twentyFour)).toContain('11');
  });

  /**
   * The Buddhist era is the Gregorian year plus 543, which is arithmetic rather than a string this
   * platform happens to produce. `calendar=nosuch` is refused at compile time precisely because
   * `Intl` would have rendered this same Gregorian year and said nothing.
   */
  it('renders the era of the calendar it is given, from the message or from the context', () => {
    expect(rendered('When: {$d :date calendar=buddhist}')).toContain('2569');
    expect(rendered('When: {$d :date}')).toContain('2026');
    expect(
      rendered(
        'When: {$d :date}',
        Object.freeze({ ...UTC, calendar: 'buddhist' }),
      ),
    ).toContain('2569');
  });
});

/**
 * The zone is the option with a wrong answer rather than a missing one: an instant formatted in the
 * wrong zone is a different day on the screen, spelled as confidently as the right one.
 */
describe('the time zone', () => {
  const MIDNIGHT_IN_TOKYO = at(2026, 9, 5, 23, 30, 0);
  const inZone = (source: string): string =>
    render(source, WHEN, { d: MIDNIGHT_IN_TOKYO }, UTC);

  it('is taken from the message over the context', () => {
    const tokyo = inZone('When: {$d :date timeZone=|Asia/Tokyo|}');
    expect(tokyo).not.toBe(inZone('When: {$d :date}'));
    expect(tokyo).toContain('6');
  });

  /**
   * *"`input` ... means that the time zone of the operand is used."* An Atlas date input is a
   * `Date`, which carries no zone, so the only operand that can answer is one whose declaration
   * wrote a zone, and the answer has to be that zone, not the context's.
   */
  it('is taken from the operand when the message writes input', () => {
    expect(
      inZone(
        '.local $t = {$d :datetime timeZone=|Asia/Tokyo|}\n{{When: {$t :date timeZone=input}}}',
      ),
    ).toBe(inZone('When: {$d :date timeZone=|Asia/Tokyo|}'));
  });

  /**
   * The compiler refuses `timeZone=input` where the chain gives no zone, so reaching this needs a
   * value the compiler cannot see: an option written as a variable. Without the check here the
   * runtime's own guard would have only ever run on the path that succeeds, and a compiled artifact
   * this runtime did not compile is exactly the input it exists for.
   */
  it('is refused at render when nothing gave the operand one', () => {
    expect(() =>
      render(
        '.input {$z :string}\n{{When: {$d :date timeZone=$z}}}',
        Object.freeze([
          ...WHEN,
          { name: 'z', type: 'string', optional: false, nullable: false },
        ]),
        { d: MIDNIGHT_IN_TOKYO, z: 'input' },
        UTC,
      ),
    ).toThrow(/timeZone=input/);
  });

  /**
   * *"Date/time override options ... are the options an expression takes from its operand."* The
   * three overrides are carried and everything else is not, which is the difference between a
   * declaration that sets the zone for the whole message and one whose length silently reappears
   * where the author asked for a different one.
   */
  it('is inherited by a later expression, where a length is not', () => {
    expect(
      inZone(
        '.local $t = {$d :datetime timeZone=|Asia/Tokyo|}\n{{When: {$t :date}}}',
      ),
    ).toBe(inZone('When: {$d :date timeZone=|Asia/Tokyo|}'));
    expect(
      inZone(
        '.local $t = {$d :datetime dateLength=long}\n{{When: {$t :date}}}',
      ),
    ).toBe(inZone('When: {$d :date}'));
  });
});
