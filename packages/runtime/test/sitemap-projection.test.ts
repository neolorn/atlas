/**
 * The file set a deployment publishes, and the two limits it splits on.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 11 leaves delivery to the application,
 * because a published URL is composed from six values the application only holds when it runs.
 * What Atlas produces is the complete set with each file's name, contents, kind, count and
 * size, and the split is on the count and the byte size together: with an alternate cluster in
 * every entry the size limit arrives first, so a split that counted only URLs would write a
 * file no crawler reads.
 */

import { describe, expect, it } from 'vitest';

import {
  createHostLocalePolicy,
  createIdentifierParameterCodec,
  createLocaleNeutralPolicy,
  createPathPrefixLocalePolicy,
  projectRouteSeo,
  projectSitemap,
  resolveLocalizedRoute,
  type GeneratedConfiguration,
  type GeneratedRouteProjectionEntry,
  type LocaleUrlPolicy,
  type RouteRuntimeProjection,
  type SitemapDocument,
  type SitemapRouteDeclaration,
} from '@neolorn/atlas/core';

/**
 * What a build publishes to a crawler as a file, from the projection it publishes in a head.
 *
 * The claim these cases exist to hold is that there is one derivation and not two. Every alternate
 * in a sitemap entry comes from `projectRouteSeo`, so the day the alternate rules change the
 * sitemap changes with them and no assertion has to remember that it should. The first group below
 * asserts that agreement directly, by reading both and comparing, rather than by writing the
 * expected set twice.
 *
 * The rest are the rules a sitemap has that a head does not: one host per file, both size limits,
 * an index when either is passed, and the two optional claims a route may make.
 */

const POLICY: LocaleUrlPolicy = createPathPrefixLocalePolicy({
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg', 'de-DE': 'de' },
  xDefaultPath: '/',
});

function projectionWith(
  routes: readonly GeneratedRouteProjectionEntry[],
): RouteRuntimeProjection {
  return {
    generated: {
      profile: 'atlas-route-projection/1',
      identity: 'sha256-AtlasSitemapProjectionTestIdentity012345678',
      routes,
    },
    // Only where the table has the route to localize. The many-route projections below are the
    // same shape without it.
    ...(routes.some(({ id }) => id === 'route:second')
      ? {
          localizedPaths: {
            'route:second': {
              'en-US': 'second',
              'ar-EG': 'الثاني',
              'de-DE': 'zweite',
            },
          },
        }
      : {}),
  };
}

const PROJECTION = projectionWith([
  { id: 'route:_index', path: '', parameterNames: [] },
  { id: 'route:second', path: 'second', parameterNames: [] },
  {
    id: 'route:account',
    path: 'account',
    parameterNames: [],
    indexing: 'private',
  },
]);

const CONFIGURATION: GeneratedConfiguration = {
  generatedAbi: 'atlas-generated/1',
  sourceLocale: 'en-US',
  defaultLocale: 'en-US',
  locales: ['en-US', 'ar-EG'],
  aliases: {},
  applicationContractFingerprint: 'sha256-application-contract-fixture',
  semanticRegistryFingerprint: 'sha256-semantic-registry-fixture',
  scopes: [],
};

const ORIGIN = 'https://atlas.example';

function sitemap(
  routes: readonly { readonly routeId: string }[],
  overrides: {
    readonly projection?: RouteRuntimeProjection;
    readonly policy?: LocaleUrlPolicy;
    readonly origin?: string;
    readonly baseHref?: string;
  } = {},
) {
  return projectSitemap({
    policy: overrides.policy ?? POLICY,
    projection: overrides.projection ?? PROJECTION,
    configuration: CONFIGURATION,
    origin: overrides.origin ?? ORIGIN,
    routes,
    ...(overrides.baseHref === undefined
      ? {}
      : { baseHref: overrides.baseHref }),
  });
}

const locations = (contents: string): string[] =>
  [...contents.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(([, url]) => url ?? '');

const links = (contents: string): string[] =>
  [
    ...contents.matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)"/gu),
  ].map(([, value]) => value ?? '');

describe('the sitemap and the head are one projection', () => {
  it('carries exactly the alternates the head carries, for the same page', () => {
    const resolution = resolveLocalizedRoute(
      '/en-us/second',
      POLICY,
      PROJECTION,
    );
    expect(resolution.status).toBe('success');
    if (resolution.status !== 'success') return;
    const head = projectRouteSeo(
      resolution,
      POLICY,
      PROJECTION,
      CONFIGURATION,
      ORIGIN,
    );

    const [file] = sitemap([{ routeId: 'route:second' }]);
    expect(file).toBeDefined();
    if (file === undefined) return;

    // Read out of the emitted XML rather than out of the value that produced it, so this compares
    // the document a crawler receives against the head a reader receives.
    const emitted = [
      ...[...file.contents.matchAll(/hreflang="([^"]+)" href="([^"]+)"/gu)].map(
        ([, hreflang, url]) => `${hreflang ?? ''} ${url ?? ''}`,
      ),
    ];
    const expected = [
      ...head.alternates.map(({ hreflang, url }) => `${hreflang} ${url}`),
      `x-default ${head.xDefault ?? ''}`,
    ];
    // Two entries, one per locale, each carrying the whole reciprocal cluster.
    expect(emitted).toEqual([...expected, ...expected]);
  });

  it('publishes one entry per locale, and each entry names itself', () => {
    const [file] = sitemap([{ routeId: 'route:second' }]);
    expect(locations(file?.contents ?? '')).toEqual([
      'https://atlas.example/en-us/second',
      'https://atlas.example/ar-eg/%D8%A7%D9%84%D8%AB%D8%A7%D9%86%D9%8A',
    ]);
    // Google requires the cluster to list every version including the page's own, which is the
    // same rule the head follows, so the count is locales squared plus one x-default each.
    expect(links(file?.contents ?? '')).toEqual([
      'en-US',
      'ar-EG',
      'x-default',
      'en-US',
      'ar-EG',
      'x-default',
    ]);
  });

  it('leaves out a locale the policy addresses and the build did not generate', () => {
    // `de-DE` has a prefix and no catalog. It is neither a `loc` nor an alternate, which is the
    // build filter reaching the sitemap because the sitemap does not apply its own.
    const [file] = sitemap([{ routeId: 'route:second' }]);
    expect(file?.contents).not.toContain('/de/');
  });

  it('publishes nothing for a route a crawler may not see', () => {
    const [file] = sitemap([{ routeId: 'route:account' }]);
    expect(file?.urls).toBe(0);
    expect(locations(file?.contents ?? '')).toEqual([]);
  });
});

describe('what a route claims about itself', () => {
  const claiming = projectionWith([
    { id: 'route:_index', path: '', parameterNames: [] },
    {
      id: 'route:second',
      path: 'second',
      parameterNames: [],
      sitemap: { changefreq: 'weekly', priority: 0.8, lastmod: '2026-09-01' },
    },
  ]);

  it('writes the three optional elements in the order the schema fixes', () => {
    const [file] = sitemap([{ routeId: 'route:second' }], {
      projection: claiming,
    });
    // `tUrl` is an `xsd:sequence`. Priority before changefreq is not a style difference, it is an
    // invalid document, and the schema case in the sibling file is what proves that claim.
    expect(file?.contents).toContain(
      [
        '    <lastmod>2026-09-01</lastmod>',
        '    <changefreq>weekly</changefreq>',
        '    <priority>0.8</priority>',
      ].join('\n'),
    );
  });

  it('writes a plain decimal, because a schema refuses an exponent', () => {
    const tiny = projectionWith([
      {
        id: 'route:second',
        path: 'second',
        parameterNames: [],
        sitemap: { priority: 0.0000001 },
      },
    ]);
    // `String(0.0000001)` is `1e-7`, which is a number and not an `xsd:decimal`.
    const [file] = sitemap([{ routeId: 'route:second' }], { projection: tiny });
    expect(file?.contents).toContain('<priority>0.0</priority>');
  });

  it('refuses a priority outside the range rather than writing it', () => {
    const wrong = projectionWith([
      {
        id: 'route:second',
        path: 'second',
        parameterNames: [],
        sitemap: { priority: 1.5 },
      },
    ]);
    expect(() =>
      sitemap([{ routeId: 'route:second' }], { projection: wrong }),
    ).toThrow(/between 0 and 1/u);
  });

  it('refuses a lastmod that is not a W3C date rather than writing it', () => {
    const wrong = projectionWith([
      {
        id: 'route:second',
        path: 'second',
        parameterNames: [],
        sitemap: { lastmod: 'last Tuesday' },
      },
    ]);
    expect(() =>
      sitemap([{ routeId: 'route:second' }], { projection: wrong }),
    ).toThrow(/W3C date/u);
  });

  it('publishes a route that claims nothing, with its address and its alternates', () => {
    const [file] = sitemap([{ routeId: 'route:second' }]);
    expect(file?.contents).not.toContain('<changefreq>');
    expect(file?.contents).not.toContain('<priority>');
    expect(file?.urls).toBe(2);
  });
});

describe('one file, one host', () => {
  it('publishes only the pages on the origin it was given, and points at the rest', () => {
    const hosts = createHostLocalePolicy({
      defaultLocale: 'en-US',
      origins: {
        'en-US': 'https://en.atlas.example',
        'ar-EG': 'https://ar.atlas.example',
      },
    });
    const [file] = sitemap([{ routeId: 'route:second' }], {
      policy: hosts,
      origin: 'https://en.atlas.example',
    });
    // The protocol requires every URL in one file to be on one host, and this policy puts each
    // locale on its own. So a host lists its own pages and names the others as alternates, which
    // is what an alternate is for, and a three-host deployment calls this three times.
    expect(locations(file?.contents ?? '')).toEqual([
      'https://en.atlas.example/second',
    ]);
    // The Arabic alternate is on the other host and spelled in Arabic, because a `locale-host`
    // policy changes the origin and the projection still changes the path.
    expect(file?.contents).toContain(
      'href="https://ar.atlas.example/%D8%A7%D9%84%D8%AB%D8%A7%D9%86%D9%8A"',
    );
  });

  it('publishes one URL where one address serves every locale', () => {
    const neutral = createLocaleNeutralPolicy({
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
    });
    // `route:_index` has no localized path, so under this policy every locale genuinely arrives at
    // one address. Listing it per locale would claim one page twice.
    const [file] = sitemap([{ routeId: 'route:_index' }], { policy: neutral });
    expect(locations(file?.contents ?? '')).toEqual(['https://atlas.example/']);
  });

  it('publishes both where the same policy gives each locale its own path', () => {
    const neutral = createLocaleNeutralPolicy({
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
    });
    // The same policy, a route the projection spells differently per locale. Two addresses, each
    // resolving to its own locale, so both are pages and both are published. The pair is the
    // point: one policy kind gives two answers, which is why the address is asked rather than the
    // policy read.
    const [file] = sitemap([{ routeId: 'route:second' }], { policy: neutral });
    expect(locations(file?.contents ?? '')).toEqual([
      'https://atlas.example/second',
      'https://atlas.example/%D8%A7%D9%84%D8%AB%D8%A7%D9%86%D9%8A',
    ]);
  });

  it('mounts every URL under the sub-path the application is served from', () => {
    const [file] = sitemap([{ routeId: 'route:second' }], { baseHref: '/app' });
    expect(locations(file?.contents ?? '')[0]).toBe(
      'https://atlas.example/app/en-us/second',
    );
  });
});

describe('splitting', () => {
  /**
   * A site the size the protocol is written around: one route and a record per page.
   *
   * Fifty thousand declared routes is not what a large site is. It is one parameterised route and
   * fifty thousand rows, which is also the shape `localizedServerRoutes` already takes values in,
   * so the same array feeds both.
   */
  function catalogue(
    pages: number,
    locales: Readonly<Record<string, string>>,
  ): {
    readonly projection: RouteRuntimeProjection;
    readonly policy: LocaleUrlPolicy;
    readonly routes: readonly SitemapRouteDeclaration[];
  } {
    const projection: RouteRuntimeProjection = {
      generated: {
        profile: 'atlas-route-projection/1',
        identity: 'sha256-AtlasSitemapProjectionTestIdentity012345678',
        routes: [
          {
            id: 'route:article',
            path: 'articles/:slug',
            parameterNames: ['slug'],
          },
        ],
      },
      parameters: {
        'route:article': { slug: createIdentifierParameterCodec() },
      },
    };
    const values: Readonly<Record<string, unknown>>[] = [];
    for (let index = 0; index < pages; index += 1) {
      values.push({ slug: `atlas-handbook-chapter-${index}` });
    }
    return {
      projection,
      policy: createPathPrefixLocalePolicy({ defaultLocale: 'en-US', locales }),
      routes: [{ routeId: 'route:article', prerender: values }],
    };
  }

  const TWO_LOCALES = { 'en-US': 'en-us', 'ar-EG': 'ar-eg' } as const;

  /** Ten locales, so each entry carries ten reciprocal links and passes a kilobyte. */
  const TEN_LOCALES = {
    'en-US': 'en-us',
    'en-GB': 'en-gb',
    'en-AU': 'en-au',
    'en-CA': 'en-ca',
    'en-IE': 'en-ie',
    'en-NZ': 'en-nz',
    'en-SG': 'en-sg',
    'en-ZA': 'en-za',
    'en-IN': 'en-in',
    'en-PH': 'en-ph',
  } as const;

  function build(
    pages: number,
    locales: Readonly<Record<string, string>>,
  ): readonly SitemapDocument[] {
    const set = catalogue(pages, locales);
    return projectSitemap({
      policy: set.policy,
      projection: set.projection,
      configuration: {
        ...CONFIGURATION,
        locales: Object.keys(locales),
      },
      origin: ORIGIN,
      routes: set.routes,
    });
  }

  it('writes one file, named as asked, while both limits hold', () => {
    const files = sitemap([{ routeId: 'route:second' }]);
    expect(files.map(({ name, kind }) => `${name} ${kind}`)).toEqual([
      'sitemap.xml urlset',
    ]);
  });

  it('splits on the URL count, and indexes the parts', () => {
    // 30,000 pages in two locales is 60,000 URLs in entries small enough that the byte budget is
    // nowhere near reached, so the cut here is the count and nothing else.
    const files = build(30_000, TWO_LOCALES);
    const parts = files.filter(({ kind }) => kind === 'urlset');
    const index = files.filter(({ kind }) => kind === 'index');

    expect(parts).toHaveLength(2);
    expect(index).toHaveLength(1);
    expect(parts.map(({ urls }) => urls)).toEqual([50_000, 10_000]);
    expect(parts[0]?.bytes).toBeLessThan(52_428_800);
  });

  it('splits on bytes while the URL count still holds', () => {
    // 4,500 pages in ten locales is 45,000 URLs, under the count, in entries carrying ten
    // reciprocal links each. A split that counted only URLs would write all of this as one file
    // and that file would be over 50 MB, which is the case this exists for.
    const files = build(4_500, TEN_LOCALES);
    const parts = files.filter(({ kind }) => kind === 'urlset');

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.reduce((total, part) => total + part.urls, 0)).toBe(45_000);
    for (const part of parts) {
      expect(part.urls).toBeLessThan(50_000);
      expect(part.bytes).toBeLessThanOrEqual(52_428_800);
    }
    expect(
      parts.reduce((total, part) => total + part.bytes, 0),
    ).toBeGreaterThan(52_428_800);
  });

  it('keeps the published name and turns it into the index', () => {
    const files = build(30_000, TWO_LOCALES);
    const index = files.find(({ kind }) => kind === 'index');
    // The address in `robots.txt` does not change when a site grows past a limit, which is the
    // whole reason the index takes the name rather than the first part.
    expect(index?.name).toBe('sitemap.xml');
    expect(
      files.filter(({ kind }) => kind === 'urlset').map(({ name }) => name),
    ).toEqual(['sitemap-1.xml', 'sitemap-2.xml']);
    expect(index?.contents).toContain(
      '<loc>https://atlas.example/sitemap-1.xml</loc>',
    );
    expect(index?.urls).toBe(2);
  });
});
