import { describe, expect, it } from 'vitest';

import {
  createHostLocalePolicy,
  createPathPrefixLocalePolicy,
  projectRouteSeo,
  resolveLocalizedRoute,
  validateRouteProjection,
  LocalizationError,
  type GeneratedConfiguration,
  type GeneratedRouteProjectionEntry,
  type RouteParameterCodec,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

/**
 * Every condition `validateRouteProjection` and `parseTarget` refuse input on, one case each.
 *
 * Both are a list of clauses, and everything downstream trusts whatever the list lets through. A
 * clause that no case names can be deleted with the suite still green, which is the same thing as
 * the clause not being there.
 *
 * One case per clause, because a fixture that trips several at once passes on whichever fires
 * first and says nothing about the rest.
 *
 * The last two blocks assert something narrower: that both call sites of a rule reach one
 * definition of it. The credential-free origin rule is read by `trustedOrigin` and by
 * `projectRouteSeo`, the x-default rule by `trustedXDefaultPath` and by
 * `createPathPrefixLocalePolicy`. Inline a second copy at either site and the matching case goes
 * red.
 */

const IDENTITY = 'sha256-AtlasRefusalsNothingWatchedTestIdentity0123';

const SLUG: RouteParameterCodec<string> = Object.freeze({
  parse: (value: string) => Object.freeze({ ok: true as const, value }),
  serialize: (value: string) => value,
});

const ROUTES: readonly GeneratedRouteProjectionEntry[] = Object.freeze([
  Object.freeze({ id: 'home', path: '', parameterNames: Object.freeze([]) }),
  Object.freeze({
    id: 'second',
    path: 'second',
    parameterNames: Object.freeze([]),
  }),
  Object.freeze({
    id: 'article',
    path: 'articles/:slug',
    parameterNames: Object.freeze(['slug']),
  }),
]);

interface Overrides {
  readonly profile?: string;
  readonly identity?: string;
  readonly routes?: readonly GeneratedRouteProjectionEntry[];
  readonly parameters?: RouteRuntimeProjection['parameters'];
  readonly localizedPaths?: RouteRuntimeProjection['localizedPaths'];
}

/**
 * A valid projection, with one thing about it changed.
 *
 * Built rather than edited because `RouteRuntimeProjection` is readonly all the way down, which is
 * the right shape for the type and means a fixture cannot be poked. Each case below names the one
 * field it invalidates, so a refusal is attributable to that field and to nothing else.
 */
const valid = (overrides: Overrides = {}): RouteRuntimeProjection => ({
  generated: {
    // Cast, and the cast is the point of the case. The type pins `profile` to one literal, so a
    // wrong profile cannot be written in TypeScript at all, and a projection reaches
    // `validateRouteProjection` from a generated file on disk, where no type held it. The runtime
    // check exists for exactly the value the compiler will not let this file name.
    profile: (overrides.profile ??
      'atlas-route-projection/1') as 'atlas-route-projection/1',
    identity: overrides.identity ?? IDENTITY,
    routes: overrides.routes ?? ROUTES,
  },
  parameters: overrides.parameters ?? { article: { slug: SLUG } },
  ...(overrides.localizedPaths === undefined
    ? {}
    : { localizedPaths: overrides.localizedPaths }),
});

/** The route list with one entry replaced, which is how a case invalidates a single route. */
const replacing = (
  index: number,
  entry: GeneratedRouteProjectionEntry,
): readonly GeneratedRouteProjectionEntry[] =>
  ROUTES.map((route, at) => (at === index ? entry : route));

/** The refusal message a call carries, or `undefined` when the call did not refuse. */
const refusal = (call: () => unknown): string | undefined => {
  try {
    call();
    return undefined;
  } catch (error) {
    if (error instanceof LocalizationError) return error.diagnostic.message;
    throw error;
  }
};

const validating = (overrides: Overrides = {}): string | undefined =>
  refusal(() => validateRouteProjection(valid(overrides)));

describe('what a generated route projection is refused for', () => {
  it('accepts the fixture every case below breaks, so a refusal names the break', () => {
    expect(validating()).toBeUndefined();
  });

  it('refuses a profile or an identity it did not write', () => {
    expect(validating({ profile: 'atlas-route-projection/2' })).toContain(
      'profile or identity',
    );
    // The identity is a sha256 in base64url and its length is the check: 43 characters after the
    // prefix and no other number. A different length is a different hash function, and a
    // projection hashed by something else is not one this build produced.
    for (const identity of [
      IDENTITY.slice(0, -1),
      `${IDENTITY}x`,
      IDENTITY.replace('sha256-', 'sha512-'),
      IDENTITY.replace('sha256-', ''),
      `${IDENTITY.slice(0, -1)}+`,
    ]) {
      expect(validating({ identity }), identity).toContain(
        'profile or identity',
      );
    }
  });

  it('refuses a route identity that is not one', () => {
    for (const id of [
      '',
      '-leading',
      '.leading',
      'has space',
      'has/slash',
      'x'.repeat(129),
    ]) {
      const routes = replacing(1, { id, path: 'second', parameterNames: [] });
      expect(validating({ routes }), id).toContain('is invalid');
    }
    // 128 characters is the bound and the bound is inclusive. A check written with the wrong
    // comparison passes every case above and fails only here.
    const routes = replacing(1, {
      id: `a${'b'.repeat(127)}`,
      path: 'second',
      parameterNames: [],
    });
    expect(validating({ routes })).toBeUndefined();
  });

  it('refuses two routes that share an identity, and two that share a path', () => {
    // Separately, because one condition catches both and a fixture that trips both cannot say the
    // second clause is there. A duplicate id means one route silently shadows another; a duplicate
    // path means two routes claim one address.
    const sameId = replacing(2, {
      id: 'second',
      path: 'third',
      parameterNames: [],
    });
    expect(validating({ routes: sameId })).toContain('unique');

    const samePath = replacing(2, {
      id: 'third',
      path: 'second',
      parameterNames: [],
    });
    expect(validating({ routes: samePath })).toContain('unique');
  });

  it('refuses a presentation path that is not a plain relative path', () => {
    for (const path of [
      '/leading',
      'trailing/',
      'double//slash',
      'Upper',
      'has space',
      '-leading-dash',
      'trailing-dash-',
      'x'.repeat(129),
    ]) {
      const routes = replacing(1, { id: 'second', path, parameterNames: [] });
      expect(validating({ routes }), path).toContain(
        'unsafe presentation path',
      );
    }
  });

  it('refuses a parameter segment that is not a valid parameter name', () => {
    for (const segment of [':', ':1st', ':has-dash', `:${'a'.repeat(65)}`]) {
      const routes = replacing(2, {
        id: 'article',
        path: `articles/${segment}`,
        parameterNames: [segment.slice(1)],
      });
      expect(validating({ routes }), segment).toBeDefined();
    }
  });

  it('refuses an indexing class it does not know', () => {
    for (const indexing of ['indexable', 'non-indexable', 'private'] as const) {
      const routes = replacing(1, {
        id: 'second',
        path: 'second',
        parameterNames: [],
        indexing,
      });
      expect(validating({ routes }), indexing).toBeUndefined();
    }
    const routes = replacing(1, {
      id: 'second',
      path: 'second',
      parameterNames: [],
      indexing: 'noindex' as 'private',
    });
    expect(validating({ routes })).toContain('invalid indexing class');
  });

  it('refuses a declared parameter list that disagrees with the path', () => {
    const parameters = {
      article: { slug: SLUG, page: SLUG, id: SLUG, extra: SLUG },
    };
    const cases: readonly (readonly [string, readonly string[]])[] = [
      // Named nothing, though the path takes one.
      ['articles/:slug', []],
      // Named one the path does not have.
      ['articles/:slug', ['slug', 'extra']],
      // Right count, wrong name: the case a length comparison alone lets through.
      ['articles/:slug', ['id']],
      // Right names, wrong order, which is how they are matched.
      ['articles/:slug/:page', ['page', 'slug']],
      // The same name twice: two positions, one value, and the second silently wins.
      ['articles/:slug/:slug', ['slug', 'slug']],
    ];
    for (const [path, parameterNames] of cases) {
      const routes = replacing(2, { id: 'article', path, parameterNames });
      expect(
        validating({ routes, parameters }),
        `${path} :: ${parameterNames.join()}`,
      ).toContain('inconsistent parameters');
    }
  });

  it('refuses a dynamic route with no codec for a parameter it declares', () => {
    expect(validating({ parameters: {} })).toContain('requires a codec');
  });

  it('refuses a localized path that changes what a route takes, or names no route', () => {
    expect(
      validating({ localizedPaths: { nowhere: { 'ar-EG': 'somewhere' } } }),
    ).toContain('unknown route');

    // A localized spelling may translate the segments and may not change the parameters: the
    // route's contract is one thing in every locale, and a spelling that drops `:slug` is an
    // address the resolver can reach and the builder cannot fill.
    expect(
      validating({ localizedPaths: { article: { 'ar-EG': 'مقالات' } } }),
    ).toContain('changes its parameter contract');

    // A locale tag that is not already canonical is refused rather than corrected, because the
    // table is keyed by it and a silent correction makes two keys for one locale.
    expect(
      validating({ localizedPaths: { article: { 'AR-eg': 'مقالات/:slug' } } }),
    ).toBeDefined();

    // The control: the same spelling, canonical, keeping the parameter, is accepted.
    expect(
      validating({ localizedPaths: { article: { 'ar-EG': 'مقالات/:slug' } } }),
    ).toBeUndefined();
  });
});

const POLICY = createPathPrefixLocalePolicy({
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
});

describe('what an address is refused for before any route sees it', () => {
  const PROJECTION = valid();
  const statusOf = (address: string) =>
    resolveLocalizedRoute(address, POLICY, PROJECTION).status;

  it('answers an ordinary address, so a refusal below is about the address', () => {
    expect(statusOf('/en-us/second')).toBe('success');
  });

  it('refuses an address that is not an origin-relative path', () => {
    expect(statusOf('')).toBe('malformed');
    expect(statusOf('en-us/second')).toBe('malformed');
    // Protocol-relative: a browser reads `//host/path` as another origin, so it is not this
    // application's address even though it starts with a slash.
    expect(statusOf('//elsewhere.example/en-us/second')).toBe('malformed');
    expect(statusOf(`/en-us/${'x'.repeat(8192)}`)).toBe('malformed');
  });

  it('reads an absolute HTTP address for its path, and refuses any other scheme', () => {
    // Measured rather than assumed, and the measurement corrected the case above: under a
    // path-prefix policy the origin carries nothing, so an absolute address is reduced to its path
    // and answered. Whose origin it names is not this function's question: only a `locale-host`
    // policy reads the origin, and it has its own resolver.
    expect(statusOf('https://elsewhere.example/en-us/second')).toBe('success');
    expect(statusOf('http://atlas.example/en-us/second')).toBe('success');
    // The scheme is still an allowlist, so an address that would execute rather than navigate is
    // refused before anything reads it.
    expect(statusOf('javascript:alert(1)')).toBe('malformed');
    expect(statusOf('data:text/html,x')).toBe('malformed');
    expect(statusOf('ftp://atlas.example/en-us/second')).toBe('malformed');
    // A traversal inside an absolute address never reaches the refusals below, because `URL` has
    // already resolved it: `/en-us/..` arrives as `/` and `/en-us/../../etc` arrives as `/etc`.
    // Measured rather than assumed: this was written expecting `malformed` and the run said
    // otherwise, which is the more useful fact. The traversal is neutralized by normalization here
    // and refused by the guard on the relative path, and both have to keep working.
    expect(statusOf('https://atlas.example/en-us/..')).toBe('redirect');
    // `/etc` is a leading segment this policy reads as a locale and does not have, which is the
    // answer an address above the application's root should get.
    expect(statusOf('https://atlas.example/en-us/../../etc')).toBe(
      'unsupported-locale',
    );
  });

  it('refuses control characters and backslashes anywhere in it', () => {
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f]) {
      expect(
        statusOf(`/en-us/se${String.fromCharCode(code)}cond`),
        String(code),
      ).toBe('malformed');
    }
    // A backslash is a path separator to some parsers and a literal to others, so an address
    // carrying one means different things to Atlas and to whatever serves the file.
    expect(statusOf('/en-us\\second')).toBe('malformed');
  });

  it('refuses an escape that hides a separator, in either case', () => {
    // `%2f` decodes to `/`. Accepting it would let one segment become two after decoding, which is
    // the shape of a path traversal: the resolver matches one segment and the host walks two.
    expect(statusOf('/en-us/a%2fb')).toBe('malformed');
    expect(statusOf('/en-us/a%2Fb')).toBe('malformed');
    expect(statusOf('/en-us/a%5cb')).toBe('malformed');
    expect(statusOf('/en-us/a%5Cb')).toBe('malformed');
    // And an escape that is not an escape at all.
    expect(statusOf('/en-us/a%zz')).toBe('malformed');
    expect(statusOf('/en-us/a%')).toBe('malformed');
  });

  it('refuses a segment that means the directory above, decoded or not', () => {
    expect(statusOf('/en-us/..')).toBe('malformed');
    expect(statusOf('/en-us/.')).toBe('malformed');
    // Percent-encoded, which is the spelling that gets past a check reading the raw text. This is
    // the pair the guard exists for: it runs after decoding, and both must reach it.
    expect(statusOf('/en-us/%2e%2e')).toBe('malformed');
    expect(statusOf('/en-us/%2E')).toBe('malformed');
    // A double slash inside the path is an empty segment rather than a traversal, and is refused
    // earlier and separately.
    expect(statusOf('/en-us//second')).toBe('malformed');
  });

  it('refuses a query that is too long, malformed, or too many entries', () => {
    expect(statusOf(`/en-us/second?q=${'x'.repeat(2048)}`)).toBe('malformed');
    expect(statusOf('/en-us/second?q=%zz')).toBe('malformed');
    const many = Array.from({ length: 33 }, (_, index) => `a${index}=1`).join(
      '&',
    );
    expect(statusOf(`/en-us/second?${many}`)).toBe('malformed');
    // The control at the bound: thirty-two entries is the limit and is allowed.
    const atTheBound = Array.from(
      { length: 32 },
      (_, index) => `a${index}=1`,
    ).join('&');
    expect(statusOf(`/en-us/second?${atTheBound}`)).toBe('success');
  });
});

describe('the credential-free origin rule, at both sites that apply it', () => {
  const CONFIGURATION: GeneratedConfiguration = {
    generatedAbi: 'atlas-generated/1',
    sourceLocale: 'en-US',
    defaultLocale: 'en-US',
    locales: ['en-US', 'ar-EG'],
    aliases: {},
    applicationContractFingerprint: 'sha256-refusals-contract',
    semanticRegistryFingerprint: 'sha256-refusals-registry',
    scopes: [],
  };
  const PROJECTION = valid();

  /** The policy constructor, which applies the rule to every origin it is given. */
  const asPolicyOrigin = (origin: string) =>
    refusal(() =>
      createHostLocalePolicy({
        defaultLocale: 'en-US',
        origins: { 'en-US': origin, 'ar-EG': 'https://ar.atlas.example' },
      }),
    );

  /** The SEO projection, which applies the same rule to the origin it publishes from. */
  const asSeoOrigin = (origin: string) => {
    const resolution = resolveLocalizedRoute(
      '/en-us/second',
      POLICY,
      PROJECTION,
    );
    return refusal(() =>
      projectRouteSeo(
        resolution as Parameters<typeof projectRouteSeo>[0],
        POLICY,
        PROJECTION,
        CONFIGURATION,
        origin,
      ),
    );
  };

  const REFUSED = [
    // Not HTTP at all. `javascript:` and `data:` are the reason this is an allowlist.
    'ftp://atlas.example',
    'javascript:alert(1)',
    'data:text/html,x',
    // Credentials in the origin, which would be written into a canonical URL in a document head.
    'https://user@atlas.example',
    'https://user:secret@atlas.example',
    // Anything beyond the origin: a path, a query or a fragment, each of which would be
    // concatenated with the route's own path and produce an address nothing serves.
    'https://atlas.example/base',
    'https://atlas.example/?a=1',
    'https://atlas.example/#a',
    // Not a URL.
    'atlas.example',
    '',
  ];

  it('refuses each of them at the policy constructor', () => {
    for (const origin of REFUSED) {
      expect(asPolicyOrigin(origin), origin).toBeDefined();
    }
    expect(asPolicyOrigin('https://atlas.example')).toBeUndefined();
    // A trailing slash is the empty path and is the same origin, so it is accepted, which says
    // the path clause above is about a path rather than about the character.
    expect(asPolicyOrigin('https://atlas.example/')).toBeUndefined();
    expect(asPolicyOrigin('http://localhost:4200')).toBeUndefined();
  });

  it('refuses each of them again in the SEO projection, which asks the same function', () => {
    for (const origin of REFUSED) {
      expect(asSeoOrigin(origin), origin).toBeDefined();
    }
    expect(asSeoOrigin('https://atlas.example')).toBeUndefined();
    expect(asSeoOrigin('https://atlas.example/')).toBeUndefined();
  });
});

describe('the x-default rule, at both sites that apply it', () => {
  // `trustedXDefaultPath` is asserted directly in `route-parameters-and-x-default.test.ts`. This
  // reaches the same rule through `createPathPrefixLocalePolicy`, on the same cases, so the two
  // call sites are held to one definition.
  const withDefault = (xDefaultPath: string) =>
    refusal(() =>
      createPathPrefixLocalePolicy({
        defaultLocale: 'en-US',
        locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
        xDefaultPath,
      }),
    );

  it('keeps an origin-relative path', () => {
    expect(withDefault('/')).toBeUndefined();
    expect(withDefault('/choose-language')).toBeUndefined();
    expect(withDefault('/a b')).toBeUndefined();
  });

  it('refuses anything that could send a crawler somewhere else', () => {
    expect(withDefault('//elsewhere.example')).toBeDefined();
    expect(withDefault('https://elsewhere.example/')).toBeDefined();
    expect(withDefault('choose-language')).toBeDefined();
    expect(withDefault('')).toBeDefined();
    expect(withDefault('/\\elsewhere.example')).toBeDefined();
    for (const code of [0x00, 0x0a, 0x0d, 0x1f, 0x7f]) {
      expect(
        withDefault(`/a${String.fromCharCode(code)}b`),
        String(code),
      ).toBeDefined();
    }
  });
});
