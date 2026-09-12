import { describe, expect, it } from 'vitest';

import type { CompiledInputContract } from '../src/catalog-runtime.js';
import { render } from './message-harness.js';

/**
 * MessageFormat's Number Operand, which is not a JavaScript number.
 *
 * `{42 :number}` is the most ordinary message MessageFormat's syntax can express, and Atlas threw
 * while rendering it. A literal reaches the evaluator as its source text, source text is what a
 * literal is, and the numeric functions asked `typeof raw === 'number'`, so the variable form of
 * a value formatted and the written form of the same value did not. Sixty-eight cases of the
 * standard's conformance suite; nothing in this repository had ever written a literal operand, so
 * nothing in this repository had ever seen it.
 *
 * The compiler refuses a literal operand that is not a number, so the message in the first test
 * below could not reach here from a catalog if the runtime were the only guard. The runtime keeps
 * its own rule because it answers for a *variable* operand, which no compiler can decide, and for
 * compiled artifacts it did not produce. The last test is that half, and it is the half a
 * compile-time check cannot cover.
 */

const NONE: readonly CompiledInputContract[] = Object.freeze([]);

const TEXT: readonly CompiledInputContract[] = Object.freeze([
  { name: 'text', type: 'string', optional: false, nullable: false },
]);

describe('MF2 number operands', () => {
  it('formats a literal operand written into the message', () => {
    expect(render('{42 :number}', NONE, {})).toBe('42');
  });

  it('formats a negative and a fractional literal operand', () => {
    expect(render('{-1.5 :number}', NONE, {})).toBe('-1.5');
  });

  it('formats a literal operand through :integer', () => {
    expect(render('{7 :integer}', NONE, {})).toBe('7');
  });

  it('selects on a literal operand', () => {
    const source = [
      '.local $n = {1 :number}',
      '.match $n',
      'one {{category}}',
      '* {{catch-all}}',
    ].join('\n');
    expect(render(source, NONE, {})).toBe('category');
  });

  /**
   * The half the compiler cannot see. The contract says this input is a string, the message asks a
   * number function to format it, and only the value decides, so the check has to be here as
   * well as there, and both read the same `number-literal` production.
   */
  it('accepts a variable operand whose value is a number literal', () => {
    expect(render('{$text :number}', TEXT, { text: '42' })).toBe('42');
  });

  it('refuses a variable operand whose value is not a number', () => {
    expect(() => render('{$text :number}', TEXT, { text: 'foo' })).toThrow(
      /number operand/i,
    );
  });

  it('refuses the strings JavaScript would coerce and the grammar does not', () => {
    for (const value of ['', ' 1 ', '0x1', 'Infinity', '+1', '01', '1.']) {
      expect(
        () => render('{$text :number}', TEXT, { text: value }),
        `${JSON.stringify(value)} is not a MessageFormat number literal`,
      ).toThrow(/number operand/i);
    }
  });
});
