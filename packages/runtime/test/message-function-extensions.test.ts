import { describe, expect, it } from 'vitest';

import type {
  MessageFunctionInvocation,
  MessageFunctionResult,
  RuntimeMessageFunctionDescriptor,
} from '@neolorn/atlas/core';
import {
  atlasMessageCustomFunctions,
  defineAtlasExtensionRegistry,
  type ExtensionValueType,
} from '../../toolkit/src/extensions.js';
import { parseAtlasMessage } from '../../toolkit/src/message-format.js';
import type { CompiledInputContract } from '../src/catalog-runtime.js';
import { RuntimeExtensions } from '../src/extensions.js';
import { parse, renderSemantics } from './message-harness.js';

/**
 * What an extension can say about selection, and what it inherits from its operand.
 *
 * MessageFormat defines two operations on a resolved value that supports selection:
 * *"Match(`rv`, `k`) returns true for any key `k` that matches `rv`"* and *"BetterThan(`rv`, `k1`,
 * `k2`) returns true ... and `k1` is a better match than `k2`"*, and an Atlas extension could
 * express neither. `MessageFunctionResult` carried one `selectKey`, so a function could not match
 * `1.0` and `1` at once and could not say which of the two it preferred, and the evaluator pinned
 * `betterThan` to false for every extension result. Both are read off one ordered `selectKeys` now:
 * Match is membership, BetterThan is position.
 *
 * The suite exercises this end to end, `pattern-selection.json#6` and `#7` differ only in the
 * order the variants are written and both must render `1.0`, and what is here is the part the
 * suite does not reach: the refusals, and the shapes no case happens to write.
 */

const NONE: readonly CompiledInputContract[] = Object.freeze([]);
const NL = String.fromCharCode(10);

/**
 * Built through the compiler's own registry rather than written out here.
 *
 * A runtime descriptor carries the fingerprint the compiler derived, so a literal would be a second
 * source of truth for the one field the two sides use to agree with each other, and the runtime
 * refuses it, which is how this test found out.
 */
const registryOf = (selector: 'none' | 'exact') => {
  const registry = defineAtlasExtensionRegistry([
    {
      kind: 'message-function',
      id: 'test:select',
      operandType: 'number',
      resultType: 'string',
      selector,
      maximumOutputLength: 32,
      options: { decimalPlaces: { type: 'integer', values: [0, 1] } },
    },
  ]);
  if (!registry.ok) {
    throw new Error(
      `the descriptor under test was refused: ${registry.diagnostics
        .map(({ summary }) => summary)
        .join('; ')}`,
    );
  }
  return registry.value;
};

const descriptorOf = (
  selector: 'none' | 'exact',
): RuntimeMessageFunctionDescriptor =>
  registryOf(selector)
    .descriptors[0] as unknown as RuntimeMessageFunctionDescriptor;

const extensionsFor = (
  selector: 'none' | 'exact',
  evaluate: (invocation: MessageFunctionInvocation) => MessageFunctionResult,
): RuntimeExtensions =>
  new RuntimeExtensions([{ descriptor: descriptorOf(selector), evaluate }]);

/** The README's `:test:select`, which is the only extension behaviour the standard writes down. */
const testSelect = ({
  operand,
  options,
}: MessageFunctionInvocation): MessageFunctionResult => {
  const decimalPlaces = Number(options['decimalPlaces'] ?? 0);
  const whole = Math.floor(Math.abs(Number(operand)));
  const text =
    decimalPlaces === 1
      ? `${whole}.${Math.floor((Math.abs(Number(operand)) - whole) * 10)}`
      : `${whole}`;
  return {
    text,
    value: text,
    // "If the Input is 1 and DecimalPlaces is 1, the method will return true for either '1.0' or
    // '1'", and BetterThan "will return true if key1 is '1.0'", so '1.0' is written first.
    selectKeys:
      Number(operand) !== 1 ? [] : decimalPlaces === 1 ? ['1.0', '1'] : ['1'],
  };
};

/**
 * Built from the same registry the runtime binding is, rather than written out here. What the
 * parser is told about a registered function is its descriptor's profile, and a literal beside the
 * descriptor is a second statement of it that nothing keeps in step.
 */
const CUSTOM = atlasMessageCustomFunctions(registryOf('exact'));

const select = (
  source: string,
  evaluate: (
    invocation: MessageFunctionInvocation,
  ) => MessageFunctionResult = testSelect,
  selector: 'none' | 'exact' = 'exact',
): string =>
  renderSemantics(
    parse(source, CUSTOM),
    NONE,
    {},
    extensionsFor(selector, evaluate),
  );

describe('an extension that selects', () => {
  /**
   * The ranking, isolated from variant order. Both messages hold the same two keys and differ only
   * in which is written first, so a result that depended on source order would answer them
   * differently. Before `selectKeys`, only the first key could match at all.
   */
  it.each([
    ['best first', ['1.0 {{decimal}}', '1 {{integer}}']],
    ['best last', ['1 {{integer}}', '1.0 {{decimal}}']],
  ])('prefers the key it listed first, written %s', (_label, variants) => {
    expect(
      select(
        [
          '.local $x = {1 :test:select decimalPlaces=1}',
          '.match $x',
          ...variants,
          '* {{other}}',
        ].join('\n'),
      ),
    ).toBe('decimal');
  });

  /**
   * The multi-key capability, isolated from the ranking.
   *
   * Both cases above are satisfied by matching only the best key, which is what a single
   * `selectKey` already did: found by reverting `match` to `matching[0] === key` and watching
   * every test still pass. What separates the two is a message that writes the *second* key and not
   * the first: the value matches `'1.0'` and `'1'`, only `1` is written, and MessageFormat's
   * *"true for any key `k` that matches"* says it is reached.
   */
  it('matches a key it listed after the best one, when the best is not written', () => {
    expect(
      select(
        [
          '.local $x = {1 :test:select decimalPlaces=1}',
          '.match $x',
          '1 {{integer}}',
          '* {{other}}',
        ].join('\n'),
      ),
    ).toBe('integer');
  });

  it('matches only the key it listed when it lists one', () => {
    expect(
      select(
        [
          '.local $x = {1 :test:select}',
          '.match $x',
          '1.0 {{decimal}}',
          '1 {{integer}}',
          '* {{other}}',
        ].join('\n'),
      ),
    ).toBe('integer');
  });

  /**
   * An empty list is a value that supports selection and matches nothing, which is a different
   * thing from a function that does not select. The first reaches the catch-all; the second is
   * refused when the catalog compiles, by 3.17.
   */
  it('reaches the catch-all when it lists no keys', () => {
    expect(
      select(
        [
          '.local $x = {2 :test:select}',
          '.match $x',
          '1 {{integer}}',
          '* {{other}}',
        ].join('\n'),
      ),
    ).toBe('other');
  });

  it.each([
    ['a repeated key', ['1', '1']],
    ['a key that is not a string', [1] as unknown as readonly string[]],
  ])('refuses %s', (_label, selectKeys) => {
    expect(() =>
      select(
        '.local $x = {1 :test:select}\n.match $x\n1 {{integer}}\n* {{other}}',
        () => ({ text: '1', value: '1', selectKeys }),
      ),
    ).toThrow(/invalid or unbounded result/);
  });

  it('refuses a selecting descriptor that returns no keys at all', () => {
    expect(() =>
      select(
        '.local $x = {1 :test:select}\n.match $x\n1 {{one}}\n* {{other}}',
        () => ({
          text: '1',
          value: '1',
        }),
      ),
    ).toThrow(/invalid or unbounded result/);
  });

  it('refuses a formatting-only descriptor that returns keys', () => {
    expect(() =>
      select(
        ['.local $x = {1 :test:select}', '{{{$x}}}'].join('\n'),
        () => ({ text: '1', value: '1', selectKeys: ['1'] }),
        'none',
      ),
    ).toThrow(/invalid or unbounded result/);
  });
});

/**
 * MessageFormat resolves an operand that is itself an annotated expression to a value carrying its
 * options, *"with options on the expression taking priority over any options of the operand"*.
 * Atlas did that for its own numeric functions and not for extensions, so the same message answered
 * differently depending on which function it named.
 */
describe('an extension that inherits its operand', () => {
  const keyedOn = (source: string) => select(source);

  it('takes an option set on the expression that produced its operand', () => {
    expect(
      keyedOn(
        [
          '.local $x = {1 :test:select decimalPlaces=1}',
          '.local $y = {$x :test:select}',
          '.match $y',
          '1.0 {{decimal}}',
          '1 {{integer}}',
          '* {{other}}',
        ].join('\n'),
      ),
    ).toBe('decimal');
  });

  it('lets the expression override what the operand carried', () => {
    expect(
      keyedOn(
        [
          '.local $x = {1 :test:select decimalPlaces=1}',
          '.local $y = {$x :test:select decimalPlaces=0}',
          '.match $y',
          '1.0 {{decimal}}',
          '1 {{integer}}',
          '* {{other}}',
        ].join('\n'),
      ),
    ).toBe('integer');
  });

  /**
   * The narrowing that is Atlas's rather than MessageFormat's. A descriptor is a closed statement
   * of what a function accepts, so inheritance must not be a second door an undeclared name walks
   * through: `:number`'s `signDisplay` reaches the chain but not this function's hands.
   */
  it('is handed only the options its own descriptor declares', () => {
    const seen: string[][] = [];
    select(
      [
        '.local $n = {1 :number signDisplay=always}',
        '.local $y = {$n :test:select decimalPlaces=1}',
        '.match $y',
        '1.0 {{decimal}}',
        '* {{other}}',
      ].join('\n'),
      (invocation) => {
        seen.push(Object.keys(invocation.options).sort());
        return testSelect(invocation);
      },
    );
    expect(seen).toEqual([['decimalPlaces']]);
  });
});

/**
 * What an extension declaration carries into the rest of the message.
 *
 * MessageFormat resolves an expression's options against its operand's, *"with options on the
 * expression taking priority over any options of the operand"*, and Atlas's rule for a custom
 * function is that the resolved value carries the whole merged mapping while the descriptor narrows
 * only what the function is *called* with. The runtime did that. The compiler could not: it was
 * told a registered function's name and whether it selects, which is not enough to build a profile,
 * so it treated an extension declaration as carrying nothing.
 *
 * Both halves of that were measured before this was written, and they fail in opposite directions,
 * which is why both are here. One message compiled and threw. One message was refused and renders.
 */
describe('what a declaration carries when the declaring function is an extension', () => {
  const registryFor = (
    id: string,
    operandType: 'date-time' | 'number',
    resultType: 'date-time' | 'number',
    options: Readonly<Record<string, { readonly type: ExtensionValueType }>>,
  ) => {
    const registry = defineAtlasExtensionRegistry([
      {
        kind: 'message-function',
        id,
        operandType,
        resultType,
        selector: 'none',
        maximumOutputLength: 64,
        options,
      },
    ]);
    if (!registry.ok) {
      throw new Error(
        registry.diagnostics.map(({ summary }) => summary).join('; '),
      );
    }
    return registry.value;
  };

  /** Passes its operand through untouched, so the only thing under test is what it carries. */
  const passThrough = ({
    operand,
  }: MessageFunctionInvocation): MessageFunctionResult =>
    ({ text: String(operand), value: operand }) as MessageFunctionResult;

  const NUMERIC = registryFor('test:carry', 'number', 'number', {
    minimumFractionDigits: { type: 'integer' },
  });
  const ZONED = registryFor('test:zoned', 'date-time', 'date-time', {
    timeZone: { type: 'string' },
  });

  const boundTo = (
    registry: ReturnType<typeof registryFor>,
  ): RuntimeExtensions =>
    new RuntimeExtensions([
      {
        descriptor: registry
          .descriptors[0] as unknown as RuntimeMessageFunctionDescriptor,
        evaluate: passThrough,
      },
    ]);

  const NUMBER_INPUT: readonly CompiledInputContract[] = Object.freeze([
    { name: 'v', type: 'number', optional: false, nullable: false },
  ]);
  const DATE_INPUT: readonly CompiledInputContract[] = Object.freeze([
    { name: 'd', type: 'date-time', optional: false, nullable: false },
  ]);
  const IN_UTC = Object.freeze({ locale: 'en-US', timeZone: 'UTC' });
  // 23:30 UTC is the following day in Tokyo, so the zone is legible in the rendering itself.
  const LATE = new Date(Date.UTC(2026, 8, 5, 23, 30, 0));

  const refusalOf = (
    source: string,
    registry: ReturnType<typeof registryFor>,
  ): string => {
    const result = parseAtlasMessage(source, {
      customFunctions: atlasMessageCustomFunctions(registry),
    });
    return result.ok
      ? 'ACCEPTED'
      : result.diagnostics.map(({ summary }) => summary).join(' | ');
  };

  /**
   * The compile-and-throw half. `:integer`'s own discard list exists because a
   * `minimumFractionDigits` above a later `maximumFractionDigits` asks `Intl.NumberFormat` for a
   * range whose minimum exceeds its maximum, and it throws, so the compiler builds the formatter
   * and refuses the message. Through an extension declaration it built the formatter without the
   * inherited option, constructed it happily, and shipped a message that throws in front of a
   * reader.
   */
  it('refuses a conflict the operand contributed, as it does for a built-in', () => {
    const throughExtension =
      '.local $x = {$v :test:carry minimumFractionDigits=4}' +
      NL +
      '{{N: {$x :number maximumFractionDigits=2}}}';
    const throughBuiltIn =
      '.local $x = {$v :number minimumFractionDigits=4}' +
      NL +
      '{{N: {$x :number maximumFractionDigits=2}}}';
    const message = refusalOf(throughExtension, NUMERIC);
    expect(message).toContain('maximumFractionDigits=2');
    expect(message).toContain('minimumFractionDigits=4');
    // The control says the two paths now give the same answer, which is the whole property.
    expect(message).toBe(refusalOf(throughBuiltIn, NUMERIC));
  });

  /**
   * The refused-a-valid-message half. *"The value `input` corresponds to the time zone of the
   * operand"*, and an extension returning a date/time value is the implementation-defined operand
   * the specification's next sentence is about.
   */
  it('lets an extension operand answer timeZone=input, and renders its zone', () => {
    const source =
      '.local $t = {$d :test:zoned timeZone=|Asia/Tokyo|}' +
      NL +
      '{{When: {$t :date timeZone=input}}}';
    expect(refusalOf(source, ZONED)).toBe('ACCEPTED');
    const rendered = renderSemantics(
      parse(source, atlasMessageCustomFunctions(ZONED)),
      DATE_INPUT,
      { d: LATE },
      boundTo(ZONED),
      IN_UTC,
    );
    // The Tokyo day, not the context's. Asserted against the two renderings it has to sit between
    // rather than against a pinned string, so a CLDR change moves all three together.
    expect(rendered).toBe(
      renderSemantics(
        parse('When: {$d :date timeZone=|Asia/Tokyo|}'),
        DATE_INPUT,
        { d: LATE },
        boundTo(ZONED),
        IN_UTC,
      ),
    );
    expect(rendered).not.toBe(
      renderSemantics(
        parse('When: {$d :date}'),
        DATE_INPUT,
        { d: LATE },
        boundTo(ZONED),
        IN_UTC,
      ),
    );
  });

  /** And the option still reaches the value itself, which is what carrying it is for. */
  it('formats with an option the extension declaration contributed', () => {
    const source =
      '.local $x = {$v :test:carry minimumFractionDigits=2}' +
      NL +
      '{{N: {$x :number}}}';
    expect(
      renderSemantics(
        parse(source, atlasMessageCustomFunctions(NUMERIC)),
        NUMBER_INPUT,
        { v: 1234.5 },
        boundTo(NUMERIC),
        Object.freeze({ locale: 'en-US' }),
      ),
    ).toBe('N: 1,234.50');
  });
});
