import { describe, expect, it } from 'vitest';

import {
  buildLocalizedRoute,
  createLocalizationContext,
  createDefaultLocalePrefixPolicy,
  createHostLocalePolicy,
  createLocaleNeutralPolicy,
  dynamicAssetParticipantReport,
  fixedLanguageAsset,
  localizedAsset,
  neutralAsset,
  projectRouteSeo,
  resolveLocalizedAsset,
  resolveLocalizedRoute,
  type DynamicAssetParticipantReportInput,
  type RouteRuntimeProjection,
} from '@neolorn/atlas';
import {
  createAtlasMigrationPlan,
  ATLAS_PSEUDO_LOCALE_EXPANDED,
  createAtlasPseudoCatalog,
  diffAtlasCatalogSets,
  exportAtlasXliff22,
  formatAtlasCatalog,
  importAtlasXliff22,
  parseAtlasCatalog,
  parseAtlasConfiguration,
  planAtlasMessageRefactor,
  type AtlasCatalog,
  type AtlasCatalogParseOptions,
} from '@neolorn/atlas-toolkit';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { families, messages, providerId, scopeId } from '#i18n/shell';

import {
  atlasRuntimeExtensions,
  skuFormatAdapter,
  skuParseAdapter,
} from './runtime-extensions';
import { appRouteProjection } from './localization.routes';

const localizedProjection: RouteRuntimeProjection = Object.freeze({
  ...appRouteProjection,
  localizedPaths: Object.freeze({
    'route:second': Object.freeze({
      'ar-EG': 'الثاني',
    }),
    article: Object.freeze({
      'ar-EG': 'مقالات/:slug',
    }),
  }),
});

describe('shared URL policies', () => {
  const locales = Object.freeze({
    'en-US': 'en-us',
    'ar-EG': 'ar-eg',
  });

  it('omits only the default-locale prefix and canonicalizes its old prefixed form', () => {
    const policy = createDefaultLocalePrefixPolicy({
      defaultLocale: 'en-US',
      locales,
    });
    expect(
      resolveLocalizedRoute('/second', policy, localizedProjection),
    ).toMatchObject({
      status: 'success',
      locale: 'en-US',
      canonicalPath: '/second',
    });
    expect(
      resolveLocalizedRoute('/en-us/second', policy, localizedProjection),
    ).toMatchObject({
      status: 'redirect',
      httpStatus: 308,
      location: '/second',
    });
    expect(
      buildLocalizedRoute(policy, localizedProjection, 'route:second', 'ar-EG'),
    ).toBe('/ar-eg/%D8%A7%D9%84%D8%AB%D8%A7%D9%86%D9%8A');
  });

  it('uses locale-neutral presentation paths with explicit locale context and truthful SEO', () => {
    const policy = createLocaleNeutralPolicy({
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
      xDefaultPath: '/',
    });
    const arabicPath = buildLocalizedRoute(
      policy,
      localizedProjection,
      'route:second',
      'ar-EG',
    );
    const resolution = resolveLocalizedRoute(
      arabicPath,
      policy,
      localizedProjection,
      { locale: 'ar-EG' },
    );
    expect(resolution).toMatchObject({
      status: 'success',
      locale: 'ar-EG',
      routeId: 'route:second',
    });
    if (resolution.status !== 'success') return;
    const seo = projectRouteSeo(
      resolution,
      policy,
      localizedProjection,
      configuration,
      'https://atlas.example',
    );
    expect(seo.alternates).toHaveLength(2);
    expect(seo.xDefault).toBe('https://atlas.example/');
  });

  it('maps locale-specific trusted origins without accepting request-controlled hosts', () => {
    const policy = createHostLocalePolicy({
      defaultLocale: 'en-US',
      origins: {
        'en-US': 'https://www.atlas.example',
        'ar-EG': 'https://ar.atlas.example',
      },
      xDefaultUrl: 'https://atlas.example',
    });
    const arabicUrl = buildLocalizedRoute(
      policy,
      localizedProjection,
      'article',
      'ar-EG',
      { slug: 'atlas-handbook' },
    );
    expect(arabicUrl).toBe(
      'https://ar.atlas.example/%D9%85%D9%82%D8%A7%D9%84%D8%A7%D8%AA/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
    );
    const resolution = resolveLocalizedRoute(
      arabicUrl,
      policy,
      localizedProjection,
    );
    expect(resolution).toMatchObject({
      status: 'success',
      locale: 'ar-EG',
      canonicalUrl: arabicUrl,
    });
    expect(
      resolveLocalizedRoute(
        'https://attacker.invalid/second',
        policy,
        localizedProjection,
      ),
    ).toMatchObject({ status: 'malformed', httpStatus: 400 });
    if (resolution.status !== 'success') return;
    const seo = projectRouteSeo(
      resolution,
      policy,
      localizedProjection,
      configuration,
      'https://ar.atlas.example',
    );
    expect(seo.alternates.map(({ url }) => url)).toEqual([
      'https://www.atlas.example/articles/atlas-handbook',
      arabicUrl,
    ]);
    expect(seo.xDefault).toBe('https://atlas.example');
  });
});

describe('application-local extensibility', () => {
  it('admits exact bindings and evaluates custom functions, slots, families, and adapters', async () => {
    const localization = createLocalizationContext({
      setup: {
        configuration,
        catalogSet,
        catalogLoaders,
        extensions: atlasRuntimeExtensions,
      },
      bootstrapScopes: [{ providerId, scopeId }],
    });
    await localization.initialize();

    expect(
      localization.text(messages.extension.uppercase, { name: 'Atlas' }),
    ).toBe('Custom function: ATLAS!');
    const badge = localization.parts(messages.extension.badge);
    expect(badge.text).toBe('Badge: New');
    expect(badge.value[0]).toMatchObject({
      kind: 'slot',
      slotKind: 'feature:badge',
      options: { tone: 'info' },
    });

    const ready = families.featureState.resolve({ state: 'ready' });
    if (ready === undefined)
      throw new Error('Generated family member is absent.');
    expect(localization.text(ready)).toBe('Feature state ready');
    expect(families.featureState.resolve({ state: 'future' })).toBeUndefined();
    expect(families.featureState.resolve({ state: 'READY' })).toBeUndefined();

    expect(
      localization.formatWithAdapter(skuFormatAdapter, 'atlas-42'),
    ).toMatchObject({
      ok: true,
      value: {
        semantic: 'extension',
        extensionId: 'feature:sku-format',
        text: 'SKU-ATLAS-42',
      },
    });
    expect(
      localization.parseWithAdapter(skuParseAdapter, 'sku-atlas-42'),
    ).toEqual({
      status: 'valid',
      text: 'sku-atlas-42',
      value: { value: 'ATLAS-42' },
    });
    localization.dispose();
  });

  it('fails runtime admission before evaluation when required bindings are absent', () => {
    expect(() =>
      createLocalizationContext({
        setup: {
          configuration,
          catalogSet,
          catalogLoaders,
        },
        bootstrapScopes: [{ providerId, scopeId }],
      }),
    ).toThrow(/Required runtime extension/u);
  });
});

describe('localized assets', () => {
  it('keeps neutral, localized, and authentic fixed-language representations explicit', async () => {
    const localization = createLocalizationContext({
      setup: {
        configuration,
        catalogSet,
        catalogLoaders,
        extensions: atlasRuntimeExtensions,
      },
      bootstrapScopes: [{ providerId, scopeId }],
    });
    await localization.initialize();
    await localization.changeLocale('ar-EG');
    const arabicAlt = localization.evaluateText(messages.asset.alt);

    const neutral = resolveLocalizedAsset(
      neutralAsset('asset.logo', { url: '/assets/logo.svg' }),
      { targetLocale: 'ar-EG', metadata: { alt: arabicAlt } },
    );
    expect(neutral).toMatchObject({
      status: 'ready',
      fallback: false,
      representation: {
        kind: 'language-independent',
        source: { url: '/assets/logo.svg' },
      },
      metadata: { alt: { supplyingLocale: 'ar-EG' } },
    });

    const cover = localizedAsset('asset.cover', [
      { locale: 'en-US', source: { url: '/assets/cover-en.webp' } },
      { locale: 'ar-EG', source: { url: '/assets/cover-ar.webp' } },
    ]);
    expect(
      resolveLocalizedAsset(cover, { targetLocale: 'ar-EG' }),
    ).toMatchObject({
      status: 'ready',
      fallback: false,
      representation: {
        kind: 'locale-bound',
        supplyingLocale: 'ar-EG',
        language: 'ar',
        direction: 'rtl',
      },
    });
    expect(
      resolveLocalizedAsset(cover, {
        targetLocale: 'fr-FR',
        fallbackLocales: ['en-US'],
      }),
    ).toMatchObject({
      status: 'ready',
      fallback: true,
      representation: { supplyingLocale: 'en-US' },
    });
    expect(
      resolveLocalizedAsset(cover, { targetLocale: 'fr-FR' }),
    ).toMatchObject({
      status: 'unavailable',
      outcome: 'localized-representation-unavailable',
    });

    const certificate = resolveLocalizedAsset(
      fixedLanguageAsset(
        'asset.certificate',
        { url: '/assets/certificate-en.pdf' },
        'en',
        'ltr',
      ),
      { targetLocale: 'ar-EG', metadata: { description: arabicAlt } },
    );
    expect(certificate).toMatchObject({
      status: 'ready',
      fallback: false,
      representation: { kind: 'fixed-language', language: 'en' },
      metadata: { description: { supplyingLocale: 'ar-EG' } },
    });
    localization.dispose();
  });

  it('exposes only safe dynamic participant metadata, never payload or URL state', () => {
    const input = {
      status: 'ready',
      assetId: 'asset.dynamic-cover',
      representationId: 'cover-ar',
      revision: 'r7',
      representation: {
        kind: 'locale-bound',
        supplyingLocale: 'ar-EG',
      },
      url: 'https://private.invalid/asset',
      payload: { secret: true },
    } satisfies DynamicAssetParticipantReportInput & {
      readonly url: string;
      readonly payload: unknown;
    };
    const report = dynamicAssetParticipantReport(input);
    expect(report).toMatchObject({
      status: 'ready',
      identity: {
        resourceId: 'asset.dynamic-cover',
        representationId: 'cover-ar',
        revision: 'r7',
      },
      representation: {
        kind: 'locale-bound',
        supplyingLocale: 'ar-EG',
        direction: 'rtl',
      },
    });
    expect(report).not.toHaveProperty('url');
    expect(report).not.toHaveProperty('payload');
    expect(JSON.stringify(report)).not.toContain('private.invalid');
  });
});

const configurationResult = parseAtlasConfiguration(
  JSON.stringify({
    schemaVersion: 1,
    sourceLocale: 'en-US',
    defaultLocale: 'en-US',
    locales: ['en-US', 'ar-EG'],
  }),
);
if (!configurationResult.ok)
  throw new Error('The fixture configuration is invalid.');
const phase5Configuration = configurationResult.value;

function phase5Catalog(
  source: string,
  options: AtlasCatalogParseOptions,
): AtlasCatalog {
  const parsed = parseAtlasCatalog(source, options);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.value;
}

const sourceOptions: AtlasCatalogParseOptions = {
  role: 'source',
  providerId: '@feature/phase-five',
  scopeId: 'shell',
  locale: 'en-US',
  sourcePath: 'i18n/shell/en-US.yaml',
};
const targetOptions: AtlasCatalogParseOptions = {
  ...sourceOptions,
  role: 'target',
  locale: 'ar-EG',
  sourcePath: 'i18n/shell/ar-EG.yaml',
};

describe('built-toolkit lifecycle', () => {
  it('round-trips XLIFF 2.2 and pseudo-localizes only human-language text', () => {
    const source = phase5Catalog(
      'messages:\n  greeting: "Hello {#strong}{$name}{/strong}."\n',
      sourceOptions,
    );
    const target = phase5Catalog(
      'messages:\n  greeting: "مرحبًا {#strong}{$name}{/strong}."\n',
      targetOptions,
    );
    const exported = exportAtlasXliff22({ source, target });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value).toContain('version="2.2"');
    const imported = importAtlasXliff22({
      document: exported.value,
      source,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(formatAtlasCatalog(imported.value)).toBe(formatAtlasCatalog(target));

    const pseudo = createAtlasPseudoCatalog(source, {
      locale: ATLAS_PSEUDO_LOCALE_EXPANDED,
      lengthFactor: 0.35,
      markers: true,
    });
    expect(pseudo.ok).toBe(true);
    if (!pseudo.ok) return;
    expect(
      (pseudo.value.messages['greeting'] as { message?: string }).message,
    ).toContain('{$name}');
    expect(
      (pseudo.value.messages['greeting'] as { message?: string }).message,
    ).toContain('⟦');
  });

  it('classifies semantic changes and previews checked refactor/migration transactions', () => {
    const beforeSource = phase5Catalog(
      'messages:\n  title: "Hello"\n  keep: "Keep"\n',
      sourceOptions,
    );
    const beforeTarget = phase5Catalog(
      'messages:\n  title: "مرحبًا"\n  keep: "أبقِ"\n',
      targetOptions,
    );
    const afterSource = phase5Catalog(
      'messages:\n  heading: "Welcome"\n  keep: "Changed"\n',
      sourceOptions,
    );
    const afterTarget = phase5Catalog(
      'messages:\n  heading: "مرحبًا"\n  keep: "أبقِ"\n',
      targetOptions,
    );
    const diff = diffAtlasCatalogSets({
      before: {
        configuration: phase5Configuration,
        catalogs: [beforeSource, beforeTarget],
      },
      after: {
        configuration: phase5Configuration,
        catalogs: [afterSource, afterTarget],
      },
      identityMoves: [
        {
          from: '@feature/phase-five:shell:title',
          to: '@feature/phase-five:shell:heading',
        },
      ],
    });
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.value.entries.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        'identity-contract-changed',
        'source-changed',
        'stale-source',
      ]),
    );

    const code = 'const title = messages.title;\n';
    const refactor = planAtlasMessageRefactor({
      from: {
        providerId: '@feature/phase-five',
        scopeId: 'shell',
        messageId: 'title',
      },
      to: {
        providerId: '@feature/phase-five',
        scopeId: 'shell',
        messageId: 'heading',
      },
      catalogs: [beforeSource, beforeTarget],
      analysis: {
        messageUsages: [
          {
            identity: '@feature/phase-five:shell:title',
            sourcePath: 'src/probe.ts',
            start: code.indexOf('messages'),
            end: code.indexOf('messages') + 'messages.title'.length,
            surface: 'typescript',
          },
        ],
      },
      sources: [{ path: 'src/probe.ts', contents: code }],
    });
    expect(refactor.ok).toBe(true);
    if (!refactor.ok) return;
    expect(refactor.value.affectedUsages).toBe(1);
    expect(
      refactor.value.changes.find(({ path }) => path === 'src/probe.ts')?.after,
    ).toBe('const title = messages.heading;\n');

    const migration = createAtlasMigrationPlan({
      id: 'phase-five-profile',
      domain: 'configuration',
      fromVersion: '1',
      toVersion: '1.1',
      changes: [
        {
          path: 'atlas.config.json',
          before: '{"schemaVersion":1}\n',
          after: '{"schemaVersion":1,"profile":"atlas-1"}\n',
        },
      ],
    });
    expect(migration.ok).toBe(true);
    if (!migration.ok) return;
    expect(migration.value).toMatchObject({
      kind: 'migration',
      id: 'configuration/1-to-1.1/phase-five-profile',
    });
    expect(migration.value.digest).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/u);
  });
});
