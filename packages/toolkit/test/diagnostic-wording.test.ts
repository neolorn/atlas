import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { MessageSyntaxError, parseMessage, validate } from 'messageformat';
import { afterEach, describe, expect, it } from 'vitest';

import { checkAtlasProject, parseAtlasCatalog } from '../src/index.js';
import { parseAtlasMessage } from '../src/message-format.js';
import { initializeAtlasProject } from '../src/project-host.js';
import { syntaxErrorSentence } from '../src/message-format.js';

/**
 * What three diagnostics say, held as text.
 *
 * The defect these tests protect against is entirely in the wording, so every assertion below is
 * on the rendered sentence and none of them is on a code. A test that asserts `code ===
 * 'ATL1102'` passes against every one of the sentences these replaced, which is why they were
 * written after those codes were already covered.
 *
 * The three, as they read before:
 *
 * - **ATL1102, a rejected key.** Two lines for one key, at two positions, each carrying half of
 *   what the reader needed: `Atlas catalog must match pattern "^[a-z][a-z0-9]*(?:-[a-z]..."` (
 *   the rule, in a language the reader is not writing in, with no property named) and
 *   `Atlas catalog property name must be valid`, which names the property's position and no rule.
 *   Neither said that a catalog spells keys one way and code spells them another.
 * - **ATL1101, a parse failure.** The `yaml` package's `message` is a code frame: sentence, blank
 *   line, source, caret. Interpolated into a one-line diagnostic it reached the terminal as
 *   `Missing closing "quote at line 3, column 1:<CR><LF>  greeting: "unterminated<CR><LF>^<CR>`.
 * - **ATL1702, no catalogs.** *"Atlas found no conventional i18n/<scope>/<locale>.yaml catalogs"*
 *   was printed whether none existed or every one of them existed and failed to parse: above the
 *   parse errors for the very files it had just read.
 *
 * The catalog cases go through `parseAtlasCatalog` and the project case through
 * `checkAtlasProject`, because that is where each sentence is decided.
 */

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function catalogSummaries(body: string, code: string): readonly string[] {
  const result = parseAtlasCatalog(body, {
    role: 'source',
    providerId: 'home',
    scopeId: 'shell',
    locale: 'en-US',
    sourcePath: 'i18n/shell/en-US.yaml',
  });
  for (const diagnostic of result.diagnostics) {
    // Every diagnostic in this file is one terminal line, whichever case produced it. This is the
    // ATL1101 defect stated as a property rather than as one expected string, so a second parser
    // message that also arrives as a code frame cannot pass unnoticed.
    expect(diagnostic.summary).not.toMatch(/[\u0000-\u001f]/u);
  }
  return result.diagnostics
    .filter((diagnostic) => diagnostic.code === code)
    .map(({ summary }) => summary);
}

async function projectWithCatalogs(scopes: readonly string[]): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-wording-'));
  temporaryRoots.push(root);
  await writeFile(
    resolve(root, 'package.json'),
    `${JSON.stringify(
      {
        name: '@example/atlas-wording-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const initialized = await initializeAtlasProject({
    project: root,
    configuration: {
      sourceLocale: 'en-US',
      defaultLocale: 'en-US',
      locales: ['en-US'],
    },
  });
  expect(initialized.ok).toBe(true);
  // A TypeScript graph, because since 10.1 a project with no catalogs is no longer a failure and
  // the run carries on to the analysis that needs one. Without this the absence case reports the
  // missing graph instead of the sentence under test.
  await writeFile(
    resolve(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'preserve',
          moduleResolution: 'bundler',
          resolvePackageJsonImports: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await mkdir(resolve(root, 'src'), { recursive: true });
  await writeFile(
    resolve(root, 'src/app.ts'),
    'export const app = 1;\n',
    'utf8',
  );
  for (const scope of scopes) {
    await mkdir(resolve(root, 'i18n', scope), { recursive: true });
    await writeFile(
      resolve(root, 'i18n', scope, 'en-US.yaml'),
      'messages:\n  greeting: "unterminated\n',
      'utf8',
    );
  }
  return root;
}

/**
 * The whole line, severity included, because since 10.1 the severity is half of what changed: an
 * absent catalog set is a note and an unreadable one is an error, and a test on the summary alone
 * would not tell them apart.
 */
async function catalogDiscoveryLines(
  scopes: readonly string[],
): Promise<readonly string[]> {
  const checked = await checkAtlasProject({
    project: await projectWithCatalogs(scopes),
  });
  return checked.diagnostics
    .filter(({ code }) => code === 'ATL1702')
    .map(({ severity, code, summary }) => `${severity} ${code}: ${summary}`);
}

describe('a rejected catalog key, said the way a person would say it', () => {
  it('names the key, states the rule, and gives the name code will use', () => {
    expect(
      catalogSummaries('messages:\n  signInButton: Sign in\n', 'ATL1102'),
    ).toEqual([
      'Message key "signInButton" is not a valid catalog key. Message keys are lower-case words joined by hyphens, and a dot separates groups. Write it as "sign-in-button", which code reaches as messages.signInButton.',
    ]);
  });

  it('is one diagnostic for one key, not the rule and the position apart', () => {
    // The count is the point. Ajv reports the rejected name twice, and printing both halves still
    // passes the assertion above.
    expect(
      catalogSummaries('messages:\n  signInButton: Sign in\n', 'ATL1102'),
    ).toHaveLength(1);
  });

  it('keeps a group separator a group separator', () => {
    expect(
      catalogSummaries('messages:\n  cart.lineItems: Items\n', 'ATL1102'),
    ).toEqual([
      'Message key "cart.lineItems" is not a valid catalog key. Message keys are lower-case words joined by hyphens, and a dot separates groups. Write it as "cart.line-items", which code reaches as messages.cart.lineItems.',
    ]);
  });

  it('repairs the mistakes a person actually makes', () => {
    expect(
      catalogSummaries('messages:\n  sign_in_button: Sign in\n', 'ATL1102'),
    ).toEqual([
      'Message key "sign_in_button" is not a valid catalog key. Message keys are lower-case words joined by hyphens, and a dot separates groups. Write it as "sign-in-button", which code reaches as messages.signInButton.',
    ]);
  });

  it('offers no repair the schema would reject in turn', () => {
    // `1greeting` has nothing wrong that lower-casing and hyphenation can fix. A suggestion that is
    // itself rejected is worse than none, so the rule is given and the sentence stops.
    expect(catalogSummaries('messages:\n  1greeting: Hi\n', 'ATL1102')).toEqual(
      [
        'Message key "1greeting" is not a valid catalog key. Message keys are lower-case words joined by hyphens, and a dot separates groups.',
      ],
    );
  });

  it('calls a family name a family name, with its own rule', () => {
    expect(
      catalogSummaries(
        'messages:\n  ok: Fine\nfamilies:\n  personName:\n    kind: person-name\n',
        'ATL1102',
      )[0],
    ).toBe(
      'Family name "personName" is not a valid catalog key. Family names are lower-case words joined by hyphens. Write it as "person-name".',
    );
  });

  it('keeps the schema errors it is not there to remove', () => {
    // A filter says nothing until it is shown keeping what it is not there to remove. The one
    // that drops Ajv's duplicate half is shown passing the ordinary errors through, so a filter
    // that silently swallowed the whole report would fail here rather than look like a quieter
    // diagnostic.
    expect(
      catalogSummaries('messages: not-a-map\nunknown-key: 1\n', 'ATL1102'),
    ).toEqual([
      'Atlas catalog must NOT have additional properties.',
      'Atlas catalog must be object.',
    ]);
  });
});

describe('a catalog the YAML parser could not read', () => {
  it('says what is wrong in one sentence, without the code frame', () => {
    expect(
      catalogSummaries('messages:\n  greeting: "unterminated\n', 'ATL1101'),
    ).toEqual(['Atlas catalog YAML is invalid: Missing closing "quote']);
  });

  it('does the same for a parser message that is not about quoting', () => {
    expect(catalogSummaries('messages:\n\tgreeting: Hi\n', 'ATL1101')).toEqual([
      'Atlas catalog YAML is invalid: Tabs are not allowed as indentation',
    ]);
  });
});

describe('catalogs that are missing and catalogs that will not parse', () => {
  it('treats having no messages yet as a note, and says where the first one goes', async () => {
    expect(await catalogDiscoveryLines([])).toEqual([
      'info ATL1702: Atlas found no messages yet. Write the first catalog at i18n/<scope>/en-US.yaml, for example i18n/shell/en-US.yaml.',
    ]);
  });

  it('names the one it found and could not read', async () => {
    expect(await catalogDiscoveryLines(['shell'])).toEqual([
      'error ATL1702: Atlas found 1 conventional catalog and could not read it: i18n/shell/en-US.yaml.',
    ]);
  });

  it('names all of them while the list is short enough to read', async () => {
    expect(await catalogDiscoveryLines(['cart', 'shell'])).toEqual([
      'error ATL1702: Atlas found 2 conventional catalogs and could not read any of them: i18n/cart/en-US.yaml, i18n/shell/en-US.yaml.',
    ]);
  });

  it('stops listing before the list becomes a wall', async () => {
    expect(
      await catalogDiscoveryLines([
        'account',
        'admin',
        'cart',
        'checkout',
        'help',
        'search',
        'shell',
      ]),
    ).toEqual([
      'error ATL1702: Atlas found 7 conventional catalogs and could not read any of them: i18n/account/en-US.yaml, i18n/admin/en-US.yaml, i18n/cart/en-US.yaml, i18n/checkout/en-US.yaml, i18n/help/en-US.yaml, i18n/search/en-US.yaml and 1 more.',
    ]);
  });
});

/**
 * What a refused message says, held as text.
 *
 * Filed by 3.17, fixed here, and the same family as ATL1101 above. `MessageSyntaxError.message` is
 * the parser's own type slug followed by the offset, `parse-error at 6`, and
 * `MessageDataModelError` adds nothing to it, so the diagnostic that carried it whole read
 * `MessageFormat missing-selector-annotation: missing-selector-annotation`: the slug twice over,
 * beside a position the diagnostic already states as a span. Every assertion here is on the
 * sentence; the two codes were covered before this item and are covered by `message-format.test.ts`
 * still.
 *
 * Each source below is one that produced its type when the pinned parser and validator were
 * measured: all thirteen types are reachable, and so are all six of the tokens `missing-syntax`
 * carries. The expected sentences are written out rather than read from the table that produces
 * them, so a wrong sentence in the table is a red test rather than an agreement.
 */
describe('a message the parser or the validator refuses', () => {
  // The third party's closed vocabulary, as its own type declaration gives it. None of it belongs in
  // a sentence a person reads.
  const SLUGS = [
    'empty-token',
    'bad-escape',
    'bad-input-expression',
    'duplicate-attribute',
    'duplicate-declaration',
    'duplicate-option-name',
    'duplicate-variant',
    'extra-content',
    'key-mismatch',
    'parse-error',
    'missing-fallback',
    'missing-selector-annotation',
    'missing-syntax',
  ] as const;

  const refusalSentences = (source: string): readonly string[] => {
    const result = parseAtlasMessage(source);
    expect(result.ok).toBe(false);
    for (const { summary } of result.diagnostics) {
      // Stated as properties rather than as expected strings, so a shape this file does not list
      // (a type added upstream, a message that grows a second line) cannot arrive unnoticed.
      expect(summary).not.toMatch(/[\u0000-\u001f]/u);
      expect(summary).not.toMatch(/ at \d+$/u);
      for (const slug of SLUGS) expect(summary).not.toContain(slug);
    }
    return result.diagnostics.map(({ summary }) => summary);
  };

  const cases: readonly (readonly [string, string, string])[] = [
    [
      'a declaration with no pattern',
      '.local $x = {|a|}',
      'MessageFormat expected a quoted pattern here, which opens with {{.',
    ],
    [
      'an unterminated quoted pattern',
      '{{Hello',
      'MessageFormat expected the quoted pattern to close with }} here.',
    ],
    [
      'an unterminated quoted literal',
      '.local $x = {|abc}',
      'MessageFormat expected the quoted literal to close with | here.',
    ],
    [
      'an option with no value',
      '{{{$x :number style}}}',
      'MessageFormat expected = here, because an option is written name=value.',
    ],
    [
      'an .input with no expression',
      '.input $x',
      'MessageFormat expected an expression in braces here.',
    ],
    [
      'no space after .match',
      '.match$x',
      'MessageFormat expected a space here.',
    ],
    [
      'content after the pattern',
      '{{Hello}} extra',
      'MessageFormat found text after the pattern ended; a quoted pattern is the last thing in a message.',
    ],
    [
      'a .match with no selector',
      '.match 1 {{a}}',
      'MessageFormat expected a name, a variable or a value here and found none.',
    ],
    [
      'an escape of a character that is not escapable',
      'a \\q b',
      'MessageFormat escape must be one of \\\\, \\{, \\| or \\}.',
    ],
    [
      'an .input whose operand is a literal',
      '.input {|literal|}',
      'MessageFormat .input declares a variable, so its expression must be a $variable.',
    ],
    [
      'the same option twice',
      '{42 :number style=percent style=decimal}',
      'MessageFormat expression writes the same option name twice.',
    ],
    [
      'the same attribute twice',
      '{{{$x :string @a=1 @a=2}}}',
      'MessageFormat expression writes the same @attribute twice.',
    ],
    [
      'a right brace in an unquoted pattern',
      'Hello } there',
      'MessageFormat found a character here that does not start anything the syntax allows.',
    ],
    [
      'more keys on a variant than the .match has selectors',
      '.input {$one :number}\n.match $one\n1 2 {{Too many}}\n* {{Otherwise}}',
      'MessageFormat variant has a different number of keys than .match has selectors.',
    ],
    [
      'a .match with no catch-all',
      '.input {$one :number}\n.match $one\n1 {{One}}\n2 {{Two}}',
      'MessageFormat .match has no catch-all variant; one variant must be * for every selector.',
    ],
    [
      'a selector no declaration annotates',
      '.match $one\n1 {{One}}\n* {{Other}}',
      'MessageFormat .match selector must reach a declaration that names a function, directly or through another declaration.',
    ],
    [
      'a variable declared twice',
      '.input {$var :number maximumFractionDigits=0}\n.input {$var :number minimumFractionDigits=0}\n{{Redeclared}}',
      'MessageFormat declares the same variable twice; using a variable already declares it, so a later .input for it is a redeclaration.',
    ],
    [
      'two variants with the same keys',
      '.input {$v :string}\n.match $v\n* {{First}}\n* {{Second}}',
      'MessageFormat .match has two variants with the same keys.',
    ],
  ];

  for (const [label, source, sentence] of cases) {
    it('says what is wrong with ' + label, () => {
      expect(refusalSentences(source)).toEqual([sentence]);
    });
  }

  it('covers every type the pinned parser and validator can produce', () => {
    // The sentences above are one per type, which is a claim about the sources rather than about
    // Atlas, so it is checked against the thing that raises them. A type this file stopped
    // exercising would otherwise leave its sentence asserted by nothing.
    const produced = new Set<string>();
    for (const [, source] of cases) {
      try {
        validate(parseMessage(source), (type) => {
          produced.add(type);
        });
      } catch (error) {
        if (!(error instanceof MessageSyntaxError)) throw error;
        produced.add(error.type);
      }
    }
    expect([...produced].sort()).toEqual([...SLUGS].sort());
  });

  /**
   * The token in `Missing }} at 7` is the one thing the message carries that the span does not, and
   * it is read back only while the message says what the span says. Both guards are exercised here,
   * because neither is reachable from a message: while the pinned parser holds its shape, every
   * `missing-syntax` above takes the path that succeeds.
   */
  it('falls back to the general sentence when the message no longer says Missing', () => {
    expect(
      syntaxErrorSentence(new MessageSyntaxError('missing-syntax', 0, 1)),
    ).toBe('MessageFormat expected more syntax here than the message has.');
  });

  it('falls back to the general sentence when the token disagrees with the span', () => {
    expect(
      syntaxErrorSentence(new MessageSyntaxError('missing-syntax', 0, 9, '{{')),
    ).toBe('MessageFormat expected more syntax here than the message has.');
  });
});
