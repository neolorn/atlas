import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateAtlasProject } from '../src/index.js';

/**
 * How a locale is written, declared where the locales are declared.
 *
 * The application-wide formatting context could say one thing for the whole application, so an
 * application shipping `ar-EG` and `fa-IR` could not say that one is written in `arab` and the
 * other in `arabext`: the decision had nowhere to be made, which is the same defect as a
 * consumer hand-writing a locale relation two standards already publish.
 *
 * This is the channel from the file to the generated module, and nothing else. Whether the runtime
 * resolves the three layers in the right order is a claim about the composed runtime and is
 * asserted in the feature lab, where a locale can actually be rendered.
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

interface ProjectOptions {
  readonly locales?: readonly string[];
  readonly formatting?: Readonly<Record<string, unknown>>;
}

async function project(options: ProjectOptions = {}): Promise<string> {
  const locales = options.locales ?? ['en-US', 'ar-EG'];
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-locale-formatting-'));
  temporaryRoots.push(root);

  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'locale-formatting',
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
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: [...locales],
        ...(options.formatting === undefined
          ? {}
          : { formatting: options.formatting }),
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
      ['messages:', '  app-title: Formatting probe', ''].join('\n'),
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

async function generated(root: string): Promise<{
  readonly codes: readonly string[];
  readonly index: string;
}> {
  const result = await generateAtlasProject({ project: root });
  const codes = result.diagnostics.map(({ code }) => code);
  const index = codes.some((code) => code.startsWith('ATL1'))
    ? ''
    : await readFile(
        resolve(root, 'src/generated/i18n/index.ts'),
        'utf8',
      ).catch(() => '');
  return { codes, index };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('a locale declares how it is written', () => {
  it('reaches the generated configuration', async () => {
    const { codes, index } = await generated(
      await project({
        formatting: {
          'ar-EG': { numberingSystem: 'latn' },
          'en-US': { hourCycle: 'h23', calendar: 'gregory' },
        },
      }),
    );
    expect(codes).toEqual([]);
    expect(index).toContain('formatting: Object.freeze(');
    expect(index).toContain('"ar-EG":{"numberingSystem":"latn"}');
    expect(index).toContain('"en-US":{"hourCycle":"h23","calendar":"gregory"}');
  });

  it('emits no table when the application declares none', async () => {
    // An empty object would say the application had considered how each locale is written and
    // chosen nothing. Absent is the runtime's "CLDR decides", which is a different statement.
    const { codes, index } = await generated(await project());
    expect(codes).toEqual([]);
    // Anchored to the configuration's own property, because the module names formatting elsewhere:
    // the provider it emits takes `LocalizationFeature` values and `withFormattingContext()` is
    // one of them. A bare substring search would have passed for the wrong reason.
    expect(index).toContain('  aliases: aliases,');
    expect(index).not.toMatch(/^\s*formatting:/mu);
  });

  it('refuses a locale the project does not serve', async () => {
    // The whole point of the key is to say something about a locale a reader is served in. A
    // declaration for one nobody is served is a typo or a locale somebody meant to declare, and
    // ignoring it would leave both looking like they worked.
    const { codes } = await generated(
      await project({
        formatting: { 'fa-IR': { numberingSystem: 'arabext' } },
      }),
    );
    expect(codes).toContain('ATL1004');
  });

  it('refuses a key that is not a locale identity at all', async () => {
    const { codes } = await generated(
      await project({
        formatting: { 'not a locale': { calendar: 'gregory' } },
      }),
    );
    expect(codes).toContain('ATL1003');
  });

  it('refuses an entry that states nothing', async () => {
    // An empty entry reads as a decision somebody made, and it is the absence of one.
    const { codes } = await generated(
      await project({ formatting: { 'ar-EG': {} } }),
    );
    expect(codes.length).toBeGreaterThan(0);
  });

  it('refuses an option Atlas does not carry per locale', async () => {
    // `timeZone` is the fourth field of a formatting context and is deliberately not here: it
    // belongs to the reader or to the deployment, not to the language, and one page is read in one
    // zone whichever language it is in.
    const { codes } = await generated(
      await project({
        formatting: { 'ar-EG': { timeZone: 'Africa/Cairo' } },
      }),
    );
    expect(codes.length).toBeGreaterThan(0);
  });
});
