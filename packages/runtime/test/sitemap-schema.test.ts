import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateXML } from 'xmllint-wasm';
import { describe, expect, it } from 'vitest';

import {
  createIdentifierParameterCodec,
  createPathPrefixLocalePolicy,
  projectSitemap,
  type GeneratedConfiguration,
  type RouteRuntimeProjection,
  type SitemapDocument,
} from '@neolorn/atlas/core';

/**
 * Every file Atlas writes, against the schemas the publishers ship for the format it claims.
 *
 * Not a round trip and not a shape assertion. A sitemap is read by software Atlas will never see,
 * and the only statement worth making about one is that the format's own schema accepts it. That is
 * what caught the ordering rule the emitter now follows: `tUrl` is an `xsd:sequence`, so an entry
 * that writes its alternates before its `priority` is well-formed, self-consistent, and invalid.
 *
 * The validator makes no network requests, for the reason the XLIFF gate beside it does not: a gate
 * that reaches the internet is a gate that fails when the internet does.
 *
 * **The shim is load-bearing and the last case here is why.** Both sitemap schemas close their
 * content models with a wildcard at `processContents="strict"`, which is the setting that demands a
 * declaration rather than tolerating an unknown element. The hreflang extension puts `xhtml:link`
 * in exactly that position, and it comes from a different publisher, so nothing in the sitemap
 * schemas declares it. `atlas-sitemap-hreflang.xsd` imports both namespaces into one schema set and
 * declares nothing itself.
 */
const schemaDirectory = fileURLToPath(
  new URL('../../../standards/data/sitemaps-0.9-schemas/', import.meta.url),
);
const xliffDirectory = fileURLToPath(
  new URL('../../../standards/data/xliff-2.2-cs01-schemas/', import.meta.url),
);
const SHIM = 'atlas-sitemap-hreflang.xsd';
const INDEX_SCHEMA = 'siteindex.xsd';

const preload = [
  ...readdirSync(schemaDirectory)
    .filter((name) => name.endsWith('.xsd'))
    .map((name) => ({
      fileName: name,
      contents: readFileSync(`${schemaDirectory}${name}`, 'utf8'),
    })),
  // `xhtml1-strict.xsd` imports the W3C XML namespace schema, which is vendored once beside the
  // XLIFF schemas. One copy, two schema sets, one digest in the lock.
  {
    fileName: 'xml.xsd',
    contents: readFileSync(`${xliffDirectory}xml.xsd`, 'utf8'),
  },
];

async function schemaErrors(
  document: string,
  schema: string,
): Promise<readonly string[]> {
  const result = await validateXML({
    xml: [{ fileName: 'atlas-sitemap.xml', contents: document }],
    schema: [
      {
        fileName: schema,
        contents: readFileSync(`${schemaDirectory}${schema}`, 'utf8'),
      },
    ],
    preload,
    // The same `--path .` the XLIFF gate passes, and for the same reason: libxml2 retries the last
    // segment of an import URL it could not open against the working directory, which is where
    // every preloaded schema is. Without it `xhtml1-strict.xsd` cannot resolve `xml.xsd` and the
    // schema does not compile at all, which reads like a schema defect rather than a missing file.
    modifyArguments: (args) => ['--path', '.', ...args],
  });
  return result.errors.map(
    (error) => `line ${error.loc?.lineNumber ?? '?'}: ${error.message}`,
  );
}

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

const POLICY = createPathPrefixLocalePolicy({
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
  xDefaultPath: '/',
});

/**
 * One projection carrying the three shapes an entry can take: a plain page, a page whose path is
 * spelled in another script, and a parameterised page.
 */
const PROJECTION: RouteRuntimeProjection = {
  generated: {
    profile: 'atlas-route-projection/1',
    identity: 'sha256-AtlasSitemapSchemaTestProjectionIdentity012',
    routes: [
      { id: 'route:_index', path: '', parameterNames: [] },
      {
        id: 'route:second',
        path: 'second',
        parameterNames: [],
        sitemap: {
          changefreq: 'weekly',
          priority: 0.8,
          lastmod: '2026-09-01T17:33:30+03:00',
        },
      },
      {
        id: 'route:article',
        path: 'articles/:slug',
        parameterNames: ['slug'],
        sitemap: { changefreq: 'never', priority: 0 },
      },
    ],
  },
  localizedPaths: {
    'route:second': { 'en-US': 'second', 'ar-EG': 'الثاني' },
  },
  parameters: { 'route:article': { slug: createIdentifierParameterCodec() } },
};

function build(pages = 1): readonly SitemapDocument[] {
  const values: Readonly<Record<string, unknown>>[] = [];
  for (let index = 0; index < pages; index += 1) {
    values.push({ slug: `atlas-handbook-${index}` });
  }
  return projectSitemap({
    policy: POLICY,
    projection: PROJECTION,
    configuration: CONFIGURATION,
    origin: 'https://atlas.example',
    routes: [
      { routeId: 'route:_index' },
      { routeId: 'route:second' },
      { routeId: 'route:article', prerender: values },
    ],
  });
}

describe('the documents Atlas writes', () => {
  it('validates against the sitemap schema with the hreflang extension imported', async () => {
    const [file] = build();
    expect(file).toBeDefined();
    if (file === undefined) return;
    // The entry carries all three optional elements, alternates in two locales, an `x-default`,
    // and a percent-encoded non-ASCII address, so one pass covers every shape the emitter has a
    // branch for.
    expect(file.contents).toContain('<changefreq>weekly</changefreq>');
    expect(file.contents).toContain('hreflang="x-default"');
    expect(file.contents).toContain('%D8%A7%D9%84%D8%AB%D8%A7%D9%86%D9%8A');
    await expect(schemaErrors(file.contents, SHIM)).resolves.toEqual([]);
  });

  it('validates an index and its parts against the sitemap index schema', async () => {
    // 25,001 articles plus the two parameterless routes, all in two locales, is 50,006 URLs. Six
    // past the count, so the set really splits and the tail is small enough to read.
    const files = build(25_001);
    const index = files.find(({ kind }) => kind === 'index');
    const last = files.filter(({ kind }) => kind === 'urlset').at(-1);
    expect(index?.urls).toBe(2);
    expect(last?.urls).toBe(6);
    if (index === undefined || last === undefined) return;

    // An index goes through `siteindex.xsd` directly rather than through the shim. It carries no
    // foreign element, and it could not go through the shim anyway: the two sitemap schemas share
    // a target namespace, so a second import of that namespace is skipped.
    await expect(schemaErrors(index.contents, INDEX_SCHEMA)).resolves.toEqual(
      [],
    );
    // The tail part rather than the 50,000-entry one. Both are written by the same line and the
    // shapes an entry can take are covered above; what is new here is that a part of a split set
    // is a valid document in its own right.
    await expect(schemaErrors(last.contents, SHIM)).resolves.toEqual([]);
  });

  /**
   * The failing half, run rather than reasoned.
   *
   * With the shim's imports out of the picture, the same bytes that just validated are refused,
   * and the message names the mechanism. That is what makes the fourth file in the standards
   * directory a dependency rather than a convenience.
   */
  it('is refused by the sitemap schema alone, which is why the shim exists', async () => {
    const [file] = build();
    expect(file).toBeDefined();
    if (file === undefined) return;
    const errors = await schemaErrors(file.contents, 'sitemap.xsd');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain(
      "Element '{http://www.w3.org/1999/xhtml}link': No matching global element declaration available, but demanded by the strict wildcard.",
    );
  });
});
