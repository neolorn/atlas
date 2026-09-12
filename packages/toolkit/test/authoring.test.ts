import { describe, expect, it } from 'vitest';

import {
  formatAtlasCatalog,
  parseAtlasCatalog,
  parseAtlasConfiguration,
  type AtlasCatalogParseOptions,
} from '../src/index.js';
import { formatAtlasConfiguration } from '../src/configuration.js';

const sourceCatalogOptions: AtlasCatalogParseOptions = {
  role: 'source',
  providerId: '@neolorn/example',
  scopeId: 'account',
  locale: 'en-US',
  sourcePath: 'i18n/account/en-US.yaml',
};

const targetCatalogOptions: AtlasCatalogParseOptions = {
  ...sourceCatalogOptions,
  role: 'target',
  locale: 'ar-EG',
  sourcePath: 'i18n/account/ar-EG.yaml',
};

function expectFailureCode(
  result:
    | ReturnType<typeof parseAtlasConfiguration>
    | ReturnType<typeof parseAtlasCatalog>,
  code: string,
): void {
  expect(result.ok).toBe(false);
  expect(
    result.diagnostics.some((diagnostic) => diagnostic.code === code),
  ).toBe(true);
}

describe('Atlas project configuration', () => {
  it('canonicalizes locale declarations and builds a prototype-safe alias table', () => {
    const result = parseAtlasConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        sourceLocale: 'EN-us',
        defaultLocale: 'ar-eg',
        locales: ['EN-us', 'ar-eg'],
        aliases: {
          arabic: 'ar-eg',
          constructor: 'EN-us',
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceLocale).toBe('en-US');
    expect(result.value.defaultLocale).toBe('ar-EG');
    expect(result.value.locales).toEqual(['en-US', 'ar-EG']);
    expect(Object.getPrototypeOf(result.value.aliases)).toBeNull();
    expect(result.value.aliases['constructor']).toBe('en-US');
    expect(Object.isFrozen(result.value.aliases)).toBe(true);
  });

  it('accepts name locales the application is not translated into', () => {
    // The whole point of the key: `ja` and `ko` are not in `locales` and must not have to be.
    // An application translated into English and Arabic still renders names people wrote in
    // Japanese, and nothing in its sources says so.
    const result = parseAtlasConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: ['en-US', 'ar-EG'],
        personNameLocales: ['JA', 'ko-kr'],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.personNameLocales).toEqual(['ja', 'ko-KR']);
    expect(Object.isFrozen(result.value.personNameLocales)).toBe(true);
  });

  it('defaults name locales to none when the key is absent', () => {
    const result = parseAtlasConfiguration(
      '{"locales":["en"],"defaultLocale":"en","sourceLocale":"en","schemaVersion":1}',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.personNameLocales).toEqual([]);
  });

  it('reports a malformed or repeated name locale against its own position', () => {
    const malformed = parseAtlasConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        sourceLocale: 'en',
        defaultLocale: 'en',
        locales: ['en'],
        personNameLocales: ['ja', 'not a locale'],
      }),
    );
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(
      malformed.diagnostics.some(
        ({ code, path }) =>
          code === 'ATL1003' &&
          path[0] === 'personNameLocales' &&
          path[1] === 1,
      ),
    ).toBe(true);

    const repeated = parseAtlasConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        sourceLocale: 'en',
        defaultLocale: 'en',
        locales: ['en'],
        personNameLocales: ['ja', 'JA'],
      }),
    );
    expect(repeated.ok).toBe(false);
    if (repeated.ok) return;
    expect(
      repeated.diagnostics.some(
        ({ code, path }) =>
          code === 'ATL1004' && path[0] === 'personNameLocales',
      ),
    ).toBe(true);
  });

  it('writes name locales back in the declaration and omits them when there are none', () => {
    const declared = parseAtlasConfiguration(
      '{"schemaVersion":1,"sourceLocale":"en","defaultLocale":"en","locales":["en"],"personNameLocales":["ja"]}',
    );
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect(formatAtlasConfiguration(declared.value)).toBe(
      [
        '{',
        '  "schemaVersion": 1,',
        '  "sourceLocale": "en",',
        '  "defaultLocale": "en",',
        '  "locales": [',
        '    "en"',
        '  ],',
        '  "personNameLocales": [',
        '    "ja"',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('formats the minimal declaration deterministically and omits empty aliases', () => {
    const result = parseAtlasConfiguration(
      '{"locales":["en"],"defaultLocale":"en","sourceLocale":"en","schemaVersion":1}',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(formatAtlasConfiguration(result.value)).toBe(
      [
        '{',
        '  "schemaVersion": 1,',
        '  "sourceLocale": "en",',
        '  "defaultLocale": "en",',
        '  "locales": [',
        '    "en"',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });

  it.each([
    ['comments', '{"schemaVersion":1,// no\n"sourceLocale":"en"}'],
    ['trailing commas', '{"schemaVersion":1,}'],
    ['empty input', ''],
  ])('rejects JSON extensions: %s', (_label, source) => {
    expectFailureCode(parseAtlasConfiguration(source), 'ATL1001');
  });

  it('detects duplicate keys before configuration construction', () => {
    const result = parseAtlasConfiguration(
      '{"schemaVersion":1,"schemaVersion":1,"sourceLocale":"en","defaultLocale":"en","locales":["en"]}',
      { sourcePath: 'atlas.config.json' },
    );

    expectFailureCode(result, 'ATL1001');
    expect(result.diagnostics[0]?.path).toEqual(['schemaVersion']);
    expect(result.diagnostics[0]?.span?.sourcePath).toBe('atlas.config.json');
    expect(result.diagnostics[0]?.span?.start.line).toBe(0);
  });

  it('rejects unknown configuration fields through a closed schema', () => {
    const result = parseAtlasConfiguration(
      '{"schemaVersion":1,"sourceLocale":"en","defaultLocale":"en","locales":["en"],"remoteCatalog":"https://example.test"}',
    );
    expectFailureCode(result, 'ATL1002');
  });

  it('rejects the withdrawn `profile` declaration', () => {
    // `profile` was a second version marker beside `schemaVersion` that told Atlas nothing it did
    // not already know, and the standards bundle it named is a property of the Atlas release
    // rather than of the consumer's project: it is recorded on compiled artifacts, where
    // compatibility checking actually reads it.
    //
    // The closed schema is what makes the withdrawal a real one. Without this, re-adding the key
    // to `schemas.ts` would pass every other test in the suite, because nothing else in the
    // codebase would notice a field that is merely accepted and ignored.
    const result = parseAtlasConfiguration(
      '{"schemaVersion":1,"profile":"atlas-1","sourceLocale":"en","defaultLocale":"en","locales":["en"]}',
    );
    expectFailureCode(result, 'ATL1002');
  });

  it('rejects duplicate canonical locales and undeclared source/default locales', () => {
    const duplicate = parseAtlasConfiguration(
      '{"schemaVersion":1,"sourceLocale":"en-US","defaultLocale":"en-US","locales":["en-US","EN-us"]}',
    );
    expectFailureCode(duplicate, 'ATL1004');

    const undeclared = parseAtlasConfiguration(
      '{"schemaVersion":1,"sourceLocale":"en","defaultLocale":"ar","locales":["en"]}',
    );
    expectFailureCode(undeclared, 'ATL1004');
  });

  it('rejects malformed, shadowing, and unsupported aliases', () => {
    const malformed = parseAtlasConfiguration(
      '{"schemaVersion":1,"sourceLocale":"en","defaultLocale":"en","locales":["en"],"aliases":{"bad_alias":"en"}}',
    );
    expectFailureCode(malformed, 'ATL1005');

    const shadowing = parseAtlasConfiguration(
      '{"schemaVersion":1,"sourceLocale":"en-US","defaultLocale":"en-US","locales":["en-US"],"aliases":{"en-us":"en-US"}}',
    );
    expectFailureCode(shadowing, 'ATL1006');

    const unsupported = parseAtlasConfiguration(
      '{"schemaVersion":1,"sourceLocale":"en","defaultLocale":"en","locales":["en"],"aliases":{"arabic":"ar"}}',
    );
    expectFailureCode(unsupported, 'ATL1006');
  });
});

describe('Atlas canonical catalogs', () => {
  it('normalizes source shorthand, structured messages, inputs, slots, and empty output', () => {
    const result = parseAtlasCatalog(
      [
        'messages:',
        '  account.title: "Account"',
        '  account.greeting:',
        '    message: "Hello {$name}"',
        '    description: "Greets the signed-in person"',
        '    inputs:',
        '      name: string',
        '    slots:',
        '      strong: strong',
        '  account.separator:',
        '    empty: true',
        '',
      ].join('\n'),
      sourceCatalogOptions,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providerId).toBe('@neolorn/example');
    expect(result.value.scopeId).toBe('account');
    expect(result.value.messages['account.title']?.kind).toBe('message');
    expect(result.value.messages['account.greeting']?.inputs['name']).toEqual({
      type: 'string',
      optional: false,
      nullable: false,
    });
    expect(result.value.messages['account.greeting']?.slots['strong']).toEqual({
      kind: 'strong',
      optional: false,
      repeatable: false,
    });
    expect(result.value.messages['account.separator']?.kind).toBe('empty');
    expect(Object.getPrototypeOf(result.value.messages)).toBeNull();
  });

  it('preserves a valid message named constructor in a prototype-safe map', () => {
    const result = parseAtlasCatalog(
      'messages:\n  constructor: "Safe"\n',
      sourceCatalogOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.getPrototypeOf(result.value.messages)).toBeNull();
    expect(result.value.messages['constructor']).toMatchObject({
      kind: 'message',
      message: 'Safe',
    });
  });

  it('formats catalogs deterministically and round-trips the normalized value', () => {
    const source = [
      'messages:',
      '  z.last: "Last"',
      '  a.first:',
      '    message: "First {$value}"',
      '    inputs:',
      '      value:',
      '        nullable: true',
      '        type: string',
      '',
    ].join('\n');
    const parsed = parseAtlasCatalog(source, sourceCatalogOptions);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const formatted = formatAtlasCatalog(parsed.value);
    expect(formatted.indexOf('a.first')).toBeLessThan(
      formatted.indexOf('z.last'),
    );
    const reparsed = parseAtlasCatalog(formatted, sourceCatalogOptions);
    expect(reparsed).toEqual(parsed);
    expect(
      formatAtlasCatalog(reparsed.ok ? reparsed.value : parsed.value),
    ).toBe(formatted);
  });

  it('allows target wording and metadata but rejects target-owned input and slot contracts', () => {
    const accepted = parseAtlasCatalog(
      'messages:\n  account.title:\n    message: "الحساب"\n    context: "Page heading"\n',
      targetCatalogOptions,
    );
    expect(accepted.ok).toBe(true);

    const inputs = parseAtlasCatalog(
      'messages:\n  account.greeting:\n    message: "مرحبًا {$name}"\n    inputs:\n      name: string\n',
      targetCatalogOptions,
    );
    expectFailureCode(inputs, 'ATL1105');

    const slots = parseAtlasCatalog(
      'messages:\n  account.greeting:\n    message: "مرحبًا"\n    slots:\n      strong: strong\n',
      targetCatalogOptions,
    );
    expectFailureCode(slots, 'ATL1105');
  });

  it.each([
    ['directives', '%YAML 1.2\n---\nmessages:\n  title: "Hi"\n'],
    ['anchors and aliases', 'messages:\n  title: &copy "Hi"\n  other: *copy\n'],
    ['custom tags', 'messages:\n  title: !unsafe "Hi"\n'],
    ['merge keys', 'messages:\n  <<: { title: "Hi" }\n'],
    ['complex keys', 'messages:\n  ? [a, b]\n  : "Hi"\n'],
    [
      'multiple documents',
      'messages:\n  title: "Hi"\n---\nmessages:\n  title: "Hi"\n',
    ],
    ['non-finite numbers', 'messages:\n  title: !!float .inf\n'],
  ])('rejects unsafe YAML structure: %s', (_label, source) => {
    expectFailureCode(
      parseAtlasCatalog(source, sourceCatalogOptions),
      'ATL1101',
    );
  });

  it('detects duplicate YAML keys before construction', () => {
    const result = parseAtlasCatalog(
      'messages:\n  title: "First"\n  title: "Second"\n',
      sourceCatalogOptions,
    );
    expectFailureCode(result, 'ATL1103');
    expect(result.diagnostics[0]?.path).toEqual(['messages', 'title']);
    expect(result.diagnostics[0]?.span?.start.line).toBe(2);
  });

  it('rejects unknown root features and malformed message identities through closed contracts', () => {
    const deferredFeature = parseAtlasCatalog(
      'messages:\n  title: "Hi"\nfuture-feature:\n  status: "status.{value}"\n',
      sourceCatalogOptions,
    );
    expectFailureCode(deferredFeature, 'ATL1102');

    const identity = parseAtlasCatalog(
      'messages:\n  Not.Valid: "Hi"\n',
      sourceCatalogOptions,
    );
    expectFailureCode(identity, 'ATL1102');
  });

  it('rejects malformed provider, scope, and locale context independently of content', () => {
    expectFailureCode(
      parseAtlasCatalog('messages:\n  title: "Hi"\n', {
        ...sourceCatalogOptions,
        providerId: 'Bad Provider',
      }),
      'ATL1104',
    );
    expectFailureCode(
      parseAtlasCatalog('messages:\n  title: "Hi"\n', {
        ...sourceCatalogOptions,
        scopeId: 'BadScope',
      }),
      'ATL1104',
    );
    expectFailureCode(
      parseAtlasCatalog('messages:\n  title: "Hi"\n', {
        ...sourceCatalogOptions,
        locale: 'en_US',
      }),
      'ATL1003',
    );
  });
});
