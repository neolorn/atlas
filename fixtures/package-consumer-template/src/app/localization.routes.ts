import {
  createIdentifierParameterCodec,
  createIntegerParameterCodec,
  createPathPrefixLocalePolicy,
  defineRouteProjection,
  type RouteParameterContext,
  type RouteParameterCodec,
} from '@neolorn/atlas';
import { routeProjection } from '#i18n/routes';

/**
 * The pseudo-locale is in here beside the two real ones, and that is the whole of what a consumer
 * writes to make one addressable.
 *
 * A prerendered page has no request, so a locale that is never in a URL can never be prerendered
 * or server-rendered: it is reachable only by a client-side switch, which is half the product.
 * Giving it a prefix here says where it lives *if this build has it*. Whether it has it is decided
 * by `atlas generate --pseudo`, and `localizedServerRoutes` reads the generated configuration to
 * find out: a production build lists no `en-Arab-XB` catalog, so no address for it is emitted, no
 * page is prerendered at it, and no `hreflang` advertises it.
 *
 * That division is why this line is safe to write once and leave. Before the configuration reached
 * the routing layer it was not: the same three entries produced `/en-arab-xb/second` and
 * `/en-arab-xb/articles/atlas-handbook` in a production build. Redirects rather than fake
 * content, but two published addresses for a locale that only exists on a developer's machine.
 */
/**
 * The site this deployment answers at, declared once because two things compose it.
 *
 * The router builds every canonical and alternate URL from it, and `server.ts` builds the sitemap
 * from it. Written twice they could disagree, and the failure would be a sitemap advertising
 * addresses the head of every page contradicts, which is exactly the disagreement the two are
 * supposed to be incapable of.
 */
export const SITE_ORIGIN = 'https://atlas.example';

export const routePolicy = createPathPrefixLocalePolicy({
  defaultLocale: 'en-US',
  locales: {
    'en-US': 'en-us',
    'ar-EG': 'ar-eg',
    'en-Arab-XB': 'en-arab-xb',
  },
  aliases: {
    en: 'en-US',
    ar: 'ar-EG',
  },
  localeNeutralRoots: ['assets'],
  xDefaultPath: '/',
});

export const articleSlugCodec: RouteParameterCodec<string> = Object.freeze({
  parse: (slug: string) =>
    Object.freeze(
      slug === 'atlas-handbook' || slug === 'دليل-أطلس'
        ? { ok: true, value: 'atlas-handbook' }
        : { ok: false },
    ),
  serialize: (entityId: string, context?: RouteParameterContext) => {
    if (entityId !== 'atlas-handbook') return undefined;
    return context?.locale === 'ar-EG' ? 'دليل-أطلس' : 'atlas-handbook';
  },
});

/**
 * A codec for a slug no function can translate.
 *
 * Identity in both directions, and it takes no `RouteParameterContext` at all: the omission is
 * the statement. `articleSlugCodec` above knows both spellings because they are in its source; a
 * dossier's Arabic slug is in a database, so no synchronous pure function can produce it and this
 * one does not pretend to. Without a declaration Atlas therefore advertises the English slug under
 * the Arabic prefix, which resolves and is not Arabic. `LocalizedRouteParameters` is what supplies
 * the fact this cannot.
 *
 * It still has to *read* every spelling, including the ones it could never have written: an
 * address Atlas emits and cannot resolve is worse than one it never emitted, and
 * `buildLocalizedRoute` refuses a declared spelling this rejects.
 */
export const dossierSlugCodec: RouteParameterCodec<string> = Object.freeze({
  parse: (slug: string) =>
    Object.freeze(
      slug.length > 0 && slug.length <= 128 && !slug.startsWith('.')
        ? { ok: true, value: slug }
        : { ok: false },
    ),
  serialize: (slug: string) => slug,
});

/**
 * An application whose routes take no parameters at all.
 *
 * Declared here because every other projection in this fixture has a parameterised route, which
 * is what let the codec requirement claim, for a projection with none, that every route was
 * parameterised and demanded codecs no route could have. That is the ordinary shape for a
 * marketing or documentation application, and it must compile.
 */
export const parameterlessProjection = defineRouteProjection({
  generated: Object.freeze({
    profile: 'atlas-route-projection/1',
    identity: 'sha256-parameterless-projection-fixture',
    routes: Object.freeze([
      Object.freeze({
        id: 'only',
        path: '',
        parameterNames: Object.freeze([]),
        indexing: 'indexable',
      }),
    ]),
  } as const),
});

export const appRouteProjection = defineRouteProjection({
  generated: routeProjection,
  parameters: Object.freeze({
    item: Object.freeze({
      id: createIntegerParameterCodec(1, 999_999),
    }),
    article: Object.freeze({ slug: articleSlugCodec }),
    // The same parameter name as `article`, and that is deliberate. It is the precondition for the
    // stale-parameter trap: a design that held declared spellings in one mutable record keyed by
    // parameter name would serve the dossier's Arabic slug on the article page after navigating
    // between them, and would tell a crawler the two are translations of each other.
    dossier: Object.freeze({ slug: dossierSlugCodec }),
    // The default pattern, deliberately. A codec that takes a pattern is only as good as the
    // pattern it is given, and the answer an application reaches for first is the one it gets
    // without arguments, so that is the one this fixture proves rejects `../etc`, `%2e%2e`, an
    // empty segment, a leading hyphen and a 129th character, and accepts an ordinary slug
    // unchanged in both locales.
    topic: Object.freeze({ topic: createIdentifierParameterCodec() }),
  }),
  historical: Object.freeze({
    legacy: Object.freeze({
      kind: 'replacement',
      routeId: 'route:second',
    } as const),
    removed: Object.freeze({ kind: 'gone' } as const),
  }),
});
