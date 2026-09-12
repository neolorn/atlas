import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkAtlasProject, generateAtlasProject } from '../src/index.js';

/**
 * A template may not spell out a locale.
 *
 * `specs/03-locale-identity-and-resolution.spec.md` section 1 leaves the locale list to the
 * consumer, and `specs/03-locale-identity-and-resolution.spec.md` section 2 derives every
 * locale-dependent table from the one declaration. A locale spelled out in a template is not
 * regenerated when that declaration changes.
 *
 * Every locale switcher in this repository was written by hand before this check existed, and both
 * of them looked the same: the locale as a string in a click handler, the option's language as a
 * static `lang`, its direction as a static `dir`, and its name in its own language as literal text.
 * Four answers Atlas already holds, authored again per locale per template, in languages the author
 * may not read, and adding a locale means finding every one of those places, with nothing failing
 * when one is missed.
 *
 * **The old fixtures are the mutation.** The first case below is a switcher exactly as one was
 * written by hand, and it has to be refused; the second is the same switcher built on
 * `localeChoices` and `localeChoice`, and it has to pass. A check that only ever ran
 * against the shape it approves of would pass without ever having refused anything.
 *
 * Both build steps are exercised. `generate` is the step a consumer cannot skip, `check` is the one
 * a release gate runs, and a refusal only one of them carried would be silent for whoever ran the
 * other.
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

const manifest = (name: string): string =>
  `${JSON.stringify({ name, version: '0.0.0', types: './index.d.ts' }, null, 2)}\n`;

const ANGULAR_STUB = [
  'export declare function Component(options: unknown): ClassDecorator;',
  'export declare function Directive(options: unknown): ClassDecorator;',
  '',
].join('\n');

/** The switcher as both fixtures wrote it, and as any application writes one without help. */
const BY_HAND = [
  '<button',
  '  type="button"',
  '  lang="en"',
  '  dir="ltr"',
  '  (click)="selectLocale(\'en-US\')"',
  '>English</button>',
  '<button',
  '  type="button"',
  '  lang="ar"',
  '  dir="rtl"',
  '  (click)="selectLocale(\'ar-EG\')"',
  '>Arabic</button>',
].join('\n');

/** The same switcher, with nothing in it that a locale set can outgrow. */
const BY_CHOICE = [
  '@for (choice of localeChoices(); track choice.locale) {',
  '  <button type="button" [localeChoice]="choice">',
  '    {{ choice.selfName }}',
  '  </button>',
  '}',
].join('\n');

/**
 * A passage quoted in a language the application also serves.
 *
 * The one legitimate form of a static `lang`, and the reason that half is a warning rather than a
 * refusal: this markup is correct, and nothing about it can be distinguished from an option's
 * `lang` by looking at the element.
 */
const QUOTATION = '<blockquote lang="ar" dir="rtl">مرحبا</blockquote>';

async function project(template: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-locale-template-'));
  temporaryRoots.push(root);

  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'locale-template',
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
        locales: ['en-US', 'ar-EG'],
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
  for (const locale of ['en-US', 'ar-EG']) {
    await write(
      root,
      `i18n/shell/${locale}.yaml`,
      ['messages:', '  app-title: Locale template probe', ''].join('\n'),
    );
  }
  await write(root, 'node_modules/@angular/core/index.d.ts', ANGULAR_STUB);
  await write(
    root,
    'node_modules/@angular/core/package.json',
    manifest('@angular/core'),
  );

  await write(root, 'src/app.component.html', `${template}\n`);
  await write(
    root,
    'src/app.ts',
    [
      "import { Component } from '@angular/core';",
      "import { messages } from '#i18n/shell';",
      '',
      '@Component({',
      "  selector: 'app-root',",
      "  templateUrl: './app.component.html',",
      '})',
      'export class AppComponent {',
      '  protected readonly title = messages.appTitle;',
      '}',
      '',
    ].join('\n'),
  );

  return root;
}

async function findings(root: string): Promise<{
  readonly generate: readonly { code: string; severity: string }[];
  readonly check: readonly { code: string; severity: string }[];
}> {
  const only = (
    diagnostics: readonly {
      readonly code: string;
      readonly severity: string;
      readonly summary: string;
    }[],
  ): readonly { code: string; severity: string }[] =>
    diagnostics
      .filter(({ code }) => code === 'ATL1410')
      .map(({ code, severity }) => ({ code, severity }));
  const generated = await generateAtlasProject({ project: root });
  const checked = await checkAtlasProject({ project: root });
  return {
    generate: only(generated.diagnostics),
    check: only(checked.diagnostics),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('a template may not spell out a locale', () => {
  it('refuses a switcher that spells its locales out by hand', async () => {
    const reported = await findings(await project(BY_HAND));

    // Two locale literals in click handlers, two hand-written langs. The literals are errors, the
    // attributes warnings, and every one of them is reported by both steps.
    for (const step of [reported.generate, reported.check]) {
      expect(step.filter(({ severity }) => severity === 'error')).toHaveLength(
        2,
      );
      expect(
        step.filter(({ severity }) => severity === 'warning'),
      ).toHaveLength(2);
    }
  });

  it('accepts the same switcher built on the choices', async () => {
    const reported = await findings(await project(BY_CHOICE));

    expect(reported.generate).toEqual([]);
    expect(reported.check).toEqual([]);
  });

  it('warns but does not refuse a passage quoted in another language', async () => {
    const reported = await findings(await project(QUOTATION));

    for (const step of [reported.generate, reported.check]) {
      expect(step).toEqual([{ code: 'ATL1410', severity: 'warning' }]);
    }
  });

  it('says nothing about a template that names no locale at all', async () => {
    const reported = await findings(
      await project('<h1>{{ title }}</h1><p lang="zxx">----</p>'),
    );

    expect(reported.generate).toEqual([]);
    expect(reported.check).toEqual([]);
  });
});
