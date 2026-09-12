/**
 * The policy says where a locale lives; the build says which locales there are.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 3 intersects the two once, into a value,
 * because the places that turn a policy into an address are not enumerable in advance: the
 * server route table, the alternate cluster, request resolution and the client route table each
 * do it, and one added later has to inherit the narrowing rather than repeat it.
 *
 * The eligibility rule is here too, and it is one observation rather than a property of the
 * policy kind: arriving at an address with nothing said about preference has to yield the locale
 * the address is advertised for. That subsumes counting duplicate addresses, which dropped a
 * true address because another locale shared it and kept a unique address that redirects.
 */

import { describe, expect, it } from 'vitest';

import {
  addressSelectsLocale,
  allowedLocaleHosts,
  buildLocalizedRoute,
  builtLocalePolicy,
  createHostLocalePolicy,
  createLocaleNeutralPolicy,
  createPathPrefixLocalePolicy,
  defineRouteProjection,
  localizedServerRoutes,
  openGraphAlternates,
  projectRouteSeo,
  resolveLocalizedRoute,
  type GeneratedConfiguration,
  type LocaleUrlPolicy,
  type PathPrefixLocalePolicy,
  type RouteParameterCodec,
  type RouteParameterContext,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

/**
 * The policy declares intent; the build decides what exists.
 *
 * A locale URL policy is one source file, the same in every build, and it says where a locale
 * lives *if this build has it*. What a build actually generated catalogs for is in the generated
 * configuration, and that varies: a development locale exists only in a build that asked for it,
 * and an ordinary locale exists only once someone has configured it.
 *
 * Atlas turns the policy into published addresses in four places: the server route table, where
 * each address becomes a prerendered file or a server route; the SEO projection, where each becomes
 * an `hreflang` claim that the same page exists in another language; route resolution, which
 * decides whether an address arriving at the server means anything; and the client route table.
 * Each reading the policy alone gives a locale named there and never built a file written for it,
 * a link advertising it, and a 200 when someone follows either.
 *
 * The first two filter as they publish and are covered by the first group below. The other two
 * cannot, because they answer rather than emit, so they take the policy already narrowed:
 * `builtLocalePolicy`, covered by the second group. The split is not cosmetic: it is why the third
 * and fourth are easy to miss while the first two look right, and why the narrowed policy is a
 * value that a site added later inherits rather than a filter it has to remember.
 *
 * Every case below is paired with its opposite. "No address for an unbuilt locale" passes just as
 * well for a function that emits nothing at all, so each absence is asserted beside the presence
 * that the same call produces when the build does have the locale.
 */

const POLICY: LocaleUrlPolicy = {
  kind: 'path-prefix',
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg', 'de-DE': 'de' },
  prefixes: { 'en-us': 'en-US', 'ar-eg': 'ar-EG', de: 'de-DE' },
  aliases: {},
  localeNeutralRoots: [],
  omitDefaultPrefix: false,
};

const PROJECTION: RouteRuntimeProjection = {
  generated: {
    profile: 'atlas-route-projection/1',
    identity: 'sha256-AtlasBuiltLocaleAddressesTestIdentity012345',
    routes: [
      { id: 'route:_index', path: '', parameterNames: [] },
      { id: 'route:second', path: 'second', parameterNames: [] },
    ],
  },
  localizedPaths: {
    'route:second': { 'en-US': 'second', 'ar-EG': 'الثاني', 'de-DE': 'zweite' },
  },
};

/**
 * A generated configuration carrying one locale set.
 *
 * The fingerprints are stated rather than computed. Nothing under test reads them, and a value
 * derived here from the same data the assertion checks would agree with itself by construction.
 */
function configurationFor(locales: readonly string[]): GeneratedConfiguration {
  return {
    generatedAbi: 'atlas-generated/1',
    sourceLocale: 'en-US',
    defaultLocale: 'en-US',
    locales,
    aliases: {},
    applicationContractFingerprint: 'sha256-application-contract-fixture',
    semanticRegistryFingerprint: 'sha256-semantic-registry-fixture',
    scopes: [],
  };
}

const SHIPPED = configurationFor(['en-US', 'ar-EG']);
const WITH_GERMAN = configurationFor(['en-US', 'ar-EG', 'de-DE']);

const paths = (configuration: GeneratedConfiguration): string[] =>
  localizedServerRoutes(
    POLICY,
    PROJECTION,
    configuration,
    [{ routeId: 'route:second', renderMode: 'prerender' }],
    { canonicalRenderMode: 'server' },
  ).map(({ path }) => path);

describe('the addresses a build publishes', () => {
  it('emits one per locale the build has, and none for a locale it does not', () => {
    // `de-DE` has a prefix in the policy and no catalog in this build. The German entries are
    // absent and the other two are present, from one call, so this is the filter working rather
    // than a table that failed to build.
    expect(paths(SHIPPED)).toEqual(['en-us/second', 'ar-eg/الثاني', 'second']);

    // The same policy, the same declaration, a build that generated German. The address the
    // assertion above proved absent is the third entry here, spelled through the projection.
    expect(paths(WITH_GERMAN)).toEqual([
      'en-us/second',
      'ar-eg/الثاني',
      'de/zweite',
      'second',
    ]);
  });

  it('refuses a configuration that does not contain the policy default locale', () => {
    // The one mismatch this call can see from inside itself. Left unreported it produces a table
    // with no addresses for the locale the application falls back to, which reads as a build that
    // rendered nothing rather than as the two arguments disagreeing.
    expect(() => paths(configurationFor(['ar-EG']))).toThrow(/default locale/u);
  });

  it('claims an alternate only for a locale that exists', () => {
    const resolution = resolveLocalizedRoute(
      '/en-us/second',
      POLICY,
      PROJECTION,
    );
    expect(resolution.status).toBe('success');
    if (resolution.status !== 'success') return;

    const hreflangs = (configuration: GeneratedConfiguration): string[] =>
      projectRouteSeo(
        resolution,
        POLICY,
        PROJECTION,
        configuration,
        'https://atlas.example',
      ).alternates.map(({ locale }) => locale);

    // An `hreflang` is a public claim that this page exists in another language. Made for a locale
    // with no catalog it is false, and the crawler that follows it is redirected back to this one.
    expect(hreflangs(SHIPPED)).toEqual(['en-US', 'ar-EG']);
    expect(hreflangs(WITH_GERMAN)).toEqual(['en-US', 'ar-EG', 'de-DE']);
  });

  it('keeps a page out of its own social alternates, where `hreflang` keeps it in', () => {
    // The assertion above is the reciprocal rule: `/en-us/second` names `en-US` among its own
    // alternates, because that set answers which addresses serve this page. Open Graph asks the
    // opposite question, which *other* languages this page exists in, and reads the same set.
    // So the divergence is a property of the two formats, and it is asserted here rather than
    // only described, because a self-listing alternate does not fail, warn, or render differently.
    //
    // Three locales rather than two. With two, "every sibling" and "the other one" produce the
    // same list, and an implementation that dropped the first entry, took only the last, or
    // reversed the set would pass every assertion that could be written.
    const social = (path: string, locale: string): readonly string[] => {
      const resolution = resolveLocalizedRoute(path, POLICY, PROJECTION);
      expect(resolution.status).toBe('success');
      if (resolution.status !== 'success') return [];
      const seo = projectRouteSeo(
        resolution,
        POLICY,
        PROJECTION,
        WITH_GERMAN,
        'https://atlas.example',
      );
      // Fed the cluster Atlas actually projects, not an alternates array written in this file,
      // and that cluster does contain this page's own locale, which is the thing being excluded.
      expect(seo.alternates.map(({ hreflang }) => hreflang)).toContain(locale);
      return openGraphAlternates(locale, seo.alternates);
    };

    expect(social('/en-us/second', 'en-US')).toEqual(['ar_EG', 'de_DE']);
    // Percent-encoded, because the raw form is not this address's canonical spelling: Atlas
    // answers it with a 308 to the encoded one, which is a `redirect` and carries no SEO
    // projection at all.
    expect(social(`/ar-eg/${encodeURIComponent('الثاني')}`, 'ar-EG')).toEqual([
      'en_US',
      'de_DE',
    ]);
    expect(social('/de/zweite', 'de-DE')).toEqual(['en_US', 'ar_EG']);
  });
});

describe('the policy a build can actually serve', () => {
  const SHIPPED_POLICY = builtLocalePolicy(POLICY, SHIPPED);
  const GERMAN_POLICY = builtLocalePolicy(POLICY, WITH_GERMAN);

  /** A resolution reduced to the one string worth asserting on. */
  const outcome = (
    policy: LocaleUrlPolicy,
    target: string,
    locale?: string,
  ): string => {
    const resolution = resolveLocalizedRoute(
      target,
      policy,
      PROJECTION,
      locale === undefined ? {} : { locale },
    );
    return resolution.status === 'redirect'
      ? `redirect ${resolution.location}`
      : resolution.status;
  };

  it('stops resolving a prefix whose locale the build does not have', () => {
    // What the declared policy answers today: a 200 for a locale with no catalog. Markup labelled
    // German, English text inside it, and a crawler told both.
    expect(outcome(POLICY, '/de/zweite')).toBe('success');

    // Narrowed, the segment is a locale identity this application does not serve, which is the
    // answer Atlas already had for one and is a 404 rather than a redirect home. A bookmark to a
    // page that genuinely no longer exists should say so; sending it to the home page in another
    // language claims the content moved.
    expect(outcome(SHIPPED_POLICY, '/de/zweite')).toBe('unsupported-locale');

    // Two controls, because "resolves nothing" would satisfy the line above just as well. A locale
    // this build has still resolves under the same narrowed policy, and German resolves again the
    // moment a build has German.
    // Percent-encoded, because that is the canonical spelling of this address and the literal
    // form answers with a 308 to it. The point here is the locale, not the encoding.
    expect(
      outcome(SHIPPED_POLICY, '/ar-eg/%D8%A7%D9%84%D8%AB%D8%A7%D9%86%D9%8A'),
    ).toBe('success');
    expect(outcome(GERMAN_POLICY, '/de/zweite')).toBe('success');
  });

  it('ignores a remembered preference for a locale the build does not have', () => {
    // A visitor whose stored preference says `de-DE` is sent to an address with nothing behind it.
    expect(outcome(POLICY, '/', 'de-DE')).toBe('redirect /de');

    // Narrowed, it is simply an unsupported preference, and an unsupported preference falls back to
    // the default rather than failing: the home page is valid whatever the visitor prefers, and
    // answering 404 there because a cookie was unusable is the worse failure by a wide margin.
    expect(outcome(SHIPPED_POLICY, '/', 'de-DE')).toBe('redirect /en-us');

    // Controls on both sides of the same call again.
    expect(outcome(SHIPPED_POLICY, '/', 'ar-EG')).toBe('redirect /ar-eg');
    expect(outcome(GERMAN_POLICY, '/', 'de-DE')).toBe('redirect /de');
  });

  it('drops the locale from every table of the policy at once', () => {
    const aliased = builtLocalePolicy(
      {
        ...(POLICY as PathPrefixLocalePolicy),
        aliases: { deutsch: 'de-DE', english: 'en-US' },
      },
      SHIPPED,
    );

    // Three tables, one locale. Leaving `prefixes` behind would leave `/de` matching with no locale
    // to serve it; leaving `aliases` behind would leave a redirect aimed at a locale that no longer
    // resolves. `english` is the control: an alias for a built locale survives.
    expect(Object.keys(aliased.locales)).toEqual(['en-US', 'ar-EG']);
    expect(Object.keys(aliased.prefixes)).toEqual(['en-us', 'ar-eg']);
    expect(Object.keys(aliased.aliases)).toEqual(['english']);
  });

  it('refuses to narrow away the locale everything falls back to', () => {
    // The same guard the publishing side has, reached from the other direction. Narrowing a policy
    // until its default locale is gone leaves an application with nowhere to send anything.
    expect(() =>
      builtLocalePolicy(POLICY, configurationFor(['ar-EG'])),
    ).toThrow(/default locale/u);
  });
});

/**
 * The one registration Atlas cannot check, derived so it does not have to be maintained.
 *
 * `@angular/ssr` refuses an unrecognised `Host` with `400` before the application runs, so a
 * host policy has to tell the server the same domains it told the policy. A build cannot reach
 * the server configuration, so there is no mismatch to refuse the way
 * `provideLocalizedRouter`'s `origin` is refused: what is left is to make the second list a
 * derivation of the first.
 *
 * It is here rather than beside the address translation because it is the same question this
 * file exists for: **the policy declares, and the build decides.** A locale narrowed out of the
 * policy must be narrowed out of this too, or a build that carries no Arabic still admits
 * requests at the Arabic domain and answers them in English at that domain's addresses.
 */
describe('the hostnames a policy admits', () => {
  const HOST_POLICY = createHostLocalePolicy({
    defaultLocale: 'en-US',
    origins: {
      'en-US': 'https://example.com',
      'ar-EG': 'https://example.eg:8443',
      'de-DE': 'https://example.de',
    },
  });

  it('names each origin by hostname, which is what allowedHosts compares', () => {
    // Hostnames, not origins and not hosts. `@angular/ssr` parses the `Host` header and
    // compares its `hostname`, so a scheme would never match and a port would never match,
    // and the Arabic origin carries one, which is why it is written with one here.
    expect(allowedLocaleHosts(HOST_POLICY)).toEqual([
      'example.com',
      'example.eg',
      'example.de',
    ]);
  });

  it('narrows with the build, so an unbuilt domain is not admitted', () => {
    // The same filter as every other table. A build with no German catalog answers nothing in
    // German, so admitting requests at the German domain would mean serving English there:
    // at addresses the German policy spelled, under a domain that says it is German.
    expect(allowedLocaleHosts(builtLocalePolicy(HOST_POLICY, SHIPPED))).toEqual(
      ['example.com', 'example.eg'],
    );
  });

  it('is empty for a policy that serves one origin', () => {
    // Not an omission. A path-prefix or locale-neutral application has one origin, which the
    // server already knows about, so there is nothing to add, and the consumer writes the
    // same line whichever policy they end up with.
    expect(allowedLocaleHosts(POLICY)).toEqual([]);
    expect(allowedLocaleHosts(builtLocalePolicy(POLICY, SHIPPED))).toEqual([]);
  });
});

/**
 * An address is advertised for a locale only when arriving at it, with nothing said about
 * preference, yields that locale.
 *
 * An `hreflang` link is a claim made to a crawler, and a crawler is precisely the visitor that
 * states no preference: Google Search Central says Googlebot "sends HTTP requests without setting
 * `Accept-Language`". The claim is therefore true exactly when the address on its own decides the
 * locale, which is a property of the address and not of the policy it was built under.
 *
 * **That distinction is why this is not written per policy kind, and one policy here gives three
 * different answers.** Under `locale-neutral`: a route every locale spells alike is negotiated, so
 * only the locale it is negotiated to is served there; a route with a localized *path* is a real
 * per-locale address and is advertised; and a route whose *slug* is spelled per locale answers a
 * `308` back to the default spelling, because a parameter codec's `parse` maps both spellings to one
 * entity and reports no locale for the canonicalizer to keep. A rule written on the policy kind
 * would have to give all three the same answer.
 *
 * The prefix and host blocks below are the controls, on the same projection and the same routes.
 * There the prefix or the origin is the locale, every address passes, and nothing changes, which
 * is what a rule about addresses rather than about policies is supposed to look like.
 */
describe('the addresses a page may be advertised at', () => {
  const SLUG: RouteParameterCodec<string> = Object.freeze({
    parse: (slug: string) =>
      Object.freeze(
        slug === 'atlas-handbook' || slug === 'دليل-أطلس'
          ? { ok: true, value: 'atlas-handbook' }
          : { ok: false },
      ),
    serialize: (entityId: string, context?: RouteParameterContext) =>
      entityId !== 'atlas-handbook'
        ? undefined
        : context?.locale === 'ar-EG'
          ? 'دليل-أطلس'
          : 'atlas-handbook',
  });

  /** Three routes that differ only in how much of the locale their address carries. */
  const SHAPES = defineRouteProjection({
    generated: Object.freeze({
      profile: 'atlas-route-projection/1',
      identity: 'sha256-AtlasAddressSelectsLocaleTestIdentity012345',
      routes: Object.freeze([
        Object.freeze({
          id: 'alike',
          path: 'second',
          parameterNames: Object.freeze([]),
          indexing: 'indexable',
        }),
        Object.freeze({
          id: 'spelled',
          path: 'third',
          parameterNames: Object.freeze([]),
          indexing: 'indexable',
        }),
        Object.freeze({
          id: 'article',
          path: 'articles/:slug',
          parameterNames: Object.freeze(['slug']),
          indexing: 'indexable',
        }),
      ]),
    } as const),
    parameters: Object.freeze({ article: Object.freeze({ slug: SLUG }) }),
    localizedPaths: Object.freeze({
      spelled: Object.freeze({ 'ar-EG': 'الثالث' }),
    }),
  });

  /** The route ids this projection declares, which is what `buildLocalizedRoute` will accept. */
  type Shape = 'alike' | 'spelled' | 'article';

  const LOCALES = ['en-US', 'ar-EG', 'de-DE'];

  const NEUTRAL = createLocaleNeutralPolicy({
    defaultLocale: 'en-US',
    locales: LOCALES,
  });

  const PREFIXED = createPathPrefixLocalePolicy({
    defaultLocale: 'en-US',
    locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg', 'de-DE': 'de' },
  });

  const HOSTED = createHostLocalePolicy({
    defaultLocale: 'en-US',
    origins: {
      'en-US': 'https://atlas.example',
      'ar-EG': 'https://ar.atlas.example',
      'de-DE': 'https://de.atlas.example',
    },
  });

  /** The English address of a route, which is where a reader of it starts. */
  const from = (
    policy: LocaleUrlPolicy,
    routeId: Shape,
    parameters?: Readonly<Record<string, unknown>>,
  ): string =>
    buildLocalizedRoute(policy, SHAPES, routeId, 'en-US', parameters);

  const hreflangs = (
    policy: LocaleUrlPolicy,
    routeId: Shape,
    parameters?: Readonly<Record<string, unknown>>,
  ): readonly string[] => {
    const address = from(policy, routeId, parameters);
    const resolution = resolveLocalizedRoute(address, policy, SHAPES);
    if (resolution.status !== 'success') {
      throw new Error(address + ' resolved ' + resolution.status);
    }
    return projectRouteSeo(
      resolution,
      policy,
      SHAPES,
      WITH_GERMAN,
      'https://atlas.example',
    ).alternates.map(({ locale }) => locale);
  };

  it('names only the locale a shared address is negotiated to', () => {
    // One address for three locales. Whoever arrives gets what their preference says, and a
    // crawler has none, so the only locale this URL can be claimed to serve is the default.
    expect(hreflangs(NEUTRAL, 'alike')).toEqual(['en-US']);
  });

  it('names a locale whose own spelling reaches it, and not one that shares another', () => {
    // `ar-EG` has its own path here and is advertised. `de-DE` does not, so its address is the
    // English one, and the English one is `en-US`. The old duplicate filter dropped both of those,
    // including the true `en-US` entry, because it counted URLs instead of asking.
    expect(hreflangs(NEUTRAL, 'spelled')).toEqual(['en-US', 'ar-EG']);
  });

  it('drops an address that answers a redirect rather than the page', () => {
    const arabic = buildLocalizedRoute(NEUTRAL, SHAPES, 'article', 'ar-EG', {
      slug: 'atlas-handbook',
    });
    // Measured rather than assumed, because the whole entry turns on it: the Arabic spelling is a
    // real, unique URL that a filter counting duplicates keeps, and it is a 308 to the English one.
    expect(resolveLocalizedRoute(arabic, NEUTRAL, SHAPES)).toMatchObject({
      status: 'redirect',
      httpStatus: 308,
      location: from(NEUTRAL, 'article', { slug: 'atlas-handbook' }),
    });
    expect(addressSelectsLocale(arabic, 'ar-EG', NEUTRAL, SHAPES)).toBe(false);

    expect(hreflangs(NEUTRAL, 'article', { slug: 'atlas-handbook' })).toEqual([
      'en-US',
    ]);
  });

  it('keeps every address where the prefix is the locale', () => {
    // The control. The same three routes, the same projection, one policy changed, and the two
    // absences above become presences, so neither is a function that returns a short list.
    expect(hreflangs(PREFIXED, 'alike')).toEqual(LOCALES);
    expect(hreflangs(PREFIXED, 'spelled')).toEqual(LOCALES);
    expect(hreflangs(PREFIXED, 'article', { slug: 'atlas-handbook' })).toEqual(
      LOCALES,
    );
  });

  it('keeps every address where the origin is the locale', () => {
    // The second control, and the one that would have caught a rule applied to absolute URLs by
    // pattern: these addresses are cross-origin, and the resolver reads the locale off the origin.
    expect(hreflangs(HOSTED, 'alike')).toEqual(LOCALES);
    expect(hreflangs(HOSTED, 'spelled')).toEqual(LOCALES);
    expect(hreflangs(HOSTED, 'article', { slug: 'atlas-handbook' })).toEqual(
      LOCALES,
    );
  });
});

/**
 * What the head says when the application is not at the root of its site.
 *
 * A deployment at `https://example.com/app` declares that once, to Angular, and the runtime reads
 * the declaration to take the prefix off every address it is handed. The head is the other
 * direction of the same fact: a canonical or `hreflang` URL is the origin, the mount point, and the
 * address the policy spells from the application's own root. Leave the middle one out and the head
 * advertises `https://example.com/ar-eg/second`, not this page, and possibly not this
 * application, since whatever else the site serves at that path is not something Atlas placed.
 *
 * **The three policy kinds are here because the two shapes of address are.** Under `path-prefix`
 * and `locale-neutral` an address is a path, and the origin comes from the configured one. Under
 * `locale-host` `buildLocalizedRoute` has already produced an absolute URL on another locale's
 * origin, and a mount point applies to that origin too: a build served under `/app` serves every
 * one of its locale domains under `/app`. A composition written for paths alone would silently
 * drop the base for exactly the policy whose URLs are hardest to check by eye.
 *
 * The root-mounted assertions are the control and they are exact strings, not a shape: the whole
 * claim about this change is that a deployment at the root produces what it always produced.
 */
describe('the head of a page served under a sub-path', () => {
  const SIMPLE = defineRouteProjection({
    generated: Object.freeze({
      profile: 'atlas-route-projection/1',
      identity: 'sha256-AtlasMountedHeadProjectionTestIdentity01234',
      routes: Object.freeze([
        Object.freeze({
          id: 'second',
          path: 'second',
          parameterNames: Object.freeze([]),
          indexing: 'indexable',
        }),
      ]),
    } as const),
  });

  const BUILT = configurationFor(['en-US', 'ar-EG']);

  const PREFIX = createPathPrefixLocalePolicy({
    defaultLocale: 'en-US',
    locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
    xDefaultPath: '/',
  });

  const HOSTS = createHostLocalePolicy({
    defaultLocale: 'en-US',
    origins: {
      'en-US': 'https://atlas.example',
      'ar-EG': 'https://ar.atlas.example',
    },
  });

  /** The head for the Arabic address of one route, under whatever policy and mount point. */
  const head = (policy: LocaleUrlPolicy, baseHref: string) => {
    const address = buildLocalizedRoute(policy, SIMPLE, 'second', 'ar-EG');
    const resolution = resolveLocalizedRoute(address, policy, SIMPLE);
    if (resolution.status !== 'success') {
      throw new Error(address + ' resolved ' + resolution.status);
    }
    return projectRouteSeo(
      resolution,
      policy,
      SIMPLE,
      BUILT,
      'https://atlas.example',
      undefined,
      undefined,
      baseHref,
    );
  };

  it('puts the mount point between the origin and the address', () => {
    const seo = head(PREFIX, '/app');

    expect(seo.canonical).toBe('https://atlas.example/app/ar-eg/second');
    expect(seo.alternates.map(({ url }) => url)).toEqual([
      'https://atlas.example/app/en-us/second',
      'https://atlas.example/app/ar-eg/second',
    ]);
    // The fallback a crawler is sent to when no alternate fits is an address in this application
    // like any other, so it is mounted like any other. Advertising `/` here would point at the
    // site's root, which under a sub-path deployment is not this application at all.
    expect(seo.xDefault).toBe('https://atlas.example/app/');
  });

  it('leaves the same page alone when it is mounted at the root', () => {
    // The control, written as the strings themselves. `''` is what an application with no
    // `<base href>` and no `APP_BASE_HREF` resolves to, which is nearly every application.
    const seo = head(PREFIX, '');

    expect(seo.canonical).toBe('https://atlas.example/ar-eg/second');
    expect(seo.alternates.map(({ url }) => url)).toEqual([
      'https://atlas.example/en-us/second',
      'https://atlas.example/ar-eg/second',
    ]);
    expect(seo.xDefault).toBe('https://atlas.example/');
  });

  it('reads a mount point in every spelling a base href arrives in', () => {
    // Four ways of declaring one deployment, and the head cannot tell them apart. The absolute one
    // is the reason this matters: on a server `getBaseHrefFromDOM()` returns the `<base>`
    // attribute unresolved, so a document that writes an absolute base href hands one straight
    // through. Measured on `@angular/platform-server` 22.1.3, not inferred from the browser.
    for (const spelling of [
      '/app',
      '/app/',
      'https://atlas.example/app/',
      '/app/index.html',
    ]) {
      expect(head(PREFIX, spelling).canonical).toBe(
        'https://atlas.example/app/ar-eg/second',
      );
    }
    // And three spellings of no mount point at all, which must not become one.
    for (const spelling of ['', '/', 'https://atlas.example']) {
      expect(head(PREFIX, spelling).canonical).toBe(
        'https://atlas.example/ar-eg/second',
      );
    }
  });

  it('mounts a host policy on the origin the locale lives at, not on the configured one', () => {
    // The case a path-shaped composition would lose. These URLs are absolute before the mount
    // point is applied, and each one belongs to a different domain: the base goes onto the path of
    // whichever origin the address already names, and the Arabic domain keeps being the Arabic
    // domain.
    const seo = head(HOSTS, '/app');

    expect(seo.canonical).toBe('https://ar.atlas.example/app/second');
    expect(seo.alternates.map(({ url }) => url)).toEqual([
      'https://atlas.example/app/second',
      'https://ar.atlas.example/app/second',
    ]);
  });
});
