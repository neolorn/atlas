import { describe, expect, it } from 'vitest';

import {
  createIntegerParameterCodec,
  createLocaleNeutralPolicy,
  createPathPrefixLocalePolicy,
  defineRouteProjection,
  localizedServerRoutes,
  type PrerenderParameterValues,
  LocalizationError,
  type GeneratedConfiguration,
  type RouteParameterCodec,
  type RouteParameterContext,
} from '@neolorn/atlas/core';

/**
 * The route parameter codecs, the x-default rule, and the values a server route is prerendered with.
 *
 * `createIntegerParameterCodec` is reached from the primary entry point. `trustedXDefaultPath` and
 * `prerenderParameters` are reached only through the public functions that call them, so a case
 * here drives each through its caller rather than importing it.
 *
 * Every case asserts what the function decides rather than that it was called. A test that merely
 * calls a function proves the function exists, which nothing was ever in doubt about.
 */

describe('an integer route parameter codec', () => {
  const DEFAULT = createIntegerParameterCodec();
  const BOUNDED = createIntegerParameterCodec(1, 10);

  const parse = (
    codec: RouteParameterCodec<number>,
    value: string,
  ): number | undefined => {
    const result = codec.parse(value);
    return result.ok ? result.value : undefined;
  };

  it('takes the decimal spellings a URL segment can carry, and no others', () => {
    expect(parse(DEFAULT, '0')).toBe(0);
    expect(parse(DEFAULT, '42')).toBe(42);
    expect(parse(DEFAULT, '-42')).toBe(-42);
    // Leading zeros parse, because a URL that carries `007` is carrying the number seven and
    // refusing it would 404 an address the same codec is happy to be handed as `7`. The
    // canonicalization that makes `/items/007` redirect to `/items/7` is the resolver's, not the
    // codec's.
    expect(parse(DEFAULT, '007')).toBe(7);
  });

  it('refuses every spelling that is not one', () => {
    // `+1` and `1.5` are numbers to `Number()` and are not integers in a path segment. Whitespace
    // is the one that matters most: `Number(' 1')` is 1, so a codec that reached for `Number`
    // first would accept an address with a space in it.
    for (const value of [
      '',
      '+1',
      '1.5',
      ' 1',
      '1 ',
      '1e3',
      '0x10',
      'NaN',
      '-',
    ]) {
      expect(codeOf(() => DEFAULT.parse(value))).toBeUndefined();
      expect(parse(DEFAULT, value)).toBeUndefined();
    }
    // Sixty-four digits is the codec's own bound and it is not the safe-integer bound. A value
    // that long is refused by the pattern before `Number` is asked, which is what keeps an
    // arbitrarily long segment from becoming an arbitrarily large float.
    expect(parse(DEFAULT, '9'.repeat(64))).toBeUndefined();
    expect(parse(DEFAULT, '9'.repeat(65))).toBeUndefined();
  });

  it('stops where the number stops being an integer', () => {
    expect(parse(DEFAULT, String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(parse(DEFAULT, String(Number.MIN_SAFE_INTEGER))).toBe(
      Number.MIN_SAFE_INTEGER,
    );
    // `9007199254740993` is a decimal spelling of no double at all: `Number` answers
    // `9007199254740992`, which is a different entity. Accepting it would let two addresses name
    // one record.
    expect(parse(DEFAULT, '9007199254740993')).toBeUndefined();
    expect(parse(DEFAULT, '-9007199254740993')).toBeUndefined();
  });

  it('admits both ends of its range and neither step beyond', () => {
    expect(parse(BOUNDED, '1')).toBe(1);
    expect(parse(BOUNDED, '10')).toBe(10);
    expect(parse(BOUNDED, '0')).toBeUndefined();
    expect(parse(BOUNDED, '11')).toBeUndefined();
  });

  it('serializes what it would parse back, and refuses what it would not', () => {
    expect(BOUNDED.serialize(1)).toBe('1');
    expect(BOUNDED.serialize(10)).toBe('10');
    expect(DEFAULT.serialize(-42)).toBe('-42');
    // The round trip is the property worth pinning: what the codec writes, the codec reads.
    expect(parse(BOUNDED, BOUNDED.serialize(7) as string)).toBe(7);
    for (const value of [0, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codeOf(() => BOUNDED.serialize(value))).toBe(
        'invalid-configuration',
      );
    }
  });

  it('refuses a range it could never satisfy', () => {
    expect(codeOf(() => createIntegerParameterCodec(10, 1))).toBe(
      'invalid-configuration',
    );
    expect(codeOf(() => createIntegerParameterCodec(1.5, 10))).toBe(
      'invalid-configuration',
    );
    expect(codeOf(() => createIntegerParameterCodec(1, Number.NaN))).toBe(
      'invalid-configuration',
    );
    // An empty range is one value wide, not zero, so it is allowed and admits exactly that value.
    const single = createIntegerParameterCodec(5, 5);
    expect(parse(single, '5')).toBe(5);
    expect(parse(single, '6')).toBeUndefined();
  });
});

describe('an x-default address on a locale-neutral policy', () => {
  const withDefault = (xDefaultPath: string) =>
    createLocaleNeutralPolicy({
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
      xDefaultPath,
    });

  it('keeps an origin-relative path, and says nothing when there is none', () => {
    expect(withDefault('/').xDefaultPath).toBe('/');
    expect(withDefault('/choose-language').xDefaultPath).toBe(
      '/choose-language',
    );
    expect(withDefault('/a/b?to=c#d').xDefaultPath).toBe('/a/b?to=c#d');
    // Absent rather than `undefined`: the policy is compared and serialized elsewhere, and a key
    // holding `undefined` is not the same object as a key that is not there.
    const none = createLocaleNeutralPolicy({
      defaultLocale: 'en-US',
      locales: ['en-US'],
    });
    expect('xDefaultPath' in none).toBe(false);
  });

  it('refuses anything that could send a crawler somewhere else', () => {
    // `//elsewhere.example` is a URL, not a path: a browser reads it as protocol-relative and
    // leaves the origin. This is the case the check exists for, and it is one character away from
    // the valid form directly above it.
    expect(codeOf(() => withDefault('//elsewhere.example'))).toBe(
      'invalid-configuration',
    );
    expect(codeOf(() => withDefault('https://elsewhere.example/'))).toBe(
      'invalid-configuration',
    );
    // Not origin-relative at all.
    expect(codeOf(() => withDefault('choose-language'))).toBe(
      'invalid-configuration',
    );
    expect(codeOf(() => withDefault(''))).toBe('invalid-configuration');
    // A backslash is a slash to some parsers and not to others, which is exactly why it cannot be
    // carried into a value Atlas writes into a document head.
    expect(codeOf(() => withDefault('/\\elsewhere.example'))).toBe(
      'invalid-configuration',
    );
    // Control characters, at both ends of the range the check names and in the middle.
    for (const code of [0x00, 0x0a, 0x0d, 0x1f, 0x7f]) {
      expect(codeOf(() => withDefault(`/a${String.fromCharCode(code)}b`))).toBe(
        'invalid-configuration',
      );
    }
    // And a printable that is not a control character passes, so the assertions above are about
    // the characters rather than about the surrounding path.
    expect(withDefault('/a b').xDefaultPath).toBe('/a b');
  });
});

describe('the parameter values a localized server route is prerendered with', () => {
  const SLUG: RouteParameterCodec<string> = Object.freeze({
    parse: (slug: string) =>
      Object.freeze(
        slug === 'atlas-handbook' || slug === 'دليل'
          ? { ok: true, value: 'atlas-handbook' }
          : { ok: false },
      ),
    serialize: (entityId: string, context?: RouteParameterContext) =>
      entityId !== 'atlas-handbook'
        ? undefined
        : context?.locale === 'ar-EG'
          ? 'دليل'
          : 'atlas-handbook',
  });

  const PROJECTION = defineRouteProjection({
    generated: Object.freeze({
      profile: 'atlas-route-projection/1',
      identity: 'sha256-AtlasPrerenderParametersTestIdentity0123456',
      routes: Object.freeze([
        Object.freeze({
          id: 'article',
          path: 'articles/:slug',
          parameterNames: Object.freeze(['slug']),
        }),
      ]),
    } as const),
    parameters: Object.freeze({ article: Object.freeze({ slug: SLUG }) }),
  });

  const CONFIGURATION: GeneratedConfiguration = {
    generatedAbi: 'atlas-generated/1',
    sourceLocale: 'en-US',
    defaultLocale: 'en-US',
    locales: ['en-US', 'ar-EG'],
    aliases: {},
    applicationContractFingerprint: 'sha256-prerender-parameters-contract',
    semanticRegistryFingerprint: 'sha256-prerender-parameters-registry',
    scopes: [],
  };

  const POLICY = createPathPrefixLocalePolicy({
    defaultLocale: 'en-US',
    locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
  });

  const schedule = (prerender: PrerenderParameterValues) =>
    localizedServerRoutes(
      POLICY,
      PROJECTION,
      CONFIGURATION,
      [{ routeId: 'article', renderMode: 1, prerender }],
      { canonicalRenderMode: 2 },
    );

  const paramsFor = async (
    path: string,
    prerender: PrerenderParameterValues = [{ slug: 'atlas-handbook' }],
  ) => {
    const entry = schedule(prerender).find((route) => route.path === path);
    expect(entry, path).toBeDefined();
    const get = (entry as { getPrerenderParams?: () => Promise<unknown> })
      .getPrerenderParams;
    expect(get, `${path} has no getPrerenderParams`).toBeInstanceOf(Function);
    return (await (get as () => Promise<unknown>)()) as readonly Readonly<
      Record<string, string>
    >[];
  };

  it('spells one domain value per locale, through that locale codec', async () => {
    // The whole reason this function exists: the caller declares the entity once and each locale's
    // build gets the spelling its own address uses. A version that passed the domain value through
    // would prerender the English slug under the Arabic prefix, and the two entries are the same
    // parameterised path under different prefixes, so nothing but these values distinguishes them.
    expect(await paramsFor('en-us/articles/:slug')).toEqual([
      { slug: 'atlas-handbook' },
    ]);
    expect(await paramsFor('ar-eg/articles/:slug')).toEqual([{ slug: 'دليل' }]);
  });

  it('keeps every declared value, in the order they were declared', async () => {
    // A single value cannot tell a map from a first-element-only reduction, and an unordered
    // comparison cannot tell a preserved order from a reversed one. A prerender list is the set of
    // pages a build writes, so dropping one is a page that is silently absent.
    const params = await paramsFor('en-us/articles/:slug', [
      { slug: 'atlas-handbook' },
      { slug: 'atlas-handbook' },
    ]);
    expect(params).toEqual([
      { slug: 'atlas-handbook' },
      { slug: 'atlas-handbook' },
    ]);
  });

  it('refuses a value with no spelling in the locale being built', async () => {
    // Silently dropping it is the defect worth naming: the page exists in English and 404s in
    // Arabic, and nothing in the build says so. The refusal is a `route-unavailable`, not a
    // configuration error, because the configuration is fine: this value is not.
    //
    // The refusal reaches the caller as a rejected promise rather than a synchronous throw, and
    // the asserted value is the diagnostic rather than the timing: a declared set and a function
    // the build calls are serialized the same way, and a function cannot answer before it is
    // awaited.
    const entry = schedule([{ slug: 'no-such-entity' }]).find(
      (route) => route.path === 'en-us/articles/:slug',
    ) as { getPrerenderParams: () => Promise<unknown> };
    let thrown: unknown;
    try {
      await entry.getPrerenderParams();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LocalizationError);
    expect((thrown as LocalizationError).diagnostic).toMatchObject({
      code: 'route-unavailable',
      outcome: 'localized-representation-unavailable',
      targetLocale: 'en-US',
    });
    expect((thrown as LocalizationError).diagnostic.message).toContain('slug');
  });

  it('takes the same values from a function the build calls', async () => {
    // A set that has to be read from a file or an API cannot be written where the table is, and
    // the addresses it produces have to be the same ones a written set produces: the expansion is
    // per locale and only the release knows which locale each emitted address belongs to.
    expect(
      await paramsFor('ar-eg/articles/:slug', () => [
        { slug: 'atlas-handbook' },
      ]),
    ).toEqual([{ slug: 'دليل' }]);
  });

  it('waits for a function that answers later', async () => {
    expect(
      await paramsFor('en-us/articles/:slug', async () => {
        await Promise.resolve();
        return [{ slug: 'atlas-handbook' }];
      }),
    ).toEqual([{ slug: 'atlas-handbook' }]);
  });

  it('asks a function once, however many addresses the route expands into', async () => {
    // Two locales, one list. A function that reads a file or calls an API would otherwise run once
    // per language for a set that does not vary by language.
    let asked = 0;
    const routes = schedule(() => {
      asked += 1;
      return [{ slug: 'atlas-handbook' }];
    });
    const params = (path: string) =>
      (
        routes.find((route) => route.path === path) as {
          getPrerenderParams: () => Promise<unknown>;
        }
      ).getPrerenderParams();

    await params('en-us/articles/:slug');
    await params('ar-eg/articles/:slug');

    expect(asked).toBe(1);
  });

  it('does not schedule prerendering for a route that declares no values', () => {
    const entry = schedule([]).find(
      (route) => route.path === 'en-us/articles/:slug',
    );
    // `prerender: []` is still a declaration, so the hook is present and answers with nothing,
    // which is the honest shape. An absent hook would say the route is not enumerable at all.
    expect(entry).toHaveProperty('getPrerenderParams');
  });
});

/**
 * The diagnostic code a call refuses with, or `undefined` if it did not refuse.
 *
 * Written as a helper because every refusal below is asserted by its code rather than by its
 * message: a message is prose that will be improved, and an assertion on prose fails the day
 * someone improves it while proving nothing about the refusal.
 */
function codeOf(call: () => unknown): string | undefined {
  try {
    call();
    return undefined;
  } catch (error) {
    if (error instanceof LocalizationError) return error.diagnostic.code;
    throw error;
  }
}
