import { describe, expect, it } from 'vitest';

import {
  decimal,
  formatInstant,
  formatInstantRange,
  instant,
  type FormattingContext,
} from '@neolorn/atlas';

/**
 * Instants finer than a millisecond.
 *
 * Any instant whose nanoseconds were not a whole millisecond was refused outright with
 * `unsupported-formatting-capability`. Sub-millisecond instants are ordinary: .NET's
 * `DateTimeOffset` carries 100-nanosecond ticks, Go and Rust count nanoseconds, and PostgreSQL
 * `timestamptz` stores microseconds, so any system whose canonical timestamp comes from one of
 * those hands Atlas a value it refused. An ordinary order timestamp did not format at all. Not
 * wrongly: not at all.
 *
 * Nothing is lost by accepting them, which is what makes this a refusal rather than a safeguard.
 * `Intl.DateTimeFormat` cannot express finer than milliseconds, since `fractionalSecondDigits`
 * stops at 3, so no caller can ask for precision this discards. The rule is to format to the
 * precision the options request, and refuse only where sub-millisecond output is genuinely
 * requested, which no Intl option can do. Silent truncation was rejected; this is not truncation
 * of an answer, it is answering the question that was asked.
 */

const english: FormattingContext = Object.freeze({
  locale: 'en-US',
  timeZone: 'UTC',
  hourCycle: 'h23',
});

const arabic: FormattingContext = Object.freeze({
  locale: 'ar-EG',
  timeZone: 'Africa/Cairo',
});

const CLOCK = Object.freeze({
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
} as const);

function text(result: ReturnType<typeof formatInstant>): string {
  if (!result.ok)
    throw new Error(`formatting failed: ${result.diagnostic.code}`);
  return result.value.text;
}

describe('an instant carrying .NET tick precision', () => {
  it('formats rather than being refused for its precision', () => {
    // 100-nanosecond ticks: the precision every timestamp coming out of .NET carries.
    const ticks = instant('1800000000123456700');

    expect(text(formatInstant(ticks, english, CLOCK))).toBe('08:00:00.123');
    expect(formatInstant(ticks, arabic, { dateStyle: 'long' }).ok).toBe(true);
  });

  it('formats at nanosecond precision too', () => {
    expect(
      text(formatInstant(instant('1800000000123456789'), english, CLOCK)),
    ).toBe('08:00:00.123');
  });

  it('shows the caller the precision they asked for and no more', () => {
    // The distinction between answering and truncating. Milliseconds is the finest Intl can
    // express, so a caller asking for three fractional digits is being answered exactly.
    const ticks = instant('1800000000123456700');

    expect(
      text(
        formatInstant(ticks, english, { ...CLOCK, fractionalSecondDigits: 1 }),
      ),
    ).toBe('08:00:00.1');
    expect(
      text(
        formatInstant(ticks, english, { hour: '2-digit', minute: '2-digit' }),
      ),
    ).toBe('08:00');
  });

  it('formats a range whose endpoints both carry ticks', () => {
    expect(
      formatInstantRange(
        instant('1800000000123456700'),
        instant('1800000900123456700'),
        english,
        { dateStyle: 'short', timeStyle: 'short' },
      ).ok,
    ).toBe(true);
  });
});

describe('the millisecond an instant falls in', () => {
  it('floors rather than truncating toward zero', () => {
    // The case that separates the two, and the reason it matters: for an instant before 1970,
    // truncating toward zero names the millisecond *after* the one the instant falls in, so a
    // timestamp displays as later than it is.
    expect(text(formatInstant(instant('-1'), english, CLOCK))).toBe(
      '23:59:59.999',
    );
    expect(
      text(formatInstant(instant('-1'), english, { dateStyle: 'short' })),
    ).toBe('12/31/69');
  });

  it('keeps the epoch itself on the right side', () => {
    expect(text(formatInstant(instant('0'), english, CLOCK))).toBe(
      '00:00:00.000',
    );
    expect(text(formatInstant(instant('1'), english, CLOCK))).toBe(
      '00:00:00.000',
    );
    expect(
      text(formatInstant(instant('1'), english, { dateStyle: 'short' })),
    ).toBe('1/1/70');
  });

  it('still refuses an instant outside the native date range', () => {
    // The refusal that is a real limit rather than a self-imposed one.
    const result = formatInstant(
      instant('99999999999999999999999'),
      english,
      CLOCK,
    );

    expect(result.ok).toBe(false);
  });
});

describe('decimal normalization cost', () => {
  it('does not grow quadratically with trailing zeros', () => {
    // An unanchored `/0+$/u` for the trailing-zero strip is restarted by the engine at every
    // position: 65,000 zeros, a length `canonicalNumberCodeUnits` permits, costs about a second,
    // against a tenth of a millisecond for the anchored sibling one line above it. The
    // always-reachable path is a direct `decimal()` call, which is how money is formatted.
    //
    // The cost-budget gate measures the growth curve properly; this only pins that the value is
    // correct at a length the unanchored form makes unusable.
    const zeros = '0'.repeat(60_000);

    expect(decimal(`1.5${zeros}`).value).toBe('1.5');
    expect(decimal(`0.${zeros}`).value).toBe('0');
    expect(decimal(`-1.${zeros}`).value).toBe('-1');
  });
});
