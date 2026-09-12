import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateAtlasProject, parseAtlasConfiguration } from '../src/index.js';
import { formatAtlasConfiguration } from '../src/configuration.js';

/**
 * Which locales must be finished, declared where the locales are.
 *
 * The release gate was one boolean across every target locale, so "ar-EG must be complete, fr-FR
 * may lag" cost a schema change rather than a line of configuration. The project fact, which
 * locales are expected to be finished, now lives per locale in the project's own file, beside
 * `pseudoLocales`, `formatting` and `aliases`, because it is stable across runs. Whether to enforce
 * it stays on the command, because that is a fact about the run.
 *
 * The default is that every locale is required. A locale nobody has said anything about is one
 * somebody expects to be finished, so silence has to be the strict state; the lax one has to be
 * written down.
 */

const temporaryRoots: string[] = [];

const configurationText = (extra: Readonly<Record<string, unknown>>) =>
  JSON.stringify({
    schemaVersion: 1,
    sourceLocale: 'en-US',
    defaultLocale: 'en-US',
    locales: ['en-US', 'ar-EG'],
    ...extra,
  });

const parse = (extra: Readonly<Record<string, unknown>>) =>
  parseAtlasConfiguration(configurationText(extra));

const codesOf = (result: ReturnType<typeof parse>) =>
  result.diagnostics.map(({ code }) => code);

async function write(
  root: string,
  path: string,
  contents: string,
): Promise<void> {
  const absolute = resolve(root, ...path.split('/'));
  await mkdir(resolve(absolute, '..'), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('a project declares which locales are still being translated', () => {
  it('parses an entry for an authored target locale', () => {
    const result = parse({
      inProgress: { 'ar-EG': { note: 'Translation starts in October.' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inProgress).toEqual({
      'ar-EG': { note: 'Translation starts in October.' },
    });
  });

  it('is empty when the key is absent, which is the strict state', () => {
    const result = parse({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inProgress).toEqual({});
  });

  it('refuses a key that is not a locale identity', () => {
    expect(
      codesOf(parse({ inProgress: { 'not a locale': { note: 'x' } } })),
    ).toContain('ATL1003');
  });

  it('refuses a locale the project does not serve', () => {
    expect(
      codesOf(parse({ inProgress: { 'fr-FR': { note: 'Later.' } } })),
    ).toContain('ATL1004');
  });

  it('refuses the source locale, which defines what complete means', () => {
    // Not a harmless no-op: the source catalog is never a target, so the entry could never change
    // an outcome, and an entry that can never do anything reads as a decision somebody made.
    expect(
      codesOf(parse({ inProgress: { 'en-US': { note: 'Still writing.' } } })),
    ).toContain('ATL1004');
  });

  it('refuses a pseudo-locale, which is derived rather than written', () => {
    const result = parseAtlasConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: ['en-US', 'ar-EG'],
        pseudoLocales: { 'en-XA': { markers: true } },
        inProgress: { 'en-XA': { note: 'Later.' } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain('ATL1004');
  });

  it('refuses an entry with no reason', () => {
    // The note is what stops an exemption outliving its reason. Without it the declaration is a
    // locale name in a file, and nobody can tell a deliberate exemption from a forgotten one.
    expect(parse({ inProgress: { 'ar-EG': {} } }).ok).toBe(false);
  });

  it('writes back only what was declared', () => {
    const declared = parse({
      inProgress: { 'ar-EG': { note: 'Translation starts in October.' } },
    });
    const bare = parse({});
    expect(declared.ok && bare.ok).toBe(true);
    if (!declared.ok || !bare.ok) return;
    expect(formatAtlasConfiguration(declared.value)).toContain('"inProgress"');
    expect(formatAtlasConfiguration(bare.value)).not.toContain('inProgress');
  });

  it('never reaches the generated module, because the runtime has no release', () => {
    // A release policy is answered before anything ships. Carrying it into the bundle would put a
    // build-time decision in front of a reader at runtime, where nothing can act on it.
    return (async () => {
      const root = await mkdtemp(resolve(tmpdir(), 'atlas-in-progress-'));
      temporaryRoots.push(root);
      await write(
        root,
        'package.json',
        `${JSON.stringify(
          {
            name: 'in-progress',
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
        `${configurationText({
          inProgress: { 'ar-EG': { note: 'Translation starts in October.' } },
        })}\n`,
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
      for (const locale of ['en-US', 'ar-EG']) {
        await write(
          root,
          `i18n/shell/${locale}.yaml`,
          ['messages:', '  app-title: In-progress probe', ''].join('\n'),
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

      const result = await generateAtlasProject({ project: root });
      expect(
        result.diagnostics
          .map(({ code }) => code)
          .filter((code) => code.startsWith('ATL1')),
      ).toEqual([]);
      const index = await readFile(
        resolve(root, 'src/generated/i18n/index.ts'),
        'utf8',
      );
      // Anchored against a control, so an empty search cannot pass for a deletion: the module does
      // carry the sibling declaration keys, and it does not carry this one.
      expect(index).toContain('  aliases: aliases,');
      expect(index).not.toContain('inProgress');
    })();
  });
});
