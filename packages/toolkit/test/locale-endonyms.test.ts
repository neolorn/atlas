import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ATLAS_LOCALE_ENDONYMS } from '../src/endonyms.generated.js';
import { generateAtlasProject } from '../src/index.js';
import { atlasLocaleEndonym } from '../src/locales.js';

/**
 * A locale's own name, decided by the build rather than by the visitor's browser.
 *
 * `selfName` was `new Intl.DisplayNames([locale], { type: 'language' }).of(locale)`, read wherever
 * the switcher happened to render. Measured over sixteen locales on the four engines Atlas gates
 * on, three disagreed: WebKit 26.5 title-cases the language name, and Chromium 149 prints the
 * untranslated variant subtag as `VALENCIA`. Atlas server-renders the switcher on Node, so the
 * label could change under a WebKit visitor on hydration: from a string Atlas itself had sent.
 *
 * This is the channel from the pinned CLDR release to the generated module. Whether the rendered
 * switcher agrees with the server is a claim about the composed application and is asserted in the
 * feature lab and in the browser gate, where a page is actually rendered on three engines.
 */

const temporaryRoots: string[] = [];

async function write(
  root: string,
  path: string,
  contents: string,
): Promise<void> {
  const absolute = resolve(root, ...path.split('/'));
  await mkdir(resolve(absolute, '..'), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

async function project(locales: readonly string[]): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-endonyms-'));
  temporaryRoots.push(root);

  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'endonyms',
        private: true,
        type: 'module',
        imports: {
          '#i18n': './src/generated/i18n/index.ts',
          '#i18n/*': './src/generated/i18n/*.ts',
        },
      },
      null,
      2,
    )}\n`,
  );
  await write(
    root,
    'atlas.config.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceLocale: locales[0],
        defaultLocale: locales[0],
        locales: [...locales],
      },
      null,
      2,
    )}\n`,
  );
  await write(
    root,
    'tsconfig.app.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'preserve',
          moduleResolution: 'bundler',
          resolvePackageJsonImports: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
  for (const locale of locales) {
    await write(
      root,
      `i18n/shell/${locale}.yaml`,
      ['messages:', '  app-title: Endonym probe', ''].join('\n'),
    );
  }
  await write(
    root,
    'src/app.ts',
    [
      "import { messages } from '#i18n/shell';",
      '',
      'export const title = messages.appTitle.messageId;',
      '',
    ].join('\n'),
  );
  return root;
}

async function generatedIndex(locales: readonly string[]): Promise<string> {
  const root = await project(locales);
  const result = await generateAtlasProject({ project: root });
  const blocking = result.diagnostics.filter(
    ({ severity }) => severity === 'error',
  );
  expect(blocking).toEqual([]);
  return readFile(resolve(root, 'src/generated/i18n/index.ts'), 'utf8');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('a locale is named by the pinned release', () => {
  /*
   * The three rows that disagreed, and the value each engine will now be handed. These are CLDR
   * 48's own answers: lowercase where CLDR is lowercase, and the `valencia` subtag translated.
   */
  it('answers the three locales the engines disagreed about', () => {
    expect(atlasLocaleEndonym('pt-BR')).toBe('português (Brasil)');
    expect(atlasLocaleEndonym('es-419')).toBe('español latinoamericano');
    expect(atlasLocaleEndonym('ca-ES-valencia')).toBe(
      'català (Espanya, valencià)',
    );
  });

  it('names both pseudo-locales, which are locales a developer sees in a switcher', () => {
    expect(atlasLocaleEndonym('en-Latn-XA')).toBe(
      'English (Latin, Pseudo-Accents)',
    );
    expect(atlasLocaleEndonym('en-Arab-XB')).toBe(
      'English (Arabic, Pseudo-Bidi)',
    );
  });

  /*
   * A tag CLDR does not list is answered by the locale above it rather than by a name assembled
   * out of subtags Atlas has no words for. Composing is what produces `VALENCIA`.
   *
   * `de-CH` is the example worth having, because CLDR does not compose it either: it is not
   * "Deutsch (Schweiz)" but a name of its own, which is exactly the kind of thing a table knows
   * and an assembly rule does not.
   */
  it('answers an unlisted tag with its parent, not with an invented name', () => {
    expect(ATLAS_LOCALE_ENDONYMS['de-CH-1901']).toBeUndefined();
    expect(atlasLocaleEndonym('de-CH')).toBe('Schweizer Hochdeutsch');
    expect(atlasLocaleEndonym('de-CH-1901')).toBe('Schweizer Hochdeutsch');
  });

  /*
   * There are 80 locales in CLDR's own list that its display names do not name. Saying so is the
   * point: the caller falls back to the engine, which usually has a name in some language, and a
   * name in the wrong language beats a raw tag.
   */
  it('says it has no name rather than inventing one', () => {
    expect(atlasLocaleEndonym('aa')).toBeUndefined();
    expect(atlasLocaleEndonym('aa-DJ')).toBeUndefined();
    expect(atlasLocaleEndonym('qaa-x-private')).toBeUndefined();
  });
});

describe('the generated configuration carries the names', () => {
  it('emits one name per configured locale', async () => {
    const index = await generatedIndex([
      'pt-BR',
      'ca-ES-valencia',
      'es-419',
      'en-US',
    ]);

    expect(index).toContain('localeNames: Object.freeze(');
    const line = index
      .split('\n')
      .find((candidate) => candidate.includes('localeNames:'));
    expect(line).toBeDefined();
    expect(JSON.parse(/\{.*\}/u.exec(line ?? '')?.[0] ?? '{}')).toEqual({
      'pt-BR': 'português (Brasil)',
      'ca-ES-valencia': 'català (Espanya, valencià)',
      'es-419': 'español latinoamericano',
      'en-US': 'American English',
    });
  });

  /*
   * No table at all rather than an empty one, for the same reason `formatting` is absent when
   * nothing was declared: an empty object would say the build had a name for each locale and chose
   * none of them.
   */
  it('emits no table when CLDR names none of the locales', async () => {
    const index = await generatedIndex(['aa-DJ', 'aa-ER']);

    expect(index).not.toContain('localeNames:');
  });
});
