import { describe, expect, it } from 'vitest';

import {
  compileAtlasProject,
  defineAtlasExtensionRegistry,
  parseAtlasCatalog,
  parseAtlasConfiguration,
  type AtlasCatalog,
  type AtlasExtensionRegistry,
  type AtlasProjectConfiguration,
} from '../src/index.js';
import {
  formatAtlasExtensionRegistry,
  parseAtlasExtensionRegistry,
} from '../src/extensions.js';
import { generateAtlasContracts } from '../src/generated-contracts.js';
import { parseAtlasMessage } from '../src/message-format.js';
import { analyzeAtlasCatalogSet } from '../src/semantic-model.js';

function configuration(): AtlasProjectConfiguration {
  const parsed = parseAtlasConfiguration(
    JSON.stringify({
      schemaVersion: 1,
      sourceLocale: 'en-US',
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
    }),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.value;
}

function registry(): AtlasExtensionRegistry {
  const defined = defineAtlasExtensionRegistry([
    {
      kind: 'message-function',
      id: 'demo:uppercase',
      operandType: 'string',
      options: {
        emphasis: { type: 'string', values: ['loud', 'plain'] },
      },
      resultType: 'string',
      selector: 'none',
      maximumOutputLength: 128,
    },
    {
      kind: 'identifier-segment',
      id: 'demo:state',
      syntax: 'lower-kebab',
      maximumLength: 24,
    },
    {
      kind: 'rich-slot-kind',
      id: 'demo:badge',
      shape: 'paired',
      interactive: false,
      textProjection: 'binding-required',
      options: { tone: ['info', 'warning'] },
    },
    {
      kind: 'formatting-adapter',
      id: 'demo:sku-format',
      inputType: 'demo:sku',
      result: 'text',
      maximumOutputLength: 64,
    },
    {
      kind: 'parsing-adapter',
      id: 'demo:sku-parse',
      outputType: 'demo:sku',
      maximumInputLength: 64,
    },
  ]);
  if (!defined.ok) throw new Error(JSON.stringify(defined.diagnostics));
  return defined.value;
}

function catalog(
  role: 'source' | 'target',
  locale: string,
  source: string,
  extensions: AtlasExtensionRegistry,
): AtlasCatalog {
  const parsed = parseAtlasCatalog(source, {
    role,
    providerId: '@example/extensions',
    scopeId: 'shell',
    locale,
    sourcePath: `i18n/shell/${locale}.yaml`,
    extensions,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.value;
}

function catalogs(extensions: AtlasExtensionRegistry): readonly AtlasCatalog[] {
  return [
    catalog(
      'source',
      'en-US',
      [
        'messages:',
        '  greeting: "Hello {$name :demo:uppercase emphasis=loud}"',
        '  badge:',
        '    message: "{#badge tone=info}New{/badge}"',
        '    slots:',
        '      badge: demo:badge',
        '  status.ready: Ready',
        '  status.pending: Pending',
        'families:',
        '  status:',
        '    template: "status.{state}"',
        '    segments:',
        '      state: demo:state',
        '',
      ].join('\n'),
      extensions,
    ),
    catalog(
      'target',
      'ar-EG',
      [
        'messages:',
        '  greeting: "مرحبًا {$name :demo:uppercase emphasis=loud}"',
        '  badge: "{#badge tone=info}جديد{/badge}"',
        '  status.ready: جاهز',
        '  status.pending: قيد الانتظار',
        '',
      ].join('\n'),
      extensions,
    ),
  ];
}

describe('Atlas application-local extension registry', () => {
  it('parses strict JSON and formats one deterministic inert registry', () => {
    const expected = registry();
    const formatted = formatAtlasExtensionRegistry(expected);
    const parsed = parseAtlasExtensionRegistry(formatted, {
      sourcePath: 'atlas.extensions.json',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(expected);
    expect(formatAtlasExtensionRegistry(parsed.value)).toBe(formatted);

    const duplicateKey = parseAtlasExtensionRegistry(
      '{"profile":"atlas-extension-registry/1","descriptors":[],"descriptors":[]}',
    );
    expect(duplicateKey.ok).toBe(false);
    expect(duplicateKey.diagnostics[0]?.code).toBe('ATL1805');
  });

  it('requires registered descriptors while keeping bindings and code out of catalogs', () => {
    const extensions = registry();
    const withoutRegistry = parseAtlasCatalog(
      'messages:\n  greeting: "Hello {$name :demo:uppercase}"\n',
      {
        role: 'source',
        providerId: '@example/extensions',
        scopeId: 'shell',
        locale: 'en-US',
      },
    );
    expect(withoutRegistry.ok).toBe(false);

    const analyzed = analyzeAtlasCatalogSet({
      configuration: configuration(),
      catalogs: catalogs(extensions),
      extensions,
    });
    expect(analyzed.ok, JSON.stringify(analyzed.diagnostics, null, 2)).toBe(
      true,
    );
    if (!analyzed.ok) return;
    const scope = analyzed.value.scopes[0];
    expect(scope?.requiredExtensions.map(({ kind, id }) => [kind, id])).toEqual(
      [
        ['identifier-segment', 'demo:state'],
        ['message-function', 'demo:uppercase'],
        ['rich-slot-kind', 'demo:badge'],
      ],
    );
    expect(analyzed.value.extensionDescriptors).toEqual(extensions.descriptors);
    expect(scope?.families[0]).toMatchObject({
      name: 'status',
      template: 'status.{state}',
      members: [
        { messageId: 'status.pending', segments: { state: 'pending' } },
        { messageId: 'status.ready', segments: { state: 'ready' } },
      ],
    });

    const generated = generateAtlasContracts(analyzed.value);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(
      generated.value.find(({ path }) => path === 'shell.ts')?.contents,
    ).toContain('defineAtlasMessageFamily');
    expect(
      generated.value.find(({ path }) => path === 'index.ts')?.contents,
    ).toContain('demo:sku-format');

    const compiled = compileAtlasProject({
      owner: {
        providerId: '@atlas/test-owner',
        generatedRootPath: 'src/generated/i18n',
      },
      configuration: configuration(),
      catalogs: catalogs(extensions),
      extensions,
    });
    expect(compiled.ok, JSON.stringify(compiled.diagnostics, null, 2)).toBe(
      true,
    );
    if (!compiled.ok) return;
    expect(
      compiled.value.artifacts.descriptor.providers[0]?.artifacts[0]?.address
        .requiredExtensions,
    ).toEqual(scope?.requiredExtensions);
  });
});

describe('Atlas bounded open message families', () => {
  it('rejects families whose current members do not share one contract', () => {
    const extensions = registry();
    const source = catalog(
      'source',
      'en-US',
      [
        'messages:',
        '  status.ready: Ready',
        '  status.pending: "Pending for {$name}"',
        'families:',
        '  status:',
        '    template: "status.{state}"',
        '    segments:',
        '      state: demo:state',
        '',
      ].join('\n'),
      extensions,
    );
    const target = catalog(
      'target',
      'ar-EG',
      'messages:\n  status.ready: جاهز\n  status.pending: "قيد الانتظار لـ {$name}"\n',
      extensions,
    );
    const analyzed = analyzeAtlasCatalogSet({
      configuration: configuration(),
      catalogs: [source, target],
      extensions,
    });
    expect(analyzed.ok).toBe(false);
    expect(analyzed.diagnostics.map(({ code }) => code)).toContain('ATL1305');
  });
});
/**
 * What an extension descriptor may spell, and what a message may write against it.
 *
 * Two rules that had drifted from the standard in the same direction and for the same reason: both
 * were written against ASCII lower-kebab identifiers, which is Atlas's own convention, and applied
 * to MessageFormat's vocabulary, which is not Atlas's. An option name could not be `decimalPlaces`
 * (nor `signDisplay`, which Atlas's own `:number` has) and an option value could not satisfy an
 * `integer`, `number` or `boolean` type, because a MessageFormat option value is a literal and a
 * literal is text. The second made the first pointless: the name became spellable and the value
 * behind it was still refused.
 */
describe('a message-function option, as MessageFormat spells one', () => {
  const withOption = (name: string, option: unknown = { type: 'string' }) =>
    defineAtlasExtensionRegistry([
      {
        kind: 'message-function',
        id: 'feature:tag',
        operandType: 'number',
        resultType: 'string',
        selector: 'exact',
        maximumOutputLength: 32,
        options: { [name]: option },
      } as never,
    ]);

  it.each([
    ["decimalPlaces, which the standard's own suite writes", 'decimalPlaces'],
    ["signDisplay, which Atlas's own :number has", 'signDisplay'],
    ['a dot, which name-char allows', 'decimal.places'],
    ['a leading +, which name-start allows', '+places'],
    ['a leading _, which name-start allows', '_places'],
    ['a non-ASCII letter', 'décimales'],
    ['a CJK name', '小数点'],
  ])('accepts an option named with %s', (_label, name) => {
    expect(withOption(name).ok).toBe(true);
  });

  it.each([
    ['a leading digit, which name-start excludes', '9places'],
    ['a space, which no production allows', 'pla ces'],
    [
      'a bidi wrapper, which the parser strips before Atlas sees it',
      '\u200eplaces\u200e',
    ],
    ['more than 64 code points', 'x'.repeat(65)],
  ])('refuses an option named with %s', (_label, name) => {
    expect(withOption(name).ok).toBe(false);
  });

  /**
   * The `[bidi]` row above is the one that is a decision rather than a transcription. MessageFormat's
   * `name` production permits the wrapper and the parser removes it, so a descriptor that could
   * declare `<LRM>places<LRM>` would be declaring a name no message can ever match and a second
   * spelling of one that already exists.
   */
  it('sees the option name a message writes with a bidi wrapper without it', () => {
    const parsed = parseAtlasMessage('{42 :feature:tag \u200eplaces\u200e=1}', {
      customFunctions: [
        {
          name: 'feature:tag',
          selects: false,
          operandType: 'number',
          resultType: 'string',
          options: ['places'],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.kind !== 'pattern') return;
    const expression = parsed.value.pattern.find(
      (part): part is Extract<typeof part, { kind: 'expression' }> =>
        typeof part !== 'string' && part.kind === 'expression',
    );
    expect(Object.keys(expression?.function?.options ?? {})).toEqual([
      'places',
    ]);
  });
});
/**
 * An option value written in a message is text, and its descriptor may declare it as something else.
 *
 * The check asked whether the JavaScript value was of the declared type, of a value that is always a
 * string: a MessageFormat option value is a literal or a variable and a literal is text. So
 * `integer`, `number` and `boolean` were option types a descriptor could declare and no message
 * could satisfy, and a closed `values` set was unsatisfiable in the same way: `values: [0, 1]`
 * compared against `'1'`. Nothing had noticed because nothing had written an extension with a typed
 * option, which needed an option name the registry would accept first.
 *
 * The standard settles what the two spellings mean: a digit size option's value "resolves to a
 * numerical integer value 0 or 1 or their corresponding string representations `'0'` or `'1'`".
 */
describe('a typed option value written as a literal', () => {
  const typed = (
    option: Readonly<Record<string, unknown>>,
    written: string,
  ) => {
    const extensions = defineAtlasExtensionRegistry([
      {
        kind: 'message-function',
        id: 'demo:typed',
        operandType: 'number',
        resultType: 'string',
        selector: 'none',
        maximumOutputLength: 32,
        options: option,
      } as never,
    ]);
    if (!extensions.ok)
      throw new Error('the descriptor under test was refused');
    const catalog = parseAtlasCatalog(
      `messages:\n  price: "Costs {42 :demo:typed ${written}}"\n`,
      {
        role: 'source',
        providerId: '@example/extensions',
        scopeId: 'shell',
        locale: 'en-US',
        extensions: extensions.value,
      },
    );
    if (!catalog.ok) throw new Error('the message under test did not parse');
    return analyzeAtlasCatalogSet({
      configuration: configuration(),
      catalogs: [catalog.value],
      extensions: extensions.value,
    });
  };

  const problems = (graph: ReturnType<typeof typed>) =>
    graph.diagnostics
      .filter(({ code }) => code === 'ATL1805')
      .map(({ summary }) => summary);

  it.each([
    ['an integer', { type: 'integer' }, 'places=1'],
    [
      'an integer inside a closed set',
      { type: 'integer', values: [0, 1] },
      'places=1',
    ],
    ['a negative integer', { type: 'integer' }, 'places=-3'],
    ['a number', { type: 'number' }, 'places=1.5'],
    ['a number in exponent form', { type: 'number' }, 'places=1e3'],
    ['a boolean', { type: 'boolean' }, 'places=true'],
    [
      'a boolean inside a closed set',
      { type: 'boolean', values: [true] },
      'places=true',
    ],
    [
      'a string inside a closed set',
      { type: 'string', values: ['wide'] },
      'places=wide',
    ],
  ])('accepts %s', (_label, option, written) => {
    expect(problems(typed({ places: option }, written))).toEqual([]);
  });

  it.each([
    [
      'a value outside a closed integer set',
      { type: 'integer', values: [0, 1] },
      'places=9',
    ],
    [
      'a fraction where an integer is declared',
      { type: 'integer' },
      'places=1.5',
    ],
    ['a word where a number is declared', { type: 'number' }, 'places=wide'],
    ['a number MessageFormat does not spell', { type: 'number' }, 'places=042'],
    ['a word where a boolean is declared', { type: 'boolean' }, 'places=yes'],
    [
      'a value outside a closed string set',
      { type: 'string', values: ['wide'] },
      'places=narrow',
    ],
  ])('refuses %s', (_label, option, written) => {
    expect(problems(typed({ places: option }, written))).toHaveLength(1);
  });
});
