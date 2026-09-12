import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkAtlasProject, generateAtlasProject } from '../src/index.js';

/**
 * A template may not write a locale into an address it hands to the Router.
 *
 * The contract: a consumer writes `routerLink="/articles/atlas-handbook"`,
 * never `/ar-eg/...`, never a link-builder service, never a pipe. Nothing enforced the never. The
 * first place a prefixed link was reported was a console warning in development, after the click,
 * to whoever happened to be looking at the console.
 *
 * **The defect is that the link cannot do what its address says.** A click hands the Router the
 * address as written, and `UrlHandlingStrategy.extract` resolves it to its canonical form before
 * anything matches it, so the prefix is removed and the page renders in the locale that is
 * committed now. A reader in `en-US` clicking a link spelled `/ar-eg/articles` gets the English
 * page. There is no locale in which that link goes where it says.
 *
 * **`routerLink` alone**, which is a scope rather than an omission, and the negative case below
 * says so out loud. `href` is a different mechanism: a full-page address the browser supplies,
 * which `LocationStrategy.path()` delocalizes on arrival. A locale in an `href` works, and a link
 * to another locale's page is legitimate content.
 *
 * Preventive: no instance of this exists in the repository today. So the fixtures are the whole
 * evidence, and they are written to make the check distinguishable from the several cheaper checks
 * that would pass the refusal cases: every fixture carries links that must stay silent, and every
 * silent reading is paired with a fixture that speaks.
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

const ANGULAR_CORE_STUB = [
  'export declare function Component(options: unknown): ClassDecorator;',
  'export declare function Directive(options: unknown): ClassDecorator;',
  '',
].join('\n');

const ANGULAR_ROUTER_STUB = [
  'export declare interface Route {',
  '  path?: string;',
  '  data?: Record<string, unknown>;',
  '  component?: unknown;',
  '  children?: readonly Route[];',
  '}',
  'export type Routes = readonly Route[];',
  '',
].join('\n');

const ATLAS_STUB = [
  'export declare function createPathPrefixLocalePolicy(options: unknown): unknown;',
  'export declare function createLocaleNeutralPolicy(options: unknown): unknown;',
  '',
].join('\n');

/**
 * The links every fixture carries and no assertion may report.
 *
 * A fixture sized to the minimum cannot tell the rule apart from its neighbours. Each of
 * these would be reported by a plausible cheaper check (one that matched the locale set rather
 * than the claimed segments, one that read any attribute, one that judged a relative address, one
 * that guessed at a computed leading segment) so a clean reading here is a reading about this
 * rule and not about the fixture being small.
 */
const ORDINARY_LINKS = [
  '<a routerLink="/articles/atlas-handbook">the contract</a>',
  '<a routerLink="articles">relative</a>',
  '<a routerLink="../articles">relative, upward</a>',
  "<a [routerLink]=\"['..', 'articles']\">relative commands</a>",
  "<a [routerLink]=\"['/', prefix, 'articles']\">a computed leading segment</a>",
  '<a [routerLink]="target()">a computed address</a>',
  '<a routerLink="/assets/brochure.pdf">a locale-neutral root</a>',
  '<a href="/ar-eg/articles">another locale\'s page, which is content</a>',
  '<a [href]="\'/ar-eg/articles\'">the same, bound</a>',
].join('\n');

interface ProjectOptions {
  /** The links under test, beside the ordinary ones. */
  readonly links: readonly string[];
  readonly factory?:
    | 'createPathPrefixLocalePolicy'
    | 'createLocaleNeutralPolicy';
  readonly aliases?: Readonly<Record<string, string>>;
}

async function project(options: ProjectOptions): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-router-link-'));
  temporaryRoots.push(root);
  const factory = options.factory ?? 'createPathPrefixLocalePolicy';

  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'router-link',
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
      ['messages:', '  app-title: Router link probe', ''].join('\n'),
    );
  }
  for (const [name, contents] of [
    ['@angular/core', ANGULAR_CORE_STUB],
    ['@angular/router', ANGULAR_ROUTER_STUB],
    ['@neolorn/atlas', ATLAS_STUB],
  ] as const) {
    await write(root, `node_modules/${name}/index.d.ts`, contents);
    await write(root, `node_modules/${name}/package.json`, manifest(name));
  }

  await write(
    root,
    'src/app.routes.ts',
    [
      "import type { Routes } from '@angular/router';",
      '',
      'export class Page {}',
      '',
      'export const routes: Routes = [',
      "  { path: 'articles/:slug', component: Page },",
      "  { path: 'dashboard', component: Page },",
      '];',
      '',
    ].join('\n'),
  );

  await write(
    root,
    'src/app.ts',
    [
      "import { messages } from '#i18n/shell';",
      `import { ${factory} } from '@neolorn/atlas';`,
      '',
      'export const title = messages.appTitle.messageId;',
      '',
      `export const routePolicy = ${factory}({`,
      "  defaultLocale: 'en-US',",
      ...(factory === 'createLocaleNeutralPolicy'
        ? ["  locales: ['en-US', 'ar-EG'],"]
        : [
            '  locales: {',
            "    'en-US': 'en-us',",
            "    'ar-EG': 'ar-eg',",
            '  },',
          ]),
      ...(options.aliases === undefined
        ? []
        : [
            '  aliases: {',
            ...Object.entries(options.aliases).map(
              ([alias, locale]) =>
                `    ${JSON.stringify(alias)}: ${JSON.stringify(locale)},`,
            ),
            '  },',
          ]),
      "  localeNeutralRoots: ['assets'],",
      '});',
      '',
    ].join('\n'),
  );

  await write(
    root,
    'src/app.component.html',
    `${[ORDINARY_LINKS, ...options.links].join('\n')}\n`,
  );
  await write(
    root,
    'src/app.component.ts',
    [
      "import { Component } from '@angular/core';",
      '',
      '@Component({',
      "  selector: 'app-root',",
      "  templateUrl: './app.component.html',",
      '})',
      'export class AppComponent {',
      "  protected readonly prefix = 'articles';",
      '  protected target(): string {',
      "    return '/articles';",
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  return root;
}

/** The refusals both build steps report, so that neither can be the only one carrying it. */
async function refusals(root: string): Promise<{
  readonly generate: readonly string[];
  readonly check: readonly string[];
  readonly severities: readonly string[];
}> {
  const only = (
    diagnostics: readonly {
      readonly code: string;
      readonly severity: string;
      readonly summary: string;
    }[],
  ): readonly { severity: string; summary: string }[] =>
    diagnostics
      .filter(({ code }) => code === 'ATL1411')
      .map(({ severity, summary }) => ({ severity, summary }));
  const generated = only(
    (await generateAtlasProject({ project: root })).diagnostics,
  );
  const checked = only(
    (await checkAtlasProject({ project: root })).diagnostics,
  );
  return {
    generate: generated.map(({ summary }) => summary),
    check: checked.map(({ summary }) => summary),
    severities: generated.map(({ severity }) => severity),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('a routerLink may not name a segment the policy claims', () => {
  it('refuses every form a routerLink is written in, and reports each from both steps', async () => {
    // Four spellings of one address. A check that read only the expression visitor would miss the
    // first, a check that read only text attributes would miss the other three, and a check that
    // read a literal whole would miss the two command lists.
    const root = await project({
      links: [
        '<a routerLink="/ar-eg/articles">static</a>',
        '<a [routerLink]="\'/ar-eg/articles\'">bound</a>',
        "<a [routerLink]=\"['/ar-eg', 'articles']\">commands</a>",
        "<a [routerLink]=\"['/', 'ar-eg', 'articles']\">commands, split root</a>",
      ],
    });
    const { generate, check, severities } = await refusals(root);

    expect(generate).toHaveLength(4);
    expect(check).toEqual(generate);
    expect(severities).toEqual(['error', 'error', 'error', 'error']);
    for (const summary of generate) {
      expect(summary).toContain('"/ar-eg/articles"');
      expect(summary).toContain('locale prefix');
      expect(summary).toContain('"/articles"');
      expect(summary).toContain('Localization.changeLocale()');
    }
  });

  it('says nothing about the links a consumer is supposed to write', async () => {
    // The same fixture, with and without one prefixed link, so that the empty result is known to
    // come from a check that speaks rather than from one that cannot.
    const clean = await project({ links: [] });
    expect((await refusals(clean)).generate).toEqual([]);
    expect((await refusals(clean)).check).toEqual([]);

    const one = await project({
      links: ['<a routerLink="/ar-eg/articles">prefixed</a>'],
    });
    const reported = (await refusals(one)).generate;
    expect(reported).toHaveLength(1);
    // And it is the added link that is named, not one of the nine the fixture always carries.
    expect(reported[0]).toContain('"/ar-eg/articles"');
  });

  it('names an alias as an alias, and leaves a locale-neutral root alone', async () => {
    // The two claims that are not prefixes, and they go opposite ways. An alias is removed from the
    // address exactly as a prefix is, so a link through one is the same defect. A locale-neutral
    // root survives the resolution, which is what it is for, so an address beginning with one goes
    // where it says.
    const root = await project({
      links: [
        '<a routerLink="/ara/articles">an older spelling</a>',
        '<a routerLink="/assets/brochure.pdf">a neutral root</a>',
      ],
      aliases: { ara: 'ar-EG' },
    });
    const { generate } = await refusals(root);

    expect(generate).toHaveLength(1);
    expect(generate[0]).toContain('locale alias');
    expect(generate[0]).toContain('"ara"');
  });

  it('matches the prefix however the address spells its case', async () => {
    // The resolver corrects the case of a prefix, so an address that differs only in case reaches
    // the same locale and is the same defect. `AtlasClaimedRouteSegment` records that rule and this
    // check reads it rather than restating it.
    const root = await project({
      links: ['<a routerLink="/AR-EG/articles">shouted</a>'],
    });
    expect((await refusals(root)).generate).toHaveLength(1);
  });

  it('says nothing under a policy that claims no prefix', async () => {
    // A locale-neutral policy puts every locale at one address, so `ar-eg` leads no route Atlas
    // owns and a link through it is an ordinary broken link for the application to answer. Paired
    // with the neutral root the same policy still claims, which is what says this silence is about
    // the claim and not about the policy going unread.
    const free = await project({
      links: ['<a routerLink="/ar-eg/articles">a segment nothing claims</a>'],
      factory: 'createLocaleNeutralPolicy',
    });
    expect((await refusals(free)).generate).toEqual([]);

    const claiming = await project({
      links: [
        '<a routerLink="/ar-eg/articles">a segment the prefix policy claims</a>',
      ],
    });
    expect((await refusals(claiming)).generate).toHaveLength(1);
  });
});
