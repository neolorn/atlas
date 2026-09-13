// Atlas builds the response and the application supplies the body, which is
// `specs/07-routing-rendering-and-seo.spec.md` section 5. A handler that only set headers could
// not answer a redirect, an unsupported locale or a malformed target, and those are the outcomes
// that must never reach a renderer; a handler that produced the body would have to know what a
// page looks like. So the status is Atlas's, the body is the renderer's, and section 14 of
// `specs/07-routing-rendering-and-seo.spec.md` is what keeps a 404 in the requested locale at
// the requested address rather than redirecting it somewhere that renders.

// Relative, not `@neolorn/atlas`.
//
// A secondary entry point that imports the primary keeps that import in its own bundle, and the
// primary is the thing that throws on import in plain Node. So the classification lives inside this
// entry point's graph rather than beside it, and the primary re-exports it from here. That is the
// layering the right way up: the base does not depend on the integration.
import {
  builtLocalePolicy,
  resolveLocalizedRoute,
  routeCacheHeaders,
  routeHttpDescriptor,
  type GeneratedConfiguration,
  type LocalePreferenceSource,
  type LocaleUrlPolicy,
  type RouteCacheDurations,
  type RouteHttpDescriptor,
  type RouteResolution,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

import { rawTargetOf } from './raw-target';

/**
 * How this deployment remembers a visitor's choice, or that it does not.
 *
 * `false` is a real answer rather than an omission: a deployment that negotiates from
 * `Accept-Language` alone is shared-cacheable per language, and one that reads a cookie is not.
 * Which of those it is decides what a CDN may do with every page of the site, so it is stated.
 */
export type LocaleCookiePolicy =
  | false
  | {
      readonly name?: string;
      readonly path?: string;
      readonly maxAgeSeconds?: number;
      readonly sameSite?: 'Lax' | 'Strict' | 'None';
      readonly secure?: boolean;
      readonly domain?: string;
    };

/**
 * The outcomes that have a body, which are the only ones a renderer is asked about.
 *
 * Narrowed rather than left as the full union, because the handler already guarantees it: `render`
 * is called only behind `hasBody`. A renderer typed against every resolution has to re-check what
 * the handler has already decided, and the check it writes is the one that goes stale: a redirect
 * has no `presentationLocale`, and nothing but the type stops a consumer reaching for it.
 *
 * A redirect and a malformed target are both excluded, and from the renderer's side for the same
 * reason: neither is an outcome with a presentation. A redirect's answer is its location, and a
 * malformed target has been refused, so asking an application to draw a page for either is asking
 * it to draw something that does not exist.
 *
 * *Stated as an exclusion, not as a list of the statuses that have bodies.* The obvious
 * spelling (`Extract<RouteResolution, { status: 'success' | 'not-found' | 'gone' }>`) silently
 * drops `not-found`, because one member of the union carries
 * `status: 'unsupported-locale' | 'not-found'` and a member whose discriminant is itself a union is
 * not assignable to a narrower one. It compiles, it looks exhaustive, and the resulting guard claims
 * a type the runtime does not honour. A redirect is the thing that genuinely has no body, so that is
 * what the type says.
 */
export type RenderableResolution = Exclude<
  RouteResolution,
  { readonly status: 'redirect' | 'malformed' }
>;

/** What the handler resolved, handed to the renderer when there is something to render. */
export interface LocaleRequestOutcome {
  /** The request as it arrived, so a renderer can read a header Atlas had no reason to. */
  readonly request: Request;
  /**
   * What the address resolved to: the route, its parameters, and the status the response carries.
   *
   * A redirect is excluded by the type, because the handler answers those itself.
   */
  readonly resolution: RenderableResolution;
  /**
   * The locale this response is in, which is what the document should be rendered in.
   *
   * For an address that names no locale and no preference that could be honoured, this is the
   * policy's default rather than nothing, so a renderer always has a language to write in.
   */
  readonly locale: string;
}

/**
 * A response whose status the application is stating for itself.
 *
 * Section 5 of `specs/07-routing-rendering-and-seo.spec.md` keeps three outcome classes apart, and
 * an operational failure is not a routing outcome: serving maintenance, or reporting a render that
 * failed, is the application's own answer about its own condition at an address that resolved
 * perfectly well. Atlas has nothing to say about it and no way to detect it, so it is declared.
 *
 * *The wrapper is the declaration.* A renderer's plain `Response` also carries a status, and
 * reading that as a statement would make an accidental 500 and a deliberate one the same signal,
 * which section 5 forbids for exactly that reason. Wrapping is the act that separates them.
 */
export interface DeclaredOperationalFailure {
  /** The response to send, whose own status is the one being declared. */
  readonly operationalFailure: Response;
}

/**
 * Declares the response's own status rather than letting the address's status stand.
 *
 * ```ts
 * render: () =>
 *   declareOperationalFailure(
 *     new Response(maintenanceDocument, {
 *       status: 503,
 *       headers: { 'retry-after': '600', 'content-type': 'text/html' },
 *     }),
 *   );
 * ```
 *
 * The declaration is honoured at an address Atlas serves. At one it refuses, the refusal stands
 * and the declaration is reported where a developer will see it, because an application declaring
 * maintenance does not know which addresses Atlas refused and cannot be asked to.
 */
export function declareOperationalFailure(
  response: Response,
): DeclaredOperationalFailure {
  return Object.freeze({ operationalFailure: response });
}

/**
 * What a renderer may return: the document, or the document with a status declared for it.
 *
 * A union rather than a replacement for `Response`. A renderer that returns one keeps working
 * exactly as it did, which is what allows the second arm to arrive in a minor release, and it is
 * also the honest shape: declaring an operational failure is the uncommon case and it should look
 * like one at the call site.
 */
export type LocalizedRenderResult = Response | DeclaredOperationalFailure;

/** Produces the document. Called only for outcomes that have a body. */
export type LocaleRenderer = (
  outcome: LocaleRequestOutcome,
) => LocalizedRenderResult | Promise<LocalizedRenderResult>;

/**
 * What a locale request handler needs to answer a request.
 *
 * The first four are required because a wrong default in any of them is a wrong response rather
 * than a missing feature: a handler that guessed the address shape, the route set or the cache
 * lifetimes would be serving something, and what it served would be plausible.
 */
export interface LocaleRequestHandlerOptions {
  /** How locale appears in an address, and which locale an address that names none is in. */
  readonly policy: LocaleUrlPolicy;
  /** The routes this deployment serves, which decides whether an address exists at all. */
  readonly projection: RouteRuntimeProjection;
  /**
   * The build's own locale set, so a policy naming a locale this build did not generate publishes
   * no address for it. Optional only because a consumer may not have one to hand; supplying it is
   * the correct thing to do and the fixture does.
   */
  readonly configuration?: GeneratedConfiguration;
  /**
   * How long each class of response may be held, and by whom.
   *
   * Read together with the cookie policy, which decides whether a shared cache may keep any of it
   * at all, so a deployment that remembers a choice is not served another visitor's language.
   */
  readonly cache: RouteCacheDurations;
  /**
   * How a visitor's choice is remembered, or `false` for a deployment that does not remember one.
   *
   * Omitting it takes the defaults, which do remember. It is the setting with the widest reach
   * here: it decides what every response at every address may be cached as.
   */
  readonly cookie?: LocaleCookiePolicy;
  /**
   * Produces the document. Without it the handler answers the status and the headers and no body,
   * which is the right shape for a deployment that puts Atlas in front of something else that
   * renders.
   */
  readonly render?: LocaleRenderer;
  /**
   * What serves an address Atlas declined to localize.
   *
   * Static assets and the policy's own locale-neutral roots reach here. Without it they answer 404,
   * which is honest, Atlas will not invent a response for something it has decided is not its
   * business, but a real deployment hands them to whatever serves files.
   */
  readonly passthrough?: (request: Request) => Response | Promise<Response>;
}

/**
 * Answers one request: takes a Fetch `Request` and gives back the response to send.
 *
 * It never throws for an address it does not recognize. An address outside the policy goes to
 * `passthrough` or answers 404, and an unsupported locale answers at the address it was asked for
 * rather than being moved somewhere that renders.
 */
export type LocaleRequestHandler = (request: Request) => Promise<Response>;

const ONE_YEAR_SECONDS = 31_536_000;

/**
 * Builds the handler that decides a response's status, language, caching and redirect.
 *
 * Takes the policy, the routes, the cache lifetimes and the cookie policy, and returns a function
 * from a request to a response. The status is Atlas's and the body is the renderer's, so a
 * redirect, an unsupported locale and a malformed address are all answered without a renderer
 * being asked anything.
 *
 * Call it once at start-up. It reads the options then, and the cookie policy in particular decides
 * how every response may be cached, so a per-request handler would be deciding that per request.
 */
export function createLocaleRequestHandler(
  options: LocaleRequestHandlerOptions,
): LocaleRequestHandler {
  const policy =
    options.configuration === undefined
      ? options.policy
      : builtLocalePolicy(options.policy, options.configuration);
  const cookie = options.cookie ?? {};
  const cookieName =
    cookie === false ? undefined : (cookie.name ?? 'atlas-locale');

  // Derived from what this deployment reads, never from what this request happened to carry.
  //
  // This is 6.1's defect one level up, and it is easy to write by accident: a request arriving
  // without a cookie was negotiated from `Accept-Language`, so deriving the source per request
  // would mark that response shared-cacheable per language, and it shares an address with the
  // responses that were decided by a cookie. A deployment that reads cookies at all has cookie-
  // varying responses at every address that varies, whoever happens to be asking.
  const localePreference: LocalePreferenceSource =
    cookie === false ? 'accept-language' : 'cookie';

  // Per handler rather than per module, so one deployment's warnings cannot silence another's,
  // and per process rather than per request, because a declaration at a refused address is a
  // defect in how the renderer was written and repeating it once a request reports nothing new.
  const reported = new Set<string>();

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const carried =
      cookieName === undefined
        ? undefined
        : readCookie(request.headers.get('cookie'), cookieName);
    const preferred =
      carried ??
      preferredFromAcceptLanguage(request.headers.get('accept-language'));

    // The target as it arrived, when this entry point's own adapter built the request. A `Request`
    // carries a parsed URL, and parsing one resolves dot segments and rewrites a backslash, so the
    // path on it is not always what was asked for.
    const resolution = resolveLocalizedRoute(
      rawTargetOf(request) ?? `${url.pathname}${url.search}`,
      policy,
      options.projection,
      preferred === undefined ? undefined : { locale: preferred },
    );

    // Classified before anything dispatches on it, which is the order
    // `specs/07-routing-rendering-and-seo.spec.md` section 4 states: the target is validated, then
    // a locale-neutral root reaches its owner, then presentation routing. A bypassed address is
    // not exempt from the first step, because `/assets/%2e%2e/%2e%2e/etc/passwd` is not an asset
    // request, and handing it to whatever serves files is the one thing that must not happen.
    if (resolution.status !== 'malformed' && bypasses(url, policy)) {
      // Declined, not rendered. A bypassed address is one Atlas has decided is not about locale
      // (a static asset, a health check, an upload root) and rendering the application's page for
      // `/main-A1B2C3.js` would be worse than answering nothing. The consumer's own handling is
      // what should serve it, so `passthrough` is where it goes and a 404 is what happens when
      // there is none.
      return (
        options.passthrough?.(request) ?? new Response(null, { status: 404 })
      );
    }
    const descriptor = routeHttpDescriptor(resolution);
    const settled = settledLocale(resolution);

    // Taken as an argument rather than read from the descriptor, because a declared operational
    // failure changes what a cache may do with the response and changes nothing else about it,
    // and that is known only after the renderer has answered.
    const atlasHeaders = (cache: RouteHttpDescriptor['cache']): Headers => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(
        routeCacheHeaders(
          { ...descriptor, cache },
          { ...options.cache, localePreference },
        ),
      )) {
        headers.set(name, value);
      }
      if (descriptor.contentLanguage !== undefined) {
        headers.set('content-language', descriptor.contentLanguage);
      }
      if (descriptor.robots !== undefined) {
        headers.set('x-robots-tag', descriptor.robots);
      }
      if (descriptor.location !== undefined) {
        headers.set('location', descriptor.location);
      }
      // Only when there is something new to remember, and only when a person asked for it.
      if (
        cookieName !== undefined &&
        settled !== undefined &&
        settled !== carried &&
        !isBackgroundRequest(request)
      ) {
        headers.append(
          'set-cookie',
          serializeCookie(cookieName, settled, cookie === false ? {} : cookie),
        );
      }
      return headers;
    };

    if (!hasBody(resolution) || options.render === undefined) {
      return new Response(null, {
        status: descriptor.status,
        headers: atlasHeaders(descriptor.cache),
      });
    }
    const result = await options.render({
      request,
      resolution,
      locale: settled ?? policy.defaultLocale,
    });

    let rendered: Response;
    let declared = false;
    if (isDeclaration(result)) {
      rendered = result.operationalFailure;
      declared = true;
    } else {
      rendered = result;
    }

    // Section 5's narrow rule: Atlas's classification wins for an address it refused, and the
    // renderer's declared status wins for one it serves. An application declaring maintenance
    // does not know which addresses Atlas refused, so a rule written the other way round would be
    // one the application could not reason about.
    const carriesDeclaration = declared && resolution.status === 'success';
    if (declared && !carriesDeclaration) {
      reportOverriddenDeclaration(
        reported,
        url.pathname,
        resolution.status,
        rendered.status,
        descriptor.status,
      );
    }

    const merged = new Headers(rendered.headers);
    for (const [name, value] of atlasHeaders(
      // A failure is not this address's representation, so it is not an answer a shared cache may
      // hand to the next visitor who asks for the address.
      carriesDeclaration ? 'private-no-store' : descriptor.cache,
    )) {
      if (name === 'set-cookie') merged.append(name, value);
      else merged.set(name, value);
    }
    return new Response(rendered.body, {
      status: carriesDeclaration ? rendered.status : descriptor.status,
      headers: merged,
    });
  };
}

function isDeclaration(
  result: LocalizedRenderResult,
): result is DeclaredOperationalFailure {
  return 'operationalFailure' in result;
}

/**
 * Whether a warning meant for a developer should be written.
 *
 * `NODE_ENV` rather than an option on the handler, because an option has to be set and a
 * deployment that needed this warning is one that did not think to set it. Anything but
 * `production` counts, which is the convention a Node process without the variable set already
 * relies on, and it is the safe direction here: this fires only where a declaration has already
 * failed to travel, so a line in a log nobody expected names a defect rather than noise.
 *
 * Read through `globalThis` because this entry point builds without Node's types and runs in
 * places that have no `process` at all.
 */
function inDevelopment(): boolean {
  const environment = globalThis as unknown as {
    readonly process?: { readonly env?: Record<string, string | undefined> };
  };
  return environment.process?.env?.['NODE_ENV'] !== 'production';
}

/**
 * Says once, where a developer will see it, that a declared status did not travel.
 *
 * Once per pair of statuses rather than once per address: the addresses are unbounded and
 * attacker-supplied, so keying the record on one would let a request decide how much this
 * process remembers. The address is in the text of the first report, where naming it helps,
 * quoted so that a target carrying control characters cannot forge a line in a log.
 */
function reportOverriddenDeclaration(
  reported: Set<string>,
  pathname: string,
  resolved: RenderableResolution['status'],
  declaredStatus: number,
  servedStatus: number,
): void {
  if (!inDevelopment()) return;
  const identity = `${resolved}:${declaredStatus}`;
  if (reported.has(identity)) return;
  reported.add(identity);
  console.warn(
    `[Atlas] The renderer declared status ${declaredStatus} at ${JSON.stringify(pathname)} and the response is ${servedStatus}. Atlas resolved that address as ${JSON.stringify(resolved)}, and a declared operational failure travels only at an address Atlas serves, so the declaration was not applied. Declare one from a renderer called for a resolved address, or answer the refusal that address already carries.`,
  );
}

/**
 * A speculative load is not a choice.
 *
 * A browser prefetching a link in another language must not change what the visitor gets next time;
 * they did not click anything. `Sec-Purpose` names a speculative load directly and `Sec-Fetch-Dest`
 * distinguishes a navigation from a subresource. `Purpose: prefetch` is deliberately not consulted:
 * it is the older Chrome convention, a guard written against it passes a test written against it,
 * and it does nothing in a browser today.
 *
 * A request with no `Sec-Fetch-*` at all is treated as a real navigation: those headers are not
 * universal, and refusing to remember anything without them would break the ordinary case to guard
 * the rare one.
 */
function isBackgroundRequest(request: Request): boolean {
  const purpose = request.headers.get('sec-purpose') ?? '';
  if (/prefetch|prerender/iu.test(purpose)) return true;
  const destination = request.headers.get('sec-fetch-dest');
  return destination !== null && destination !== 'document';
}

/**
 * Addresses this policy says carry no locale, read from the policy rather than hardcoded.
 *
 * The dotted-file check is a heuristic and is named as one. It is what next-intl's documented
 * default matcher does, and the alternative, a consumer listing every asset path, is a list that
 * goes stale the first time somebody adds a font.
 */
function bypasses(url: URL, policy: LocaleUrlPolicy): boolean {
  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  const first = segments[0];
  if (first !== undefined && policy.localeNeutralRoots.includes(first)) {
    return true;
  }
  const last = segments[segments.length - 1];
  return last !== undefined && last.includes('.');
}

function settledLocale(resolution: RouteResolution): string | undefined {
  if (resolution.status === 'success' || resolution.status === 'redirect') {
    return resolution.locale;
  }
  return undefined;
}

/**
 * Whether this outcome has a presentation for an application to produce.
 *
 * Two outcomes do not, and reading this as "not a redirect" let one of them through. A redirect
 * answers with its location. A malformed target has been refused before presentation routing, by
 * `specs/07-routing-rendering-and-seo.spec.md` section 5, and a refusal is not a page: the
 * resolution carries a diagnostic rather than a route, and an application asked to render one has
 * nothing to draw and an address it must not reflect.
 */
function hasBody(
  resolution: RouteResolution,
): resolution is RenderableResolution {
  return resolution.status !== 'redirect' && resolution.status !== 'malformed';
}

function readCookie(header: string | null, name: string): string | undefined {
  for (const entry of header?.split(';') ?? []) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    const value = decodeURIComponent(entry.slice(separator + 1).trim());
    return value.length === 0 ? undefined : value;
  }
  return undefined;
}

/**
 * The first acceptable language, in the order the client ranked them.
 *
 * Deliberately shallow: this hands a candidate to `resolveLocalizedRoute`, which is the function
 * that decides whether Atlas supports it, so nothing here needs to know the locale set. An
 * unsupported value is ignored there rather than being an error here.
 */
function preferredFromAcceptLanguage(
  header: string | null,
): string | undefined {
  if (header === null) return undefined;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...parameters] = part.split(';');
      const quality = parameters
        .map((parameter) => /^\s*q=([0-9.]+)\s*$/iu.exec(parameter))
        .find((match) => match !== null);
      return {
        tag: (tag ?? '').trim(),
        quality: quality === undefined ? 1 : Number(quality[1] ?? 1),
      };
    })
    .filter((entry) => entry.tag.length > 0 && entry.tag !== '*')
    .filter((entry) => Number.isFinite(entry.quality) && entry.quality > 0)
    .sort((left, right) => right.quality - left.quality);
  return ranked[0]?.tag;
}

function serializeCookie(
  name: string,
  value: string,
  options: Exclude<LocaleCookiePolicy, false>,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
    `Max-Age=${options.maxAgeSeconds ?? ONE_YEAR_SECONDS}`,
    `SameSite=${options.sameSite ?? 'Lax'}`,
    ...(options.domain === undefined ? [] : [`Domain=${options.domain}`]),
    ...((options.secure ?? true) ? ['Secure'] : []),
  ].join('; ');
}
