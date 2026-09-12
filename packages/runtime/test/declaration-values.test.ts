import { describe, expect, it } from 'vitest';

import type { AtlasPatternMessageSemanticModel } from '../../toolkit/src/message-format.js';
import type { CompiledInputContract } from '../src/catalog-runtime.js';
import { parse, render, renderSemantics } from './message-harness.js';

/**
 * What a `.local` or `.input` declaration produces, and what a later reference to it gets.
 *
 * `readReference` returned `value.raw`, so a declaration's whole annotation was thrown away the
 * moment the pattern referred to it: `.local $n = {$v :number minimumFractionDigits=2}` printed
 * `4.2` where it had already produced `4.20`, and `u:dir` written on a declaration lost the
 * isolation the author had asked for by name. Selection read the resolved value and formatting did
 * not, so a message could choose the right variant and print the wrong number inside it: the
 * failure nobody looks for, because the variant is visibly correct.
 *
 * LDML 48 Part 9, Variable Resolution: *"If a declaration exists for the variable, its resolved
 * value is used."* And for a number function's operand: an implementation-defined operand "can
 * include option values", resolved "with options on the expression taking priority over any options
 * of the operand".
 */

const NONE: readonly CompiledInputContract[] = Object.freeze([]);

const VALUE: readonly CompiledInputContract[] = Object.freeze([
  { name: 'v', type: 'number', optional: false, nullable: false },
]);

const ISOLATE_LTR = '⁦';
const POP = '⁩';

describe('MF2 declaration values', () => {
  it('uses the text the declaration produced, not its operand', () => {
    const source = [
      '.local $n = {$v :number minimumFractionDigits=2}',
      '{{bar {$n}}}',
    ].join('\n');
    expect(render(source, VALUE, { v: 4.2 })).toBe('bar 4.20');
  });

  it('does the same for a declaration written with .input', () => {
    const source = [
      '.input {$v :number minimumFractionDigits=2}',
      '{{bar {$v}}}',
    ].join('\n');
    expect(render(source, VALUE, { v: 4.2 })).toBe('bar 4.20');
  });

  it('keeps the isolation a declaration asked for with u:dir', () => {
    const source = [
      '.local $w = {world :string u:dir=ltr u:id=foo}',
      '{{hello {$w}}}',
    ].join('\n');
    expect(render(source, NONE, {})).toBe(`hello ${ISOLATE_LTR}world${POP}`);
  });

  it('carries a declaration option into a later annotation', () => {
    const source = [
      '.local $x = {41 :integer signDisplay=always}',
      '{{{$x :offset add=1}}}',
    ].join('\n');
    expect(render(source, NONE, {})).toBe('+42');
  });

  it('carries a currency code into a re-annotation that names no currency', () => {
    const source = [
      '.local $n = {42 :currency currency=EUR}',
      '{{{$n :currency}}}',
    ].join('\n');
    // The euro sign rather than the whole string: the amount's grouping and decimals are locale
    // data and move with CLDR, and what is under test is that `currency=EUR` survived at all.
    expect(render(source, NONE, {})).toContain('€');
  });

  it('lets the expression override what the operand carried', () => {
    const source = [
      '.local $x = {4.2 :number minimumFractionDigits=2}',
      '{{{$x :number minimumFractionDigits=3}}}',
    ].join('\n');
    expect(render(source, NONE, {})).toBe('4.200');
  });

  /**
   * The one option the specification says a resolved value does not carry, and the case the
   * conformance suite has no example of. `:offset`'s options say what was done to the number, and
   * the number they were done to *is* the resolved value, so carrying `add` forward would add
   * again, silently, in arithmetic nobody wrote.
   */
  it('does not carry :offset add or subtract into a later annotation', () => {
    expect(
      render(
        ['.local $a = {41 :offset add=1}', '{{{$a :number}}}'].join('\n'),
        NONE,
        {},
      ),
    ).toBe('42');
    expect(
      render(
        ['.local $b = {52 :offset subtract=10}', '{{{$b :number}}}'].join('\n'),
        NONE,
        {},
      ),
    ).toBe('42');
  });

  /**
   * The three the specification tells `:integer` to throw away, and the reason it is not a tidiness
   * rule: `:integer` pins `maximumFractionDigits` to 0, so a `minimumFractionDigits` of 2 arriving
   * from the operand asks `Intl.NumberFormat` for a range whose minimum is above its maximum, and it
   * throws while rendering. The conformance suite has no case for this, so nothing but this file
   * stands between the inheritance rule and a message that formats in review and breaks in front of
   * a reader.
   */
  it('drops the fraction and significant-digit options :integer cannot honour', () => {
    expect(
      render(
        [
          '.local $n = {4.2 :number minimumFractionDigits=2}',
          '{{{$n :integer}}}',
        ].join('\n'),
        NONE,
        {},
      ),
    ).toBe('4');
    expect(
      render(
        [
          '.local $n = {4.2 :number minimumSignificantDigits=3}',
          '{{{$n :integer}}}',
        ].join('\n'),
        NONE,
        {},
      ),
    ).toBe('4');
  });

  /**
   * Discarding and not accepting look the same one step out and are different one step further.
   *
   * All three names `:integer` discards are names it does not accept either, so neither is applied:
   * what separates them is what happens next. A discarded option is gone from the resolved value
   * and cannot reach a third expression; an option the function simply has no use for is still
   * *"included in the resolved option values"* and formats when it reaches a function that does.
   *
   * `:offset` is the sharpest case of the second: it accepts nothing but `add` and `subtract`, and
   * an operand's `minimumFractionDigits` has to survive it untouched.
   */
  it('drops a discarded option from the rest of the chain', () => {
    const source = [
      '.local $a = {4.2 :number minimumFractionDigits=2}',
      '.local $b = {$a :integer}',
      '{{{$b :number}}}',
    ].join('\n');
    expect(render(source, NONE, {})).toBe('4');
  });

  it('carries an option through a function that has no use for it', () => {
    const source = [
      '.local $a = {4 :number minimumFractionDigits=2}',
      '.local $b = {$a :offset add=1}',
      '{{{$b :number}}}',
    ].join('\n');
    expect(render(source, NONE, {})).toBe('5.00');
  });

  /**
   * The half a compiled catalog cannot reach, built the way the NFD key case in
   * `pattern-selection.test.ts` is built and for the same reason.
   *
   * `packages/toolkit/src/message-format.ts` refuses an inherited `select` at parse, so no catalog
   * can carry this shape to the evaluator and the source below does not parse. The runtime keeps the
   * rule anyway, because its input is a compiled artifact and it has no way to know what produced
   * one. So the model is assembled from two messages that do parse: the declaration that sets
   * `select` from one, the re-annotation from the other with its operand pointed at it.
   */
  it('refuses a select option that arrives from the operand of compiled IR', () => {
    const setter = parse(
      '.local $sel = {1 :integer select=exact}\n{{{$sel}}}',
    ) as AtlasPatternMessageSemanticModel;
    const reader = parse(
      '.local $bad = {$other :integer}\n{{{$bad}}}',
    ) as AtlasPatternMessageSemanticModel;
    const reannotation = reader.declarations[0];
    const repointed = {
      ...reannotation,
      value: {
        ...reannotation!.value,
        operand: { kind: 'variable' as const, name: 'sel' },
      },
    } as (typeof reader.declarations)[number];
    const spliced: AtlasPatternMessageSemanticModel = {
      ...reader,
      declarations: Object.freeze([setter.declarations[0]!, repointed]),
    };
    expect(() => renderSemantics(spliced, NONE, {})).toThrow(/select option/i);
  });
});
