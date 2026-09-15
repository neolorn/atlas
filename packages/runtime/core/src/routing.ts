import { directionForLocale } from './locale-profile';
import {
  LocalizationError,
  type GeneratedConfiguration,
  type LocaleDirection,
  type LocalizationDiagnostic,
} from './contracts';
import { escapeXml } from './xml-text';

/**
 * The version of the route projection shape, written into every generated projection.
 *
 * Checked when a projection is validated, so a projection produced by an older build is refused
 * rather than read as though its fields meant what they mean now.
 */
export const ROUTE_PROJECTION_PROFILE = 'atlas-route-projection/1' as const;

/**
 * What a route says to a crawler.
 *
 * `indexable` is a page meant to be found. `non-indexable` is a real page that should not be
 * listed, such as a confirmation screen. `private` is a page behind a sign-in, which is left out
 * of sitemaps and alternates entirely rather than listed with a `noindex` on it.
 */
export type RouteIndexingClass = 'indexable' | 'non-indexable' | 'private';

/**
 * The route-data field Atlas reads when a consumer does not name one of its own.
 *
 * A project that already classifies its routes points Atlas at the field it already has. A
 * project that does not gets this.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 14 is why this is a field name and a table
 * of literals rather than a predicate: the declaration is read from the provider file's source
 * text when the owner is compiled, and Atlas does not execute consumer code to find out how an
 * application classifies its own routes.
 */
export const DEFAULT_ROUTE_INDEXING_FIELD = 'atlasIndexing';

/**
 * How a consumer's own route data says which routes are indexable.
 *
 * Atlas must not read a field name belonging to a particular consumer, so the field is named here
 * rather than assumed, and the values in it are the consumer's words rather than Atlas's. Only the
 * exceptions need naming: a route whose field is absent, or carries a value this policy does not
 * list, is indexable. Marking every route would be the cost this option exists to avoid.
 *
 * This is read from the provider file's source text at build time, which is why it is a field
 * name and a table of literals rather than a predicate. A function body cannot be evaluated
 * without executing consumer code, and Atlas does not execute consumer code.
 */
export interface RouteIndexingPolicy {
  /** The route-data field to read the class out of. */
  readonly field: string;
  /** What each value in that field means. A route whose value is unlisted is indexable. */
  readonly values: Readonly<Record<string, RouteIndexingClass>>;
}

/**
 * The seven values `changefreq` admits, from the sitemap protocol's own enumeration.
 *
 * A closed set, and the schema enforces it, so a value outside it is not a hint a crawler ignores
 * but a document a validator refuses.
 */
export type SitemapChangeFrequency =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never';

/** What one class of routes claims about itself in a sitemap. */
export interface SitemapRouteClass {
  /** How often this class of pages changes. A hint the format defines and crawlers may ignore. */
  readonly changefreq?: SitemapChangeFrequency;
  /** Between 0 and 1 inclusive. The protocol's default when absent is 0.5, so absent is a value. */
  readonly priority?: number;
}

/**
 * How a consumer's own route data says what a route claims in a sitemap.
 *
 * The same shape as the indexing policy above and for the same reason: Atlas reads a field name it
 * was given rather than one of its own invention, and a table of literals rather than a predicate,
 * because the declaration is read from source text and Atlas does not execute consumer code.
 *
 * The mapping is class to value rather than route to value. A project that groups its routes at
 * all has already written the grouping, and a project that wants one route to differ names a class
 * for it. That keeps the route itself carrying a word about the project instead of a number about
 * a crawler.
 *
 * `lastmodField` is separate because `lastmod` is not a class property: it is a date belonging to
 * one page. It names a second route-data field whose value is read as written. Atlas never
 * computes one, because a build time or a file time is a date the page did not change on, and a
 * `lastmod` that is not accurate is worse than none.
 */
export interface RouteSitemapPolicy {
  /** The route-data field carrying the class. The consumer's own name for its own grouping. */
  readonly field: string;
  /** What each value of that field claims. A value not listed here claims nothing. */
  readonly values: Readonly<Record<string, SitemapRouteClass>>;
  /** A second route-data field carrying a W3C date, read as written and never computed. */
  readonly lastmodField?: string;
}

/**
 * One route as the build found it: its identity, its shape, and what it needs to render.
 *
 * Derived from the application's own route definitions rather than declared a second time, which
 * is why a route can be added without anything about localization being written for it.
 */
export interface GeneratedRouteProjectionEntry {
  /** The stable name for this route, which is what every address is built from. */
  readonly id: string;
  /** Its path as declared, with parameters still in it. */
  readonly path: string;
  /** The parameters in that path, in the order they appear. */
  readonly parameterNames: readonly string[];
  /** What it says to a crawler. Absent where no indexing policy classified it. */
  readonly indexing?: RouteIndexingClass;
  /**
   * The scopes this route must have ready before it renders.
   *
   * Every startup scope, plus the scopes used by the files this route brings in behind its own
   * lazy boundary. The startup ones are here even though bootstrap already loaded them, because
   * "startup" means loaded for the locale the page started in, and a locale transition has to have
   * every scope the page renders ready in the *new* locale before it commits.
   *
   * Deriving it is what makes deferring a scope safe: the route's code arrives when it activates
   * and its messages arrive with it, without an application listing scopes per route. Absent when
   * the route needs none.
   */
  readonly scopes?: readonly {
    /** The package that owns the messages. */
    readonly providerId: string;
    /** The scope within it. */
    readonly scopeId: string;
  }[];
  /** Where the route was declared, for diagnostics. A repository-relative path, never absolute. */
  readonly sourcePath?: string;
  /**
   * What this route claims about itself in a sitemap, resolved at build time.
   *
   * Absent for a route whose project declared no sitemap policy, and absent for a route whose
   * class the policy does not list. Both are the same thing to a reader: the entry is written with
   * `loc` and its alternates and nothing else, which is a complete entry.
   */
  readonly sitemap?: SitemapRouteClass & { readonly lastmod?: string };
}

/**
 * The whole route table the build derived, which is what addresses are resolved against.
 *
 * Written `as const`, so the identities in it survive into the type system and a misspelled route
 * name is a compile error rather than a throw.
 */
export interface GeneratedRouteProjection {
  /** The shape version, checked when the projection is validated. */
  readonly profile: typeof ROUTE_PROJECTION_PROFILE;
  /** What this table is, so a snapshot resolved against an older one can be recognized. */
  readonly identity: string;
  /** The routes. */
  readonly routes: readonly GeneratedRouteProjectionEntry[];
}

/**
 * What reading one route parameter out of an address gave: the value, or nothing.
 *
 * Reported rather than thrown, because a parameter that will not parse is an address that names no
 * route, which is an ordinary answer on the web.
 */
export interface RouteParameterParseResult<Value> {
  /** Whether the text parsed. */
  readonly ok: boolean;
  /** The value, present only when it did. */
  readonly value?: Value;
}

/** Which parameter is being read or written, and for which locale. */
export interface RouteParameterContext {
  /** The locale the address is in, which is what makes a spelling per-locale. */
  readonly locale?: string;
  /** Which route the parameter belongs to. */
  readonly routeId: string;
  /** Which parameter. */
  readonly parameterName: string;
}

/**
 * How one route parameter is spelled in a URL, and read back out of one.
 *
 * **A codec must be able to read its own output, in the locale it wrote it for.** For every locale
 * the policy names, `parse(serialize(value, locale), locale)` has to succeed and serialize back to
 * the same text. That is not a style rule: it is the mechanism a locale change runs on. Changing
 * locale re-addresses the current page by parsing the address in the locale it was written in and
 * serializing the result in the new one, so a codec that writes a spelling it cannot read has
 * produced an address Atlas emits and then cannot resolve. The visitor sees a link that leads
 * nowhere, or a page that silently reverts to the default locale, and nothing on the way there
 * looks wrong.
 *
 * Both halves take the locale in `context`, which is what makes the requirement per-locale rather
 * than global: a codec is free to spell a value differently in each locale, that is the point,
 * as long as it accepts each of its own spellings when handed one back.
 *
 * `serialize` is synchronous, and deliberately. It runs while a URL is being built, including
 * during a navigation already in progress, and there is nowhere to await. A value whose spelling
 * has to be fetched (a slug that lives in a database, a title translated by a service) cannot
 * be a route parameter under this contract. Put the identifier in the URL and fetch the copy
 * behind it, or generate the localized paths and let `localizedPaths` carry them.
 *
 * When `parse` rejects a spelling it should have accepted, Atlas does not guess. The route declines
 * to match, resolution answers `not-found`, and the address is handed back unchanged for the
 * application to answer: the same outcome as a URL naming no route at all. That is the safe
 * failure, because the alternative is serving one page's content at another page's address.
 */
export interface RouteParameterCodec<Value = unknown> {
  /** Reads one segment of an address. Returns `{ok: false}` rather than throwing on a refusal. */
  parse(
    value: string,
    context?: RouteParameterContext,
  ): RouteParameterParseResult<Value>;
  /** Writes a value into an address. Synchronous: there is nowhere to await mid-build. */
  serialize(value: Value, context?: RouteParameterContext): string | undefined;
}

/**
 * The spellings of one page's route parameters in locales other than the one it was addressed in.
 *
 * Keyed parameter name, then locale. Supplied by whoever loaded the record, because that is the only
 * code that can know them: `RouteParameterCodec.serialize` is synchronous, so a slug held in a
 * database cannot be produced at the moment an address is built.
 *
 * This does not replace the codec. The codec still decides what a parameter looks like for routes
 * whose spelling is derivable, and it still has to *read* every spelling declared here: an address
 * Atlas emits and cannot resolve is worse than one it never emitted.
 */
export type LocalizedParameterSpellings = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

/** What building a path-prefix policy takes, where the locale is a segment at the front. */
export interface PathPrefixLocalePolicyOptions {
  /** The locale an address with no prefix is in. Must be one of the locales below. */
  readonly defaultLocale: string;
  /** The prefix each locale is written under, keyed by locale. Prefixes must be distinct. */
  readonly locales: Readonly<Record<string, string>>;
  /** Other prefixes accepted for a locale, which is how an old spelling keeps working. */
  readonly aliases?: Readonly<Record<string, string>>;
  /** Paths that carry no locale at all, such as an asset root or a health check. */
  readonly localeNeutralRoots?: readonly string[];
  /** The address to point `x-default` at. Must not change origin. */
  readonly xDefaultPath?: string;
  /** Whether the default locale is written without its prefix. Off by default. */
  readonly omitDefaultPrefix?: boolean;
}

/**
 * A checked path-prefix policy, built by `createPathPrefixLocalePolicy`.
 *
 * Frozen, and with both directions of the prefix table resolved, so reading an address and writing
 * one are the same lookup rather than two tables that can disagree.
 */
export interface PathPrefixLocalePolicy {
  readonly kind: 'path-prefix';
  /** The locale an address with no prefix is in. */
  readonly defaultLocale: string;
  /** Prefix by locale, which is the direction writing an address needs. */
  readonly locales: Readonly<Record<string, string>>;
  /** Locale by prefix, which is the direction reading one needs. */
  readonly prefixes: Readonly<Record<string, string>>;
  /** Locale by accepted alias, which reading also consults. */
  readonly aliases: Readonly<Record<string, string>>;
  /** The paths that carry no locale. */
  readonly localeNeutralRoots: readonly string[];
  /** Whether the default locale is written without its prefix. */
  readonly omitDefaultPrefix: boolean;
  /** Where `x-default` points. */
  readonly xDefaultPath?: string;
}

/**
 * What building a locale-neutral policy takes, where one address serves every locale.
 *
 * The locale comes from the reader rather than from the URL, so a page cannot be linked to in a
 * particular language and a crawler sees one page where there are several. Choose it deliberately.
 */
export interface LocaleNeutralPolicyOptions {
  /** The locale to serve when nothing about the reader says otherwise. */
  readonly defaultLocale: string;
  /** Every locale this application serves. */
  readonly locales: readonly string[];
  /** Paths outside localization altogether. */
  readonly localeNeutralRoots?: readonly string[];
  /** Where `x-default` points. Must not change origin. */
  readonly xDefaultPath?: string;
}

/** A checked locale-neutral policy, built by `createLocaleNeutralPolicy`. */
export interface LocaleNeutralPolicy {
  readonly kind: 'locale-neutral';
  /** The locale served when nothing about the reader says otherwise. */
  readonly defaultLocale: string;
  /** The supported locales, each mapping to the empty prefix this policy gives them all. */
  readonly locales: Readonly<Record<string, ''>>;
  /** The paths outside localization. */
  readonly localeNeutralRoots: readonly string[];
  /** Where `x-default` points. */
  readonly xDefaultPath?: string;
}

/**
 * What building a host policy takes, where each locale has an origin of its own.
 *
 * Changing locale is a document navigation under this policy, because the new address is on another
 * origin. A change reports `redirected` rather than committing in place.
 */
export interface HostLocalePolicyOptions {
  /** The locale of the origin treated as the primary one. */
  readonly defaultLocale: string;
  /** The origin each locale lives on, keyed by locale. Origins must be distinct and HTTP. */
  readonly origins: Readonly<Record<string, string>>;
  /** Paths outside localization on every origin. */
  readonly localeNeutralRoots?: readonly string[];
  /** The absolute URL `x-default` points at. */
  readonly xDefaultUrl?: string;
}

/** A checked host policy, built by `createHostLocalePolicy`. */
export interface HostLocalePolicy {
  readonly kind: 'locale-host';
  /** The primary origin's locale. */
  readonly defaultLocale: string;
  /** Origin by locale, which is the direction writing an address needs. */
  readonly locales: Readonly<Record<string, string>>;
  /** Locale by origin, which is the direction reading a request needs. */
  readonly origins: Readonly<Record<string, string>>;
  /** The paths outside localization. */
  readonly localeNeutralRoots: readonly string[];
  /** Where `x-default` points. */
  readonly xDefaultUrl?: string;
}

/**
 * How an address says which locale it is in: a prefix, nothing at all, or the origin.
 *
 * One of these is chosen per application and everything about addresses follows from it. Check
 * `kind` to tell them apart; build one with the matching factory rather than by hand, so the
 * prefixes and origins are checked before anything is published under them.
 */
export type LocaleUrlPolicy =
  | PathPrefixLocalePolicy
  | LocaleNeutralPolicy
  | HostLocalePolicy;

/** What is known about the request an address is being resolved for. */
export interface RouteResolutionContext {
  /** The locale to read the address in, when the caller already knows it. */
  readonly locale?: string;
  /** The origin the request arrived on, which under a host policy is what names the locale. */
  readonly origin?: string;
}

/**
 * The route table plus everything that varies per locale: spellings, codecs, and retired routes.
 *
 * The generated half comes from the build. The other three are supplied by the application, because
 * they depend on data the build cannot see.
 */
export interface RouteRuntimeProjection {
  /** The route table the build derived. */
  readonly generated: GeneratedRouteProjection;
  /**
   * Paths written differently per locale, keyed by route identity and then locale.
   *
   * For a path whose segments are translated rather than shared. A route absent here is spelled the
   * same in every locale.
   */
  readonly localizedPaths?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  /** How each route's parameters are spelled and read, keyed by route identity then parameter. */
  readonly parameters?: Readonly<
    Record<string, Readonly<Record<string, RouteParameterCodec>>>
  >;
  /** What became of retired routes, keyed by the path each one was served at. */
  readonly historical?: Readonly<Record<string, RouteHistoricalOutcome>>;
}

/**
 * What happened to a route that no longer exists: it moved, or it is gone.
 *
 * A replacement produces a permanent redirect to the named route; `gone` produces a 410. Both are
 * better than a 404, which tells a crawler to keep asking.
 */
export type RouteHistoricalOutcome =
  | {
      readonly kind: 'replacement';
      readonly routeId: string;
      readonly parameters?: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'gone' };

type RouteEntriesOf<Projection> = Projection extends {
  readonly generated: { readonly routes: readonly (infer Entry)[] };
}
  ? Entry
  : never;

/**
 * The route identities a projection actually contains.
 *
 * The generated projection is written `as const`, so it already knows its own identities. What
 * lost them was assignment: `RouteRuntimeProjection` declared `id: string`, so the moment a
 * consumer stored the projection the union collapsed and `buildLocalizedRoute` became
 * `(routeId: string) => string`. A typo compiled and threw at runtime, from a function whose
 * declared return type is a string.
 *
 * A projection that was widened to the base type still resolves to `string`, which keeps the
 * permissive path working for code that holds a projection generically.
 */
export type RouteIdOf<Projection> =
  RouteEntriesOf<Projection> extends { readonly id: infer Id extends string }
    ? Id
    : string;

type RouteCodecValue<Codec> =
  Codec extends RouteParameterCodec<infer Value> ? Value : never;

type RouteCodecMapOf<Projection> = Projection extends {
  readonly parameters?: infer Codecs;
}
  ? NonNullable<Codecs>
  : Readonly<Record<never, never>>;

/**
 * The parameter values one route takes, read from the codecs that serialize them.
 *
 * `createIntegerParameterCodec` produces a `RouteParameterCodec<number>`, so the route it is
 * registered under takes a number. The value type was `unknown` before, which is how a route that
 * needs an integer accepted a string that would fail to serialize.
 */
export type RouteParametersOf<
  Projection,
  Id extends string,
> = Id extends keyof RouteCodecMapOf<Projection>
  ? {
      readonly [Name in keyof RouteCodecMapOf<Projection>[Id]]: RouteCodecValue<
        RouteCodecMapOf<Projection>[Id][Name]
      >;
    }
  : Readonly<Record<never, never>>;

/**
 * The trailing arguments of `buildLocalizedRoute`.
 *
 * A route with parameters requires them; a route without them takes none. Expressed as a tuple for
 * the same reason message inputs are: it is the only shape that makes one argument mandatory or
 * absent depending on which route was named, while keeping the arguments after it positional.
 */
export type RouteBuildArguments<Projection, Id extends string> =
  RouteParametersAreKnown<Projection, Id> extends true
    ? readonly [
        parameters: RouteParametersOf<Projection, Id>,
        query?: readonly RouteQueryValue[],
        fragment?: string,
        spellings?: LocalizedParameterSpellings,
      ]
    : readonly [
        parameters?: RouteParametersOf<Projection, Id>,
        query?: readonly RouteQueryValue[],
        fragment?: string,
        spellings?: LocalizedParameterSpellings,
      ];

/**
 * Whether this projection actually knows the route takes parameters.
 *
 * False for a route with none, and false for a projection that has been widened to the base type:
 * an index signature says "some parameters, unknown which", which is not knowledge to enforce
 * against. Code holding a projection generically keeps working exactly as before.
 */
type RouteParametersAreKnown<Projection, Id extends string> = [
  keyof RouteParametersOf<Projection, Id>,
] extends [never]
  ? false
  : string extends keyof RouteParametersOf<Projection, Id>
    ? false
    : true;

/** One query parameter, kept as a name and a value so an address can be rebuilt as it was. */
export interface RouteQueryValue {
  /** The parameter's name, already decoded. */
  readonly name: string;
  /** Its value, already decoded. */
  readonly value: string;
}

/**
 * A resolution whose route identity and parameters are the ones this projection declares.
 *
 * `RouteResolution` widens both: `routeId` is `string` and `parameters` is
 * `Readonly<Record<string, unknown>>`, so everything a generated projection knows about itself was
 * thrown away on the way out, and feeding a resolution back into `buildLocalizedRoute`, which is
 * generic and does keep the literals, needed a cast at the join. A cast there is not a formality:
 * it is the one place a typo in a route identity would otherwise be caught, and `buildLocalizedRoute`
 * exists to catch it.
 *
 * Distributed over the identities rather than written as one member, so each identity is paired
 * with its own parameters. A single member holding `RouteIdOf<Projection>` beside a union of every
 * route's parameters would type-check `{ routeId: 'home', parameters: { id: 42 } }`, which is the
 * mismatch this is for.
 *
 * Only the `success` branch is narrowed. The others name no route the caller can build from, and
 * `redirect` deliberately keeps `routeId` optional and wide: locale entry redirects an address to a
 * locale whether or not this application has a page there, so its identity is not drawn from the
 * projection at all.
 */
export type LocalizedRouteResolution<Projection> =
  | (RouteIdOf<Projection> extends infer Id
      ? Id extends string
        ? Omit<
            Extract<RouteResolution, { readonly status: 'success' }>,
            'routeId' | 'parameters'
          > & {
            readonly routeId: Id;
            readonly parameters: RouteParametersOf<Projection, Id>;
          }
        : never
      : never)
  | Exclude<RouteResolution, { readonly status: 'success' }>;

/**
 * Every answer this module can give about an address.
 *
 * **Narrowing this union: use `Exclude`, not `Extract`, and read this first.** One member below
 * carries `status: 'unsupported-locale' | 'not-found'`. A discriminant that is itself a union. A
 * member like that is *not assignable* to a narrower object type, so
 * `Extract<RouteResolution, { status: 'success' | 'not-found' | 'gone' }>` silently omits it and
 * yields only `success` and `gone`.
 *
 * That is a TypeScript fact rather than a fact about this union, and it recurs wherever a
 * discriminated union is narrowed this way. What makes it worth a comment is how it fails: it
 * compiles, it reads as exhaustive, and a type guard written against the result claims a type the
 * runtime does not honour. `hasBody` returned `true` for a `not-found` the type said could not be
 * One. Nothing reports it. `Exclude` states which members are out and cannot drop a member by
 * accident, so prefer it whenever the discriminant might not be a single literal.
 */
export type RouteResolution =
  | {
      readonly status: 'success';
      readonly locale: string;
      readonly direction: LocaleDirection;
      readonly routeId: string;
      readonly parameters: Readonly<Record<string, unknown>>;
      readonly canonicalPath: string;
      readonly canonicalUrl?: string;
      readonly query: readonly RouteQueryValue[];
      readonly fragment?: string;
      readonly indexing: RouteIndexingClass;
      /**
       * Present when this address answers for more than one locale, so which document it returns
       * depended on a preference the address does not state.
       *
       * Structural to `locale-neutral`, which is the policy whose whole premise is one address per
       * page. Under `path-prefix` and `locale-host` the address states the locale, every request to
       * it gets the same document, and this is absent.
       */
      readonly variesBy?: 'locale-preference';
    }
  | {
      readonly status: 'redirect';
      readonly reason: 'locale-entry' | 'canonical-correction' | 'replacement';
      readonly httpStatus: 307 | 308;
      readonly location: string;
      // 'public' is reachable only for a redirect whose answer is the same for every request,
      // which is a property of the address rather than of the request that arrived at it. A
      // canonical correction qualifies: every request to a misspelled address gets the same
      // correction. Locale entry never does: one address carries every locale's answer.
      readonly cache:
        | 'public'
        | 'private-no-store'
        | 'consumer-defined-permanent';
      readonly locale: string;
      /**
       * Absent when the redirect names no route, which locale entry does not require: an address
       * carrying no locale is sent to one whether or not this application has a page at it, and
       * the localized address that results is what answers.
       */
      readonly routeId?: string;
    }
  | {
      readonly status: 'unsupported-locale' | 'not-found';
      readonly httpStatus: 404;
      readonly presentationLocale: string;
      readonly requestedLocale?: string;
    }
  | {
      readonly status: 'gone';
      readonly httpStatus: 410;
      readonly presentationLocale: string;
    }
  | {
      readonly status: 'malformed';
      readonly httpStatus: 400;
      readonly presentationLocale: string;
      readonly diagnostic: LocalizationDiagnostic;
    };

/** One other language this page exists in, as an `hreflang` link wants it. */
export interface RouteAlternate {
  /** The locale this alternate is in. */
  readonly locale: string;
  /** What the `hreflang` attribute carries, which is the locale in the form the format wants. */
  readonly hreflang: string;
  /** The absolute URL of this page in that locale. */
  readonly url: string;
}

/**
 * Everything a page's head needs to say about where else it exists: canonical, alternates,
 * x-default, and whether to index it at all.
 *
 * Computed from the policy and the route table, so the set is complete and mutual by construction.
 * Alternates written by hand go stale the moment a locale is added, and a page that lists itself
 * among its own alternates asymmetrically is ignored by crawlers without any error being raised.
 */
export interface RouteSeoProjection {
  /** What this page says to a crawler. */
  readonly indexing: RouteIndexingClass;
  /** This page's own preferred address. Absent for a page that should not be indexed. */
  readonly canonical?: string;
  /** The other locales this page exists in, each an absolute URL. Empty for a private page. */
  readonly alternates: readonly RouteAlternate[];
  /** Where a reader whose language is none of the alternates should be sent. */
  readonly xDefault?: string;
  /** The `robots` value to emit, present only for a page that should not be indexed. */
  readonly robots?: 'noindex' | 'noindex, nofollow';
}

/**
 * The response a server should send for one address: its status, its headers, and its caching.
 *
 * Derived from resolving the address rather than decided by the application, because whether an
 * address redirects, is gone, or may be held in a shared cache is a conclusion about Atlas's own
 * routing. How long it may be held is the deployment's, and `routeCacheHeaders` takes that.
 */
export interface RouteHttpDescriptor {
  /** The status to send. */
  readonly status: 200 | 307 | 308 | 400 | 404 | 410;
  /** Where to send the reader, on a redirect. */
  readonly location?: string;
  /** The `Content-Language` value, which follows the locale actually being served. */
  readonly contentLanguage?: string;
  /** The `robots` value, present only where the page should not be indexed. */
  readonly robots?: 'noindex' | 'noindex, nofollow';
  /** How it may be cached, which is a conclusion about the address rather than a setting. */
  readonly cache:
    | 'public'
    | 'private-no-store'
    | 'consumer-defined-permanent'
    | 'varies-by-locale-preference';
}

/**
 * How long this application's infrastructure holds a response Atlas has said may be shared.
 *
 * Only the two shared classifications take a number, and neither number is one Atlas could pick:
 * how long a CDN should hold a page, or a permanent correction, is a fact about a deployment.
 * `private-no-store` takes none, because a response that is never stored has no freshness.
 *
 * The durations alone, without the one fact only the caller knows, because a caller that reads
 * the request derives that fact rather than being told it, and the handler in
 * `@neolorn/atlas/http` does exactly that.
 */
export interface RouteCacheDurations {
  /** Seconds a shared cache may serve a successful localized response before revalidating. */
  readonly successMaxAge: number;
  /** Seconds a shared cache may serve a permanent canonical correction or replacement. */
  readonly permanentRedirectMaxAge: number;
  /**
   * Whether a shared cache must revalidate a stale successful response rather than serve it.
   *
   * Defaults to `true`, which is the safe answer for a representation whose content can change
   * under an unchanged URL: a retranslated page is the ordinary case here, not an exotic one.
   */
  readonly revalidateSuccess?: boolean;
}

/**
 * The durations, plus where this deployment reads a locale preference.
 *
 * What a caller that cannot see the request has to state, so one rule holds at two levels: a fact
 * is derived by whoever can observe it and supplied by whoever cannot.
 */
export interface RouteCacheFreshness extends RouteCacheDurations {
  /**
   * Where the host reads a visitor's locale preference, which is the one fact in this file Atlas
   * cannot derive: it never sees the request.
   *
   * Required, with no default, because every possible default is wrong for somebody and the wrong
   * one is silent. It decides whether an answer that varied by locale can be held by a shared cache
   * at all.
   */
  readonly localePreference: LocalePreferenceSource;
}

/**
 * Where a locale preference was read from, and therefore what a shared cache can do with it.
 *
 * A closed set of three rather than a header name, and that is the point rather than a
 * simplification. `Vary: Cookie` is not a thing Atlas will emit: MDN's guidance for content
 * personalized by cookie is `Cache-Control: private` instead, because cookies carry everything and
 * a cache keyed on the whole of one stores a variant per visitor, which is not a shared cache. So
 * there is no input here that names a header, and `Vary: Cookie` is not a value this function can
 * be asked to produce. A type that cannot express the mistake beats a check that rejects it.
 *
 * - `'accept-language'`: standard content negotiation. A shared cache can hold one variant per
 *   language, and `Vary: Accept-Language` is what tells it to.
 * - `'cookie'`: a cookie, or anything else request-specific. Not shared-cacheable.
 * - `'none'`: the host never consults a preference, so nothing varies.
 */
export type LocalePreferenceSource = 'none' | 'accept-language' | 'cookie';

/**
 * The response headers Atlas determines, by lowercase name.
 *
 * A map rather than a string, because `Cache-Control` stopped being the only header the
 * classification implies the moment `Vary` became one of the answers. A consumer writes them with
 * one loop and gains a header Atlas adds later without changing a line; a consumer handed a string
 * plus an optional second value has a branch to forget, which is the shape 6.3 removed.
 */
export interface RouteCacheHeaders {
  /** The `Cache-Control` value. */
  readonly 'cache-control': string;
  /** The `Vary` value, present only where the answer depends on what the reader asked for. */
  readonly vary?: string;
}

/**
 * The `Cache-Control` value for a resolved route, given the freshness this deployment chose.
 *
 * Two different questions live in that header and only one of them is the consumer's. **Whether a
 * shared cache may hold this response at all** is a conclusion about Atlas's own routing: an entry
 * address carries a different answer per preference, a canonical correction is the same answer
 * forever, a malformed target is nobody's to keep. A consumer retyping that conclusion cannot
 * improve on it and can only diverge from it. **How long** a shared cache should then hold one is a
 * fact about a deployment (traffic, budget, how often content is retranslated) that Atlas has no
 * basis to guess.
 *
 * So the storability half is emitted and the freshness half is taken as an argument. What this
 * replaces is a mapping every consumer wrote by hand from the three classifications to three
 * directive strings, which failed in a way nothing could catch: a conditional chain always has a
 * final branch, so a mapping that has stopped covering the cases still compiles and still answers.
 * When a classification changes meaning, and locale entry's did, every hand-written mapping is
 * silently wrong with no signal anywhere.
 *
 * `descriptor.cache` remains exported for a consumer who wants the classification and nothing else,
 * and this sets no header: writing it onto a response is the host's, as is deciding not to.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 16 draws that line and requires the result
 * to be a set of headers by name rather than one header's text, so a consumer writes the set with
 * one loop and gains a header a later release adds without changing a line.
 */
export function routeCacheHeaders(
  descriptor: RouteHttpDescriptor,
  freshness: RouteCacheFreshness,
): RouteCacheHeaders {
  switch (descriptor.cache) {
    case 'public':
      return Object.freeze({ 'cache-control': successDirective(freshness) });
    case 'consumer-defined-permanent':
      return Object.freeze({
        'cache-control': `public, max-age=${wholeSeconds(freshness.permanentRedirectMaxAge, 'permanentRedirectMaxAge')}`,
      });
    case 'private-no-store':
      return Object.freeze({ 'cache-control': 'private, no-store' });
    case 'varies-by-locale-preference':
      switch (freshness.localePreference) {
        case 'accept-language':
          return Object.freeze({
            'cache-control': successDirective(freshness),
            vary: 'Accept-Language',
          });
        case 'cookie':
          return Object.freeze({ 'cache-control': 'private, no-store' });
        case 'none':
          routeError(
            'This response varied by locale preference and `localePreference` is `none`, which are two statements that cannot both be true. Atlas resolved a locale from a preference the host supplied, so the host reads one somewhere; name where, so the answer can say whether a shared cache may hold it.',
          );
      }
  }
}

function successDirective(freshness: RouteCacheFreshness): string {
  return `public, max-age=${wholeSeconds(freshness.successMaxAge, 'successMaxAge')}${
    freshness.revalidateSuccess === false ? '' : ', must-revalidate'
  }`;
}

function wholeSeconds(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    routeError(
      `\`${field}\` is a whole number of seconds and cannot be ${JSON.stringify(value)}. A cache reads this as a delta-seconds value, and a fractional or negative one is not one.`,
    );
  }
  return value;
}

/**
 * A configuration failure, carrying what the caller knew about it.
 *
 * Both optional arguments were accepted and dropped: five call sites hand this the parser's own
 * error and the reason `'malformed-input'`, and none of it reached the thrown diagnostic, whose
 * `reason` field and whose `cause` option are both part of the published contract. Turning
 * `noUnusedParameters` on is what reported it.
 */
function routeError(
  message: string,
  reason?: LocalizationDiagnostic['reason'],
  cause?: unknown,
): never {
  throw new LocalizationError(
    Object.freeze({
      code: 'invalid-configuration',
      outcome: 'operational-failure',
      message,
      ...(reason === undefined ? {} : { reason }),
    }),
    cause === undefined ? undefined : { cause },
  );
}

function canonicalLocale(value: string): string {
  try {
    return Intl.getCanonicalLocales(value)[0] as string;
  } catch (cause) {
    return routeError(
      `Route locale ${JSON.stringify(value)} is invalid.`,
      'malformed-input',
      cause,
    );
  }
}

function validPrefix(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}

/**
 * The locales this build produced, which is not the same question as the locales the policy
 * addresses.
 *
 * A locale URL policy is a source file. It says where a locale lives *if the build has it*, and it
 * is the same file in every build. What a build actually generated catalogs for is in the generated
 * configuration, and that varies: a pseudo-locale exists only in a build that asked for one, and
 * an ordinary locale exists only once someone has configured it. Atlas publishes addresses from the
 * first and had no way to consult the second, so a locale the policy named and the build never
 * generated got a prerendered file, a server route and an `hreflang` link, all pointing at a locale
 * that resolves to nothing and redirects away.
 *
 * So the policy states intent and the configuration decides. Both callers pass the same generated
 * `configuration` the application's own `provideLocalization()` received; it is not a list to keep
 * in step by hand.
 *
 * The default locale is checked rather than filtered. Dropping it would leave an application with
 * no addresses at all under a prefixing policy, which reads as a build that produced nothing rather
 * than as the mismatch it is, and a configuration that does not contain the locale its own policy
 * makes default is the one form of "you passed a different configuration here than you passed
 * `provideLocalization()`" that this function can see from inside a single call.
 */
function builtLocales(
  policy: LocaleUrlPolicy,
  configuration: GeneratedConfiguration,
): ReadonlySet<string> {
  const built = new Set(configuration.locales.map(canonicalLocale));
  const defaultLocale = canonicalLocale(policy.defaultLocale);
  if (!built.has(defaultLocale)) {
    routeError(
      `This policy makes ${JSON.stringify(policy.defaultLocale)} the default locale and the generated configuration passed alongside it lists ${configuration.locales.map((locale) => JSON.stringify(locale)).join(', ')}. Pass the same generated configuration the application's own \`provideLocalization()\` received, or add the locale to it.`,
    );
  }
  return built;
}

/**
 * The policy as this build can actually serve it.
 *
 * A policy is written by hand and states intent: these are the locales this application means to
 * have, spelled this way in a URL. The generated configuration states fact: these are the locales
 * whose catalogs exist. The two are allowed to disagree (a locale is given an address before its
 * translations land, or dropped from the configuration and left in the policy) and every place
 * Atlas turns the policy into a published address has to answer for the disagreement.
 *
 * Filtering at each such place answers it once per place and misses the next one. Matching any
 * prefix the policy names means a build with no German catalog answers `/de/zweite` with a 200,
 * German-labelled markup with English text inside it, and honours a stored `de-DE` preference with
 * a 307 to an address like it.
 *
 * So the intersection is a value rather than a step. Narrow once, here, and every function that
 * takes a policy is right by construction, including the ones not written yet, which is the
 * property a per-site filter cannot have. `provideLocalization` narrows what it provides, so an
 * application inside Angular gets this without doing anything; a server entry that resolves routes
 * before Angular boots narrows once, beside where it reads its own configuration.
 *
 * The tables move together, which is the other reason this is one function rather than a set. A
 * path-prefix policy carries `locales` keyed by locale, `prefixes` keyed by the URL segment, and
 * `aliases` keyed by an older segment: dropping a locale from the first and leaving the second
 * would leave an address that matches with nothing behind it, and leaving the third would leave a
 * redirect aimed at a locale that no longer resolves.
 *
 * Throws when the policy's default locale is not in the build. That is the one disagreement no
 * narrowing can resolve, because what it leaves behind is an application with nothing to fall back
 * to.
 */
// Overloads rather than a type parameter, so a caller holding one kind of policy is handed the
// same kind back and never re-narrows what it already knew. A generic would have to spread a type
// parameter and assert the result, which is the one thing this function must not do: an assertion
// here would be believed by every caller.
export function builtLocalePolicy(
  policy: PathPrefixLocalePolicy,
  configuration: GeneratedConfiguration,
): PathPrefixLocalePolicy;
export function builtLocalePolicy(
  policy: LocaleNeutralPolicy,
  configuration: GeneratedConfiguration,
): LocaleNeutralPolicy;
export function builtLocalePolicy(
  policy: HostLocalePolicy,
  configuration: GeneratedConfiguration,
): HostLocalePolicy;
export function builtLocalePolicy(
  policy: LocaleUrlPolicy,
  configuration: GeneratedConfiguration,
): LocaleUrlPolicy;
export function builtLocalePolicy(
  policy: LocaleUrlPolicy,
  configuration: GeneratedConfiguration,
): LocaleUrlPolicy {
  const built = builtLocales(policy, configuration);
  const retain = <Value extends string>(
    table: Readonly<Record<string, Value>>,
    localeOf: (key: string, value: Value) => string,
  ): Readonly<Record<string, Value>> =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(table).filter(([key, value]) =>
          built.has(canonicalLocale(localeOf(key, value))),
        ),
      ),
    );
  const keyed = (key: string): string => key;
  const valued = <Value extends string>(_key: string, value: Value): string =>
    value;
  if (policy.kind === 'locale-host') {
    return Object.freeze({
      ...policy,
      locales: retain(policy.locales, keyed),
      origins: retain(policy.origins, valued),
    });
  }
  if (policy.kind === 'locale-neutral') {
    return Object.freeze({
      ...policy,
      locales: retain(policy.locales, keyed),
    });
  }
  return Object.freeze({
    ...policy,
    locales: retain(policy.locales, keyed),
    prefixes: retain(policy.prefixes, valued),
    aliases: retain(policy.aliases, valued),
  });
}

/**
 * Builds a path-prefix policy from its options, checking every prefix before anything is published.
 *
 * Refuses a duplicate locale, a prefix that collides with another, a prefix that is not a usable
 * path segment, an alias naming an unsupported locale, a default locale that is not among the
 * locales, and an `x-default` that changes origin. Throws a `LocalizationError` on each.
 *
 * The result is frozen, and resolves the prefix table in both directions so reading an address and
 * writing one cannot disagree.
 */
export function createPathPrefixLocalePolicy(
  options: PathPrefixLocalePolicyOptions,
): PathPrefixLocalePolicy {
  const localeEntries = Object.entries(options.locales);
  if (localeEntries.length === 0)
    routeError('A route policy requires locales.');
  const locales: Record<string, string> = {};
  const prefixes: Record<string, string> = {};
  const occupied = new Set<string>();
  for (const [localeValue, prefix] of localeEntries) {
    const locale = canonicalLocale(localeValue);
    if (
      locales[locale] !== undefined ||
      !validPrefix(prefix) ||
      occupied.has(prefix)
    ) {
      routeError(
        `Route locale prefix ${JSON.stringify(prefix)} is invalid or colliding.`,
      );
    }
    occupied.add(prefix);
    locales[locale] = prefix;
    prefixes[prefix] = locale;
  }
  const defaultLocale = canonicalLocale(options.defaultLocale);
  if (locales[defaultLocale] === undefined) {
    routeError('The route default locale must be supported.');
  }
  const neutral = (options.localeNeutralRoots ?? []).map((value) => {
    if (!validPrefix(value) || occupied.has(value)) {
      return routeError(
        `Locale-neutral root ${JSON.stringify(value)} is invalid or colliding.`,
      );
    }
    occupied.add(value);
    return value;
  });
  const aliases: Record<string, string> = {};
  for (const [alias, targetValue] of Object.entries(options.aliases ?? {})) {
    const target = canonicalLocale(targetValue);
    if (
      !validPrefix(alias) ||
      occupied.has(alias) ||
      locales[target] === undefined
    ) {
      routeError(
        `Route locale alias ${JSON.stringify(alias)} is invalid or colliding.`,
      );
    }
    occupied.add(alias);
    aliases[alias] = target;
  }
  const xDefaultPath = trustedXDefaultPath(options.xDefaultPath);
  return Object.freeze({
    kind: 'path-prefix',
    defaultLocale,
    locales: Object.freeze(locales),
    prefixes: Object.freeze(prefixes),
    aliases: Object.freeze(aliases),
    localeNeutralRoots: Object.freeze(neutral),
    omitDefaultPrefix: options.omitDefaultPrefix ?? false,
    ...(xDefaultPath === undefined ? {} : { xDefaultPath }),
  });
}

/**
 * Builds a path-prefix policy whose default locale is written without a prefix.
 *
 * The common arrangement: the primary language sits at the root and the others under a segment.
 * The same checks apply as for `createPathPrefixLocalePolicy`.
 */
export function createDefaultLocalePrefixPolicy(
  options: Omit<PathPrefixLocalePolicyOptions, 'omitDefaultPrefix'>,
): PathPrefixLocalePolicy {
  return createPathPrefixLocalePolicy({
    ...options,
    omitDefaultPrefix: true,
  });
}

/**
 * The one definition of what an origin Atlas will write into an address has to be.
 *
 * Every value that reaches here is concatenated with a route's own path and published: a canonical
 * URL, an `hreflang` alternate, an `x-default`. Credentials in one of those are written into a
 * document head; a path, query or fragment in one produces an address nothing serves; a scheme
 * that is not HTTP is a destination the browser will not treat as a page.
 *
 * It returns the parsed URL rather than the origin string, because the caller that builds addresses
 * needs the object and re-parsing a value that was just parsed is a second place for the two
 * readings to differ. Callers that want the normalized text take `.origin`.
 */
function trustedOrigin(value: string, label: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch (cause) {
    return routeError(
      `${label} must be a trusted absolute HTTP origin.`,
      'malformed-input',
      cause,
    );
  }
  if (!['http:', 'https:'].includes(origin.protocol)) {
    routeError(`${label} must use HTTP or HTTPS.`);
  }
  if (
    origin.username.length > 0 ||
    origin.password.length > 0 ||
    origin.pathname !== '/' ||
    origin.search.length > 0 ||
    origin.hash.length > 0
  ) {
    routeError(`${label} must be a credential-free HTTP origin only.`);
  }
  return origin;
}

function neutralRoots(
  values: readonly string[] | undefined,
): readonly string[] {
  const roots = new Set<string>();
  for (const value of values ?? []) {
    if (!validPrefix(value) || roots.has(value)) {
      routeError(
        `Locale-neutral root ${JSON.stringify(value)} is invalid or colliding.`,
      );
    }
    roots.add(value);
  }
  return Object.freeze([...roots]);
}

function trustedXDefaultPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u001f\u007f]/u.test(value)
  ) {
    routeError('x-default must be an origin-relative trusted path.');
  }
  try {
    if (
      new URL(value, 'https://atlas.invalid').origin !== 'https://atlas.invalid'
    ) {
      routeError('x-default cannot change origin.');
    }
  } catch (cause) {
    routeError(
      'x-default must be a valid origin-relative path.',
      'malformed-input',
      cause,
    );
  }
  return value;
}

/**
 * Builds a locale-neutral policy, where one address serves every locale.
 *
 * Refuses a duplicate locale, an empty locale list, a default locale that is not among them, and an
 * `x-default` that changes origin. Throws a `LocalizationError` on each.
 */
export function createLocaleNeutralPolicy(
  options: LocaleNeutralPolicyOptions,
): LocaleNeutralPolicy {
  const locales: Record<string, ''> = {};
  for (const value of options.locales) {
    const locale = canonicalLocale(value);
    if (locales[locale] !== undefined) {
      routeError(
        `Locale-neutral policy locale ${JSON.stringify(locale)} is duplicated.`,
      );
    }
    locales[locale] = '';
  }
  if (Object.keys(locales).length === 0) {
    routeError('A locale-neutral policy requires locales.');
  }
  const defaultLocale = canonicalLocale(options.defaultLocale);
  if (locales[defaultLocale] === undefined) {
    routeError('The locale-neutral default locale must be supported.');
  }
  return Object.freeze({
    kind: 'locale-neutral',
    defaultLocale,
    locales: Object.freeze(locales),
    localeNeutralRoots: neutralRoots(options.localeNeutralRoots),
    ...(trustedXDefaultPath(options.xDefaultPath) === undefined
      ? {}
      : { xDefaultPath: options.xDefaultPath }),
  });
}

/**
 * Builds a host policy, where each locale has an origin of its own.
 *
 * Every origin is checked before it can be written into a published address: it must be HTTP, must
 * carry no credentials, path, query or fragment, and must be unique, as must each locale. A
 * default locale outside the set is refused. Throws a `LocalizationError` on each.
 */
export function createHostLocalePolicy(
  options: HostLocalePolicyOptions,
): HostLocalePolicy {
  const locales: Record<string, string> = {};
  const origins: Record<string, string> = {};
  for (const [localeValue, originValue] of Object.entries(options.origins)) {
    const locale = canonicalLocale(localeValue);
    const origin = trustedOrigin(originValue, `Origin for ${locale}`).origin;
    if (locales[locale] !== undefined || origins[origin] !== undefined) {
      routeError(
        'Locale-specific origins must be unique by locale and origin.',
      );
    }
    locales[locale] = origin;
    origins[origin] = locale;
  }
  if (Object.keys(locales).length === 0) {
    routeError('A host locale policy requires origins.');
  }
  const defaultLocale = canonicalLocale(options.defaultLocale);
  if (locales[defaultLocale] === undefined) {
    routeError('The host default locale must be supported.');
  }
  const xDefaultUrl =
    options.xDefaultUrl === undefined
      ? undefined
      : trustedOrigin(options.xDefaultUrl, 'x-default URL').origin;
  return Object.freeze({
    kind: 'locale-host',
    defaultLocale,
    locales: Object.freeze(locales),
    origins: Object.freeze(origins),
    localeNeutralRoots: neutralRoots(options.localeNeutralRoots),
    ...(xDefaultUrl === undefined ? {} : { xDefaultUrl }),
  });
}

/**
 * The hostnames a policy serves, for `@angular/ssr`'s `allowedHosts`.
 *
 * A `locale-host` policy is a list of origins, and the server has to be told the same list a second
 * time: `@angular/ssr` answers `400` before the application runs for any `Host` header it does not
 * recognise, and it recognises loopback and nothing else by default. So a host policy that works in
 * development stops working the moment it is served under its own domains, and the failure arrives
 * as a `400` with no mention of localization in it.
 *
 * **Atlas cannot check this one.** The server configuration is not reachable from a build, so there
 * is no point at which a mismatch could be refused the way `provideLocalizedRouter`'s `origin` is.
 * What is left is to make the second registration a copy of the first rather than a second list
 * someone maintains: this derives it, and the consumer passes it once.
 *
 * Hostnames, not origins and not hosts. `@angular/ssr` parses the `Host` header and compares its
 * `hostname`, so a scheme or a port in the value would never match anything. Measured against
 * `isHostAllowed` rather than inferred from the option's name.
 *
 * The two path policies serve one origin, which needs no entry, so this is empty for them. That is
 * the correct answer rather than an omission: a consumer who switches policy kinds keeps one line
 * that keeps saying the truth.
 */
export function allowedLocaleHosts(policy: LocaleUrlPolicy): readonly string[] {
  if (policy.kind !== 'locale-host') return Object.freeze([]);
  return Object.freeze(
    Object.keys(policy.origins).map((origin) => new URL(origin).hostname),
  );
}

/**
 * A codec for a parameter that is the same text in every locale, such as an identifier or a slug.
 *
 * The default pattern accepts up to 128 characters of unreserved URL text starting with a letter or
 * a digit. Supply a pattern to narrow it. A global or sticky pattern is refused: a lastIndex
 * carried between calls makes the same text match on one call and not the next.
 *
 * `parse` reports a refusal rather than throwing, which resolves to a not-found. `serialize` throws
 * a `LocalizationError` on a value the pattern refuses: writing an address Atlas cannot read back
 * is worse than failing where the mistake is.
 */
export function createIdentifierParameterCodec(
  pattern: RegExp = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u,
): RouteParameterCodec<string> {
  if (pattern.global || pattern.sticky) {
    routeError('A route parameter pattern cannot be global or sticky.');
  }
  return Object.freeze({
    parse: (value: string) =>
      Object.freeze(
        pattern.test(value) ? { ok: true, value } : { ok: false },
      ) as RouteParameterParseResult<string>,
    serialize: (value: string) => {
      if (!pattern.test(value)) {
        return routeError('A route parameter value violates its codec.');
      }
      return value;
    },
  });
}

/**
 * A codec for a whole-number parameter, bounded by the range given.
 *
 * The bounds must be safe integers and ordered; anything else throws a `LocalizationError` when the
 * codec is built. Text outside the range, or carrying anything but digits and a leading sign, is
 * refused by `parse` and resolves to a not-found. `serialize` throws on a value out of range.
 */
export function createIntegerParameterCodec(
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): RouteParameterCodec<number> {
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum > maximum
  ) {
    routeError(
      'An integer route parameter codec requires an ordered safe range.',
    );
  }
  return Object.freeze({
    parse: (value: string) => {
      if (!/^-?[0-9]{1,64}$/u.test(value)) {
        return Object.freeze({ ok: false });
      }
      const parsed = Number(value);
      return Object.freeze(
        Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
          ? { ok: true, value: parsed }
          : { ok: false },
      );
    },
    serialize: (value: number) => {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        return routeError(
          'An integer route parameter is outside its codec range.',
        );
      }
      return String(value);
    },
  });
}

function parameterNames(path: string): readonly string[] {
  return Object.freeze(
    path
      .split('/')
      .filter((segment) => segment.startsWith(':'))
      .map((segment) => segment.slice(1)),
  );
}

function safePresentationPath(path: string, localized = false): boolean {
  return !(
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('//') ||
    (path.length > 0 &&
      path
        .split('/')
        .some((segment) =>
          segment.startsWith(':')
            ? !/^:[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(segment)
            : localized
              ? segment.length > 128 ||
                segment.normalize('NFC') !== segment ||
                !/^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,126}[\p{L}\p{N}\p{M}])?$/u.test(
                  segment,
                )
              : !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u.test(segment),
        ))
  );
}

function presentationPath(
  projection: RouteRuntimeProjection,
  route: GeneratedRouteProjectionEntry,
  locale: string,
): string {
  return projection.localizedPaths?.[route.id]?.[locale] ?? route.path;
}

function parameterContext(
  routeId: string,
  parameterName: string,
  locale?: string,
): RouteParameterContext {
  return Object.freeze({
    routeId,
    parameterName,
    ...(locale === undefined ? {} : { locale }),
  });
}

function safeParameterSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.normalize('NFC') === value &&
    value !== '.' &&
    value !== '..' &&
    !/[\u0000-\u001f\u007f\\/]/u.test(value)
  );
}

function checkRouteProjection(
  projection: RouteRuntimeProjection,
): RouteRuntimeProjection {
  // Generated code carries the profile it was written under, and this reads what it carries.
  const profile: unknown = projection.generated.profile;
  if (
    profile !== ROUTE_PROJECTION_PROFILE ||
    !/^sha256-[A-Za-z0-9_-]{43}$/u.test(projection.generated.identity)
  ) {
    routeError(
      'The generated route projection profile or identity is invalid.',
    );
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const route of projection.generated.routes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(route.id)) {
      routeError(
        `Generated route identity ${JSON.stringify(route.id)} is invalid.`,
      );
    }
    if (ids.has(route.id) || paths.has(route.path)) {
      routeError('Generated route identities and paths must be unique.');
    }
    ids.add(route.id);
    paths.add(route.path);
    if (!safePresentationPath(route.path)) {
      routeError(
        `Generated route ${route.id} has an unsafe presentation path.`,
      );
    }
    if (
      route.indexing !== undefined &&
      !['indexable', 'non-indexable', 'private'].includes(route.indexing)
    ) {
      routeError(`Generated route ${route.id} has an invalid indexing class.`);
    }
    const discovered = parameterNames(route.path);
    if (
      new Set(discovered).size !== discovered.length ||
      discovered.length !== route.parameterNames.length ||
      discovered.some((name, index) => route.parameterNames[index] !== name)
    ) {
      routeError(`Generated route ${route.id} has inconsistent parameters.`);
    }
    const codecs = projection.parameters?.[route.id] ?? {};
    for (const name of discovered) {
      if (codecs[name] === undefined) {
        routeError(`Dynamic route ${route.id} requires a codec for ${name}.`);
      }
    }
  }
  const localizedLocales = new Set<string>();
  for (const [routeId, localized] of Object.entries(
    projection.localizedPaths ?? {},
  )) {
    const route = projection.generated.routes.find(({ id }) => id === routeId);
    if (route === undefined) {
      routeError(
        `Localized path configuration references unknown route ${JSON.stringify(routeId)}.`,
      );
    }
    for (const [localeValue, path] of Object.entries(localized)) {
      const locale = canonicalLocale(localeValue);
      if (
        locale !== localeValue ||
        !safePresentationPath(path, true) ||
        parameterNames(path).join('\u0000') !==
          route.parameterNames.join('\u0000')
      ) {
        routeError(
          `Localized path for ${routeId}/${localeValue} is unsafe or changes its parameter contract.`,
        );
      }
      localizedLocales.add(locale);
    }
  }
  for (const locale of localizedLocales) {
    const pathsForLocale = new Map<string, string>();
    for (const route of projection.generated.routes) {
      const path = presentationPath(projection, route, locale);
      const existing = pathsForLocale.get(path);
      if (existing !== undefined && existing !== route.id) {
        routeError(
          `Localized paths for ${existing} and ${route.id} collide in ${locale}.`,
        );
      }
      pathsForLocale.set(path, route.id);
    }
  }
  const historical = Object.entries(projection.historical ?? {});
  if (historical.length > 256) {
    routeError('Historical route outcomes exceed Atlas bounds.');
  }
  for (const [path, outcome] of historical) {
    if (
      path.length === 0 ||
      paths.has(path) ||
      path.startsWith('/') ||
      path.endsWith('/') ||
      path.includes('//') ||
      path
        .split('/')
        .some(
          (segment) =>
            !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u.test(segment),
        )
    ) {
      routeError(
        `Historical route path ${JSON.stringify(path)} is unsafe or colliding.`,
      );
    }
    if (outcome.kind === 'replacement') {
      const target = projection.generated.routes.find(
        ({ id }) => id === outcome.routeId,
      );
      if (target === undefined) {
        routeError(
          `Historical replacement target ${outcome.routeId} is unavailable.`,
        );
      }
      for (const name of target.parameterNames) {
        const codec = projection.parameters?.[target.id]?.[name];
        const value = outcome.parameters?.[name];
        if (codec === undefined || value === undefined) {
          routeError(
            `Historical replacement ${path} requires parameter ${name}.`,
          );
        }
        const serialized = codec.serialize(
          value,
          parameterContext(target.id, name),
        );
        if (serialized !== undefined && !safeParameterSegment(serialized)) {
          routeError(
            `Historical replacement ${path} has an unsafe parameter ${name}.`,
          );
        }
      }
    }
  }
  return projection;
}

/** One route as a lookup sees it: the entry, its place in the table, and its spelling here. */
interface IndexedRoute {
  readonly route: GeneratedRouteProjectionEntry;
  readonly order: number;
  readonly pattern: readonly string[];
}

/**
 * Every route a locale can present, arranged for the question a request asks.
 *
 * `keyed` answers the ordinary case in one lookup. A route whose every segment is written in the
 * lower-case alphanumeric spelling a generated path is restricted to matches a request exactly when
 * the request's segments fold to the same thing, so the folded spelling is the key. `scanned` holds
 * what a key cannot answer, which is every parameterized route and the localized paths written in a
 * script that has case: those still have to be offered the segments one at a time.
 */
interface RouteLocaleIndex {
  readonly keyed: ReadonlyMap<string, IndexedRoute>;
  readonly scanned: readonly IndexedRoute[];
}

/**
 * What Atlas works out about a projection the first time it is handed one.
 *
 * Worked out once rather than on every call. Validating the whole projection per resolve and per
 * URL build, then walking it again to compute each route's spelling for the locale, costs two
 * passes over every route in the application per address. That is invisible at the size a route
 * table is usually written by hand and it is the whole cost at the size Atlas is built for: twenty
 * thousand routes take thirty-two seconds to build a thousand addresses that way, and a site cannot
 * publish a sitemap it cannot finish.
 *
 * So the work happens once. Validation asks about the projection rather than about the request and
 * has one answer for as long as the object exists, and the index is that same pass kept instead of
 * thrown away. This is not a cache of matching: nothing here remembers an address or a result, and
 * two identical requests do the same work as each other. What is kept is the arrangement of the
 * routes, which is a property of the table.
 *
 * Held against the projection object rather than on it, because the type is the consumer's and a
 * field of Atlas's own would be one they can read, copy, and set. A projection that is discarded
 * takes its index with it.
 */
interface PreparedRouteProjection {
  readonly projection: RouteRuntimeProjection;
  readonly byId: ReadonlyMap<string, GeneratedRouteProjectionEntry>;
  readonly generated: RouteLocaleIndex;
  /** The locales in which some route is spelled differently from the table. */
  readonly localizedLocales: ReadonlySet<string>;
  /** Filled as a locale is first asked for, so a build pays for the locales it serves. */
  readonly localized: Map<string, RouteLocaleIndex>;
}

const preparedProjections = new WeakMap<
  RouteRuntimeProjection,
  PreparedRouteProjection
>();

/**
 * A segment that can be keyed rather than compared.
 *
 * The same spelling `safePresentationPath` restricts a generated path to. Matching folds case for
 * exactly these and compares every other segment as written, so a localized path carrying a capital
 * letter is the one thing a key must not stand in for.
 */
const KEYABLE_SEGMENT = /^[a-z0-9-]+$/u;

function foldedKey(segments: readonly string[]): string {
  return segments.map((segment) => segment.toLowerCase()).join('\u0000');
}

function localeIndex(
  projection: RouteRuntimeProjection,
  locale: string | undefined,
): RouteLocaleIndex {
  const keyed = new Map<string, IndexedRoute>();
  const scanned: IndexedRoute[] = [];
  let order = 0;
  for (const route of projection.generated.routes) {
    order += 1;
    const path =
      locale === undefined
        ? route.path
        : presentationPath(projection, route, locale);
    // The wildcard is not an address. Matching skipped it and so does this.
    if (path === '**') continue;
    const pattern = path.length === 0 ? [] : path.split('/');
    const indexed: IndexedRoute = { route, order, pattern };
    if (!pattern.every((segment) => KEYABLE_SEGMENT.test(segment))) {
      scanned.push(indexed);
      continue;
    }
    const key = foldedKey(pattern);
    // Two routes cannot share a spelling: identity uniqueness and the per-locale collision check
    // both refuse it. The guard keeps the earlier one anyway, so that if either ever stops holding,
    // this reads the table in its own order rather than in reverse.
    if (!keyed.has(key)) keyed.set(key, indexed);
  }
  return { keyed, scanned };
}

function prepareRouteProjection(
  projection: RouteRuntimeProjection,
): PreparedRouteProjection {
  const existing = preparedProjections.get(projection);
  if (existing !== undefined) return existing;
  const checked = checkRouteProjection(projection);
  const prepared: PreparedRouteProjection = {
    projection: checked,
    byId: new Map(checked.generated.routes.map((route) => [route.id, route])),
    generated: localeIndex(checked, undefined),
    localizedLocales: new Set(
      Object.values(checked.localizedPaths ?? {}).flatMap((localized) =>
        Object.keys(localized),
      ),
    ),
    localized: new Map(),
  };
  preparedProjections.set(projection, prepared);
  return prepared;
}

function indexForLocale(
  prepared: PreparedRouteProjection,
  locale: string,
): RouteLocaleIndex {
  // A locale nothing is spelled differently in reads the table's own spellings, which is the index
  // already built, so most locales in most applications cost nothing here.
  if (!prepared.localizedLocales.has(locale)) return prepared.generated;
  const existing = prepared.localized.get(locale);
  if (existing !== undefined) return existing;
  const built = localeIndex(prepared.projection, locale);
  prepared.localized.set(locale, built);
  return built;
}

/**
 * The projection, checked, and arranged for lookup while it is being checked.
 *
 * Every entry point asks for this first, which is what makes the answer worth keeping: the first
 * call does the work and the rest of them read it.
 */
export function validateRouteProjection(
  projection: RouteRuntimeProjection,
): RouteRuntimeProjection {
  return prepareRouteProjection(projection).projection;
}

interface ParsedTarget {
  readonly segments: readonly string[];
  readonly trailingSlash: boolean;
  readonly query: readonly RouteQueryValue[];
  readonly fragment?: string;
  readonly canonicalSuffix: string;
}

function decodeBounded(value: string, maximum: number): string | undefined {
  if (value.length > maximum || /%(?![0-9A-Fa-f]{2})/u.test(value))
    return undefined;
  try {
    const decoded = decodeURIComponent(value).normalize('NFC');
    return /[\u0000-\u001f\u007f\\/]/u.test(decoded) ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function parseTarget(target: string): ParsedTarget | undefined {
  if (
    target.length === 0 ||
    target.length > 8192 ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    /[\\\u0000-\u001f\u007f]/u.test(target)
  ) {
    return undefined;
  }
  const hashIndex = target.indexOf('#');
  const beforeHash = hashIndex < 0 ? target : target.slice(0, hashIndex);
  const rawFragment = hashIndex < 0 ? undefined : target.slice(hashIndex + 1);
  const queryIndex = beforeHash.indexOf('?');
  const rawPath = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex);
  const rawQuery = queryIndex < 0 ? '' : beforeHash.slice(queryIndex + 1);
  if (rawPath.includes('//') || /%2f|%5c/iu.test(rawPath)) return undefined;
  const trailingSlash = rawPath.length > 1 && rawPath.endsWith('/');
  const rawSegments = rawPath
    .slice(1, trailingSlash ? -1 : undefined)
    .split('/');
  const segments: string[] = [];
  for (const raw of rawSegments) {
    if (raw.length === 0 && rawSegments.length === 1) continue;
    const decoded = decodeBounded(raw, 1024);
    if (decoded === undefined || decoded === '.' || decoded === '..')
      return undefined;
    segments.push(decoded);
  }
  if (rawQuery.length > 2048 || /%(?![0-9A-Fa-f]{2})/u.test(rawQuery)) {
    return undefined;
  }
  const query: RouteQueryValue[] = [];
  if (rawQuery.length > 0) {
    const entries = rawQuery.split('&');
    if (entries.length > 32) return undefined;
    for (const entry of entries) {
      const separator = entry.indexOf('=');
      const rawName = separator < 0 ? entry : entry.slice(0, separator);
      const rawValue = separator < 0 ? '' : entry.slice(separator + 1);
      const name = decodeBounded(rawName, 128);
      const value = decodeBounded(rawValue, 512);
      if (name === undefined || value === undefined || name.length === 0) {
        return undefined;
      }
      query.push(Object.freeze({ name, value }));
    }
  }
  const fragment =
    rawFragment === undefined ? undefined : decodeBounded(rawFragment, 512);
  if (rawFragment !== undefined && fragment === undefined) return undefined;
  const canonicalQuery = query
    .map(
      ({ name, value }) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join('&');
  const canonicalSuffix = `${canonicalQuery.length === 0 ? '' : `?${canonicalQuery}`}${fragment === undefined ? '' : `#${encodeURIComponent(fragment)}`}`;
  return Object.freeze({
    segments: Object.freeze(segments),
    trailingSlash,
    query: Object.freeze(query),
    ...(fragment === undefined ? {} : { fragment }),
    canonicalSuffix,
  });
}

interface RouteMatch {
  readonly route: GeneratedRouteProjectionEntry;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly canonicalSegments: readonly string[];
  readonly corrected: boolean;
}

/**
 * One route offered the segments, one segment at a time.
 *
 * The comparison itself is unchanged. What changed is how often it is reached: for the routes the
 * index could not key, rather than for every route in the table.
 */
function matchIndexedRoute(
  indexed: IndexedRoute,
  segments: readonly string[],
  projection: RouteRuntimeProjection,
  locale: string,
): RouteMatch | undefined {
  const { route, pattern } = indexed;
  if (pattern.length !== segments.length) return undefined;
  const parameters: Record<string, unknown> = {};
  const canonicalSegments: string[] = [];
  let corrected = false;
  let matched = true;
  for (const [index, expected] of pattern.entries()) {
    const actual = segments[index] as string;
    if (expected.startsWith(':')) {
      const name = expected.slice(1);
      const codec = projection.parameters?.[route.id]?.[name];
      if (codec === undefined) {
        matched = false;
        break;
      }
      const context = parameterContext(route.id, name, locale);
      const parsed = codec.parse(actual, context);
      if (!parsed.ok || parsed.value === undefined) {
        matched = false;
        break;
      }
      const canonical = codec.serialize(parsed.value, context);
      if (canonical === undefined || !safeParameterSegment(canonical)) {
        matched = false;
        break;
      }
      parameters[name] = parsed.value;
      canonicalSegments.push(canonical);
      corrected ||= canonical !== actual;
    } else if (/^[a-z0-9-]+$/u.test(expected)) {
      if (expected.toLowerCase() !== actual.toLowerCase()) {
        matched = false;
        break;
      }
      canonicalSegments.push(expected.toLowerCase());
      corrected ||= expected.toLowerCase() !== actual;
    } else if (expected === actual) {
      canonicalSegments.push(expected);
    } else {
      matched = false;
      break;
    }
  }
  if (matched) {
    return Object.freeze({
      route,
      parameters: Object.freeze(parameters),
      canonicalSegments: Object.freeze(canonicalSegments),
      corrected,
    });
  }
  return undefined;
}

function matchRoute(
  segments: readonly string[],
  projectionValue: RouteRuntimeProjection,
  locale: string,
): RouteMatch | undefined {
  const prepared = prepareRouteProjection(projectionValue);
  const index = indexForLocale(prepared, locale);
  const keyed = index.keyed.get(foldedKey(segments));
  // Table order decides between two routes that both fit, so a keyed route is the answer only if
  // nothing written before it fits as well. The scan therefore stops where that route stands.
  const limit = keyed?.order ?? Number.POSITIVE_INFINITY;
  for (const candidate of index.scanned) {
    if (candidate.order > limit) break;
    const match = matchIndexedRoute(
      candidate,
      segments,
      prepared.projection,
      locale,
    );
    if (match !== undefined) return match;
  }
  return keyed === undefined
    ? undefined
    : matchIndexedRoute(keyed, segments, prepared.projection, locale);
}

function localeIntent(value: string): boolean {
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value);
}

function encodedSegments(segments: readonly string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function historicalResolution(
  routeSegments: readonly string[],
  locale: string,
  parsed: ParsedTarget,
  policy: LocaleUrlPolicy,
  projection: RouteRuntimeProjection,
): RouteResolution | undefined {
  const outcome = projection.historical?.[routeSegments.join('/')];
  if (outcome === undefined) return undefined;
  if (outcome.kind === 'gone') {
    return Object.freeze({
      status: 'gone',
      httpStatus: 410,
      presentationLocale: locale,
    });
  }
  return Object.freeze({
    status: 'redirect',
    reason: 'replacement',
    httpStatus: 308,
    cache: 'consumer-defined-permanent',
    locale,
    routeId: outcome.routeId,
    location: buildLocalizedRoute(
      policy,
      projection,
      outcome.routeId,
      locale,
      outcome.parameters ?? {},
      parsed.query,
      parsed.fragment,
    ),
  });
}

/**
 * The locale prefix this policy puts in front of a route's own segments, or nothing.
 *
 * Nothing is two different situations and the callers separate them: the default locale under
 * `omitDefaultPrefix`, which is the design, and a locale the policy never gave a prefix, which is
 * a mistake. What they share is the only thing this answers: whether the address the caller is
 * about to build begins with a segment the policy owns or with a segment the route owns.
 */
function emittedLocalePrefix(
  policy: LocaleUrlPolicy,
  locale: string,
): string | undefined {
  if (policy.kind !== 'path-prefix') return undefined;
  return policy.omitDefaultPrefix && locale === policy.defaultLocale
    ? undefined
    : policy.locales[locale];
}

/** A leading segment the policy has already claimed, and what it claimed it as. */
interface ClaimedLeadingSegment {
  readonly spelling: string;
  readonly kind: 'locale prefix' | 'locale alias' | 'locale-neutral root';
}

/**
 * Whether the policy has already claimed this leading path segment.
 *
 * A resolver reads the first segment of an address before it reads anything else, and it reads it
 * as one of three things: a locale-neutral root, which is answered by nothing; a locale prefix,
 * which names the locale and is removed; or an older alias of one, which redirects. Only if it is
 * none of those does the segment belong to a route. The three are mutually exclusive by
 * construction (every policy factory refuses a prefix, alias or neutral root that repeats one
 * already taken) so a route whose own first segment spells one of them is not a fourth
 * possibility. It is an address the resolver reads as one of the first three, and the route behind
 * it is unreachable at its own address.
 *
 * The comparisons match the resolver's rather than being chosen here. Prefixes and aliases are
 * compared case-insensitively because the resolver corrects the case of both, so `AR-EG` is not a
 * free spelling. Locale-neutral roots are compared exactly because the resolver compares them
 * exactly.
 */
function claimedLeadingSegment(
  policy: LocaleUrlPolicy,
  segment: string,
): ClaimedLeadingSegment | undefined {
  if (policy.localeNeutralRoots.includes(segment)) {
    return Object.freeze({
      spelling: segment,
      kind: 'locale-neutral root' as const,
    });
  }
  if (policy.kind !== 'path-prefix') return undefined;
  const folded = segment.toLowerCase();
  const matching = (
    table: Readonly<Record<string, string>>,
  ): string | undefined =>
    Object.keys(table).find((candidate) => candidate.toLowerCase() === folded);
  const prefix = matching(policy.prefixes);
  if (prefix !== undefined) {
    return Object.freeze({ spelling: prefix, kind: 'locale prefix' as const });
  }
  const alias = matching(policy.aliases);
  return alias === undefined
    ? undefined
    : Object.freeze({ spelling: alias, kind: 'locale alias' as const });
}

/**
 * Refuse an address Atlas is about to emit and could not read back.
 *
 * The same rule as the declared-spelling refusal one layer down, where a codec that cannot parse
 * its own serialization is refused rather than allowed to produce a link: what Atlas writes, Atlas
 * reads back. Here the unreadable part is not a parameter but the leading segment, and it is only
 * unreadable when no locale prefix stands in front of it, with a prefix the resolver removes the
 * prefix first and the route's own segments are read as the route's.
 *
 * Called with the route's segments before encoding, because that is what the resolver compares:
 * it decodes before it reads the first segment.
 */
function refuseClaimedAddress(refusal: {
  readonly claimed: ClaimedLeadingSegment;
  readonly routeId: string;
  readonly locale: string;
  readonly segments: readonly string[];
}): never {
  const { claimed, routeId, locale, segments } = refusal;
  return routeError(
    `Route ${routeId} is addressed at ${JSON.stringify(`/${segments.join('/')}`)} in ${locale}, where this policy emits no locale prefix, and its leading segment ${JSON.stringify(segments[0] ?? '')} is this policy's ${claimed.kind} ${JSON.stringify(claimed.spelling)}. Atlas's own resolver reads that segment as the ${claimed.kind} and never reaches the route, so this is an address Atlas would emit and could not resolve. Rename the route's leading segment, or spell the ${claimed.kind} differently.`,
  );
}

/** The same refusal for an address assembled without going through the builder. */
function refuseClaimedSegments(
  policy: LocaleUrlPolicy,
  routeId: string,
  locale: string,
  segments: readonly string[],
): void {
  const first = segments[0];
  if (first === undefined) return;
  const claimed = claimedLeadingSegment(policy, first);
  if (claimed !== undefined) {
    refuseClaimedAddress({ claimed, routeId, locale, segments });
  }
}

function pathPrefixCanonicalPath(
  policy: PathPrefixLocalePolicy,
  locale: string,
  segments: readonly string[],
): string {
  const prefix = emittedLocalePrefix(policy, locale);
  if (prefix === undefined && locale !== policy.defaultLocale) {
    return routeError('The route locale has no configured prefix.');
  }
  const path = encodedSegments(segments);
  return prefix === undefined
    ? path.length === 0
      ? '/'
      : `/${path}`
    : `/${prefix}${path.length === 0 ? '' : `/${path}`}`;
}

/**
 * The locale an entry redirect should send an unprefixed request to.
 *
 * Under a path-prefix policy the URL is authoritative whenever it carries a prefix, so this is
 * consulted only where the URL states nothing: the locale-entry redirect. It was not consulted
 * at all before: `resolveLocalizedRoute` accepted a resolution context and then dropped it
 * before the prefix branch, so a request resolved to `ar-EG` produced the identical redirect to
 * `/en-us` as a request that resolved to nothing.
 *
 * An unsupported preference is ignored rather than turned into an error. In a locale-neutral
 * policy `context.locale` is the request's stated locale and an unsupported value is a 404; here
 * it is a preference about a URL that is itself perfectly valid, and answering 404 for a site's
 * home page because a preference was unusable is the worse failure by a wide margin.
 */
function preferredEntryLocale(
  policy: PathPrefixLocalePolicy,
  context: RouteResolutionContext,
): string | undefined {
  if (context.locale === undefined) return undefined;
  let requested: string;
  try {
    requested = canonicalLocale(context.locale);
  } catch {
    return undefined;
  }
  return policy.locales[requested] === undefined ? undefined : requested;
}

function resolvePathPrefixRoute(
  target: string,
  policy: PathPrefixLocalePolicy,
  projectionValue: RouteRuntimeProjection,
  context: RouteResolutionContext,
): RouteResolution {
  const projection = validateRouteProjection(projectionValue);
  const parsed = parseTarget(target);
  if (parsed === undefined) {
    return Object.freeze({
      status: 'malformed',
      httpStatus: 400,
      presentationLocale: policy.defaultLocale,
      diagnostic: Object.freeze({
        code: 'unsafe-route',
        outcome: 'operational-failure',
        message: 'The request target is structurally unsafe or outside bounds.',
      }),
    });
  }
  const first = parsed.segments[0];
  if (first !== undefined && policy.localeNeutralRoots.includes(first)) {
    return Object.freeze({
      status: 'not-found',
      httpStatus: 404,
      presentationLocale: policy.defaultLocale,
    });
  }
  let locale: string | undefined;
  let routeSegments: readonly string[];
  let prefixCorrection = false;
  if (first !== undefined && policy.prefixes[first] !== undefined) {
    locale = policy.prefixes[first];
    routeSegments = parsed.segments.slice(1);
  } else {
    const casePrefix =
      first === undefined
        ? undefined
        : Object.keys(policy.prefixes).find(
            (prefix) => prefix.toLowerCase() === first.toLowerCase(),
          );
    const alias =
      first === undefined
        ? undefined
        : Object.keys(policy.aliases).find(
            (candidate) => candidate.toLowerCase() === first.toLowerCase(),
          );
    const aliasLocale = alias === undefined ? undefined : policy.aliases[alias];
    if (casePrefix !== undefined) {
      locale = policy.prefixes[casePrefix];
      routeSegments = parsed.segments.slice(1);
      prefixCorrection = true;
    } else if (aliasLocale !== undefined) {
      locale = aliasLocale;
      routeSegments = parsed.segments.slice(1);
      prefixCorrection = true;
    } else {
      const unprefixedMatch = matchRoute(
        parsed.segments,
        projection,
        policy.defaultLocale,
      );
      if (unprefixedMatch === undefined) {
        const historical = historicalResolution(
          parsed.segments,
          policy.defaultLocale,
          parsed,
          policy,
          projection,
        );
        if (historical !== undefined) return historical;
        if (first !== undefined && localeIntent(first)) {
          return Object.freeze({
            status: 'unsupported-locale',
            httpStatus: 404,
            presentationLocale: policy.defaultLocale,
            requestedLocale: first,
          });
        }
        // An address carrying no locale is locale entry, whether or not this application has a page
        // at it. Answering not-found here settled the second question before the first and left the
        // visitor on an unprefixed URL, which under this policy no localized route can match: the
        // outlet renders nothing, the document takes no title, and the response claims success.
        //
        // The requested path travels through unchanged, so the localized address answers, with
        // the application's own not-found page, in a locale, at a URL that states which one. A
        // crawler needs the same thing, which is why this is a redirect rather than a rendered 404
        // at an address that names no language.
        if (!policy.omitDefaultPrefix) {
          const entryLocale =
            preferredEntryLocale(policy, context) ?? policy.defaultLocale;
          return Object.freeze({
            status: 'redirect',
            reason: 'locale-entry',
            httpStatus: 307,
            cache: 'private-no-store',
            locale: entryLocale,
            location: `/${policy.locales[entryLocale] as string}${parsed.segments.length === 0 ? '' : `/${encodedSegments(parsed.segments)}`}${parsed.canonicalSuffix}`,
          });
        }
        // Where the default locale has no prefix, the unprefixed space is that locale's own
        // canonical form. There is nowhere to send this address that is not itself.
        return Object.freeze({
          status: 'not-found',
          httpStatus: 404,
          presentationLocale: policy.defaultLocale,
        });
      }
      const prefix = policy.locales[policy.defaultLocale] as string;
      if (policy.omitDefaultPrefix) {
        const canonicalPath = pathPrefixCanonicalPath(
          policy,
          policy.defaultLocale,
          unprefixedMatch.canonicalSegments,
        );
        if (
          parsed.trailingSlash ||
          unprefixedMatch.corrected ||
          target !== `${canonicalPath}${parsed.canonicalSuffix}`
        ) {
          return Object.freeze({
            status: 'redirect',
            reason: 'canonical-correction',
            httpStatus: 308,
            cache: 'consumer-defined-permanent',
            locale: policy.defaultLocale,
            routeId: unprefixedMatch.route.id,
            location: `${canonicalPath}${parsed.canonicalSuffix}`,
          });
        }
        return Object.freeze({
          status: 'success',
          locale: policy.defaultLocale,
          direction: directionForLocale(policy.defaultLocale),
          routeId: unprefixedMatch.route.id,
          parameters: unprefixedMatch.parameters,
          canonicalPath,
          query: parsed.query,
          ...(parsed.fragment === undefined
            ? {}
            : { fragment: parsed.fragment }),
          indexing: unprefixedMatch.route.indexing ?? 'indexable',
        });
      }
      const preferred = preferredEntryLocale(policy, context);
      // Never public, whether or not a preference was consulted.
      //
      // Keyed off the address rather than off `context.locale === undefined`, which asks about the
      // request. Cacheability is a question about the address. A cache key is the target URI
      // unless the stored response names a varying header, and an entry address states no locale,
      // so the answer a preference produced and the answer it did not share one key. Marking the
      // second `public` lets a shared cache store it and hand it to a visitor who would have got
      // the first; marking the first `private` prevents nothing, because that request is served
      // from the cache and never arrives here. `private` keeps a response from being stored. It
      // does not evict one already held.
      //
      // `Vary` is not available as the alternative. Atlas never sees the request, the host reads
      // the preference and passes a locale in, so Atlas cannot name the header that varied, and
      // for a cookie-borne preference `private` is the right answer regardless.
      const cache = 'private-no-store' as const;
      if (preferred !== undefined && preferred !== policy.defaultLocale) {
        const localized = localizedRouteSegments(
          projection,
          unprefixedMatch.route,
          preferred,
          unprefixedMatch.parameters,
        );
        if (localized.ok) {
          return Object.freeze({
            status: 'redirect',
            reason: 'locale-entry',
            httpStatus: 307,
            cache,
            locale: preferred,
            routeId: unprefixedMatch.route.id,
            location: `${pathPrefixCanonicalPath(policy, preferred, localized.segments)}${parsed.canonicalSuffix}`,
          });
        }
      }
      return Object.freeze({
        status: 'redirect',
        reason: 'locale-entry',
        httpStatus: 307,
        cache,
        locale: policy.defaultLocale,
        routeId: unprefixedMatch.route.id,
        location: `/${prefix}${unprefixedMatch.canonicalSegments.length === 0 ? '' : `/${encodedSegments(unprefixedMatch.canonicalSegments)}`}${parsed.canonicalSuffix}`,
      });
    }
  }
  const match = matchRoute(
    routeSegments,
    projection,
    locale ?? policy.defaultLocale,
  );
  if (locale !== undefined && match === undefined) {
    const historical = historicalResolution(
      routeSegments,
      locale,
      parsed,
      policy,
      projection,
    );
    if (historical !== undefined) return historical;
  }
  if (locale === undefined || match === undefined) {
    // The address stated a locale and the projection has no route at it. Those are two different
    // facts and only the second one is a miss: `specs/07-routing-rendering-and-seo.spec.md`
    // section 5 puts it as "the locale resolved, and only the page is unknown", and requires
    // resolution to commit the locale and yield no route context.
    //
    // `requestedLocale` is what carries that, and it is set only where the *address* named the
    // locale: a prefix this policy recognises. It is absent when the address named none and
    // `presentationLocale` is merely the default, because a caller asking "what locale does this
    // URL state" must be able to tell those apart and get nothing back for the second.
    //
    // Found through `loadChildren`: routes discovered inside a lazily loaded module are not in the
    // projection, so every one of their localized addresses lands here, and the page rendered in
    // the default locale at an address spelled in another one. The projection's coverage is a
    // separate item: this is the half that stops a gap in coverage from also losing the locale.
    return Object.freeze({
      status: 'not-found',
      httpStatus: 404,
      presentationLocale: locale ?? policy.defaultLocale,
      ...(locale === undefined ? {} : { requestedLocale: locale }),
    });
  }
  const canonicalPath = pathPrefixCanonicalPath(
    policy,
    locale,
    match.canonicalSegments,
  );
  if (
    prefixCorrection ||
    parsed.trailingSlash ||
    match.corrected ||
    target !== `${canonicalPath}${parsed.canonicalSuffix}`
  ) {
    return Object.freeze({
      status: 'redirect',
      reason: 'canonical-correction',
      httpStatus: 308,
      cache: 'consumer-defined-permanent',
      locale,
      routeId: match.route.id,
      location: `${canonicalPath}${parsed.canonicalSuffix}`,
    });
  }
  return Object.freeze({
    status: 'success',
    locale,
    direction: directionForLocale(locale),
    routeId: match.route.id,
    parameters: match.parameters,
    canonicalPath,
    query: parsed.query,
    ...(parsed.fragment === undefined ? {} : { fragment: parsed.fragment }),
    indexing: match.route.indexing ?? 'indexable',
  });
}

function pathOnlyTarget(target: string): string | undefined {
  if (target.startsWith('/')) return target;
  try {
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

function unsupportedLocaleResolution(
  policy: LocaleUrlPolicy,
  requestedLocale: string,
): RouteResolution {
  return Object.freeze({
    status: 'unsupported-locale',
    httpStatus: 404,
    presentationLocale: policy.defaultLocale,
    requestedLocale,
  });
}

function resolveLocaleNeutralRoute(
  target: string,
  policy: LocaleNeutralPolicy,
  projectionValue: RouteRuntimeProjection,
  context: RouteResolutionContext,
): RouteResolution {
  const projection = validateRouteProjection(projectionValue);
  const parsed = parseTarget(target);
  if (parsed === undefined) {
    return Object.freeze({
      status: 'malformed',
      httpStatus: 400,
      presentationLocale: policy.defaultLocale,
      diagnostic: Object.freeze({
        code: 'unsafe-route',
        outcome: 'operational-failure',
        message: 'The request target is structurally unsafe or outside bounds.',
      }),
    });
  }
  const first = parsed.segments[0];
  if (first !== undefined && policy.localeNeutralRoots.includes(first)) {
    return Object.freeze({
      status: 'not-found',
      httpStatus: 404,
      presentationLocale: policy.defaultLocale,
    });
  }
  let locale = policy.defaultLocale;
  if (context.locale !== undefined) {
    let requested: string;
    try {
      requested = canonicalLocale(context.locale);
    } catch {
      return unsupportedLocaleResolution(policy, context.locale);
    }
    if (policy.locales[requested] === undefined) {
      return unsupportedLocaleResolution(policy, context.locale);
    }
    locale = requested;
  }
  let match = matchRoute(parsed.segments, projection, locale);
  if (match === undefined && context.locale === undefined) {
    const alternatives = Object.keys(policy.locales)
      .filter((candidate) => candidate !== locale)
      .map((candidate) => ({
        locale: candidate,
        match: matchRoute(parsed.segments, projection, candidate),
      }))
      .filter(
        (candidate): candidate is { locale: string; match: RouteMatch } =>
          candidate.match !== undefined,
      );
    if (alternatives.length === 1) {
      locale = alternatives[0]?.locale as string;
      match = alternatives[0]?.match;
    }
  }
  if (match === undefined) {
    const historical = historicalResolution(
      parsed.segments,
      locale,
      parsed,
      policy,
      projection,
    );
    if (historical !== undefined) return historical;
    return Object.freeze({
      status: 'not-found',
      httpStatus: 404,
      presentationLocale: locale,
    });
  }
  const routeText = encodedSegments(match.canonicalSegments);
  const canonicalPath = routeText.length === 0 ? '/' : `/${routeText}`;
  if (
    parsed.trailingSlash ||
    match.corrected ||
    target !== `${canonicalPath}${parsed.canonicalSuffix}`
  ) {
    return Object.freeze({
      status: 'redirect',
      reason: 'canonical-correction',
      httpStatus: 308,
      cache: 'consumer-defined-permanent',
      locale,
      routeId: match.route.id,
      location: `${canonicalPath}${parsed.canonicalSuffix}`,
    });
  }
  return Object.freeze({
    status: 'success',
    locale,
    direction: directionForLocale(locale),
    routeId: match.route.id,
    parameters: match.parameters,
    canonicalPath,
    query: parsed.query,
    ...(parsed.fragment === undefined ? {} : { fragment: parsed.fragment }),
    indexing: match.route.indexing ?? 'indexable',
    // Every success here, not only the ones that read a preference on this request.
    //
    // The address carries no locale, so the document it returns is chosen by something the address
    // does not state, and the requests that state nothing share a cache key with the requests that
    // do. A response marked cacheable because *this* request consulted nothing is the one a shared
    // cache hands to everybody, which is 6.1's lesson on a response that has a body. A preference
    // for a locale the site does not have turns this same address into a 404, so even an address
    // only one locale can answer does not return the same response to every request.
    variesBy: 'locale-preference',
  });
}

/**
 * The redirects above are deliberately not marked.
 *
 * What a redirect returns is its `Location`, and that is computed from the matched route's
 * canonical segments, which are the same text for every locale that can reach this address.
 * Measured: `/about/` corrects to `/about` under `en-US` and under `ar-EG` alike. A preference for
 * an unsupported locale answers 404 here instead, and a shared cache serving the correction to that
 * visitor sends them to an address that will answer them correctly. Marking these would split a
 * cache by language for a response that is byte-identical in every language.
 */

function resolveHostRoute(
  target: string,
  policy: HostLocalePolicy,
  projectionValue: RouteRuntimeProjection,
  context: RouteResolutionContext,
): RouteResolution {
  let originValue = context.origin;
  let requestTarget = target;
  if (!target.startsWith('/')) {
    try {
      const absolute = new URL(target);
      if (!['http:', 'https:'].includes(absolute.protocol))
        throw new TypeError();
      originValue = absolute.origin;
      requestTarget = `${absolute.pathname}${absolute.search}${absolute.hash}`;
    } catch {
      return Object.freeze({
        status: 'malformed',
        httpStatus: 400,
        presentationLocale: policy.defaultLocale,
        diagnostic: Object.freeze({
          code: 'unsafe-route',
          outcome: 'operational-failure',
          message: 'The host-localized request URL is malformed.',
        }),
      });
    }
  }
  const origin =
    originValue === undefined
      ? policy.locales[policy.defaultLocale]
      : (() => {
          try {
            return new URL(originValue).origin;
          } catch {
            return undefined;
          }
        })();
  const locale = origin === undefined ? undefined : policy.origins[origin];
  if (origin === undefined || locale === undefined) {
    return Object.freeze({
      status: 'malformed',
      httpStatus: 400,
      presentationLocale: policy.defaultLocale,
      diagnostic: Object.freeze({
        code: 'unsafe-route',
        outcome: 'operational-failure',
        message: 'The request origin is not an allowed locale-specific origin.',
      }),
    });
  }
  const projection = validateRouteProjection(projectionValue);
  const parsed = parseTarget(requestTarget);
  if (parsed === undefined) {
    return Object.freeze({
      status: 'malformed',
      httpStatus: 400,
      presentationLocale: locale,
      diagnostic: Object.freeze({
        code: 'unsafe-route',
        outcome: 'operational-failure',
        message: 'The request target is structurally unsafe or outside bounds.',
      }),
    });
  }
  const first = parsed.segments[0];
  if (first !== undefined && policy.localeNeutralRoots.includes(first)) {
    return Object.freeze({
      status: 'not-found',
      httpStatus: 404,
      presentationLocale: locale,
    });
  }
  const match = matchRoute(parsed.segments, projection, locale);
  if (match === undefined) {
    const historical = historicalResolution(
      parsed.segments,
      locale,
      parsed,
      policy,
      projection,
    );
    if (historical !== undefined) return historical;
    // Same as the prefix policy above: the origin named the locale, and only the page is unknown.
    return Object.freeze({
      status: 'not-found',
      httpStatus: 404,
      presentationLocale: locale,
      requestedLocale: locale,
    });
  }
  const routeText = encodedSegments(match.canonicalSegments);
  const canonicalPath = routeText.length === 0 ? '/' : `/${routeText}`;
  const canonicalUrl = `${policy.locales[locale]}${canonicalPath === '/' ? '/' : canonicalPath}`;
  if (
    parsed.trailingSlash ||
    match.corrected ||
    requestTarget !== `${canonicalPath}${parsed.canonicalSuffix}`
  ) {
    return Object.freeze({
      status: 'redirect',
      reason: 'canonical-correction',
      httpStatus: 308,
      cache: 'consumer-defined-permanent',
      locale,
      routeId: match.route.id,
      location: `${canonicalUrl}${parsed.canonicalSuffix}`,
    });
  }
  return Object.freeze({
    status: 'success',
    locale,
    direction: directionForLocale(locale),
    routeId: match.route.id,
    parameters: match.parameters,
    canonicalPath,
    canonicalUrl,
    query: parsed.query,
    ...(parsed.fragment === undefined ? {} : { fragment: parsed.fragment }),
    indexing: match.route.indexing ?? 'indexable',
  });
}

/**
 * Resolve a target, and say which of this projection's routes answered.
 *
 * The narrowing happens here and exactly here. Everything below builds a resolution from a route
 * matched by walking the projection's entries at runtime, so `routeId` genuinely is one of the
 * declared identities, but it arrives as a `string` read out of a data structure, and no amount
 * of generic plumbing through the helpers would let the compiler prove otherwise. Making those four
 * helpers generic would move the same unprovable step deeper and add noise on the way.
 *
 * So it is asserted once, at the boundary where the widened internal representation becomes the
 * public contract, rather than left for every consumer to assert at the join with
 * `buildLocalizedRoute`. That is the trade: one assertion inside Atlas, where the invariant is
 * known, instead of one in each consumer, at the one place a mistyped route identity would
 * otherwise have been caught.
 *
 * What this may correct on the way, and what it must not, is
 * `specs/07-routing-rendering-and-seo.spec.md` section 6: compatible host, locale, static-segment,
 * slash, alias and query corrections combine into one hop, and a dynamic identity is never
 * case-folded or rewritten except through its own codec.
 */
export function resolveLocalizedRoute<
  const Projection extends RouteRuntimeProjection,
>(
  target: string,
  policy: LocaleUrlPolicy,
  projection: Projection,
  context: RouteResolutionContext = {},
): LocalizedRouteResolution<Projection> {
  return resolveRouteTarget(
    target,
    policy,
    projection,
    context,
  ) as LocalizedRouteResolution<Projection>;
}

function resolveRouteTarget(
  target: string,
  policy: LocaleUrlPolicy,
  projection: RouteRuntimeProjection,
  context: RouteResolutionContext = {},
): RouteResolution {
  if (policy.kind === 'locale-host') {
    return resolveHostRoute(target, policy, projection, context);
  }
  const path = pathOnlyTarget(target);
  if (path === undefined) {
    return Object.freeze({
      status: 'malformed',
      httpStatus: 400,
      presentationLocale: policy.defaultLocale,
      diagnostic: Object.freeze({
        code: 'unsafe-route',
        outcome: 'operational-failure',
        message: 'The localized request URL is malformed.',
      }),
    });
  }
  return policy.kind === 'path-prefix'
    ? resolvePathPrefixRoute(path, policy, projection, context)
    : resolveLocaleNeutralRoute(path, policy, projection, context);
}

function requestTarget(context: unknown): string | undefined {
  const candidate =
    typeof context === 'string'
      ? context
      : typeof context === 'object' && context !== null
        ? typeof (context as { readonly url?: unknown }).url === 'string'
          ? (context as { readonly url: string }).url
          : typeof (
                context as { readonly request?: { readonly url?: unknown } }
              ).request?.url === 'string'
            ? (context as { readonly request: { readonly url: string } })
                .request.url
            : undefined
        : undefined;
  if (candidate === undefined) return undefined;
  if (candidate.startsWith('/')) return candidate;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

/**
 * The locale this request's URL states, or `undefined` when it states none.
 *
 * The difference from `resolveInitialRouteLocale` is the ability to say nothing.
 * `resolveInitialRouteLocale` answers with the default locale when a URL carries no locale, which
 * is the right answer when the URL is the only source and the wrong one inside a resolution
 * chain, where a URL that states nothing must step aside and let the next source answer rather
 * than pre-empting it with a default.
 *
 * A locale-neutral policy never states a locale in the URL, so it always declines. Under a prefix
 * policy an unprefixed request produces a locale-entry redirect, and that redirect is precisely
 * the signal that the URL said nothing.
 */
export function localeFromRoute(
  context: unknown,
  policy: LocaleUrlPolicy,
  projection: RouteRuntimeProjection,
): string | undefined {
  if (policy.kind === 'locale-neutral') return undefined;
  const target = requestTarget(context);
  if (target === undefined) return undefined;
  const origin =
    typeof context === 'object' &&
    context !== null &&
    typeof (context as { readonly origin?: unknown }).origin === 'string'
      ? (context as { readonly origin: string }).origin
      : undefined;
  const resolution = resolveLocalizedRoute(target, policy, projection, {
    ...(origin === undefined ? {} : { origin }),
  });
  if (resolution.status === 'success') return resolution.locale;
  // An address the projection has no route for still states a locale when it carries a prefix this
  // policy recognises, and `requestedLocale` is present only in that case, so this stays silent
  // for an address that named none and lets the next source in the chain answer.
  //
  // `unsupported-locale` shares this member of the union and also carries `requestedLocale`, but
  // there it holds the raw prefix the address used rather than a locale this application has. It is
  // deliberately not read here: answering with it would hand the rest of the runtime a locale that
  // does not exist.
  if (resolution.status === 'not-found') return resolution.requestedLocale;
  return resolution.status === 'redirect' &&
    resolution.reason !== 'locale-entry'
    ? resolution.locale
    : undefined;
}

/**
 * Reads the locale out of the address a request arrived at, before anything has been rendered.
 *
 * Called on a server, where there is no committed snapshot yet and the address is the only thing
 * that says which language to start in. The context is whatever the platform supplies for the
 * request; the origin is read off it when it has one, which is what a host policy needs.
 *
 * Returns the locale to present in, which for an address naming no route is the one the resolution
 * decided the response should be presented in rather than always the default.
 */
export function resolveInitialRouteLocale(
  context: unknown,
  policy: LocaleUrlPolicy,
  projection: RouteRuntimeProjection,
): string {
  const target = requestTarget(context);
  if (target === undefined) return policy.defaultLocale;
  const origin =
    typeof context === 'object' &&
    context !== null &&
    typeof (context as { readonly origin?: unknown }).origin === 'string'
      ? (context as { readonly origin: string }).origin
      : undefined;
  const resolution = resolveLocalizedRoute(target, policy, projection, {
    ...(origin === undefined ? {} : { origin }),
  });
  // Every other member carries `presentationLocale`, which is already the locale this resolution
  // decided the response should be presented in: the address's own locale where it stated one, and
  // the default where it did not. Reaching past it to `policy.defaultLocale` discarded a locale the
  // resolution had already worked out, and did it precisely on the addresses that most need it: the
  // ones with no route in the projection.
  return resolution.status === 'success' || resolution.status === 'redirect'
    ? resolution.locale
    : resolution.presentationLocale;
}

function routeById(
  projection: RouteRuntimeProjection,
  routeId: string,
): GeneratedRouteProjectionEntry {
  return (
    prepareRouteProjection(projection).byId.get(routeId) ??
    routeError(`Route identity ${JSON.stringify(routeId)} is unavailable.`)
  );
}

type LocalizedSegments =
  | { readonly ok: true; readonly segments: readonly string[] }
  | {
      readonly ok: false;
      readonly reason:
        | 'parameter-missing'
        | 'unrepresentable'
        | 'unsafe'
        | 'unreadable';
      readonly parameter: string;
    };

/**
 * The path segments a route occupies in one locale.
 *
 * Shared by URL building and by the locale-entry redirect, which needs the same answer without a
 * throw: an entry redirect that cannot represent the route in the preferred locale falls back to
 * the default locale, where the request was already going to land.
 */
function localizedRouteSegments(
  projection: RouteRuntimeProjection,
  route: GeneratedRouteProjectionEntry,
  locale: string,
  parameters: Readonly<Record<string, unknown>>,
  spellings?: LocalizedParameterSpellings,
): LocalizedSegments {
  const localizedPath = presentationPath(projection, route, locale);
  const pattern = localizedPath.length === 0 ? [] : localizedPath.split('/');
  const segments: string[] = [];
  for (const segment of pattern) {
    if (!segment.startsWith(':')) {
      segments.push(
        /^[a-z0-9-]+$/u.test(segment) ? segment.toLowerCase() : segment,
      );
      continue;
    }
    const name = segment.slice(1);
    const codec = projection.parameters?.[route.id]?.[name];
    if (codec === undefined || parameters[name] === undefined) {
      return { ok: false, reason: 'parameter-missing', parameter: name };
    }
    const context = parameterContext(route.id, name, locale);
    const declared = spellings?.[name]?.[locale];
    if (declared !== undefined) {
      // A declared spelling replaces what the codec would have written, and is held to the half of
      // the round trip that still means something.
      //
      // The codec's own check below asks `serialize(parse(x)) === x`, which cannot apply here: in
      // another locale the parameter's value *is* that locale's slug, so parsing a declared
      // spelling yields a different value than the one this page was addressed with, and requiring
      // them to match would reject every correct declaration. What must still hold is the reason
      // that check exists, Atlas has to be able to resolve the address it is about to emit, so
      // the declared spelling is required to parse, and required to be a safe segment.
      if (!safeParameterSegment(declared)) {
        return { ok: false, reason: 'unsafe', parameter: name };
      }
      if (!codec.parse(declared, context).ok) {
        return { ok: false, reason: 'unreadable', parameter: name };
      }
      segments.push(declared);
      continue;
    }
    const serialized = codec.serialize(parameters[name], context);
    if (serialized === undefined) {
      return { ok: false, reason: 'unrepresentable', parameter: name };
    }
    if (!safeParameterSegment(serialized)) {
      return { ok: false, reason: 'unsafe', parameter: name };
    }
    // The codec has to be able to read what it just wrote, in the locale it wrote it for.
    //
    // This is the one property the whole design rests on and the only one a codec can quietly not
    // have. A locale change re-addresses the current page by parsing the address in its old locale
    // and serializing the parts in the new one, so a codec that writes a spelling it cannot read
    // builds an address Atlas emits and then fails to resolve. Nothing about that looks wrong on
    // the way out: the URL is well formed, the segments are safe, the link renders. It fails when
    // someone follows it, as a page that quietly reverts to the default locale.
    //
    // Checked as text rather than by comparing values, because a codec may parse to anything
    // (an object, a branded type) and Atlas has no equality to apply to it. Serializing what came
    // back and comparing the two strings asks the same question without needing one.
    //
    // Paid on every URL build, which is the hot path, and worth it: the inbound direction already
    // parses and re-serializes every parameter it matches, so this is the cost the resolution side
    // has always paid, now paid symmetrically. A check that only ran in development would ship the
    // broken codec, which is the failure `validateConfig` demonstrates.
    const read = codec.parse(serialized, context);
    if (
      !read.ok ||
      read.value === undefined ||
      codec.serialize(read.value, context) !== serialized
    ) {
      return { ok: false, reason: 'unreadable', parameter: name };
    }
    segments.push(serialized);
  }
  return { ok: true, segments: Object.freeze(segments) };
}

/**
 * The identities of the routes that actually take parameters.
 *
 * Distributive on purpose. Written as `Extract<...> extends { readonly id: infer Id }`, an
 * application with no parameterised route made `Extract` resolve to `never`, `never extends`
 * anything is trivially true, and `infer Id` had nothing to infer from and fell back to its
 * `string` constraint, so the type claimed every route was parameterised and demanded codecs no
 * route could have. Distributing over the entry short-circuits on `never`, which is the answer.
 */
type ParameterisedRouteId<Projection> =
  RouteEntriesOf<Projection> extends infer Entry
    ? Entry extends {
        readonly id: infer Id extends string;
        readonly parameterNames: readonly [string, ...string[]];
      }
      ? Id
      : never
    : never;

type RouteParameterNames<Projection, Id extends string> =
  Extract<
    RouteEntriesOf<Projection>,
    { readonly id: Id; readonly parameterNames: readonly string[] }
  > extends { readonly parameterNames: readonly (infer Name extends string)[] }
    ? Name
    : never;

type RequiredRouteCodecs<Projection> = {
  readonly [Id in ParameterisedRouteId<Projection>]: {
    readonly [Name in RouteParameterNames<Projection, Id>]: RouteParameterCodec;
  };
};

/**
 * Declare a route projection without losing what the generated one knows.
 *
 * The generated projection is written `as const` and therefore knows its own route identities and
 * parameter names. Storing it in a variable annotated `RouteRuntimeProjection` throws that away,
 * and every consumer writes that annotation because it is the obvious thing to write. This is the
 * supported way to keep it: the projection is checked here and its literal types survive, so
 * `buildLocalizedRoute` can reject a route identity that does not exist and require the parameters
 * the named route actually takes.
 *
 * It also requires a codec for every route that has parameters. That was optional in the type and
 * mandatory in fact: a projection missing one produced a runtime throw from whichever of five
 * unrelated entry points happened to validate it first.
 */
export function defineRouteProjection<
  const Projection extends RouteRuntimeProjection & {
    readonly parameters?: RequiredRouteCodecs<Projection>;
  },
>(
  projection: Projection &
    ([ParameterisedRouteId<Projection>] extends [never]
      ? unknown
      : { readonly parameters: RequiredRouteCodecs<Projection> }),
): Projection {
  return projection;
}

/**
 * One address a build should render ahead of time, in one locale.
 *
 * `renderMode` is whatever the caller put in: Atlas never imports `@angular/ssr` and has no
 * opinion about its enum. What Atlas contributes is the path, every supported locale's spelling
 * of a route it already knows, and, for a parameterised route, the parameter values serialized
 * through that locale's codecs.
 */
export interface LocalizedServerRoute<Mode> {
  /** The address, in one locale's spelling. */
  readonly path: string;
  /** How it is rendered, carried through untouched from what the caller declared. */
  readonly renderMode: Mode;
  /**
   * A mutable array, deliberately, and the property is `readonly` while the array is not.
   *
   * This value is not Atlas's to protect: the caller hands it to `withRoutes`, whose declared
   * shape is `getPrerenderParams: () => Promise<Record<string, string>[]>`. A `readonly` array is
   * not assignable to a mutable one, so declaring one here forces every consumer to write
   * `as ServerRoute[]` over the whole table: a cast that silences far more than the thing it was
   * added for. `Readonly<Record<...>>` on the entries costs nothing and assigns cleanly, so the
   * record keeps it and the array does not.
   */
  readonly getPrerenderParams?: () => Promise<
    Readonly<Record<string, string>>[]
  >;
}

/**
 * The table `localizedServerRoutes` returns, distributed over the render mode.
 *
 * A plain `LocalizedServerRoute<Mode>[]` is one object type whose `renderMode` is the union of
 * every mode used, and a single object with a union discriminant matches no member of Angular's
 * discriminated `ServerRoute`. That is what forced every consumer to write `as ServerRoute[]` over
 * the whole table: a cast wide enough to hide a genuine mistake in any of the entries under it.
 *
 * Distributing gives `LocalizedServerRoute<Prerender> | LocalizedServerRoute<Client> | ...`, and
 * each of those matches the corresponding `ServerRoute` member on its own. Atlas still imports
 * nothing from `@angular/ssr` here; the shape is compatible rather than shared, which is what lets
 * this stay on the primary entry point under `specs/02-packages-and-platform.spec.md` section 6.
 */
export type LocalizedServerRoutes<Mode> = (Mode extends unknown
  ? LocalizedServerRoute<Mode>
  : never)[];

/**
 * One route a build should render, named once and expanded into every locale's spelling.
 *
 * Written against the route's identity rather than its path, so adding a locale adds addresses
 * without anything here changing.
 */
export interface LocalizedServerRouteDeclaration<Mode, Projection = unknown> {
  /**
   * One of the identities this projection declares.
   *
   * `RouteIdOf` resolves to the literal union when the projection is the generated one and widens
   * to `string` when it is held generically, so ordinary code keeps working and a spelling
   * mistake stops compiling. It was `string` here while the client side already used `RouteIdOf`,
   * the same defect in the same file with only one of its two callers fixed: a typo type-checked
   * and then threw from `routeById` when the module was evaluated. That does fail the build, but
   * at the wrong moment and with no completion on the way there.
   */
  readonly routeId: RouteIdOf<Projection>;
  /** How this route is rendered, in whatever terms the server framework uses. */
  readonly renderMode: Mode;
  /**
   * Domain parameter values to render ahead of time, written once.
   *
   * Serialized per locale through the route's codecs, so an article prerendered as
   * `/en-us/articles/atlas-handbook` is prerendered as `/ar-eg/articles/دليل-أطلس` from the same
   * entry. Writing the localized spellings by hand is the part nobody gets right, and getting it
   * wrong produces a page that exists in one language and 404s in the other.
   */
  readonly prerender?: readonly Readonly<Record<string, unknown>>[];
}

/** What to do about the addresses the declarations did not name. */
export interface LocalizedServerRoutesOptions<Mode> {
  /** Appended last, matching every address the declarations did not name. */
  readonly fallback?: Mode;
  /**
   * The mode for the canonical spelling of every declared route: `RenderMode.Server`.
   *
   * Under a policy that prefixes every locale, a route has an address nobody visits: the authored
   * path with no locale in it. It is the address the Router matches, because the location strategy
   * delocalizes before matching, and it is not an address a visitor can arrive at: one who tries
   * is redirected to their locale's spelling. Prerendered, it writes a file at an address no link
   * points to, in whatever locale that render happened to resolve.
   *
   * Atlas emits these entries rather than leaving them to the consumer, because they are Atlas's
   * addresses. A consumer never wrote `/second`; the two-layer table did. Left undeclared they
   * fail the build, `@angular/ssr` errors on a client route no server route matches, and the
   * obvious way to answer that error is to declare them, at which point whether they prerender
   * becomes a decision made by someone who does not know the addresses exist.
   *
   * Required exactly when the policy produces such addresses, which `omitDefaultPrefix`,
   * `locale-neutral` and `locale-host` do not.
   */
  readonly canonicalRenderMode?: Mode;
}

/**
 * The server route table for an application whose addresses are localized.
 *
 * A prerendered route has no request, so nothing can negotiate a locale for it: every locale's
 * copy is a separate address that has to exist in the build. Written by hand that is one entry per
 * route per locale, re-edited on every route added and every locale added, which is the wiring
 * decision section 1 exists to eliminate, and the kind that fails quietly, because a missing
 * variant is not an error anywhere. It is a page that is simply absent in Arabic.
 *
 *     export const serverRoutes = localizedServerRoutes(routePolicy, projection, [
 *       { routeId: 'article', renderMode: RenderMode.Prerender, prerender: [{ slug: 'handbook' }] },
 *       { routeId: 'item', renderMode: RenderMode.Client },
 *     ], { fallback: RenderMode.Server });
 *
 * Locale order follows the policy, and declaration order is kept, because a server route table is
 * matched in order.
 *
 * A `locale-host` policy puts the locale in the host rather than the path, so one path serves
 * every locale and one entry per route is emitted. Rendering those variants ahead of time is a
 * build-per-host question, which is outside a route table.
 *
 * The generated `configuration` decides which of the policy's locales get addresses at all: see
 * `builtLocales`. A locale the policy names and this build did not generate is left out rather than
 * written as a file that redirects away.
 */
export function localizedServerRoutes<
  Mode,
  const Projection extends RouteRuntimeProjection,
>(
  policy: LocaleUrlPolicy,
  projectionValue: Projection,
  configuration: GeneratedConfiguration,
  declarations: readonly LocalizedServerRouteDeclaration<Mode, Projection>[],
  options: LocalizedServerRoutesOptions<Mode> = {},
): LocalizedServerRoutes<Mode> {
  const projection = validateRouteProjection(projectionValue);
  const built = builtLocales(policy, configuration);
  // Only the prefixing branch is filtered, and that is not an oversight. Under `locale-neutral` and
  // `locale-host` one path serves every locale, the address does not name one, so there is no
  // per-locale address to withhold, and the entry emitted below is the application's own, which the
  // default-locale check above has already confirmed this build produced.
  const prefixes: readonly (readonly [string, string])[] =
    policy.kind === 'path-prefix'
      ? Object.entries(policy.locales)
          .filter(([locale]) => built.has(canonicalLocale(locale)))
          .map(([locale, prefix]) =>
            Object.freeze([
              locale,
              policy.omitDefaultPrefix && locale === policy.defaultLocale
                ? ''
                : prefix,
            ] as const),
          )
      : [Object.freeze([policy.defaultLocale, ''] as const)];

  const routes: LocalizedServerRoute<Mode>[] = [];
  const seen = new Set<string>();
  for (const declaration of declarations) {
    const route = routeById(projection, declaration.routeId);
    const parameterised = route.parameterNames.length > 0;
    // No check that a parameterised route supplies values. Whether one needs them depends on its
    // render mode, and the render mode is the caller's enum: Atlas does not import
    // `@angular/ssr` and cannot read meaning into a value it only passes through. A route that
    // needs enumerating and has nothing to enumerate is Angular's build error to report, in its
    // own words.
    if (!parameterised && declaration.prerender !== undefined) {
      routeError(
        `Route ${route.id} takes no parameters, so \`prerender\` values have nothing to fill.`,
      );
    }
    for (const [localeValue, prefix] of prefixes) {
      const locale = canonicalLocale(localeValue);
      const presentation = presentationPath(projection, route, locale);
      // Where a prefix is emitted the resolver removes it before it reads the route's segments, so
      // only the unprefixed entries can collide. That is the default locale under
      // `omitDefaultPrefix`, and it is the one case a build sees before a visitor does: this
      // schedules a rendered file at that address.
      if (prefix === '') {
        refuseClaimedSegments(
          policy,
          route.id,
          locale,
          presentation.split('/'),
        );
      }
      const path = [prefix, presentation]
        .filter((segment) => segment.length > 0)
        .join('/');
      if (seen.has(path)) continue;
      seen.add(path);
      routes.push(
        Object.freeze({
          path,
          renderMode: declaration.renderMode,
          ...(declaration.prerender === undefined
            ? {}
            : {
                getPrerenderParams: () =>
                  Promise.resolve(
                    prerenderParameters(
                      projection,
                      route,
                      locale,
                      declaration.prerender ?? [],
                    ),
                  ),
              }),
        }),
      );
    }
  }
  // The canonical layer, after every localized address and before the fallback.
  //
  // A second pass rather than an entry inside the loop above, so that `seen` already holds every
  // localized spelling by the time this asks. Under `omitDefaultPrefix` the canonical path *is*
  // the default locale's address and has already been emitted with the mode its own declaration
  // asked for; this must not follow it with a second entry saying `Server`.
  const canonical: string[] = [];
  for (const declaration of declarations) {
    const { path } = routeById(projection, declaration.routeId);
    // Before `seen`, not after. The canonical layer carries no prefix by definition, so the same
    // rule applies to it, and a colliding canonical path is precisely one `seen` already holds,
    // because the address it collides with is another route's localized spelling. Asking after the
    // skip is asking only about the routes that could not collide.
    refuseClaimedSegments(
      policy,
      declaration.routeId,
      policy.defaultLocale,
      path.split('/'),
    );
    if (seen.has(path)) continue;
    seen.add(path);
    canonical.push(path);
  }
  if (canonical.length > 0) {
    if (options.canonicalRenderMode === undefined) {
      routeError(
        `This policy gives every locale a path prefix, so ${canonical.length} declared route(s) also have a canonical address no visitor reaches (${canonical
          .map((path) => JSON.stringify(`/${path}`))
          .join(
            ', ',
          )}). Pass \`canonicalRenderMode\`, \`RenderMode.Server\`, so they are rendered on demand instead of written as files nothing links to.`,
      );
    }
    const canonicalRenderMode = options.canonicalRenderMode;
    for (const path of canonical) {
      // No `getPrerenderParams`. These are rendered on demand, so there is nothing to enumerate,
      // and a parameterised canonical address is matched as a pattern rather than expanded.
      routes.push(Object.freeze({ path, renderMode: canonicalRenderMode }));
    }
  }
  if (options.fallback !== undefined) {
    routes.push(Object.freeze({ path: '**', renderMode: options.fallback }));
  }
  // Entries frozen, array not. The entries are Atlas's statement about each address and nothing
  // downstream has cause to rewrite one. The array is the caller's: it was built for them, they
  // pass it to `withRoutes`, and `withRoutes` declares it mutable. Freezing something being
  // handed away is half of what made the consumer's cast unavoidable.
  //
  // The assertion is the other half, and it is here so that no consumer writes one. Every entry
  // was built with a single concrete mode a few lines above, but `Mode` is still an unresolved
  // type parameter here, so the distributive conditional stays deferred and TypeScript cannot
  // construct a value of it. That is a limit on what the checker can prove about its own
  // deferred types, not a claim about the data. One assertion here, inside the function that
  // built every element, replaces one `as ServerRoute[]` per consumer: each of those sitting
  // above a whole table of entries it silenced along the way.
  return routes as LocalizedServerRoutes<Mode>;
}

function prerenderParameters(
  projection: RouteRuntimeProjection,
  route: GeneratedRouteProjectionEntry,
  locale: string,
  values: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, string>>[] {
  return values.map((value) => {
    const serialized: Record<string, string> = {};
    for (const name of route.parameterNames) {
      const codec = projection.parameters?.[route.id]?.[name];
      if (codec === undefined) {
        routeError(`Route ${route.id} has no codec for parameter ${name}.`);
      }
      const text = codec.serialize(
        value[name],
        parameterContext(route.id, name, locale),
      );
      if (text === undefined) {
        // The value has no spelling in this locale. Silently dropping it would ship a build
        // where the page exists in one language and 404s in the other.
        throw new LocalizationError(
          Object.freeze({
            code: 'route-unavailable',
            outcome: 'localized-representation-unavailable',
            message: `Route ${route.id} parameter ${name} has no representation in ${locale}, so it cannot be rendered ahead of time.`,
            targetLocale: locale,
          }),
        );
      }
      serialized[name] = text;
    }
    return Object.freeze(serialized);
  });
}

/**
 * One route's address, or the reason there is none in this locale.
 *
 * A result rather than a throw, because its two callers want opposite things from the same
 * question. `buildLocalizedRoute` is being asked for an address and must refuse rather than hand
 * back one nothing can resolve. The address translators are being asked to rewrite a URL and must
 * decline rather than fail: they already hand an address they cannot place straight back, on the
 * stated ground that Atlas does not own every address in the application, and a route with no
 * address in the default locale is that same fact arriving from the builder instead of the
 * resolver. Making this throw would turn a request for `/ar-eg/ar-eg`, a page whose slug happens
 * to spell a locale prefix, into a crash on navigation, which is a URL deciding whether the
 * application runs.
 *
 * Only the claimed-segment outcome is a result. Every other failure here is a configuration
 * mistake with no correct fallback, and those still throw from inside.
 */
function localizedRouteAddress(
  policy: LocaleUrlPolicy,
  projectionValue: RouteRuntimeProjection,
  routeId: string,
  localeValue: string,
  parameters: Readonly<Record<string, unknown>>,
  query: readonly RouteQueryValue[] = [],
  fragment?: string,
  spellings?: LocalizedParameterSpellings,
):
  | { readonly ok: true; readonly address: string }
  | {
      readonly ok: false;
      readonly claimed: ClaimedLeadingSegment;
      readonly routeId: string;
      readonly locale: string;
      readonly segments: readonly string[];
    } {
  const projection = validateRouteProjection(projectionValue);
  const locale = canonicalLocale(localeValue);
  const policyValue = policy.locales[locale];
  if (policyValue === undefined)
    routeError('The requested route locale is unsupported.');
  const route = routeById(projection, routeId);
  const built = localizedRouteSegments(
    projection,
    route,
    locale,
    parameters,
    spellings,
  );
  if (!built.ok) {
    if (built.reason === 'parameter-missing') {
      routeError(`Route ${route.id} requires parameter ${built.parameter}.`);
    }
    if (built.reason === 'unsafe') {
      routeError(
        `Route ${route.id} produced an unsafe parameter ${built.parameter}.`,
      );
    }
    // A configuration failure, not an unavailable representation. The codec produced a spelling
    // for this locale and then could not read it back, so the address would be one Atlas emits and
    // cannot resolve. Refusing to build it is what keeps that from becoming a link.
    if (built.reason === 'unreadable') {
      routeError(
        `Route ${route.id} has a codec for parameter ${built.parameter} that cannot read its own ${locale} spelling back. \`parse(serialize(value, locale), locale)\` must return that value.`,
      );
    }
    throw new LocalizationError(
      Object.freeze({
        code: 'route-unavailable',
        outcome: 'localized-representation-unavailable',
        message:
          'The route parameter has no localized representation for the requested locale.',
        targetLocale: locale,
      }),
    );
  }
  const serialized = built.segments;
  // Nothing stands in front of the route's own segments here, so the first of them is the first
  // segment of the address. A route whose leading segment the policy has already claimed produces
  // an address this library's own resolver answers for something else, and the parameterised case
  // is only knowable now: a slug that serializes to a locale prefix is not visible to a build.
  const leading = serialized[0];
  const claimed =
    emittedLocalePrefix(policy, locale) === undefined && leading !== undefined
      ? claimedLeadingSegment(policy, leading)
      : undefined;
  if (claimed !== undefined) {
    return Object.freeze({
      ok: false as const,
      claimed,
      routeId: route.id,
      locale,
      segments: serialized,
    });
  }
  if (query.length > 32) routeError('Route query state exceeds Atlas bounds.');
  const queryText = query
    .map(
      ({ name, value }) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join('&');
  if (fragment !== undefined && [...fragment].length > 512) {
    routeError('Route fragment state exceeds Atlas bounds.');
  }
  const routeText = encodedSegments(serialized);
  const suffix = `${queryText.length === 0 ? '' : `?${queryText}`}${fragment === undefined ? '' : `#${encodeURIComponent(fragment)}`}`;
  if (policy.kind === 'path-prefix') {
    return Object.freeze({
      ok: true as const,
      address: `${pathPrefixCanonicalPath(policy, locale, serialized)}${suffix}`,
    });
  }
  const path = routeText.length === 0 ? '/' : `/${routeText}`;
  return Object.freeze({
    ok: true as const,
    address:
      policy.kind === 'locale-host'
        ? `${policyValue}${path}${suffix}`
        : `${path}${suffix}`,
  });
}

/**
 * Writes one route's address in one locale, with its parameters spelled the way that locale wants.
 *
 * The route identity is checked against the projection at compile time, and a parameterised route
 * requires its parameters, so a missing one is a type error rather than an address with a literal
 * `:id` in it. Returns a path, or an absolute URL under a host policy, since the locale is the
 * origin there.
 *
 * Throws a `LocalizationError` when the identity is not in the projection, when a parameter has no
 * codec, or when a codec refuses the value it was handed. Each of those is a mistake in the call
 * rather than something a visitor did.
 */
export function buildLocalizedRoute<
  const Projection extends RouteRuntimeProjection,
  Id extends RouteIdOf<Projection>,
>(
  policy: LocaleUrlPolicy,
  projectionValue: Projection,
  routeId: Id,
  localeValue: string,
  ...rest: RouteBuildArguments<Projection, Id>
): string {
  const built = localizedRouteAddress(
    policy,
    projectionValue,
    routeId,
    localeValue,
    (rest[0] ?? {}) as Readonly<Record<string, unknown>>,
    rest[1] ?? [],
    rest[2],
    rest[3],
  );
  return built.ok ? built.address : refuseClaimedAddress(built);
}

/**
 * Where this route lives in every locale that has an address for it.
 *
 * The visitor is on one page. This answers "and where is that page in Arabic", for every locale at
 * once, from the route they resolved, so it needs the policy, the projection and the declared
 * spellings, and nothing else. No origin, because a path is relative to whatever host the reader is
 * on. No indexing class, because the question is not whether a crawler may follow this. No
 * configuration, because the caller hands in the policy it wants answered: inside an application
 * that is the policy already narrowed to the locales the build produced.
 *
 * Two readers, neither of whose rules is here. `projectRouteSeo` below adds the origin, refuses
 * non-indexable pages, and collapses two locales that resolve to one URL, because an `hreflang`
 * cluster is a public claim. A locale switcher applies none of those: a reader on an account page
 * that no crawler may see still has an Arabic address to move to, and one on an application with no
 * canonical origin configured still has one. What both readers share is the path; each forms its
 * own string from it.
 *
 * Keyed by the canonical locale, which is the spelling the generated configuration uses:
 * `canonicalizeAtlasLocale` runs `Intl.getCanonicalLocales` over every configured locale at build
 * time and `canonicalLocale` runs it again here, so a policy that spells a locale differently
 * still lands on the key its runtime speaks. A locale whose parameters have no spelling in that
 * locale is absent rather than approximated: an address Atlas cannot build is one it must not
 * publish, which is the same rule the alternates are filtered by.
 *
 * The visitor's query and fragment are carried, because this is the address the switch moves to and
 * that is what the address bar shows after one. The crawler's reader drops them: section 6 of
 * `specs/07-routing-rendering-and-seo.spec.md` omits the query and the fragment from every
 * published URL, and section 10 of `specs/07-routing-rendering-and-seo.spec.md` composes what is
 * published from the origin, the mount point and the address alone.
 */
export function localizedRouteAddresses(
  resolution: Extract<RouteResolution, { readonly status: 'success' }>,
  policy: LocaleUrlPolicy,
  projection: RouteRuntimeProjection,
  spellings?: LocalizedParameterSpellings,
): Readonly<Record<string, string>> {
  const addresses: Record<string, string> = {};
  for (const locale of Object.keys(policy.locales)) {
    try {
      addresses[canonicalLocale(locale)] = buildLocalizedRoute(
        policy,
        projection,
        resolution.routeId,
        locale,
        resolution.parameters,
        resolution.query,
        resolution.fragment,
        spellings,
      );
    } catch (error: unknown) {
      if (
        error instanceof LocalizationError &&
        error.diagnostic.outcome === 'localized-representation-unavailable'
      ) {
        continue;
      }
      throw error;
    }
  }
  return Object.freeze(addresses);
}

/**
 * Whether arriving at this address, with no preference stated, actually yields this locale.
 *
 * Two things Atlas publishes are the same public claim: an `hreflang` alternate tells a crawler
 * that this URL serves that language, and a switcher option's `href` tells a reader that following
 * it takes them there. Both are only true if the address *selects* the locale on its own, with no
 * cookie, no `Accept-Language`, no session. So both are decided here, by asking the resolver what a
 * stranger would get, rather than by each caller reasoning about the policy it was configured with.
 *
 * **The observation replaces an assumption, and that is the point of it.** A rule written per policy
 * kind is a claim about every route under that kind, and no policy kind is uniform enough to carry
 * one: under `locale-neutral` a route with a localized *path* has a genuine per-locale address that
 * resolves to that locale for anyone, while the same policy's per-locale *slug* produces an address
 * that answers `308` back to the default spelling, because a parameter codec's `parse` maps both
 * spellings to one entity and reports no locale for the canonicalizer to keep. One kind, two
 * answers, measured on all three kinds and three route shapes.
 *
 * It also subsumes the duplicate-URL filter this replaced. Where two locales share one address, the
 * one actually served passes and the other does not, where that filter dropped both, including the
 * true entry, and kept a unique address that redirects because uniqueness is not truth.
 *
 * Under `path-prefix` and `locale-host` every address passes by construction: the prefix or the
 * origin *is* the locale, so the resolver reads it back off the address it was given. Nothing
 * changes there, which is the shape of a rule that is about addresses rather than about policies.
 *
 * The path only. The shared derivation carries the reader's query and fragment, and neither is an
 * input to which locale answers.
 */
export function addressSelectsLocale(
  address: string,
  locale: string,
  policy: LocaleUrlPolicy,
  projection: RouteRuntimeProjection,
): boolean {
  const arrival = resolveLocalizedRoute(
    splitSuffix(address)[0],
    policy,
    projection,
  );
  return arrival.status === 'success' && arrival.locale === locale;
}

/**
 * One published URL: the origin, the sub-path the application is mounted under, and the address.
 *
 * The address arrives from the policy in one of two shapes, and `withBasePath` mounts both: a
 * path by prefixing it, an absolute `locale-host` URL by mounting its path and keeping its origin.
 * What is added here is the site: a mounted path resolves against the configured origin, and a
 * mounted absolute URL resolves to itself.
 *
 * A root-mounted deployment produces the string it always produced, because an empty prefix
 * returns the address untouched and this is then the expression it always was.
 */
function mounted(location: string, baseHref: string, origin: URL): string {
  return new URL(withBasePath(location, baseHref), origin).href;
}

/**
 * What one resolved route says about itself to a crawler: its canonical URL, its reciprocal
 * `hreflang` alternates, and whether it may be indexed at all.
 *
 * `configuration` is here for the alternates. An `hreflang` link is a public claim that the same
 * page exists in another language, and the locales that claim can be made for are the ones this
 * build generated, not the ones the policy would address if they existed. Without it a locale
 * declared in the policy and never built was advertised on every indexable page, pointing at an
 * address that resolves to nothing and redirects back.
 *
 * The second condition on that same claim is `addressSelectsLocale` above: a built locale is only
 * advertised at an address that serves it to a visitor who states no preference, which is the only
 * kind of visitor a crawler is.
 *
 * `spellings` is for the routes whose parameters cannot be translated by a pure function: a slug
 * held in a database. It is supplied by whoever loaded the record, and it applies to the canonical
 * URL as well as the alternates, so that one page's address comes from one rule rather than two.
 *
 * `addresses` is that same rule, extended one step further. This function is a reader of
 * `localizedRouteAddresses` above, and a caller that has already derived them, the Router
 * adapter derives them per navigation for the locale switcher, passes them in so the pass is
 * made once rather than twice. Omitted, this derives its own and behaves identically. The one way
 * to make it lie is to pass a set built from a different resolution, policy or projection, so the
 * only caller that passes them derives them from the same three values a line earlier.
 *
 * `baseHref` is where the application is mounted, and it is the third of three things a published
 * URL is made of. `origin` is the site, this is the sub-path the deployment is served under, and
 * the address is what the policy says, from the application's own root. An application at
 * `https://example.com/app` publishes `https://example.com/app/ar-eg/second`, and without this it
 * published `https://example.com/ar-eg/second`: an address that is not the page, on a site that
 * may not even be Angular at that path.
 *
 * **It is the base, and not a path on `origin`, on purpose.** A deployment already declares its
 * mount point once, to Angular, and the runtime reads that declaration to strip the prefix off
 * every address it is handed. A second declaration here would be free to disagree with the first,
 * and the head would then advertise addresses the same build refuses to resolve. So `origin`
 * still refuses a path (it is the site, not the site plus a guess at the sub-path) and this
 * takes whatever `APP_BASE_HREF` or the document's `<base href>` said, in whichever spelling it
 * said it: `basePathPrefix` above reduces all of them the way Angular's own `Location` does.
 *
 * A root-mounted deployment is unchanged by construction rather than by convention. Its prefix is
 * empty, and an empty prefix takes the early return below before any URL is touched.
 */
export function projectRouteSeo(
  resolution: Extract<RouteResolution, { readonly status: 'success' }>,
  policy: LocaleUrlPolicy,
  projection: RouteRuntimeProjection,
  configuration: GeneratedConfiguration,
  origin: string,
  spellings?: LocalizedParameterSpellings,
  addresses?: Readonly<Record<string, string>>,
  baseHref = '',
): RouteSeoProjection {
  const site = trustedOrigin(origin, 'SEO projection origin');
  const indexing = resolution.indexing;
  if (indexing !== 'indexable') {
    return Object.freeze({
      indexing,
      alternates: Object.freeze([]),
      robots: indexing === 'private' ? 'noindex, nofollow' : 'noindex',
    });
  }
  const canonicalLocation = buildLocalizedRoute(
    policy,
    projection,
    resolution.routeId,
    resolution.locale,
    resolution.parameters,
    [],
    undefined,
    spellings,
  );
  const canonical = mounted(canonicalLocation, baseHref, site);
  const alternates: RouteAlternate[] = [];
  const built = builtLocales(policy, configuration);
  const located =
    addresses ??
    localizedRouteAddresses(resolution, policy, projection, spellings);
  for (const [locale, address] of Object.entries(located)) {
    // Two conditions, and they are not the same condition twice. The build decides whether this
    // locale exists at all, which no address can be asked about; the address decides whether it is
    // the one this locale is served at, which the build knows nothing about.
    if (!built.has(locale)) continue;
    if (!addressSelectsLocale(address, locale, policy, projection)) continue;
    // The path only. The shared derivation carries the reader's own query and fragment, because
    // that is the address a locale switch moves to, and
    // `specs/07-routing-rendering-and-seo.spec.md` section 6 has a canonical or alternate URL
    // omit both. Dropping is safe where rebuilding would not be: the first `?` or `#` ends a
    // path, so this cannot disagree with the serializer that produced it.
    const url = mounted(splitSuffix(address)[0], baseHref, site);
    alternates.push(
      Object.freeze({
        locale,
        hreflang: locale,
        url,
      }),
    );
  }
  return Object.freeze({
    indexing,
    canonical,
    alternates: Object.freeze(alternates),
    ...(policy.kind === 'locale-host'
      ? policy.xDefaultUrl === undefined
        ? {}
        : { xDefault: policy.xDefaultUrl }
      : policy.xDefaultPath === undefined
        ? {}
        : // Mounted like the rest of them: `xDefaultPath` is a path in this application, declared
          // the same way a route's is, and the fallback a crawler is sent to has to exist.
          { xDefault: mounted(policy.xDefaultPath, baseHref, site) }),
  });
}

/** At most 50,000 URLs in one file, from the sitemap protocol. */
const SITEMAP_URL_LIMIT = 50_000;

/**
 * At most 50 MB uncompressed in one file, from the same place, and it is the limit that binds
 * first here.
 *
 * A `url` entry with ten reciprocal alternates runs past a kilobyte, so fifty thousand of them
 * exceed fifty megabytes while the URL count is still exactly at its limit. Counting one and not
 * the other produces a file that is legal by the count a reader thought about and rejected by the
 * one they did not.
 */
const SITEMAP_BYTE_LIMIT = 52_428_800;

const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * The reserved `hreflang` value for the entry a crawler falls back to.
 *
 * Not a locale, which is why it is spelled once here rather than reached for as if it were one.
 */
const SITEMAP_X_DEFAULT = 'x-default';

const W3C_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u;

const NO_PARAMETERS: readonly Readonly<Record<string, unknown>>[] =
  Object.freeze([Object.freeze({})]);

const utf8 = new TextEncoder();

function utf8Length(value: string): number {
  return utf8.encode(value).length;
}

/**
 * `priority` as a plain decimal, which is the only form `xsd:decimal` accepts.
 *
 * `String(0.0000001)` is `1e-7`, and a schema refuses that: it is a valid number and not a valid
 * decimal. Four places is past anything a priority distinguishes, and trailing zeros go so that
 * the ordinary values read the way the protocol's own examples write them.
 */
function sitemapPriority(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    routeError(
      `A sitemap priority must be between 0 and 1 inclusive; received ${JSON.stringify(value)}.`,
    );
  }
  const fixed = value.toFixed(4).replace(/0+$/u, '');
  return fixed.endsWith('.') ? `${fixed}0` : fixed;
}

/** One published URL and everything the sitemap says about it. */
interface SitemapEntry {
  readonly url: string;
  readonly alternates: readonly RouteAlternate[];
  readonly xDefault?: string;
  readonly claim?: SitemapRouteClass & { readonly lastmod?: string };
}

function sitemapEntryXml(entry: SitemapEntry): string {
  const lines = [`  <url>`, `    <loc>${escapeXml(entry.url)}</loc>`];
  const claim = entry.claim;
  // In the schema's own order. `tUrl` is an `xsd:sequence`, so `priority` written before
  // `changefreq` is not a style difference, it is an invalid document.
  if (claim?.lastmod !== undefined) {
    if (!W3C_DATE.test(claim.lastmod)) {
      routeError(
        `A sitemap lastmod must be a W3C date or date and time; received ${JSON.stringify(claim.lastmod)}.`,
      );
    }
    lines.push(`    <lastmod>${claim.lastmod}</lastmod>`);
  }
  if (claim?.changefreq !== undefined) {
    lines.push(`    <changefreq>${claim.changefreq}</changefreq>`);
  }
  if (claim?.priority !== undefined) {
    lines.push(`    <priority>${sitemapPriority(claim.priority)}</priority>`);
  }
  for (const alternate of entry.alternates) {
    lines.push(
      `    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hreflang)}" href="${escapeXml(alternate.url)}"/>`,
    );
  }
  if (entry.xDefault !== undefined) {
    lines.push(
      `    <xhtml:link rel="alternate" hreflang="${SITEMAP_X_DEFAULT}" href="${escapeXml(entry.xDefault)}"/>`,
    );
  }
  lines.push(`  </url>`);
  return `${lines.join('\n')}\n`;
}

/**
 * One route to publish, and the parameter values that make it into pages.
 *
 * Structurally what `localizedServerRoutes` is already given, so a consumer passes the array it
 * wrote for the render table rather than writing the route list twice. `renderMode` is ignored
 * here and its presence is harmless: what a page is rendered by is not what a crawler is told.
 *
 * A parameterised route with no values contributes nothing, because a sitemap lists pages and a
 * pattern is not one. That is silent rather than an error for the same reason the render table
 * leaves it to Angular: whether a route needs enumerating is a property of how it is rendered,
 * which Atlas does not read.
 */
export interface SitemapRouteDeclaration {
  /** One of the identities the projection declares. */
  readonly routeId: string;
  /** The parameter values that turn a parameterised route into pages, spelled per locale. */
  readonly prerender?: readonly Readonly<Record<string, unknown>>[];
}

/** One file to publish: what to call it, what is in it, and what it holds. */
export interface SitemapDocument {
  /** The file name, relative to wherever the application serves it from. */
  readonly name: string;
  /** Whether this file lists pages or lists other sitemaps. */
  readonly kind: 'urlset' | 'index';
  /** The XML to serve, complete and ready to write. */
  readonly contents: string;
  /** URLs in this file, or child sitemaps for an index. */
  readonly urls: number;
  /** The size of `contents` in UTF-8 bytes, which is the size the protocol's limit is against. */
  readonly bytes: number;
}

/** Everything a sitemap is derived from, which is what the head is derived from plus the site. */
export interface SitemapProjectionOptions {
  /** The locale URL policy, narrowed to what this build serves where that applies. */
  readonly policy: LocaleUrlPolicy;
  /** The route projection, the same object the router and the render table were given. */
  readonly projection: RouteRuntimeProjection;
  /** The generated configuration, which decides which locales this build actually has. */
  readonly configuration: GeneratedConfiguration;
  /** The site these pages are published at. Carries no path; the mount point is `baseHref`. */
  readonly origin: string;
  /** The routes to publish and their parameter values. */
  readonly routes: readonly SitemapRouteDeclaration[];
  /** Per-locale spellings for parameters no pure function can translate. */
  readonly spellings?: LocalizedParameterSpellings;
  /** The sub-path the application is served under, composed into every URL published here. */
  readonly baseHref?: string;
  /**
   * What the first file is called, and what a `robots.txt` line points at.
   *
   * It stays this name whether or not the set had to be split, because the split is an artifact of
   * how many pages there are and the address a crawler was given is not. Past a limit this file
   * becomes the index and the pages move into numbered siblings beside it.
   */
  readonly fileName?: string;
}

/**
 * Every sitemap file for this build, from the projection the head is written from.
 *
 * **The alternates here and the alternates in the document head are one derivation read twice.**
 * Both come from `projectRouteSeo` above, so a page whose head advertises three languages has three
 * in its sitemap entry and the same three URLs, and the agreement is structural rather than
 * asserted. That is the whole reason this is a reader of that function rather than a second
 * traversal of the policy: two traversals agree until one of them is corrected.
 *
 * A page is a route and a set of parameter values, and it appears once per locale that has an
 * address serving it. `projectRouteSeo` decides which those are, by the three conditions in
 * section 10 of `specs/07-routing-rendering-and-seo.spec.md`: the policy addresses the locale, the
 * build generated it, and the
 * address serves it to a visitor who states no preference. A non-indexable route contributes
 * nothing at all, which is the indexing class doing in a sitemap exactly what it does in the head.
 *
 * **`loc` is filtered to the origin it was given, and the alternates are not.** The protocol
 * requires every URL in one file to be on one host, and a `locale-host` policy puts each locale on
 * its own. So a host publishes the pages that are its own and points at the others as alternates,
 * which is what the format is for, and a deployment that serves three hosts calls this three times
 * exactly as it built three times. Under the other two policies every address is already on the
 * one origin and this filter removes nothing.
 *
 * **Files split on both limits.** Fifty thousand URLs is the count and fifty megabytes is the size,
 * and with reciprocal alternates the size is reached first, so counting only the count writes a
 * file no crawler will read. When a split happens the named file becomes an index and the pages go
 * into numbered files beside it, so the address the application published does not change when the
 * site grows past a limit.
 *
 * **This returns files rather than writing them, and that is the layering rather than a choice.**
 * A sitemap is a list of addresses, and an address does not exist until six things do: the locale
 * URL policy, the route projection, the parameter codecs, the parameter values that turn a pattern
 * into pages, the origin this build answers at, and the mount point it is served under. All six are
 * values the application holds when it runs. `atlas generate` reads source text and cannot see any
 * of them, so a generator writing files at build time could be right only for a site with no
 * localized paths and no parameterized indexable pages, and would be quietly wrong for every other
 * one. So Atlas supplies the projection and the validation and the application supplies the
 * delivery, which is section 10 as written: where the files are written, how they are served, and
 * the `Sitemap:` line in `robots.txt` are the application's.
 */
export function projectSitemap(
  options: SitemapProjectionOptions,
): readonly SitemapDocument[] {
  const {
    policy,
    projection,
    configuration,
    origin,
    routes,
    spellings,
    baseHref = '',
    fileName = 'sitemap.xml',
  } = options;
  const site = trustedOrigin(origin, 'sitemap origin');
  const entries: SitemapEntry[] = [];
  const published = new Set<string>();

  for (const declaration of routes) {
    const route = routeById(projection, declaration.routeId);
    const claim = route.sitemap;
    for (const parameters of declaration.prerender ??
      (route.parameterNames.length > 0 ? [] : NO_PARAMETERS)) {
      // One projection for the page rather than one per locale. Every locale's entry carries the
      // same reciprocal cluster, so asking once and reading the cluster is the same answer as
      // asking per locale, and it is the answer the head gets.
      const seo = pageSeo(
        policy,
        projection,
        configuration,
        origin,
        parameters,
        declaration.routeId,
        spellings,
        baseHref,
      );
      if (seo === undefined || seo.indexing !== 'indexable') continue;
      for (const alternate of seo.alternates) {
        if (new URL(alternate.url).origin !== site.origin) continue;
        if (published.has(alternate.url)) continue;
        published.add(alternate.url);
        entries.push({
          url: alternate.url,
          alternates: seo.alternates,
          ...(seo.xDefault === undefined ? {} : { xDefault: seo.xDefault }),
          ...(claim === undefined ? {} : { claim }),
        });
      }
    }
  }

  return sitemapFiles(entries, fileName, baseHref, site);
}

/**
 * What one page says about itself, or nothing when no locale of it resolves.
 *
 * The locale this is asked in does not change the answer: the cluster is the page's, not the
 * locale's. So the first address that resolves is used, and a route whose parameters have no
 * spelling in a locale simply moves to the next one rather than failing the file.
 */
function pageSeo(
  policy: LocaleUrlPolicy,
  projection: RouteRuntimeProjection,
  configuration: GeneratedConfiguration,
  origin: string,
  parameters: Readonly<Record<string, unknown>>,
  routeId: string,
  spellings: LocalizedParameterSpellings | undefined,
  baseHref: string,
): RouteSeoProjection | undefined {
  for (const locale of Object.keys(policy.locales)) {
    let address: string;
    try {
      address = buildLocalizedRoute(
        policy,
        projection,
        routeId,
        locale,
        parameters,
        [],
        undefined,
        spellings,
      );
    } catch (error: unknown) {
      if (
        error instanceof LocalizationError &&
        error.diagnostic.outcome === 'localized-representation-unavailable'
      ) {
        continue;
      }
      throw error;
    }
    const resolution = resolveLocalizedRoute(
      splitSuffix(address)[0],
      policy,
      projection,
    );
    if (resolution.status !== 'success') continue;
    return projectRouteSeo(
      resolution,
      policy,
      projection,
      configuration,
      origin,
      spellings,
      undefined,
      baseHref,
    );
  }
  return undefined;
}

/**
 * The entries, cut into files that both limits hold for, and an index when there is more than one.
 *
 * The envelope counts. A file's size is its declaration, its root element and its entries, and a
 * budget that counts only the entries is a budget that is wrong by the part that is always there.
 */
function sitemapFiles(
  entries: readonly SitemapEntry[],
  fileName: string,
  baseHref: string,
  site: URL,
): readonly SitemapDocument[] {
  const open = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${SITEMAP_NAMESPACE}" xmlns:xhtml="${XHTML_NAMESPACE}">\n`;
  const close = `</urlset>\n`;
  const envelope = utf8Length(open) + utf8Length(close);

  const pages: { readonly contents: string; readonly urls: number }[] = [];
  let current: string[] = [];
  let bytes = envelope;
  const flush = (): void => {
    if (current.length === 0) return;
    pages.push({
      contents: `${open}${current.join('')}${close}`,
      urls: current.length,
    });
    current = [];
    bytes = envelope;
  };
  for (const entry of entries) {
    const text = sitemapEntryXml(entry);
    const size = utf8Length(text);
    if (
      current.length > 0 &&
      (current.length + 1 > SITEMAP_URL_LIMIT ||
        bytes + size > SITEMAP_BYTE_LIMIT)
    ) {
      flush();
    }
    current.push(text);
    bytes += size;
  }
  flush();

  if (pages.length <= 1) {
    const contents = pages[0]?.contents ?? `${open}${close}`;
    return Object.freeze([
      Object.freeze({
        name: fileName,
        kind: 'urlset' as const,
        contents,
        urls: pages[0]?.urls ?? 0,
        bytes: utf8Length(contents),
      }),
    ]);
  }

  const dot = fileName.lastIndexOf('.');
  const stem = dot <= 0 ? fileName : fileName.slice(0, dot);
  const extension = dot <= 0 ? '' : fileName.slice(dot);
  const documents = pages.map((page, position) =>
    Object.freeze({
      name: `${stem}-${position + 1}${extension}`,
      kind: 'urlset' as const,
      contents: page.contents,
      urls: page.urls,
      bytes: utf8Length(page.contents),
    }),
  );
  const index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${SITEMAP_NAMESPACE}">\n${documents
    .map(
      (document) =>
        `  <sitemap>\n    <loc>${escapeXml(mounted(`/${document.name}`, baseHref, site))}</loc>\n  </sitemap>\n`,
    )
    .join('')}</sitemapindex>\n`;
  return Object.freeze([
    ...documents,
    Object.freeze({
      name: fileName,
      kind: 'index' as const,
      contents: index,
      urls: documents.length,
      bytes: utf8Length(index),
    }),
  ]);
}

/**
 * Turns a resolved address into the response to send for it: status, headers, and cacheability.
 *
 * For a server answering a request. It decides what follows from routing and nothing else, so the
 * caller still chooses how long a cacheable response may be held, which `routeCacheHeaders` takes.
 */
export function routeHttpDescriptor(
  resolution: RouteResolution,
): RouteHttpDescriptor {
  switch (resolution.status) {
    case 'malformed':
      return Object.freeze({
        status: 400,
        contentLanguage: resolution.presentationLocale,
        robots: 'noindex',
        cache: 'private-no-store',
      });
    case 'unsupported-locale':
    case 'not-found':
      return Object.freeze({
        status: 404,
        contentLanguage: resolution.presentationLocale,
        robots: 'noindex',
        cache: 'private-no-store',
      });
    case 'gone':
      return Object.freeze({
        status: 410,
        contentLanguage: resolution.presentationLocale,
        robots: 'noindex',
        cache: 'private-no-store',
      });
    case 'redirect':
      return Object.freeze({
        status: resolution.httpStatus,
        location: resolution.location,
        cache: resolution.cache,
      });
    case 'success':
      return Object.freeze({
        status: 200,
        contentLanguage: resolution.locale,
        ...(resolution.indexing === 'indexable'
          ? {}
          : {
              robots:
                resolution.indexing === 'private'
                  ? ('noindex, nofollow' as const)
                  : ('noindex' as const),
            }),
        cache:
          resolution.indexing === 'private'
            ? 'private-no-store'
            : resolution.variesBy === 'locale-preference'
              ? 'varies-by-locale-preference'
              : 'public',
      });
  }
}

/**
 * The address translation, as two pure functions.
 *
 *   toExternalPath()  canonical internal -> localized external
 *   toInternalPath()  localized external -> canonical internal
 *
 * Mirror images of the same pair of Atlas calls: `resolveLocalizedRoute` reads an address into a
 * route identity and its parameters, `buildLocalizedRoute` writes that pair back out in whichever
 * locale the direction wants. Outbound wants the active locale. Inbound wants the default one,
 * because the internal address is by definition the one the authored route table matches.
 *
 * Pure and exported so the translation can be exercised directly. The class below is a shell that
 * supplies the arguments from DI, and a shell is the part a rendered-output check has to prove;
 * the arithmetic is the part a unit test can.
 */

/** The base href never varies, so everything locale-dependent lives below it, in the path. */
export interface LocalizedAddressContext {
  /** How addresses say which locale they are in. */
  readonly policy: LocaleUrlPolicy;
  /** The route table addresses are resolved against. */
  readonly projection: RouteRuntimeProjection;
}

/**
 * The prefix the internal address space does *not* carry.
 *
 * Empty when the policy omits the default locale's prefix, because then the canonical address is
 * already unprefixed and there is nothing to strip. Computing it as the configured prefix anyway
 * would strip a leading segment from any route genuinely spelled that way.
 */
function defaultPrefix(policy: LocaleUrlPolicy): string {
  if (policy.kind !== 'path-prefix' || policy.omitDefaultPrefix) return '';
  const prefix = policy.locales[policy.defaultLocale];
  return prefix === undefined || prefix === '' ? '' : `/${prefix}`;
}

function splitSuffix(url: string): readonly [string, string] {
  const index = url.search(/[?#]/u);
  return index < 0 ? [url, ''] : [url.slice(0, index), url.slice(index)];
}

function dropPrefix(path: string, prefix: string): string {
  if (prefix === '') return path;
  const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return rest === '' ? '/' : rest;
}

/**
 * Whether this policy distinguishes locales in the path at all.
 *
 * `locale-neutral` puts every locale at one address, so there is nothing to translate.
 * `locale-host` distinguishes by origin, and `buildLocalizedRoute` returns an absolute URL for it,
 * which is not something a `LocationStrategy` path may be. Both are handed through untouched.
 */
function translates(policy: LocaleUrlPolicy): boolean {
  return policy.kind === 'path-prefix';
}

/**
 * The redirects a client-side arrival follows, and why it is only the permanent ones.
 *
 * A visitor who arrives from outside gets the server's answer, and for an address the resolver
 * corrects that answer is a `308`. A visitor who arrives from inside the application (an in-app
 * link, a `Location` write, a hydrated Back) never reaches the server, and until this the address
 * was handed to the Router unchanged. Under `omitDefaultPrefix` that meant `/en-us/second`, the
 * spelling this policy retired, reached a route table with no `en-us` branch and died with
 * `NG04002`; a retired path spelling did the same and fell through to the application's `**`. Both
 * are the same shape: **the resolver answered with a redirect and the client ignored it**, so one
 * address had two answers depending on which door the reader came through.
 *
 * `httpStatus` is the whole of the rule, and it comes from the resolution rather than from a list
 * of reasons kept in step by hand. The two `308`s, `canonical-correction` and `replacement`,
 * correct the address itself and answer the same for every request, which is what makes them safe
 * to apply without one. `locale-entry` is a `307` marked `private-no-store`: its answer depends on
 * a preference the address does not state, so following it here would move a reader between locales
 * during what is meant to be an address translation. `gone` is not a redirect at all and keeps
 * falling through to the application's own not-found, which is where a retired page with no
 * replacement belongs.
 *
 * Followed once. A `308` whose target is itself a `308` is a defect in the projection rather than a
 * chain to walk, and the second resolution is returned as it comes: not `success`, so the caller
 * hands the address back untouched, which is what it did before this followed anything.
 */
function followPermanentRedirect(
  resolution: RouteResolution,
  policy: LocaleUrlPolicy,
  projection: RouteRuntimeProjection,
): RouteResolution {
  if (resolution.status !== 'redirect' || resolution.httpStatus !== 308)
    return resolution;
  return resolveLocalizedRoute(resolution.location, policy, projection);
}

/**
 * The declared base href reduced to the path it means, by the steps Angular reduces it by.
 *
 * The three that follow are `Location`'s own, in its order: a trailing `/index.html` goes, then one
 * trailing slash, then the origin of an absolute base. `@angular/common` 22.1.3,
 * `_location-chunk.mjs:239`, `this._basePath = _stripOrigin(stripTrailingSlash(_stripIndexHtml(
 * baseHref)))`, with the three at `:20`, `:366` and `:369`. Matching them is not deference; it is
 * the only way this cannot disagree with `Location.normalize`, which strips the same base off the
 * same address a few frames away, and a disagreement there is an address one half of the runtime
 * accepts and the other does not.
 *
 * **An absolute base href is a server-side shape, and it is why this is not `replace(/\/$/)`.**
 * Measured on a real `renderApplication` at `@angular/platform-server` 22.1.3: a document declaring
 * `<base href="https://example.com/app/">` yields exactly that string from
 * `PlatformLocation.getBaseHrefFromDOM()` on the server, because the server DOM adapter returns the
 * attribute unresolved (`_server-chunk.mjs:61`). The browser adapter resolves it first
 * (`new URL(href, document.baseURI).pathname`, `platform-browser` `_browser-chunk.mjs:57-59`) so
 * the same document is a path in one place and a URL in the other. Reading only the first spelling
 * puts the sub-path defect of section 14.7 back for exactly the deployments that prerender.
 *
 * A bare `/`, an empty string, and the document origin that `PathLocationStrategy` falls back to
 * when nothing declares a base all reduce to no prefix at all, which is what a root deployment is.
 */
function basePathPrefix(baseHref: string): string {
  const withoutIndex = baseHref.replace(/\/index\.html$/u, '');
  const pathEnd = withoutIndex.search(/[?#]|$/u);
  const trimmed =
    withoutIndex[pathEnd - 1] === '/'
      ? withoutIndex.slice(0, pathEnd - 1) + withoutIndex.slice(pathEnd)
      : withoutIndex;
  if (!/^(https?:)?\/\//u.test(trimmed)) return trimmed;
  const [, pathname] = trimmed.split(/\/\/[^/]+/u);
  return pathname ?? '';
}

/**
 * The address without the sub-path the application is deployed under.
 *
 * An application served at `https://example.com/app` sees `/app/ar-eg/second` in every address the
 * browser hands it, and `/app` is not part of any address Atlas knows: the policy addresses routes
 * from the application's own root. So the base path comes off before anything reads a locale out of
 * an address, and `withBasePath` puts it back before one reaches the browser. Every caller that
 * does one owes the other.
 *
 * **Both directions are needed in two places, which is why this is one function rather than a line
 * in each.** The `LocationStrategy` strips it to delocalize and restores it to write; locale
 * resolution strips it to read the prefix out of the address the document is at. Missing it there
 * is not a formatting slip: `/app/ar-eg/second` begins with a segment no policy names, so the
 * locale falls back to the default and the reader gets English at an Arabic address.
 *
 * A prefix only matches at a segment boundary. `/app` is not the base of `/application/x`, and the
 * naive `startsWith` that says otherwise removes four characters from the middle of a word. It
 * cannot arise from a browser under a correct deployment, and it can arise from a server, a test,
 * or a consumer passing an address in by hand.
 *
 * An empty base, `/`, and the origin `PathLocationStrategy` falls back to when a document declares
 * no `<base href>` all strip nothing, which is the right answer for all three: each reduces to no
 * prefix, and no prefix is what a root deployment has.
 */
export function withoutBasePath(address: string, baseHref: string): string {
  const prefix = basePathPrefix(baseHref);
  if (prefix === '' || !address.startsWith(prefix)) return address;
  const rest = address.slice(prefix.length);
  if (rest === '') return '/';
  if (rest.startsWith('/')) return rest;
  // `;` is a boundary because the Router's matrix parameters make it one, and because Angular's
  // `_stripBasePath` lists it beside `/`, `?` and `#` (`_location-chunk.mjs:361`). Restored with a
  // leading slash: what leaves here is an application-rooted address, and every reader wants one.
  return /^[?#;]/u.test(rest) ? `/${rest}` : address;
}

/**
 * The inverse: an application-rooted address as the browser must see it.
 *
 * Two shapes arrive here and both are composed the same way, because the mount point applies to
 * both. Most addresses are application-rooted paths, and the prefix goes in front. Under a
 * `locale-host` policy `buildLocalizedRoute` produces an absolute URL on another locale's origin,
 * and the prefix goes into that URL's path instead: a build served under `/app` serves every one
 * of its locale domains under `/app`, so the origin is kept and the path is mounted.
 *
 * Deciding by parse rather than by pattern: an address that is a URL on its own is absolute, and
 * one that needs a base is a path. That is the same question `new URL` answers, so there is no
 * second definition of what "absolute" means here to drift from it.
 *
 * A root-mounted deployment returns the address it was given, before either branch.
 */
export function withBasePath(address: string, baseHref: string): string {
  const prefix = basePathPrefix(baseHref);
  if (prefix === '') return address;
  let absolute: URL;
  try {
    absolute = new URL(address);
  } catch {
    return `${prefix}${address}`;
  }
  absolute.pathname = `${prefix}${absolute.pathname}`;
  return absolute.href;
}

/**
 * Turns an address as a visitor sees it into the one the authored route table matches.
 *
 * The inbound half of the translation: the locale's spelling is read back into a route identity and
 * its parameters, then written out again in the default locale, which is what the route table was
 * authored in. Query and fragment are carried through.
 *
 * An address Atlas cannot place is returned unchanged, so an application's own catch-all route and
 * any locale-neutral root still answer for it.
 */
export function toInternalPath(
  external: string,
  context: LocalizedAddressContext,
): string {
  const { policy, projection } = context;
  if (!translates(policy)) return external;
  const [pathOnly, suffix] = splitSuffix(external);
  const resolution = followPermanentRedirect(
    resolveLocalizedRoute(pathOnly, policy, projection),
    policy,
    projection,
  );
  // An address Atlas cannot place is handed back untouched, so the application's own `**` route
  // and any locale-neutral root still answer for it. Declining is the correct outcome here, not a
  // failure: Atlas does not own every address in the application.
  if (resolution.status !== 'success') return external;
  // A route with no address in the default locale has no internal address either, and that is a
  // request the visitor can cause: a slug spelling a locale prefix reaches here from the URL bar.
  // Handed back untouched, on the same ground as the resolution above.
  const canonical = localizedRouteAddress(
    policy,
    projection,
    resolution.routeId,
    policy.defaultLocale,
    resolution.parameters,
  );
  if (!canonical.ok) return external;
  return `${dropPrefix(canonical.address, defaultPrefix(policy))}${suffix}`;
}

/**
 * A canonical internal address, spelled for the locale the reader is in.
 *
 * `spellings` is here for the same reason it is on `projectRouteSeo`, and for a sharper one: this
 * is what writes the address bar. A locale switch is not a navigation, so the switch calls
 * `Location.replaceState` with the Router's canonical URL and this function localizes it. Without
 * the declaration the head would carry the record's Arabic slug while the address bar carried its
 * English one, which is one page giving two answers about where it lives.
 */
export function toExternalPath(
  internal: string,
  activeLocale: string,
  context: LocalizedAddressContext,
  spellings?: LocalizedParameterSpellings,
): string {
  const { policy, projection } = context;
  if (!translates(policy)) return internal;
  const [pathOnly, suffix] = splitSuffix(internal);
  const prefix = defaultPrefix(policy);
  const resolution = resolveLocalizedRoute(
    `${prefix}${pathOnly === '/' && prefix !== '' ? '' : pathOnly}`,
    policy,
    projection,
  );
  if (resolution.status !== 'success') return internal;
  const localized = localizedRouteAddress(
    policy,
    projection,
    resolution.routeId,
    activeLocale,
    resolution.parameters,
    [],
    undefined,
    spellings,
  );
  // Declined for the same reason as above: this route has no address in the requested locale, so
  // there is nothing to rewrite the URL to.
  return localized.ok ? `${localized.address}${suffix}` : internal;
}
