import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkAtlasProject, generateAtlasProject } from '../src/index.js';

/**
 * A canonical route whose leading segment the policy already owns.
 *
 * The policy claims the first segment of an address before any route does: a locale prefix names
 * the locale and is removed, an older alias of one redirects, a locale-neutral root is answered by
 * nothing. A route declared at `ar-eg/tools` under an `ar-eg` prefix is therefore unreachable at
 * the address it declared, and Atlas will publish addresses for it that it cannot resolve.
 *
 * This is the first point in a build that holds both statements. The policy is one source file and
 * the route projection is another; the runtime validator that checks the projection is handed no
 * policy at all, and the runtime functions that meet both meet them one address at a time, after
 * the build has finished. So the whole-projection question is asked in the compiler or nowhere.
 *
 * Both `generate` and `check` are exercised on every case. `generate` is the step a consumer
 * cannot skip (the application imports `#i18n`, which only `generate` writes) and `check` is
 * the one a release gate runs. A refusal only one of them carried would be silent for whoever ran
 * the other.
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

const ROUTER_STUB = [
  'export declare interface Route {',
  '  path?: string;',
  '  data?: Record<string, unknown>;',
  '  component?: unknown;',
  '  loadComponent?: () => Promise<unknown>;',
  '  loadChildren?: () => Promise<unknown>;',
  '  children?: readonly Route[];',
  '}',
  'export type Routes = readonly Route[];',
  '',
].join('\n');

// Every factory the package exports, so that recognizing only some of them is a failure here
// rather than a hole a consumer discovers in production.
const ATLAS_STUB = [
  'export declare function createPathPrefixLocalePolicy(options: unknown): unknown;',
  'export declare function createDefaultLocalePrefixPolicy(options: unknown): unknown;',
  'export declare function createHostLocalePolicy(options: unknown): unknown;',
  'export declare function createLocaleNeutralPolicy(options: unknown): unknown;',
  '',
].join('\n');

const manifest = (name: string): string =>
  `${JSON.stringify({ name, version: '0.0.0', types: './index.d.ts' }, null, 2)}\n`;

interface ProjectOptions {
  /** The paths of the routes the application declares, beside the ordinary ones. */
  readonly routePaths: readonly string[];
  readonly factory?:
    | 'createPathPrefixLocalePolicy'
    | 'createDefaultLocalePrefixPolicy'
    | 'createHostLocalePolicy'
    | 'createLocaleNeutralPolicy';
  readonly aliases?: Readonly<Record<string, string>>;
  readonly localeNeutralRoots?: readonly string[];
  /**
   * Declare the factory locally instead of importing it. The negative control for the whole
   * mechanism: recognition is by resolved symbol, so a consumer's own function of the same name
   * must claim nothing.
   */
  readonly shadowed?: boolean;
}

/**
 * The routes every fixture carries and no assertion may report. They are the control that tells
 * a check refusing every projection apart from one that found the collision.
 */
const ORDINARY_ROUTES = ['dashboard', 'articles/:slug'];

async function project(options: ProjectOptions): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-reserved-segment-'));
  temporaryRoots.push(root);
  const factory = options.factory ?? 'createPathPrefixLocalePolicy';

  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'reserved-segment',
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
      ['messages:', '  app-title: Reserved segment probe', ''].join('\n'),
    );
  }
  await write(root, 'node_modules/@angular/router/index.d.ts', ROUTER_STUB);
  await write(
    root,
    'node_modules/@angular/router/package.json',
    manifest('@angular/router'),
  );
  await write(root, 'node_modules/@neolorn/atlas/index.d.ts', ATLAS_STUB);
  await write(
    root,
    'node_modules/@neolorn/atlas/package.json',
    manifest('@neolorn/atlas'),
  );

  const table =
    factory === 'createHostLocalePolicy'
      ? [
          '  origins: {',
          "    'en-US': 'https://example.com',",
          "    'ar-EG': 'https://example.eg',",
          '  },',
        ]
      : factory === 'createLocaleNeutralPolicy'
        ? ["  locales: ['en-US', 'ar-EG'],"]
        : [
            '  locales: {',
            "    'en-US': 'en-us',",
            "    'ar-EG': 'ar-eg',",
            '  },',
          ];

  await write(
    root,
    'src/app.routes.ts',
    [
      "import type { Routes } from '@angular/router';",
      '',
      'export class Page {}',
      '',
      'export const routes: Routes = [',
      ...[...ORDINARY_ROUTES, ...options.routePaths].map(
        (path) => `  { path: ${JSON.stringify(path)}, component: Page },`,
      ),
      '];',
      '',
    ].join('\n'),
  );

  await write(
    root,
    'src/app.ts',
    [
      "import { messages } from '#i18n/shell';",
      ...(options.shadowed
        ? []
        : [`import { ${factory} } from '@neolorn/atlas';`]),
      '',
      ...(options.shadowed
        ? [
            `function ${factory}(options: unknown): unknown {`,
            '  return options;',
            '}',
            '',
          ]
        : []),
      'export const title = messages.appTitle.messageId;',
      '',
      `export const routePolicy = ${factory}({`,
      "  defaultLocale: 'en-US',",
      ...table,
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
      ...(options.localeNeutralRoots === undefined
        ? []
        : [
            `  localeNeutralRoots: [${options.localeNeutralRoots
              .map((root_) => JSON.stringify(root_))
              .join(', ')}],`,
          ]),
      '});',
      '',
    ].join('\n'),
  );

  return root;
}

/** The refusals both build steps report, so that neither can be the only one carrying it. */
async function refusals(root: string): Promise<{
  readonly generate: readonly string[];
  readonly check: readonly string[];
}> {
  const summaries = (
    diagnostics: readonly { readonly code: string; readonly summary: string }[],
  ): readonly string[] =>
    diagnostics
      .filter(({ code }) => code === 'ATL1409')
      .map(({ summary }) => summary);
  const generated = await generateAtlasProject({ project: root });
  const checked = await checkAtlasProject({ project: root });
  return {
    generate: summaries(generated.diagnostics),
    check: summaries(checked.diagnostics),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('a route may not be declared at an address the policy owns', () => {
  it('refuses a route whose leading segment is a locale prefix, and reports it from both steps', async () => {
    const root = await project({ routePaths: ['ar-eg/tools'] });
    const { generate, check } = await refusals(root);
    expect(generate).toHaveLength(1);
    expect(generate[0]).toContain('"/ar-eg/tools"');
    expect(generate[0]).toContain('locale prefix');
    expect(generate[0]).toContain('"ar-eg"');
    expect(check).toEqual(generate);
  });

  it('leaves the ordinary routes alone', async () => {
    // The control the whole suite rests on. Every fixture carries `dashboard` and `articles/:slug`,
    // and a check that refused a projection outright would be indistinguishable from one that
    // found the collision.
    const clean = await project({ routePaths: ['ar-egypt/tools'] });
    expect((await refusals(clean)).generate).toEqual([]);
    const colliding = await project({ routePaths: ['ar-eg/tools'] });
    const reported = (await refusals(colliding)).generate;
    expect(reported).toHaveLength(1);
    for (const path of ORDINARY_ROUTES) {
      expect(reported[0]).not.toContain(path);
    }
  });

  it('refuses a route whose whole path is the prefix', async () => {
    const root = await project({ routePaths: ['ar-eg'] });
    expect((await refusals(root)).generate[0]).toContain('"/ar-eg"');
  });

  it('names an alias and a locale-neutral root as what they are', async () => {
    const root = await project({
      routePaths: ['ara/help', 'assets/logo'],
      aliases: { ara: 'ar-EG' },
      localeNeutralRoots: ['assets'],
    });
    const { generate } = await refusals(root);
    expect(generate).toHaveLength(2);
    expect(generate.join('\n')).toContain('locale alias');
    expect(generate.join('\n')).toContain('locale-neutral root');
  });

  /**
   * The hole that made the check silent for half the ways of spelling a policy.
   *
   * Atlas exports four policy factories and the toolkit recognized two, so a consumer who used
   * `createDefaultLocalePrefixPolicy` (the shape in which a route's own leading segment becomes
   * the first segment of an address, and therefore the one most exposed to this defect) got no
   * check at all. Every factory is asserted here, and the two that put no locale in the path are
   * asserted to claim only their neutral roots.
   */
  it('reads every factory the package exports', async () => {
    const prefixing = await project({
      routePaths: ['ar-eg/tools'],
      factory: 'createDefaultLocalePrefixPolicy',
    });
    expect((await refusals(prefixing)).generate).toHaveLength(1);

    for (const factory of [
      'createHostLocalePolicy',
      'createLocaleNeutralPolicy',
    ] as const) {
      // No path prefixes to claim, so a route named like a locale is an ordinary route...
      const free = await project({ routePaths: ['ar-eg/tools'], factory });
      expect((await refusals(free)).generate).toEqual([]);
      // ...but a locale-neutral root is claimed by every policy kind, which is what says the
      // empty result above is about prefixes rather than about the factory going unread.
      const claimed = await project({
        routePaths: ['assets/logo'],
        factory,
        localeNeutralRoots: ['assets'],
      });
      expect((await refusals(claimed)).generate).toHaveLength(1);
    }
  });

  it('does not read a consumer function that merely shares the name', async () => {
    const root = await project({
      routePaths: ['ar-eg/tools'],
      shadowed: true,
    });
    expect((await refusals(root)).generate).toEqual([]);
  });

  it('leaves a parameterised leading segment to the runtime', async () => {
    // Whether a slug spells a locale prefix is decided per value, after the build. The build says
    // nothing about it rather than guessing, and `buildLocalizedRoute` refuses the value.
    const root = await project({ routePaths: [':slug'] });
    expect((await refusals(root)).generate).toEqual([]);
  });
});
