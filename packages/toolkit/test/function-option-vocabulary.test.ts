import { describe, expect, it } from 'vitest';

import { parseAtlasMessage } from '../src/message-format.js';

/**
 * Every built-in function declares the options it accepts, and the compiler builds the
 * formatter the evaluator will build for all of them rather than for the numeric six.
 *
 * The state this replaced is worth stating, because it is the reason the check is shaped this way.
 * `checkFunctionOptions` looked the function up in a table that held only the numeric family and
 * returned when it was absent, so **every option name and every option value written on `:string`,
 * `:datetime`, `:date` and `:time` was accepted unread**. That failed in two directions at once:
 * thirteen messages compiled and threw while rendering, and thirty-seven compiled, rendered, and
 * ignored the option the author had written.
 *
 * The exhaustive half of this lives in `tools/verify-message-function-space.mjs`, which generates
 * its cases from the table and runs in the gate. What is here is the named cases: the ones a
 * reader needs to see spelled out, and the ones whose diagnostics a person has to be able to act on.
 */
describe('the option vocabulary of the built-in functions', () => {
  const refusal = (source: string): string => {
    const result = parseAtlasMessage(source);
    expect(result.ok, `${source} was accepted`).toBe(false);
    if (result.ok) return '';
    return result.diagnostics.map(({ summary }) => summary).join(' | ');
  };

  const accepted = (source: string): void => {
    const result = parseAtlasMessage(source);
    expect(
      result.ok,
      `${source} was refused: ${result.ok ? '' : result.diagnostics.map(({ summary }) => summary).join(' | ')}`,
    ).toBe(true);
  };

  describe('the date family', () => {
    it.each([
      ['fields', '{$d :date fields=weekday}'],
      ['length', '{$d :date length=long}'],
      ['dateFields', '{$d :datetime dateFields=month-day-weekday}'],
      ['dateLength', '{$d :datetime dateLength=short}'],
      ['timePrecision', '{$d :datetime timePrecision=second}'],
      ['precision', '{$d :time precision=hour}'],
      ['timeZoneStyle', '{$d :time timeZoneStyle=long}'],
      ['hour12', '{$d :time hour12=false}'],
      ['calendar', '{$d :date calendar=buddhist}'],
      ['timeZone', '{$d :date timeZone=|Europe/Paris|}'],
    ])('accepts %s, which the standard requires it to', (_name, source) => {
      accepted(source);
    });

    it('refuses an option no date function has', () => {
      expect(refusal('{$d :date nosuchoption=1}')).toContain(
        'is not an option of :date; it takes calendar, fields, length, timeZone',
      );
    });

    /**
     * `:datetime` writes `dateFields` and `dateLength` where `:date` writes `fields` and `length`,
     * and the specification does not let either borrow the other's spelling. Both were accepted
     * before this item, and neither was read.
     */
    it('refuses one function spelling of an option on another', () => {
      expect(refusal('{$d :date dateFields=weekday}')).toContain(
        'is not an option of :date',
      );
      expect(refusal('{$d :datetime fields=weekday}')).toContain(
        'is not an option of :datetime',
      );
    });

    it('refuses a value outside the option', () => {
      expect(refusal('{$d :date fields=nosuch}')).toContain(
        'is not one of weekday, day-weekday, month-day, month-day-weekday, year-month-day, year-month-day-weekday',
      );
      expect(refusal('{$d :time hour12=maybe}')).toContain(
        'is not true or false',
      );
    });

    /**
     * *"The `fields` and `length` option values MUST each be set by a literal."* Everything except
     * the three date/time override options, which describe the environment rather than the message.
     */
    it('refuses a variable where the standard requires a literal, and allows one where it does not', () => {
      expect(
        refusal('.input {$f :string}\n{{When: {$d :date fields=$f}}}'),
      ).toContain('must be a literal, not a variable reference');
      accepted('.input {$z :string}\n{{When: {$d :date timeZone=$z}}}');
    });
  });

  /**
   * Two options whose valid values are a body of data rather than a rule, and which need two
   * different authorities because the platform answers for one and not the other.
   */
  describe('the two options whose vocabulary is data', () => {
    it('refuses a time zone by constructing the formatter that would receive it', () => {
      expect(refusal('{$d :date timeZone=|Nowhere/Nowhere|}')).toContain(
        'is not a time zone identifier such as UTC or Europe/Paris',
      );
      accepted('{$d :date timeZone=|Asia/Tokyo|}');
    });

    /**
     * Constructing the formatter does not answer for `calendar`, which is why it is read from
     * `Intl.supportedValuesOf` instead. `Intl.DateTimeFormat` throws on a malformed identifier and
     * *silently formats in the locale's own calendar* for a well-formed one it has no data for, so
     * an unchecked `calendar=nosuch` renders a Gregorian date with nothing anywhere to say the
     * option was dropped.
     */
    it('refuses a calendar the platform accepts and would then ignore', () => {
      expect(refusal('{$d :date calendar=nosuch}')).toContain(
        'is not a calendar this runtime has data for',
      );
      accepted('{$d :date calendar=japanese}');
    });
  });

  /**
   * `timeZone=input` names the operand's own zone. An Atlas date input is a `Date` and carries
   * none, so the only operand that can answer is one whose declaration wrote a zone.
   *
   * The specification's answer when nothing does is a Bad Operand error at format time beside a
   * rendered fallback. Section 6 of `specs/04-message-authoring-and-catalogs.spec.md` declines
   * that, and the reason is sharper here
   * than almost anywhere: the fallback formats the instant in whatever zone the consumer's context
   * happens to hold, which either side of midnight is a different day on the screen with no
   * indication that anything went wrong.
   */
  describe('timeZone=input', () => {
    it('is refused when nothing in the message gives the operand a zone', () => {
      expect(refusal('{$d :date timeZone=input}')).toContain(
        'names the time zone of its operand, and nothing in this message gives the operand one',
      );
    });

    it('is accepted when the operand carries one', () => {
      accepted(
        '.local $t = {$d :datetime timeZone=|Asia/Tokyo|}\n{{When: {$t :date timeZone=input}}}',
      );
    });

    it('is refused when the operand is annotated but writes no zone', () => {
      expect(
        refusal(
          '.local $t = {$d :datetime dateLength=long}\n{{When: {$t :date timeZone=input}}}',
        ),
      ).toContain('nothing in this message gives the operand one');
    });
  });

  /**
   * *"The function `:string` has no options."* An empty vocabulary is a statement, and the one that
   * turns `{$s :string case=upper}` from a message that renders unchanged into a refusal.
   */
  it('refuses any option on :string, which the specification gives none', () => {
    expect(refusal('{$s :string case=upper}')).toContain(
      'is not an option of :string, which the specification gives none',
    );
  });

  it('leaves u: options alone, which belong to the syntax rather than to the function', () => {
    accepted('{$s :string u:dir=ltr}');
    accepted('{$d :date u:id=when timeZone=UTC}');
  });
});
