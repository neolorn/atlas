import { describe, expect, it } from 'vitest';

import {
  buildLocalizedRoute,
  createIdentifierParameterCodec,
  resolveLocalizedRoute,
  toExternalPath,
  toInternalPath,
  withBasePath,
  withoutBasePath,
  type LocaleUrlPolicy,
  type LocalizedAddressContext,
  type RouteParameterCodec,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

/**
 * The half of the location strategy a unit test can reach.
 *
 * The strategy class is a shell that reads the active locale from DI and hands these two functions
 * their arguments; what it does with the answer is a rendered-output question and is asserted in
 * the consumer suite. The translation itself is arithmetic over strings, and this is where it gets
 * exercised, including cases nothing else covers, like a policy that omits the default
 * locale's prefix.
 */

const PROJECTION: RouteRuntimeProjection = {
  generated: {
    profile: 'atlas-route-projection/1',
    identity: 'sha256-AtlasRouteProjectionTestIdentity0123456789_',
    routes: [
      { id: 'route:_index', path: '', parameterNames: [] },
      { id: 'route:second', path: 'second', parameterNames: [] },
      { id: 'article', path: 'articles/:slug', parameterNames: ['slug'] },
    ],
  },
  localizedPaths: {
    'route:second': { 'en-US': 'second', 'ar-EG': 'الثاني' },
    article: { 'en-US': 'articles/:slug', 'ar-EG': 'مقالات/:slug' },
  },
  // A parameter value passes through unchanged; only the static segments localize. Atlas's own
  // identifier codec rather than a two-entry fixture table, which would be a cooperating stub for
  // exactly the case that has to work.
  parameters: { article: { slug: createIdentifierParameterCodec() } },
};

const PREFIXED: LocaleUrlPolicy = {
  kind: 'path-prefix',
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
  prefixes: { 'en-us': 'en-US', 'ar-eg': 'ar-EG' },
  aliases: {},
  localeNeutralRoots: [],
  omitDefaultPrefix: false,
};

const CONTEXT: LocalizedAddressContext = {
  policy: PREFIXED,
  projection: PROJECTION,
};

const OMITTED: LocalizedAddressContext = {
  policy: { ...PREFIXED, omitDefaultPrefix: true },
  projection: PROJECTION,
};

/**
 * Percent-encoded, because that is what a URL path is.
 *
 * `buildLocalizedRoute` encodes each segment, so every outbound expectation below is the
 * encoded form. Written out as literals rather than built with `encodeURIComponent`: an
 * expectation produced by the same encoding the code under test uses agrees with it whatever
 * either of them does.
 *
 * The decoded spellings, for anyone reading: SECOND_ENC is الثاني and ARTICLES_ENC is مقالات.
 */
const SECOND_ENC = '%D8%A7%D9%84%D8%AB%D8%A7%D9%86%D9%8A';
const ARTICLES_ENC = '%D9%85%D9%82%D8%A7%D9%84%D8%A7%D8%AA';

/**
 * A codec that writes a spelling it will not read back.
 *
 * The hostile case, and the one a cooperating fixture cannot produce. `serialize` gives Arabic its
 * own spelling of the slug, which is the whole point of a per-locale codec; `parse` accepts only
 * the English one, which is the mistake anybody writing the first half will make, because in the
 * locale they developed in it works. Nothing about it is malformed (the URL is well formed, the
 * segment is safe, the link renders) and it fails only when someone follows it.
 */
const ONE_WAY_SLUG: RouteParameterCodec<string> = {
  parse: (value) =>
    value === 'atlas-handbook' ? { ok: true, value } : { ok: false },
  serialize: (value, context) =>
    context?.locale === 'ar-EG' ? 'dalil-atlas' : value,
};

/** A codec that reads its own output as a different value: idempotent in neither direction. */
const DRIFTING_SLUG: RouteParameterCodec<string> = {
  parse: (value) => ({ ok: true, value: `${value}-x` }),
  serialize: (value) => value,
};

function withCodec(codec: RouteParameterCodec<string>): RouteRuntimeProjection {
  return {
    ...PROJECTION,
    parameters: { article: { slug: codec } },
  } as RouteRuntimeProjection;
}

describe('a parameter codec that cannot read its own spelling', () => {
  it('refuses to build an address it could not resolve', () => {
    // The failure is refused where it is created rather than where it is followed. Left to build,
    // `/ar-eg/مقالات/dalil-atlas` is an address Atlas emits and then cannot place, so it renders as
    // a link that leads nowhere, and it leads nowhere in Arabic only, which is how a codec like
    // this survives every test written in the default locale.
    expect(() =>
      buildLocalizedRoute(
        PREFIXED,
        withCodec(ONE_WAY_SLUG),
        'article',
        'ar-EG',
        {
          slug: 'atlas-handbook',
        },
      ),
    ).toThrow(/cannot read its own ar-EG spelling back/u);
  });

  it('builds the locale the codec does agree with', () => {
    // The control. The same codec, the same route, the locale whose spelling it accepts: this has
    // to keep working, or the check is refusing codecs rather than refusing broken ones.
    expect(
      buildLocalizedRoute(
        PREFIXED,
        withCodec(ONE_WAY_SLUG),
        'article',
        'en-US',
        {
          slug: 'atlas-handbook',
        },
      ),
    ).toBe('/en-us/articles/atlas-handbook');
  });

  it('refuses a codec that reads its output back as something else', () => {
    // Caught by comparing text rather than values, which is why this shape is caught at all: the
    // codec answers `ok` to everything, so a check that only asked whether `parse` succeeded would
    // pass it. Serializing what came back and comparing the two strings asks the real question.
    expect(() =>
      buildLocalizedRoute(
        PREFIXED,
        withCodec(DRIFTING_SLUG),
        'article',
        'en-US',
        {
          slug: 'atlas-handbook',
        },
      ),
    ).toThrow(/cannot read its own en-US spelling back/u);
  });

  it('hands back an address whose parameter it rejects, rather than guessing', () => {
    // The specified behaviour when `parse` refuses a spelling it should have accepted. The route
    // declines to match, resolution answers `not-found`, and the address is returned unchanged:
    // the same treatment an address naming no route at all gets. The alternative is serving one
    // page's content at another page's address, which is worse than serving nothing.
    const context: LocalizedAddressContext = {
      policy: PREFIXED,
      projection: withCodec(ONE_WAY_SLUG),
    };
    const rejected = `/ar-eg/${ARTICLES_ENC}/dalil-atlas`;

    const resolution = resolveLocalizedRoute(
      rejected,
      PREFIXED,
      withCodec(ONE_WAY_SLUG),
    );
    expect(resolution.status).toBe('not-found');
    expect(toInternalPath(rejected, context)).toBe(rejected);
  });
});

describe('inbound: localized external to canonical internal', () => {
  it('delocalizes a translated address to the authored one', () => {
    expect(toInternalPath(`/ar-eg/${SECOND_ENC}`, CONTEXT)).toBe('/second');
  });

  it('delocalizes the default locale prefix too', () => {
    expect(toInternalPath('/en-us/second', CONTEXT)).toBe('/second');
  });

  it('carries a parameter through a translated segment', () => {
    expect(
      toInternalPath(`/ar-eg/${ARTICLES_ENC}/atlas-handbook`, CONTEXT),
    ).toBe('/articles/atlas-handbook');
  });

  it('corrects a decoded spelling rather than declining it', () => {
    // Every inbound case above is fed the encoded form, because that is what
    // `document.location.pathname` yields. A decoded spelling can only come from application code,
    // and it is not an address Atlas fails to place: the resolver knows the route and answers
    // `canonical-correction`, a 308 to the encoded form, which is what a server sends a visitor who
    // types it. Handing it straight back has the server correcting it and the client not: the
    // one-address-two-answers split, on the one door where nobody looks.
    expect(
      resolveLocalizedRoute('/ar-eg/الثاني', PREFIXED, PROJECTION),
    ).toMatchObject({
      status: 'redirect',
      reason: 'canonical-correction',
      httpStatus: 308,
      location: `/ar-eg/${SECOND_ENC}`,
    });
    expect(toInternalPath('/ar-eg/الثاني', CONTEXT)).toBe('/second');
  });

  it('resolves the index address to the root', () => {
    expect(toInternalPath('/ar-eg', CONTEXT)).toBe('/');
  });

  it('hands back an address it cannot place, so the app can answer', () => {
    // Declining is the correct outcome, not a failure. Atlas does not own every address in the
    // application: the consumer's own `**` route and its locale-neutral roots still answer, and
    // they can only do that if the address reaches them unchanged.
    expect(toInternalPath('/ar-eg/nope', CONTEXT)).toBe('/ar-eg/nope');
    expect(toInternalPath('/not-localized-at-all', CONTEXT)).toBe(
      '/not-localized-at-all',
    );
  });

  it('preserves query and fragment', () => {
    expect(toInternalPath(`/ar-eg/${SECOND_ENC}?page=2#top`, CONTEXT)).toBe(
      '/second?page=2#top',
    );
  });
});

describe('outbound: canonical internal to localized external', () => {
  it('localizes into the active locale', () => {
    expect(toExternalPath('/second', 'ar-EG', CONTEXT)).toBe(
      `/ar-eg/${SECOND_ENC}`,
    );
    expect(toExternalPath('/second', 'en-US', CONTEXT)).toBe('/en-us/second');
  });

  it('localizes a parameterised address without touching the parameter', () => {
    expect(toExternalPath('/articles/atlas-handbook', 'ar-EG', CONTEXT)).toBe(
      `/ar-eg/${ARTICLES_ENC}/atlas-handbook`,
    );
  });

  it('localizes the root', () => {
    expect(toExternalPath('/', 'ar-EG', CONTEXT)).toBe('/ar-eg');
  });

  it('hands back an address it cannot place', () => {
    expect(toExternalPath('/nope', 'ar-EG', CONTEXT)).toBe('/nope');
  });

  it('preserves query and fragment', () => {
    expect(toExternalPath('/second?page=2#top', 'ar-EG', CONTEXT)).toBe(
      `/ar-eg/${SECOND_ENC}?page=2#top`,
    );
  });
});

describe('the two directions are mirror images', () => {
  it('round-trips every projected address through both locales', () => {
    for (const internal of ['/', '/second', '/articles/atlas-handbook']) {
      for (const locale of ['en-US', 'ar-EG']) {
        const external = toExternalPath(internal, locale, CONTEXT);
        expect(toInternalPath(external, CONTEXT)).toBe(internal);
      }
    }
  });
});

describe('a policy that omits the default prefix', () => {
  it('leaves the default locale unprefixed in both directions', () => {
    expect(toExternalPath('/second', 'en-US', OMITTED)).toBe('/second');
    expect(toInternalPath('/second', OMITTED)).toBe('/second');
  });

  it('still prefixes every other locale', () => {
    expect(toExternalPath('/second', 'ar-EG', OMITTED)).toBe(
      `/ar-eg/${SECOND_ENC}`,
    );
    expect(toInternalPath(`/ar-eg/${SECOND_ENC}`, OMITTED)).toBe('/second');
  });

  it('round-trips', () => {
    for (const internal of ['/', '/second', '/articles/atlas-handbook']) {
      for (const locale of ['en-US', 'ar-EG']) {
        const external = toExternalPath(internal, locale, OMITTED);
        expect(toInternalPath(external, OMITTED)).toBe(internal);
      }
    }
  });
});

/**
 * A projection with a history, which is what makes a redirect representable at all here.
 *
 * `historical` is keyed by the authored path, and the two entries are the two answers a retired
 * address gets: `legacy` moved and names its replacement, `removed` did not and names nothing.
 */
const WITH_HISTORY = {
  ...PROJECTION,
  historical: {
    legacy: { kind: 'replacement', routeId: 'route:second' },
    removed: { kind: 'gone' },
  },
} as RouteRuntimeProjection;

const RETIRED: LocalizedAddressContext = {
  policy: PREFIXED,
  projection: WITH_HISTORY,
};

/**
 * The answers a client-side arrival adopts, and the ones it must not.
 *
 * A visitor from outside gets these as HTTP statuses and their browser acts on them. A visitor from
 * inside never reaches a server, so this function is the only place the same answer can be given,
 * and the rule is the status, not the reason. Both halves are asserted, because a translation that
 * followed everything would move readers between locales, and a test that only checked the `308`s
 * would call that a pass.
 */
describe('an address the resolver answers with a redirect', () => {
  it('follows a canonical correction, so the retired prefix reaches the page', () => {
    expect(toInternalPath('/en-us/second', OMITTED)).toBe('/second');
    expect(toInternalPath('/en-us', OMITTED)).toBe('/');
  });

  it('follows a replacement, so a retired path spelling reaches the page', () => {
    expect(toInternalPath('/en-us/legacy', RETIRED)).toBe('/second');
    expect(toInternalPath('/ar-eg/legacy', RETIRED)).toBe('/second');
  });

  it('carries the query and the fragment across the correction', () => {
    expect(toInternalPath('/en-us/second?page=2#notes', OMITTED)).toBe(
      '/second?page=2#notes',
    );
  });

  it('leaves a 410 where it was, because the application answers for it', () => {
    expect(
      resolveLocalizedRoute('/en-us/removed', PREFIXED, WITH_HISTORY),
    ).toMatchObject({ status: 'gone' });
    expect(toInternalPath('/en-us/removed', RETIRED)).toBe('/en-us/removed');
  });

  it('leaves the 307 where it was, because the address states no locale', () => {
    // The one redirect whose answer depends on a preference rather than on the address, which is
    // why it is marked `private-no-store` and why following it here would be a locale change
    // disguised as an address translation.
    expect(resolveLocalizedRoute('/', PREFIXED, PROJECTION)).toMatchObject({
      status: 'redirect',
      reason: 'locale-entry',
      httpStatus: 307,
    });
    expect(toInternalPath('/', CONTEXT)).toBe('/');
  });
});

describe('policies that do not distinguish locales in the path', () => {
  it('passes a locale-neutral address through untouched', () => {
    const context: LocalizedAddressContext = {
      policy: {
        kind: 'locale-neutral',
        defaultLocale: 'en-US',
        locales: { 'en-US': '', 'ar-EG': '' },
        localeNeutralRoots: [],
      },
      projection: PROJECTION,
    };
    expect(toInternalPath('/second', context)).toBe('/second');
    expect(toExternalPath('/second', 'ar-EG', context)).toBe('/second');
  });

  it('passes a host-keyed address through untouched', () => {
    // `buildLocalizedRoute` returns an absolute URL under a host policy, which is not something a
    // `LocationStrategy` path may be. Translating here would put an origin in the address bar.
    const context: LocalizedAddressContext = {
      policy: {
        kind: 'locale-host',
        defaultLocale: 'en-US',
        locales: {
          'en-US': 'https://example.com',
          'ar-EG': 'https://example.eg',
        },
        origins: {
          'https://example.com': 'en-US',
          'https://example.eg': 'ar-EG',
        },
        localeNeutralRoots: [],
      },
      projection: PROJECTION,
    };
    expect(toExternalPath('/second', 'ar-EG', context)).toBe('/second');
  });
});

/**
 * The sub-path an application is deployed under, taken off to read an address and put back to write
 * one.
 *
 * An application served at `https://example.com/app` sees `/app` in front of every address the
 * browser hands it, and in none of the addresses Atlas builds: a policy addresses routes from the
 * application's own root. Two callers do this and they must do it the same way: the
 * `LocationStrategy`, which strips to delocalize and restores to write, and locale resolution,
 * which strips to read the prefix out of the address the document is at. The second was missing it,
 * so under a sub-path an Arabic address committed the default locale while the Router matched the
 * right route: the page was right and the language was not.
 *
 * The pair is asserted here rather than only through the deployment, because two of the cases below
 * cannot be produced by a correct browser and can be produced by a server, a test, or an address
 * passed in by hand.
 */
describe('the sub-path an application is deployed under', () => {
  it('comes off an address and goes back on', () => {
    expect(withoutBasePath('/app/ar-eg/second', '/app')).toBe('/ar-eg/second');
    expect(withBasePath('/ar-eg/second', '/app')).toBe('/app/ar-eg/second');
  });

  it('reads a trailing slash and the bare root as the same base', () => {
    // `<base href="/app/">` is the spelling Angular's own documentation uses, and `/` is what a
    // root deployment declares. Three spellings of two intents, and the pair must agree on both.
    expect(withoutBasePath('/app/second', '/app/')).toBe('/second');
    expect(withoutBasePath('/second', '/')).toBe('/second');
    expect(withoutBasePath('/second', '')).toBe('/second');
    expect(withBasePath('/second', '/')).toBe('/second');
    expect(withBasePath('/second', '')).toBe('/second');
  });

  it('reads every spelling one deployment can declare', () => {
    // One mount point, six declarations of it, and the pair must not be able to tell them apart.
    //
    // The absolute ones are not hypothetical and they are not a browser shape. On a server
    // `PlatformLocation.getBaseHrefFromDOM()` returns the `<base>` attribute exactly as written
    // (`@angular/platform-server` 22.1.3, `_server-chunk.mjs:61`) while the browser adapter
    // resolves it to a path first (`platform-browser`, `_browser-chunk.mjs:57-59`). Measured on a
    // real `renderApplication`: a document declaring `<base href="https://example.com/app/">`
    // yields that whole string inside the application injector. A strip that only understood paths
    // would work in every test, work in the browser, and put section 14.7's defect back on exactly
    // the deployments that prerender, where nobody sees the wrong language until it is on disk.
    //
    // `/index.html` and the protocol-relative form are here because Angular's own `Location`
    // reduces both (`@angular/common` 22.1.3, `_location-chunk.mjs:239`), and a base this disagreed
    // with `Location` about would be an address one half of the runtime accepts and the other does
    // not.
    for (const spelling of [
      '/app',
      '/app/',
      'https://example.com/app',
      'https://example.com/app/',
      '//example.com/app/',
      '/app/index.html',
    ]) {
      expect(withoutBasePath('/app/ar-eg/second', spelling)).toBe(
        '/ar-eg/second',
      );
      expect(withBasePath('/ar-eg/second', spelling)).toBe('/app/ar-eg/second');
    }
  });

  it('mounts an absolute address on its own origin, not on the deployment', () => {
    // Under a `locale-host` policy an address is already a URL on another locale's domain, and it
    // is the switcher option's href as well as the head's alternate. A build served under `/app`
    // serves every one of its locale domains under `/app`, so the mount point goes into that URL's
    // path and its origin is kept. Prefixing the string instead would produce `/apphttps://...`.
    expect(withBasePath('https://ar.example.com/second', '/app')).toBe(
      'https://ar.example.com/app/second',
    );
    expect(withBasePath('https://ar.example.com/second', '')).toBe(
      'https://ar.example.com/second',
    );
  });

  it('treats a matrix parameter on the base as the boundary Angular treats it as', () => {
    // `;` ends a segment for the Router, which puts its own matrix parameters there, and Angular's
    // `_stripBasePath` lists it beside `/`, `?` and `#` (`_location-chunk.mjs:361`). What comes
    // back is application-rooted, because that is what every reader of this expects.
    expect(withoutBasePath('/app;view=grid', '/app')).toBe('/;view=grid');
  });

  it('leaves a route whose name merely starts with the base alone', () => {
    // The one that corrupts silently. `startsWith` alone says `/app` is the base of
    // `/application/x` and hands back `lication/x`, which resolves to nothing and reads as a
    // routing bug rather than a string bug. A base matches at a segment boundary or not at all.
    expect(withoutBasePath('/application/x', '/app')).toBe('/application/x');
  });

  it('answers the root for the base itself, with or without a suffix', () => {
    expect(withoutBasePath('/app', '/app')).toBe('/');
    expect(withoutBasePath('/app/', '/app')).toBe('/');
    expect(withoutBasePath('/app?tab=one', '/app')).toBe('/?tab=one');
    expect(withoutBasePath('/app#notes', '/app')).toBe('/#notes');
  });

  it('strips nothing when the base is the origin a missing declaration falls back to', () => {
    // `PathLocationStrategy` uses the document origin when nothing declares a base href, so this
    // value reaches the pair on any page with no `<base>` element. It never matches a path, which
    // is the right answer, there is no sub-path, and it must not become one by accident.
    expect(withoutBasePath('/ar-eg/second', 'https://atlas.example')).toBe(
      '/ar-eg/second',
    );
  });

  it('round-trips every address a deployment under a sub-path produces', () => {
    for (const address of [
      '/app/second',
      '/app/ar-eg/الثاني',
      '/app/ar-eg/second?tab=one#notes',
      '/app',
    ]) {
      expect(withBasePath(withoutBasePath(address, '/app'), '/app')).toBe(
        address === '/app' ? '/app/' : address,
      );
    }
  });
});
