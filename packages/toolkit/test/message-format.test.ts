import { DraftFunctions, DefaultFunctions } from 'messageformat/functions';
import { describe, expect, it } from 'vitest';

import {
  formatAtlasCatalog,
  parseAtlasCatalog,
  type AtlasCatalogParseOptions,
  type AtlasMessageCustomFunction,
} from '../src/index.js';
import {
  ATLAS_MESSAGE_FUNCTION_PROFILE,
  parseAtlasMessage,
} from '../src/message-format.js';

const catalogOptions: AtlasCatalogParseOptions = {
  role: 'source',
  providerId: '@neolorn/example',
  scopeId: 'messages',
  locale: 'en-US',
  sourcePath: 'i18n/messages/en-US.yaml',
};

describe('Atlas MessageFormat 2 profile', () => {
  it('pins every stable and draft LDML 48.2 default function', () => {
    expect(ATLAS_MESSAGE_FUNCTION_PROFILE).toEqual([
      { name: 'string', status: 'stable', selection: 'literal' },
      { name: 'number', status: 'stable', selection: 'number' },
      { name: 'integer', status: 'stable', selection: 'number' },
      { name: 'offset', status: 'stable', selection: 'number' },
      { name: 'currency', status: 'stable', selection: 'none' },
      { name: 'percent', status: 'stable', selection: 'number' },
      { name: 'unit', status: 'draft', selection: 'none' },
      { name: 'datetime', status: 'draft', selection: 'none' },
      { name: 'date', status: 'draft', selection: 'none' },
      { name: 'time', status: 'draft', selection: 'none' },
    ]);
    expect(
      [
        ...new Set([
          ...Object.keys(DefaultFunctions),
          ...Object.keys(DraftFunctions),
        ]),
      ].sort(),
    ).toEqual(ATLAS_MESSAGE_FUNCTION_PROFILE.map(({ name }) => name).sort());
  });

  it.each([
    ['string', '{$value :string}'],
    ['number', '{$value :number}'],
    ['integer', '{$value :integer}'],
    ['offset', '{$value :offset add=1}'],
    ['currency', '{$value :currency currency=USD}'],
    ['percent', '{$value :percent}'],
    ['unit', '{$value :unit unit=meter}'],
    ['datetime', '{$value :datetime}'],
    ['date', '{$value :date}'],
    ['time', '{$value :time}'],
  ])(
    'admits the pinned :%s function into the Atlas semantic model',
    (name, source) => {
      const result = parseAtlasMessage(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.functions).toEqual([name]);
      expect(result.value.externalInputs).toEqual(['value']);
    },
  );

  /**
   * The option here is a real one on a function that has it. `:string case=upper` is neither:
   * `:string` has no options and `case` is not an option of anything, so a normalizer asked about
   * that message is asked about one no reader could rely on, and Atlas refuses it. The question is
   * worth putting only to a message that means something.
   */
  it('normalizes expressions, options, attributes, and external inputs without dependency-owned types', () => {
    const result = parseAtlasMessage(
      'Hello {$person :number signDisplay=always @dir=rtl}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'pattern') return;

    expect(result.value.externalInputs).toEqual(['person']);
    expect(result.value.functions).toEqual(['number']);
    expect(result.value.pattern[1]).toEqual({
      kind: 'expression',
      operand: { kind: 'variable', name: 'person' },
      function: {
        name: 'number',
        options: {
          signDisplay: { kind: 'literal', value: 'always' },
        },
      },
      attributes: {
        dir: { kind: 'literal', value: 'rtl' },
      },
    });
    const expression = result.value.pattern[1];
    expect(typeof expression).toBe('object');
    if (typeof expression !== 'object') return;
    expect(expression.kind).toBe('expression');
    if (expression.kind !== 'expression') return;
    expect(Object.getPrototypeOf(expression.function?.options)).toBeNull();
  });

  it('normalizes declarations, selectors, variants, and catch-all fallback', () => {
    const source = [
      '.input {$count :number}',
      '.match $count',
      '1 {{One item}}',
      '* {{Other: {$count}}}',
    ].join('\n');
    const result = parseAtlasMessage(source);

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'select') return;
    expect(result.value.canonicalSource).toBe(source);
    expect(result.value.externalInputs).toEqual(['count']);
    expect(result.value.declarations).toMatchObject([
      { kind: 'input', name: 'count' },
    ]);
    expect(result.value.selectors).toEqual(['count']);
    expect(result.value.variants).toMatchObject([
      { keys: [{ kind: 'literal', value: '1' }] },
      { keys: [{ kind: 'catchall' }] },
    ]);
  });

  it('excludes local declarations from the external input set', () => {
    const result = parseAtlasMessage(
      '.local $label = {$name :string}\n{{Hello {$label}}}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.externalInputs).toEqual(['name']);
    expect(result.value.declarations).toMatchObject([
      { kind: 'local', name: 'label' },
    ]);
  });

  it('marks semantic markup as structured output without interpreting it as HTML', () => {
    const result = parseAtlasMessage('{#strong}Important{/strong}');
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'pattern') return;
    expect(result.value.resultKind).toBe('structured');
    expect(result.value.pattern).toEqual([
      {
        kind: 'markup',
        markupKind: 'open',
        name: 'strong',
        options: {},
        attributes: {},
      },
      'Important',
      {
        kind: 'markup',
        markupKind: 'close',
        name: 'strong',
        options: {},
        attributes: {},
      },
    ]);
  });

  it('reports source-located syntax and data-model failures', () => {
    const syntax = parseAtlasMessage('Hello {', {
      sourcePath: 'message.mf2',
      path: ['messages', 'hello'],
    });
    expect(syntax.ok).toBe(false);
    expect(syntax.diagnostics[0]?.code).toBe('ATL1201');
    expect(syntax.diagnostics[0]?.path).toEqual(['messages', 'hello']);
    expect(syntax.diagnostics[0]?.span?.sourcePath).toBe('message.mf2');

    const dataModel = parseAtlasMessage(
      '.input {$count :number}\n.match $count\n1 {{One}}',
    );
    expect(dataModel.ok).toBe(false);
    expect(dataModel.diagnostics.some(({ code }) => code === 'ATL1202')).toBe(
      true,
    );
  });

  /**
   * The standard's division, not the parser's stages.
   *
   * `messageformat` throws `duplicate-option-name` while parsing and reports the other five types
   * from `validate`, so classifying by stage files them under two codes, `ATL1201` and `ATL1202`.
   * The working group's own `data-model-errors.json` files all six together. Which stage notices a
   * fault is a detail of the parser Atlas embeds; which class of error it is belongs to the
   * message.
   *
   * The sources are written out rather than read from that suite, which `verify:message-format-
   * conformance` runs in full: a table drawn from the same file as its subject agrees by
   * construction.
   */
  it('gives every Data Model Error the data-model code, from either stage', () => {
    const dataModelSources: Readonly<Record<string, string>> = {
      'duplicate-declaration': '.input {$foo} .input {$foo} {{_}}',
      'duplicate-option-name': 'bad {:placeholder option=x option=x}',
      'duplicate-variant':
        '.input {$var :string} .match $var * {{The first}} * {{The second}}',
      'key-mismatch': '.input {$foo :x} .match $foo * * {{foo}}',
      'missing-fallback': '.input {$foo :x} .match $foo 1 {{_}}',
      'missing-selector-annotation':
        '.input {$foo} .match $foo one {{one}} * {{other}}',
    };
    for (const [type, source] of Object.entries(dataModelSources)) {
      const result = parseAtlasMessage(source);
      expect(result.ok, `${type} was accepted`).toBe(false);
      expect(
        result.diagnostics.map(({ code }) => code),
        `${type} did not report the data-model code`,
      ).toEqual([`ATL1202`]);
    }

    // The control that keeps the row above meaningful: a message the syntax refuses is still
    // `ATL1201`, so the table is a division rather than a rename.
    expect(parseAtlasMessage('Hello {').diagnostics[0]?.code).toBe('ATL1201');
  });

  it('rejects functions outside the approved Atlas 1 profile', () => {
    const result = parseAtlasMessage('{$value :example}');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'ATL1203',
        summary:
          'MessageFormat function :example is not part of the Atlas 1 profile.',
      },
    ]);
  });
});

describe('MessageFormat catalog integration', () => {
  it('attaches Atlas-owned semantics to every nonempty catalog message', () => {
    const result = parseAtlasCatalog(
      'messages:\n  greeting: "Hello {$name :string}"\n  spacer:\n    empty: true\n',
      catalogOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const greeting = result.value.messages['greeting'];
    expect(greeting).toMatchObject({
      kind: 'message',
      semantics: {
        kind: 'pattern',
        externalInputs: ['name'],
        functions: ['string'],
      },
    });
    expect(result.value.messages['spacer']).not.toHaveProperty('semantics');
    expect(formatAtlasCatalog(result.value)).toContain(
      'greeting: "Hello {$name :string}"',
    );
  });

  it('rejects invalid or unsupported MessageFormat before catalog admission', () => {
    const invalid = parseAtlasCatalog(
      'messages:\n  greeting: "Hello {"\n',
      catalogOptions,
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics[0]?.code).toBe('ATL1201');
    expect(invalid.diagnostics[0]?.path).toEqual(['messages', 'greeting']);
    expect(invalid.diagnostics[0]?.span?.sourcePath).toBe(
      'i18n/messages/en-US.yaml',
    );

    const unsupported = parseAtlasCatalog(
      'messages:\n  greeting: "{$name :custom}"\n',
      catalogOptions,
    );
    expect(unsupported.ok).toBe(false);
    expect(unsupported.diagnostics[0]?.code).toBe('ATL1203');
  });
});

/**
 * MessageFormat 2 reserves the `u:` option namespace for the message syntax itself.
 *
 * Atlas folded these in with every other option, kept them in the model and dropped them at
 * runtime, so `{$name :string u:dir=rtl}` produced no diagnostic and no isolation. An author had no
 * way to discover that: the message parsed, the gate was green, and the bytes were identical to
 * the same message written without the option.
 *
 * `u:dir` and `u:id` are implemented. The rest of the namespace is refused here rather than
 * ignored, because `u:locale` is a real option in the spec: accepting it quietly would mean a
 * message formatted in the wrong locale with nothing to say so.
 */
describe('Atlas MessageFormat u: options', () => {
  const diagnosticsFor = (message: string) => {
    const result = parseAtlasMessage(message);
    return result.ok
      ? []
      : result.diagnostics.map(({ code, summary }) => ({ code, summary }));
  };

  it('accepts the two it implements', () => {
    expect(parseAtlasMessage('{$name :string u:dir=rtl}').ok).toBe(true);
    expect(parseAtlasMessage('{$name :string u:dir=auto}').ok).toBe(true);
    expect(parseAtlasMessage('{$name :string u:dir=inherit}').ok).toBe(true);
    expect(parseAtlasMessage('{$name :string u:id=who}').ok).toBe(true);
  });

  it('rejects a u:dir value outside the four the spec defines', () => {
    const diagnostics = diagnosticsFor('{$name :string u:dir=sideways}');
    expect(diagnostics[0]?.code).toBe('ATL1204');
    expect(diagnostics[0]?.summary).toContain('u:dir="sideways"');
  });

  it('rejects a u:dir that is a variable rather than a literal', () => {
    const diagnostics = diagnosticsFor('{$name :string u:dir=$flag}');
    expect(diagnostics[0]?.code).toBe('ATL1204');
    expect(diagnostics[0]?.summary).toContain('must be a literal');
  });

  /**
   * `u:dir` on markup is a Bad Option error in the spec, and the reason is structural: markup
   * resolves to no value, so there is nothing for a direction to be a property of.
   */
  it('rejects u:dir on markup', () => {
    const diagnostics = diagnosticsFor('{#strong u:dir=rtl}text{/strong}');
    expect(diagnostics[0]?.code).toBe('ATL1204');
    expect(diagnostics[0]?.summary).toContain('markup {#strong}');
  });

  it('accepts u:id on markup, which does resolve to a formatted part', () => {
    expect(parseAtlasMessage('{#strong u:id=lead}text{/strong}').ok).toBe(true);
  });

  it('refuses a reserved option it does not implement rather than ignoring it', () => {
    const diagnostics = diagnosticsFor('{$name :string u:locale=ar}');
    expect(diagnostics[0]?.code).toBe('ATL1204');
    expect(diagnostics[0]?.summary).toContain('u:locale');
  });
});

/**
 * MessageFormat's Number Operand, refused here so it cannot reach the runtime and throw.
 *
 * `{foo :number}` is valid MessageFormat syntax and Atlas compiled it without a word. The operand
 * is a literal, so it reaches the evaluator as the string `foo`, and the evaluator threw. A message
 * that passes the gate and then throws while rendering is the one failure a localization library
 * cannot leave in: there is no fallback below it and the frame is already on screen.
 *
 * The compiler answers for what it can see. A literal operand is knowable at compile time, so it is
 * decided at compile time; a variable operand is not, and the runtime still answers for that. The
 * two checks read the same production out of the same sentence of LDML 48 Part 9.
 */
describe('Atlas MessageFormat number operands', () => {
  const diagnosticsFor = (message: string) => {
    const result = parseAtlasMessage(message);
    return result.ok
      ? []
      : result.diagnostics.map(({ code, summary }) => ({ code, summary }));
  };

  it('accepts a literal operand that is a number literal', () => {
    expect(parseAtlasMessage('{42 :number}').ok).toBe(true);
    expect(parseAtlasMessage('{-1.5e3 :number}').ok).toBe(true);
    expect(parseAtlasMessage('{0 :integer}').ok).toBe(true);
  });

  it('accepts a variable operand, which only the runtime can decide', () => {
    expect(parseAtlasMessage('{$count :number}').ok).toBe(true);
  });

  it('refuses a literal operand that is not a number', () => {
    const diagnostics = diagnosticsFor('{foo :number}');
    expect(diagnostics[0]?.code).toBe('ATL1205');
    expect(diagnostics[0]?.summary).toContain('"foo"');
  });

  /**
   * The shapes JavaScript would have accepted and MessageFormat does not. `Number('')` is 0,
   * `Number(' 1 ')` is 1, `Number('0x1')` is 1 and `Number('Infinity')` is infinite, so a check
   * written with `Number()` would have admitted all four.
   */
  it('refuses the literals JavaScript would coerce and the grammar does not', () => {
    // Every one quoted, so the literal reaches the check rather than being refused as syntax
    // first. What is under test is the operand rule, not the tokenizer.
    for (const operand of [
      '||',
      '| 1 |',
      '|0x1|',
      '|Infinity|',
      '|+1|',
      '|01|',
      '|1.|',
    ]) {
      const diagnostics = diagnosticsFor(`{${operand} :number}`);
      expect(
        diagnostics.some(({ code }) => code === 'ATL1205'),
        `${operand} should be refused as a number operand`,
      ).toBe(true);
    }
  });

  it('refuses a number function written with no operand at all', () => {
    const diagnostics = diagnosticsFor('{:number}');
    expect(diagnostics[0]?.code).toBe('ATL1205');
    expect(diagnostics[0]?.summary).toContain('needs an operand');
  });

  it('leaves a non-numeric function alone', () => {
    expect(parseAtlasMessage('{foo :string}').ok).toBe(true);
  });
});

/**
 * A `select` option that would arrive from the operand rather than be written where it is used.
 *
 * LDML 48 Part 9 lets a number function's resolved value carry its options into a later annotation,
 * and names one exception: "If the `select` option is set by an implementation-defined type used as
 * an operand, a Bad Option Error is emitted." MessageFormat reports that while formatting and falls
 * back to the catch-all. Atlas refuses the message here instead, for the reason the rest of the
 * `select` handling is here: the value decides which CLDR plural table a target catalog's coverage
 * is checked against, and a translator opening the message has to be able to see which one.
 *
 * Refusing at parse rather than at render is the point. The evaluator carries the same rule for a
 * compiled artifact that did not come through this check, and `packages/runtime/test/
 * declaration-values.test.ts` reaches it by assembling one.
 */
describe('Atlas MessageFormat inherited select', () => {
  const diagnosticsFor = (message: string) => {
    const result = parseAtlasMessage(message);
    return result.ok
      ? []
      : result.diagnostics.map(({ code, summary }) => ({ code, summary }));
  };

  it('refuses a re-annotation that would inherit select', () => {
    const diagnostics = diagnosticsFor(
      '.local $sel = {1 :integer select=exact}\n.local $bad = {$sel :integer}\n{{{$bad}}}',
    );
    expect(diagnostics[0]?.code).toBe('ATL1204');
    expect(diagnostics[0]?.summary).toContain('$sel');
  });

  it('refuses it through a declaration that only re-binds the value', () => {
    expect(
      diagnosticsFor(
        '.local $sel = {1 :number select=exact}\n.local $same = {$sel}\n.local $bad = {$same :number}\n{{{$bad}}}',
      )[0]?.code,
    ).toBe('ATL1204');
  });

  it('refuses it in the pattern as well as in a declaration', () => {
    expect(
      diagnosticsFor(
        '.local $sel = {1 :integer select=exact}\n{{{$sel :number}}}',
      )[0]?.code,
    ).toBe('ATL1204');
  });

  it('accepts a re-annotation that writes its own select', () => {
    expect(
      parseAtlasMessage(
        '.local $sel = {1 :integer select=exact}\n.local $ok = {$sel :integer select=plural}\n{{{$ok}}}',
      ).ok,
    ).toBe(true);
  });

  it('leaves a declaration that never set select alone', () => {
    expect(
      parseAtlasMessage(
        '.local $n = {1 :integer signDisplay=always}\n.local $m = {$n :offset add=1}\n{{{$m}}}',
      ).ok,
    ).toBe(true);
  });
});

/**
 * Numeric options, refused where an author can still fix them.
 *
 * LDML 48 Part 9 gives each of the six numeric functions its own option table, and Atlas read one
 * union of seven names for all of them: `roundingMode`, `roundingPriority`, `roundingIncrement`,
 * `trailingZeroDisplay`, `currencySign` and `:currency`'s `fractionDigits` were parsed, compiled,
 * shipped and ignored. The conformance suite cannot see any of it, it writes none of those names
 * in any of its 461 cases, so the check is against the specification's tables rather than against
 * a failing case. `packages/runtime/test/message-function-options.test.ts` holds the other
 * half, where the same tables are checked against the two `Intl` constructors that impose them.
 */
describe('Atlas MessageFormat numeric options', () => {
  const summaryFor = (message: string): string | undefined => {
    const result = parseAtlasMessage(message);
    return result.ok ? undefined : result.diagnostics[0]?.summary;
  };

  it('accepts every option the specification gives a function', () => {
    for (const message of [
      '{1 :number roundingMode=halfEven roundingPriority=morePrecision}',
      '{1 :number trailingZeroDisplay=stripIfInteger useGrouping=min2}',
      '{1 :currency currency=EUR currencySign=accounting fractionDigits=auto}',
      '{1 :currency currency=EUR fractionDigits=0 currencyDisplay=narrowSymbol}',
      '{1 :percent minimumFractionDigits=1 trailingZeroDisplay=auto}',
      '{1 :unit unit=mile-per-hour unitDisplay=long signDisplay=exceptZero}',
      '{1 :integer minimumIntegerDigits=2 maximumSignificantDigits=3}',
      '{1 :offset subtract=99}',
    ]) {
      expect(summaryFor(message), message).toBeUndefined();
    }
  });

  it('refuses an option the function does not have', () => {
    // Real options, on the wrong functions: :integer has no fraction digits, :percent has no
    // rounding increment, :unit has no trailing-zero display, :currency does not take the two
    // fraction-digit names because it takes `fractionDigits` instead.
    for (const [message, name] of [
      ['{1 :integer minimumFractionDigits=2}', 'minimumFractionDigits'],
      ['{1 :percent roundingIncrement=5}', 'roundingIncrement'],
      ['{1 :unit unit=meter trailingZeroDisplay=auto}', 'trailingZeroDisplay'],
      [
        '{1 :currency currency=EUR maximumFractionDigits=2}',
        'maximumFractionDigits',
      ],
      ['{1 :percent select=exact}', 'select'],
      ['{1 :number fractionDigits=2}', 'fractionDigits'],
    ] as const) {
      const summary = summaryFor(message);
      expect(summary, message).toContain(name);
      expect(summary, message).toContain('is not an option of');
    }
  });

  /**
   * `digit-size-option = "0" / (("1"-"9") [DIGIT])`. The grammar refuses a leading zero, a sign and
   * anything of three digits; the declared range refuses what `Intl.NumberFormat` would throw on.
   * Neither is visible in the conformance suite, which never writes a digit size above 13.
   */
  it('refuses a digit size the grammar or the runtime cannot take', () => {
    for (const value of ['foo', '01', '+1', '-1', '1.5', '100', '']) {
      expect(
        summaryFor(`{1 :number minimumFractionDigits=|${value}|}`),
        value,
      ).toContain('minimumFractionDigits');
    }
    // Inside the grammar and outside what Intl accepts: 22 significant digits, 0 integer digits.
    expect(summaryFor('{1 :number maximumSignificantDigits=22}')).toContain(
      '1 to 21',
    );
    expect(summaryFor('{1 :number minimumIntegerDigits=0}')).toContain(
      '1 to 21',
    );
    expect(summaryFor('{1 :number minimumFractionDigits=99}')).toBeUndefined();
  });

  it('refuses a value outside an enumerated vocabulary', () => {
    expect(summaryFor('{1 :number roundingMode=nearest}')).toContain(
      'halfExpand',
    );
    expect(summaryFor('{1 :number useGrouping=false}')).toContain('min2');
    expect(summaryFor('{1 :currency currency=eur}')).toContain(
      'Unicode Currency Identifier',
    );
  });

  /**
   * Two the specification requires and this runtime has no way to produce. Refusing them by name is
   * the whole point: `Intl.NumberFormat` accepts `usage` and silently ignores it, so a message
   * asking for road distances would print metres to an American reader with nothing to say so.
   */
  it('refuses the two options Atlas cannot honour rather than ignoring them', () => {
    expect(
      summaryFor('{1 :currency currency=EUR currencyDisplay=never}'),
    ).toContain('no way to produce it');
    expect(summaryFor('{1 :unit unit=meter usage=road}')).toContain(
      'unit conversion is not implemented',
    );
  });

  /**
   * The check that cannot be a table. `roundingIncrement` is a legal option whose validity depends
   * on the options around it, and the surrounding options can be inherited from a declaration three
   * lines up, so the compiler resolves the whole option set and builds the formatter the runtime
   * would build, rather than transcribing ECMA-402's rule into a file nothing keeps current.
   */
  it('refuses a combination of options that no formatter can honour', () => {
    expect(summaryFor('{1 :number roundingIncrement=5}')).toContain(
      'cannot be used together',
    );
    expect(
      summaryFor('{1 :number minimumFractionDigits=3 maximumFractionDigits=1}'),
    ).toContain('cannot be used together');
    // The same option, valid, because the operand carried the fraction digits it needs.
    expect(
      summaryFor(
        '.local $n = {1 :number minimumFractionDigits=2 maximumFractionDigits=2}\n{{{$n :number roundingIncrement=5}}}',
      ),
    ).toBeUndefined();
    // And valid written out in one expression, so the inheritance is not what makes it pass.
    expect(
      summaryFor(
        '{1 :number roundingIncrement=5 minimumFractionDigits=2 maximumFractionDigits=2}',
      ),
    ).toBeUndefined();
  });

  it('refuses :offset written with neither option or with both', () => {
    expect(summaryFor('{1 :offset}')).toContain('neither');
    expect(summaryFor('{1 :offset add=1 subtract=1}')).toContain('both');
  });

  /**
   * `:percent` discards `select` from its operand rather than reporting it, because it has no
   * `select` option for an inherited one to have decided anything about. Atlas refused this, which
   * is a conforming message rejected, and the conformance suite has no case for it either.
   */
  it('lets a function without a select option inherit one harmlessly', () => {
    expect(
      summaryFor('.local $n = {1 :number select=exact}\n{{{$n :percent}}}'),
    ).toBeUndefined();
    expect(
      summaryFor('.local $n = {1 :number select=exact}\n{{{$n :integer}}}'),
    ).toContain('would be inherited');
  });
});

/**
 * The behaviour Atlas depends on and does not implement.
 *
 * MF2 `NormalizeKey` compares a variant key in Unicode Normalization Form C, and Atlas's compiled
 * catalogs satisfy it, but not because Atlas does anything. `normalizeVariantKey` reshapes a key
 * into the semantic model and copies its value through untouched; the normalization is
 * `messageformat`'s parser, a dependency, doing it on the way in.
 *
 * That is fine and it is not written down anywhere, which is the problem. The evaluator carries its
 * own `NormalizeKey` for artifacts it did not compile, and a reader who believed the toolkit
 * normalized could delete it as duplicated work: leaving Atlas's conformance resting entirely on
 * an undocumented behaviour of a third-party parser, with nothing that would notice if it changed.
 *
 * So the dependency is pinned here rather than assumed. If a future `messageformat` stops
 * normalizing, this fails and says so, instead of the two `functions/string.json` cases quietly
 * changing which layer they were testing.
 */
describe('MessageFormat key normalization', () => {
  // "Ḍ̇" as D + dot-below + dot-above, which NFC composes to U+1E0C U+0307.
  const decomposed = 'Ḍ̇';
  const composed = decomposed.normalize('NFC');

  it('is done by the parser, before Atlas sees the key', () => {
    expect(composed).not.toBe(decomposed);
    const result = parseAtlasMessage(
      `.input {$s :string}\n.match $s\n${decomposed} {{hit}}\n* {{miss}}`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'select') return;
    const key = result.value.variants[0]?.keys[0];
    expect(key?.kind).toBe('literal');
    expect(key?.kind === 'literal' ? key.value : undefined).toBe(composed);
  });

  /**
   * The other half of the claim, that Atlas's own step does *not* normalize, is deliberately not
   * asserted here, because nothing in this package can assert it. A compiled key is NFC either way,
   * so measuring the outcome cannot tell the two layers apart, and the only input that could is one
   * the parser refuses to produce. Every check available from this side would agree by construction.
   *
   * It is established from the other side instead, and only from there:
   * `packages/runtime/test/pattern-selection.test.ts` assembles an artifact with an NFD key by hand
   * and shows the evaluator has to normalize it, which is only true because nothing upstream did.
   */
});
/**
 * A `.match` over a function that formats but does not select.
 *
 * MessageFormat requires a *Bad Selector* error here and requires the selector to match nothing but
 * the catch-all. Atlas reported neither: `:currency` and `:unit` reached the evaluator's one numeric
 * resolved value and selected as plain numbers, so `.match {42 :currency currency=EUR} 42 {{keyed}}
 * * {{other}}` rendered `keyed`. A variant the standard says is unreachable, chosen silently. The
 * refusal is at parse because which functions select is known before anything runs.
 */
describe('a selector that cannot select', () => {
  const selecting = [
    [':string', '.local $v = {|a| :string}', 'a'],
    [':number', '.local $v = {1 :number}', '1'],
    [':integer', '.local $v = {1 :integer}', '1'],
    [':offset', '.local $v = {2 :offset subtract=1}', '1'],
    [':percent', '.local $v = {1 :percent}', '100'],
  ] as const;

  const formattingOnly = [
    [':currency', '.local $v = {42 :currency currency=EUR}'],
    [':unit', '.local $v = {42 :unit unit=meter}'],
    [':datetime', '.local $v = {|2024-05-01| :datetime}'],
    [':date', '.local $v = {|2024-05-01| :date}'],
    [':time', '.local $v = {|2024-05-01T10:00:00| :time}'],
  ] as const;

  it.each(formattingOnly)('refuses %s as a selector', (label, declaration) => {
    const result = parseAtlasMessage(
      `${declaration}\n.match $v\n42 {{keyed}}\n* {{other}}`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(({ code }) => code)).toContain('ATL1206');
    const summary = result.diagnostics.find(
      ({ code }) => code === 'ATL1206',
    )?.summary;
    // The author is told which function, which variable, and what a selecting one is.
    expect(summary).toContain(label);
    expect(summary).toContain('$v');
    expect(summary).toContain(':number');
  });

  it.each(selecting)('accepts %s as a selector', (_label, declaration, key) => {
    const result = parseAtlasMessage(
      `${declaration}\n.match $v\n${key} {{keyed}}\n* {{other}}`,
    );
    expect(result.ok).toBe(true);
  });

  /**
   * A refusal says nothing until the same shape is shown passing: the guard above only counts if
   * the same message is accepted when the annotation is one that selects. These two differ by
   * the function name and nothing else.
   */
  it('follows a chain of declarations to the annotation that made the value', () => {
    const refused = parseAtlasMessage(
      [
        '.local $a = {42 :currency currency=EUR}',
        '.local $b = {$a}',
        '.match $b',
        '42 {{keyed}}',
        '* {{other}}',
      ].join('\n'),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.diagnostics.map(({ code }) => code)).toContain('ATL1206');
    }
    const accepted = parseAtlasMessage(
      [
        '.local $a = {42 :number}',
        '.local $b = {$a}',
        '.match $b',
        '42 {{keyed}}',
        '* {{other}}',
      ].join('\n'),
    );
    expect(accepted.ok).toBe(true);
  });

  /**
   * An unannotated selector never reaches this rule, and that is worth pinning rather than assuming.
   *
   * `messageformat`'s own data-model validation refuses it first, so every shape below stops at
   * ATL1202: a bare variable, a local that relays an undeclared one, an unannotated `.input`, and
   * a bare literal. That is why the rule may walk a declaration chain and find no annotating
   * function without deciding anything: by then the message is already refused. The last row is the
   * one that does reach it, and shows the walk is load-bearing rather than defensive.
   */
  it.each([
    ['a bare variable', '.match $v\n42 {{keyed}}\n* {{other}}'],
    [
      'a local relaying an undeclared variable',
      '.local $b = {$a}\n.match $b\n42 {{keyed}}\n* {{other}}',
    ],
    [
      'an unannotated input',
      '.input {$v}\n.match $v\n42 {{keyed}}\n* {{other}}',
    ],
    [
      'a bare literal',
      '.local $b = {|a|}\n.match $b\na {{keyed}}\n* {{other}}',
    ],
  ])('never reaches an unannotated selector: %s', (_label, source) => {
    const result = parseAtlasMessage(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(({ code }) => code)).toEqual(['ATL1202']);
  });

  it('reads a registered function from its descriptor rather than its name', () => {
    const tag = (selects: boolean): AtlasMessageCustomFunction => ({
      name: 'feature:tag',
      selects,
      operandType: 'number',
      resultType: 'string',
      options: [],
    });
    const source =
      '.local $v = {42 :feature:tag}\n.match $v\n42 {{keyed}}\n* {{other}}';
    const refused = parseAtlasMessage(source, {
      customFunctions: [tag(false)],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.diagnostics.map(({ code }) => code)).toContain('ATL1206');
    }
    const accepted = parseAtlasMessage(source, {
      customFunctions: [tag(true)],
    });
    expect(accepted.ok).toBe(true);
  });
});
