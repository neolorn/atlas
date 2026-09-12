import { describe, expect, it } from 'vitest';

import {
  buildLocalizedRoute,
  createHostLocalePolicy,
  createIdentifierParameterCodec,
  createLocaleNeutralPolicy,
  createPathPrefixLocalePolicy,
  localizedServerRoutes,
  resolveLocalizedRoute,
  toExternalPath,
  toInternalPath,
  type GeneratedConfiguration,
  type LocaleUrlPolicy,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

/**
 * An address is built without asking whether it can be resolved.
 *
 * A policy claims the first segment of an address before any route does. A locale prefix names the
 * locale and is removed, an older alias of one redirects, a locale-neutral root is answered by
 * nothing; only if the segment is none of those does it belong to a route. So a route whose own
 * leading segment spells one of them is not a route at a free address. It is an address this
 * library reads as a locale, and the route behind it is unreachable at the address it declared.
 *
 * Atlas built such addresses and handed them out: `buildLocalizedRoute` returned `/ar-eg` for a
 * route its own resolver answered not-found for, and `localizedServerRoutes` scheduled a rendered
 * file there. That is the same class of defect as a codec that cannot parse its own serialization,
 * one layer up, and it gets the same answer: what Atlas writes, Atlas reads back.
 *
 * The property asserted here is that one sentence and not a list of cases: **for every route, in
 * every locale, under every policy, either the address is refused or the resolver answers it.**
 * The refusal in the source is O(1) and derived from what the resolver does with a leading
 * segment; this suite is what pins the derivation to the resolver itself, by running the real
 * resolver over every address the builder emits. If the two ever disagree, the disagreement is a
 * failure here rather than a page that 404s in production.
 */

const IDENTITY = 'sha256-AtlasRouteProjectionTestIdentity0123456789_';

/**
 * Ordinary routes and colliding ones in one projection, which is the point of the fixture.
 *
 * A fixture holding only the colliding route cannot tell "the address was refused" from "the route
 * was never there". Every assertion below therefore names the ordinary routes as well, and the
 * exhaustive property runs over all of them at once.
 */
const PROJECTION: RouteRuntimeProjection = {
  generated: {
    profile: 'atlas-route-projection/1',
    identity: IDENTITY,
    routes: [
      { id: 'route:_index', path: '', parameterNames: [] },
      { id: 'tools', path: 'tools', parameterNames: [] },
      { id: 'article', path: 'articles/:slug', parameterNames: ['slug'] },
      // The three collisions, one per kind of claim.
      { id: 'prefix-trap', path: 'ar-eg/tools', parameterNames: [] },
      { id: 'root-trap', path: 'ar-eg', parameterNames: [] },
      { id: 'alias-trap', path: 'ara/help', parameterNames: [] },
      { id: 'neutral-trap', path: 'assets/logo', parameterNames: [] },
      // A leading segment no build can read, because its spelling is a value.
      { id: 'page', path: ':slug', parameterNames: ['slug'] },
    ],
  },
  parameters: {
    article: { slug: createIdentifierParameterCodec() },
    page: { slug: createIdentifierParameterCodec() },
  },
};

/** Only the routes an application would call ordinary, which every assertion must leave alone. */
const ORDINARY = ['route:_index', 'tools', 'article'] as const;

/**
 * The same projection with the colliding routes removed, and a localized spelling on top.
 *
 * The symmetric pair is a property of a projection a build accepted. A projection carrying a
 * collision has no default-locale address for that route, so there is no internal address for the
 * pair to be symmetric about, which is the defect, not a counterexample to the pair. The
 * collisions are asserted above; this is where symmetry is asserted, over more than one route so
 * that a pair which merely agrees on one cannot pass.
 */
const VALID: RouteRuntimeProjection = {
  generated: {
    profile: 'atlas-route-projection/1',
    identity: IDENTITY,
    routes: PROJECTION.generated.routes.filter(({ id }) =>
      [...ORDINARY, 'page'].includes(id),
    ),
  },
  localizedPaths: {
    tools: { 'en-US': 'tools', 'ar-EG': 'أدوات' },
    article: { 'en-US': 'articles/:slug', 'ar-EG': 'مقالات/:slug' },
  },
  ...(PROJECTION.parameters === undefined
    ? {}
    : { parameters: PROJECTION.parameters }),
};

const PARAMETERS: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
  {
    article: { slug: 'a-slug' },
    page: { slug: 'about' },
  };

const PREFIX_OPTIONS = {
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
  aliases: { ara: 'ar-EG' },
  localeNeutralRoots: ['assets'],
} as const;

const PREFIXED = createPathPrefixLocalePolicy(PREFIX_OPTIONS);
const OMITTING = createPathPrefixLocalePolicy({
  ...PREFIX_OPTIONS,
  omitDefaultPrefix: true,
});
const NEUTRAL = createLocaleNeutralPolicy({
  defaultLocale: 'en-US',
  locales: ['en-US', 'ar-EG'],
  localeNeutralRoots: ['assets'],
});
const HOST = createHostLocalePolicy({
  defaultLocale: 'en-US',
  origins: {
    'en-US': 'https://example.com',
    'ar-EG': 'https://example.eg',
  },
  localeNeutralRoots: ['assets'],
});

const POLICIES: readonly (readonly [string, LocaleUrlPolicy])[] = [
  ['prefixed', PREFIXED],
  ['omitting the default prefix', OMITTING],
  ['locale-neutral', NEUTRAL],
  ['locale-host', HOST],
];

const CONFIGURATION: GeneratedConfiguration = {
  generatedAbi: 'atlas-generated/1',
  sourceLocale: 'en-US',
  defaultLocale: 'en-US',
  locales: ['en-US', 'ar-EG'],
  aliases: {},
  applicationContractFingerprint: 'sha256-unresolvable-address-contract',
  semanticRegistryFingerprint: 'sha256-unresolvable-address-registry',
  scopes: [],
};

function build(
  policy: LocaleUrlPolicy,
  routeId: string,
  locale: string,
  parameters: Readonly<Record<string, unknown>> = PARAMETERS[routeId] ?? {},
  projection: RouteRuntimeProjection = PROJECTION,
): { readonly address: string } | { readonly refused: string } {
  try {
    return {
      address: buildLocalizedRoute(
        policy,
        projection,
        routeId as never,
        locale,
        parameters as never,
      ),
    };
  } catch (error) {
    return { refused: (error as Error).message };
  }
}

/** The path part of an address, which is all a path-prefix resolver is given. */
function pathOf(address: string): string {
  return address.startsWith('http') ? new URL(address).pathname : address;
}

describe('every address Atlas emits, Atlas resolves', () => {
  /**
   * The whole item in one assertion, run over every route, locale and policy.
   *
   * This is the check that cannot drift. The refusal in `buildLocalizedRoute` is a single lookup
   * on one segment, derived by reading what the resolver does with a leading segment; here the
   * actual resolver decides. A refusal the resolver would have answered is over-strict and fails
   * the second half; an address the resolver cannot answer fails the first.
   */
  it('refuses the address or resolves it, for every route in every locale', () => {
    const refused: string[] = [];
    for (const [label, policy] of POLICIES) {
      const locales =
        policy.kind === 'locale-neutral'
          ? [policy.defaultLocale]
          : Object.keys(policy.locales);
      for (const locale of locales) {
        for (const route of PROJECTION.generated.routes) {
          const outcome = build(policy, route.id, locale);
          if ('refused' in outcome) {
            refused.push(`${label} ${locale} ${route.id}`);
            continue;
          }
          const resolution = resolveLocalizedRoute(
            pathOf(outcome.address),
            policy,
            PROJECTION,
          );
          expect(
            `${label} ${locale} ${route.id} ${outcome.address} -> ${resolution.status}`,
          ).toBe(
            `${label} ${locale} ${route.id} ${outcome.address} -> success`,
          );
        }
      }
    }
    // The control on the whole property: it is satisfiable by refusing everything, and this says
    // that is not what happened. Every ordinary route was built and answered in every locale.
    expect(
      refused.filter((entry) => ORDINARY.some((id) => entry.endsWith(id))),
    ).toEqual([]);
    expect(refused.length).toBeGreaterThan(0);
  });

  it('names the route, the segment and what claimed it', () => {
    const outcome = build(OMITTING, 'root-trap', 'en-US');
    expect(outcome).toHaveProperty('refused');
    const message = (outcome as { readonly refused: string }).refused;
    expect(message).toContain('root-trap');
    expect(message).toContain('"ar-eg"');
    expect(message).toContain('locale prefix');
  });

  it('distinguishes an alias and a locale-neutral root from a prefix', () => {
    expect(
      (build(OMITTING, 'alias-trap', 'en-US') as { readonly refused: string })
        .refused,
    ).toContain('locale alias');
    expect(
      (build(OMITTING, 'neutral-trap', 'en-US') as { readonly refused: string })
        .refused,
    ).toContain('locale-neutral root');
  });

  /**
   * The case only a running application can see.
   *
   * A build reads route paths and can refuse a literal leading segment. It cannot read a slug that
   * has not been fetched yet, so a parameter that serializes to a locale prefix is the runtime's
   * to catch, and the same route with an ordinary value is the control that says the refusal is
   * about the value rather than about the route.
   */
  it('refuses a parameter value that spells a claimed segment, and only that value', () => {
    expect(build(OMITTING, 'page', 'en-US', { slug: 'about' })).toEqual({
      address: '/about',
    });
    expect(build(OMITTING, 'page', 'en-US', { slug: 'ar-eg' })).toHaveProperty(
      'refused',
    );
  });

  /**
   * The resolver corrects the case of a prefix and of an alias, and compares a neutral root
   * exactly. The refusal has to make the same three distinctions or it is a second, different rule
   * wearing the same name.
   */
  it('matches case the way the resolver matches it', () => {
    // A route path cannot carry an upper-case segment, the projection validator already refuses
    // one as an unsafe presentation path, so the case rule is reachable only through a parameter
    // value, which is where it is exercised.
    const attempt = (slug: string): string | undefined => {
      const outcome = build(OMITTING, 'page', 'en-US', { slug });
      return 'refused' in outcome ? outcome.refused : undefined;
    };
    // Refused: the resolver corrects the case of a prefix, so `/AR-EG` redirects rather than
    // reaching this page.
    expect(attempt('AR-EG')).toContain('locale prefix');
    // Not refused: the resolver compares a locale-neutral root exactly, so `/ASSETS` is this page.
    expect(attempt('ASSETS')).toBeUndefined();
    expect(resolveLocalizedRoute('/ASSETS', OMITTING, PROJECTION).status).toBe(
      'success',
    );
    // And the exact spelling of that same root is refused, which is what says the pair of
    // assertions above is about case rather than about the segment being unknown.
    expect(attempt('assets')).toContain('locale-neutral root');
  });

  /**
   * The address a build writes to disk, rather than one a link produces.
   *
   * `localizedServerRoutes` assembles its paths itself instead of calling `buildLocalizedRoute`,
   * so the refusal has to be stated there too, and this is the entry that turns into a rendered
   * file, which is the worst place for an address nothing can reach.
   */
  it('refuses to schedule a rendered file at an address it cannot resolve', () => {
    const schedule = (
      policy: LocaleUrlPolicy,
      ids: readonly string[],
    ): string | undefined => {
      try {
        localizedServerRoutes(
          policy,
          PROJECTION,
          CONFIGURATION,
          ids.map((routeId) => ({ routeId: routeId as never, renderMode: 1 })),
          { canonicalRenderMode: 2 },
        );
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(schedule(OMITTING, ORDINARY)).toBeUndefined();
    expect(schedule(OMITTING, ['root-trap'])).toContain('root-trap');
    // Under full prefixing every localized entry carries a prefix, but the canonical layer does
    // not, so the same projection is still refused, by the second pass rather than the first.
    expect(schedule(PREFIXED, ['prefix-trap'])).toContain('prefix-trap');
    // And with the ordinary routes declared alongside it, which is the case that got through: the
    // trap's canonical path is `ar-eg/tools`, which is also `tools`'s ar-EG address, so the second
    // pass had already seen it and skipped the route before asking anything about it. A run with
    // the colliding route alone could not have caught that.
    expect(schedule(PREFIXED, [...ORDINARY, 'prefix-trap'])).toContain(
      'prefix-trap',
    );
  });

  /**
   * The symmetric pair, over the whole projection rather than over one route.
   *
   * `toInternalPath` and `toExternalPath` are one rule read in two directions, and a single route
   * cannot tell a working pair from a pair that happens to agree on it. Both directions are
   * asserted for every route the projection holds, in every locale the policy addresses, anchored
   * on addresses the builder actually produced.
   */
  it('round-trips every route in every locale, both directions', () => {
    let checked = 0;
    for (const [label, policy] of [
      ['prefixed', PREFIXED],
      ['omitting the default prefix', OMITTING],
    ] as const) {
      const context = { policy, projection: VALID };
      for (const locale of Object.keys(policy.locales)) {
        for (const route of VALID.generated.routes) {
          const outcome = build(policy, route.id, locale, undefined, VALID);
          expect(outcome).toHaveProperty('address');
          if ('refused' in outcome) continue;
          const external = outcome.address;
          const internal = toInternalPath(external, context);
          expect(`${label} ${locale} ${route.id} out ${external}`).toBe(
            `${label} ${locale} ${route.id} out ${toExternalPath(internal, locale, context)}`,
          );
          expect(`${label} ${locale} ${route.id} in ${internal}`).toBe(
            `${label} ${locale} ${route.id} in ${toInternalPath(toExternalPath(internal, locale, context), context)}`,
          );
          checked += 1;
        }
      }
    }
    // A round trip that ran over nothing is green for the wrong reason, so the count is asserted.
    expect(checked).toBeGreaterThanOrEqual(ORDINARY.length * 2 * 2);
  });
});
