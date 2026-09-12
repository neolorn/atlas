import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { atlasDiagnosticsBlock } from '../src/diagnostics.js';
import { checkAtlasProject, generateAtlasProject } from '../src/index.js';

/**
 * An application states its locales twice, and the two statements have to agree.
 *
 * `atlas.config.json` decides which locales get catalogs. The locale URL policy decides which
 * locales get addresses. They are separate files written at separate times, and nothing compared
 * them: the toolkit had no knowledge of the policy at all, so none of its diagnostic codes could
 * have covered this.
 *
 * Both directions are silent at runtime and neither is recoverable by a reader:
 *
 *   - configured, not in the policy (the translations exist and nothing can navigate to them
 *   - in the policy, not configured) the address resolves and every message on the page falls
 *     back to the default language, which reads as a translation gap rather than a misconfiguration
 *
 * So both are errors, and both are checked here in both `generate` and bare `check`, because a
 * release gate runs `check` and an error only `generate` reports is one the gate never sees.
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
  readonly configuredLocales: readonly string[];
  readonly configuredDefault?: string;
  /** Locale keys the policy declares. `undefined` builds no policy at all. */
  readonly policyLocales?: readonly string[];
  readonly policyDefault?: string;
  /** Which factory builds it. `origins` is the host policy's key for the same table. */
  readonly factory?: 'path-prefix' | 'host';
  /** Build a second policy, to exercise the ambiguity warning. */
  readonly secondPolicy?: readonly string[];
  /**
   * Declare the factory locally instead of importing it from the package.
   *
   * The negative control for the whole mechanism. Recognition is by resolved symbol, so a
   * consumer's own function of the same name must configure nothing, and if this test went green
   * the detector would be matching on the name, which every consumer can shadow.
   */
  readonly shadowed?: boolean;
  /** Pseudo-locales declared in configuration. Generated only when `pseudo` is passed. */
  readonly pseudoLocales?: readonly string[];
}

async function project(options: ProjectOptions): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-locale-set-'));
  temporaryRoots.push(root);
  const defaultLocale = options.configuredDefault ?? 'en-US';

  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'locale-set',
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
        defaultLocale,
        locales: [...options.configuredLocales],
        ...(options.pseudoLocales === undefined
          ? {}
          : {
              pseudoLocales: Object.fromEntries(
                options.pseudoLocales.map((locale) => [
                  locale,
                  { lengthFactor: 0.4, markers: true },
                ]),
              ),
            }),
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

  for (const locale of options.configuredLocales) {
    await write(
      root,
      `i18n/shell/${locale}.yaml`,
      ['messages:', '  app-title: Locale set probe', ''].join('\n'),
    );
  }

  await write(
    root,
    'node_modules/@neolorn/atlas/index.d.ts',
    [
      'export declare function createPathPrefixLocalePolicy(',
      '  options: unknown,',
      '): unknown;',
      'export declare function createHostLocalePolicy(options: unknown): unknown;',
      '',
    ].join('\n'),
  );
  await write(
    root,
    'node_modules/@neolorn/atlas/package.json',
    `${JSON.stringify(
      { name: '@neolorn/atlas', version: '0.0.0', types: './index.d.ts' },
      null,
      2,
    )}\n`,
  );

  const factoryName =
    options.factory === 'host'
      ? 'createHostLocalePolicy'
      : 'createPathPrefixLocalePolicy';
  const tableKey = options.factory === 'host' ? 'origins' : 'locales';
  const entry = (locale: string): string =>
    options.factory === 'host'
      ? `    ${JSON.stringify(locale)}: 'https://${locale.toLowerCase()}.example',`
      : `    ${JSON.stringify(locale)}: '${locale.toLowerCase()}',`;

  const policy = (name: string, locales: readonly string[]): string[] => [
    `export const ${name} = ${factoryName}({`,
    `  defaultLocale: ${JSON.stringify(options.policyDefault ?? defaultLocale)},`,
    `  ${tableKey}: {`,
    ...locales.map(entry),
    '  },',
    '});',
  ];

  await write(
    root,
    'src/app.ts',
    [
      "import { messages } from '#i18n/shell';",
      ...(options.policyLocales === undefined || options.shadowed
        ? []
        : [`import { ${factoryName} } from '@neolorn/atlas';`]),
      '',
      ...(options.shadowed
        ? [
            `function ${factoryName}(options: unknown): unknown {`,
            '  return options;',
            '}',
            '',
          ]
        : []),
      'export const title = messages.appTitle.messageId;',
      '',
      ...(options.policyLocales === undefined
        ? []
        : policy('routePolicy', options.policyLocales)),
      ...(options.secondPolicy === undefined
        ? []
        : ['', ...policy('otherPolicy', options.secondPolicy)]),
      '',
    ].join('\n'),
  );

  return root;
}

async function codes(root: string, pseudo = false): Promise<readonly string[]> {
  const generated = await generateAtlasProject({
    project: root,
    pseudoLocales: pseudo,
  });
  return generated.diagnostics.map(({ code }) => code);
}

async function summaries(root: string): Promise<readonly string[]> {
  const generated = await generateAtlasProject({ project: root });
  return generated.diagnostics
    .filter(({ code }) => code === 'ATL1408')
    .map(({ summary }) => summary);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * The agreement rule cannot bind a locale whose existence is decided by the build.
 *
 * A pseudo-locale is generated only when the build asks for it, and the locale URL policy is a
 * source file that is the same in every build. Requiring the two to agree makes one of them wrong
 * in every build of the other kind, so a declared pseudo-locale is exempt in both directions.
 *
 * Both are checked against a build that asked for pseudo-locales and one that did not, because the
 * two exemptions fail in opposite builds: the forward one would fire when they are generated, and
 * the reverse one when they are not. A test that ran only one kind would pass with either exemption
 * missing.
 */
describe('a pseudo-locale is exempt from locale-set agreement', () => {
  it('does not require an address, in either kind of build', async () => {
    const root = await project({
      configuredLocales: ['en-US', 'ar-EG'],
      policyLocales: ['en-US', 'ar-EG'],
      pseudoLocales: ['en-Arab-XB'],
    });
    expect(await codes(root, true)).not.toContain('ATL1408');
    expect(await codes(root, false)).not.toContain('ATL1408');
  });

  it('may be given an address without failing the build that omits it', async () => {
    const root = await project({
      configuredLocales: ['en-US', 'ar-EG'],
      // The address is written once, in source. The catalog behind it exists only in the build
      // that asked for it, and that build is not the production one.
      policyLocales: ['en-US', 'ar-EG', 'en-Arab-XB'],
      pseudoLocales: ['en-Arab-XB'],
    });
    expect(await codes(root, true)).not.toContain('ATL1408');
    expect(await codes(root, false)).not.toContain('ATL1408');
  });

  it('still reports an ordinary locale that the exemption does not cover', async () => {
    // The control. Without it the two cases above pass for an exemption that silenced ATL1408
    // entirely, which is the cheapest wrong way to make them green.
    const root = await project({
      configuredLocales: ['en-US', 'ar-EG'],
      policyLocales: ['en-US', 'ar-EG', 'fr-FR'],
      pseudoLocales: ['en-Arab-XB'],
    });
    expect(await codes(root, true)).toContain('ATL1408');
    expect(await codes(root, false)).toContain('ATL1408');
  });
});

describe('the locale set an application states twice', () => {
  it('says nothing when the two agree', async () => {
    const root = await project({
      configuredLocales: ['en-US', 'ar-EG'],
      policyLocales: ['en-US', 'ar-EG'],
    });

    expect(await codes(root)).not.toContain('ATL1408');
  });

  it('reports a configured locale the policy gives no address', async () => {
    const root = await project({
      configuredLocales: ['en-US', 'ar-EG', 'fr-FR'],
      policyLocales: ['en-US', 'ar-EG'],
    });

    const reported = await summaries(root);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('"fr-FR"');
    expect(reported[0]).toContain('no address');
  });

  it('reports a policy locale the configuration gives no catalogs', async () => {
    const root = await project({
      configuredLocales: ['en-US', 'ar-EG'],
      policyLocales: ['en-US', 'ar-EG', 'fr-FR'],
    });

    const reported = await summaries(root);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('"fr-FR"');
    expect(reported[0]).toContain('no catalogs');
  });

  it('reports both directions at once when both are wrong', async () => {
    // Two independent mistakes, and reporting only the first would send someone round twice.
    const root = await project({
      configuredLocales: ['en-US', 'de-DE'],
      policyLocales: ['en-US', 'fr-FR'],
    });

    const reported = await summaries(root);
    expect(reported).toHaveLength(2);
    expect(reported.join('\n')).toContain('"de-DE"');
    expect(reported.join('\n')).toContain('"fr-FR"');
  });

  it('reports a default locale the two disagree on', async () => {
    const root = await project({
      configuredLocales: ['en-US', 'ar-EG'],
      configuredDefault: 'en-US',
      policyLocales: ['en-US', 'ar-EG'],
      policyDefault: 'ar-EG',
    });

    const reported = await summaries(root);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('"en-US"');
    expect(reported[0]).toContain('"ar-EG"');
  });

  it('blocks a gate rather than advising', async () => {
    // Neither direction has a legitimate form and both are silent at runtime, so this is an error.
    // An advisory here would be a finding that ships.
    //
    // Asserted through `atlasDiagnosticsBlock`, which is what actually decides a gate's exit code,
    // and on the severity it reads, not on the result's `ok`, which reports whether the compile
    // produced output rather than whether the gate passes. `diagnostics.ts` records the bug that
    // came from testing anything other than severity here.
    const root = await project({
      configuredLocales: ['en-US', 'fr-FR'],
      policyLocales: ['en-US'],
    });

    const generated = await generateAtlasProject({ project: root });
    const reported = generated.diagnostics.filter(
      ({ code }) => code === 'ATL1408',
    );

    expect(reported.map(({ severity }) => severity)).toEqual(['error']);
    expect(atlasDiagnosticsBlock(generated.diagnostics)).toBe(true);
  });

  it('is reported by bare check too, because that is what a gate runs', async () => {
    const root = await project({
      configuredLocales: ['en-US', 'fr-FR'],
      policyLocales: ['en-US'],
    });

    const checked = await checkAtlasProject({ project: root });

    expect(checked.diagnostics.map(({ code }) => code)).toContain('ATL1408');
  });

  it('reads the host policy, which states the same set under another key', async () => {
    // Keyed on the factory rather than on the field name, so a policy that spells its table
    // `origins` is covered the same way. Written because a check that only understood one factory
    // would report nothing at all for an application using the other, which reads as agreement.
    const root = await project({
      configuredLocales: ['en-US', 'ar-EG'],
      policyLocales: ['en-US'],
      factory: 'host',
    });

    const reported = await summaries(root);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('"ar-EG"');
  });

  it('says which policy it checked when an owner builds more than one', async () => {
    const root = await project({
      configuredLocales: ['en-US'],
      policyLocales: ['en-US'],
      secondPolicy: ['en-US', 'fr-FR'],
    });

    const reported = await summaries(root);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('more than one locale URL policy');
  });

  it('declares nothing from a consumer function of the same name', async () => {
    // The negative control. Recognition resolves the symbol and requires its declaration to come
    // from inside the Atlas package, so a local function called `createPathPrefixLocalePolicy`
    // configures nothing, and this test going green while the others pass is what separates
    // "resolves the symbol" from "matches the name".
    const root = await project({
      configuredLocales: ['en-US', 'ar-EG'],
      policyLocales: ['en-US'],
      shadowed: true,
    });

    expect(await codes(root)).not.toContain('ATL1408');
  });

  it('says nothing about an owner that builds no policy', async () => {
    const root = await project({ configuredLocales: ['en-US', 'ar-EG'] });

    expect(await codes(root)).not.toContain('ATL1408');
  });
});
