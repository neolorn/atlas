import { randomUUID } from 'node:crypto';

import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import {
  allowedLocaleHosts,
  builtLocalePolicy,
  projectSitemap,
} from '@neolorn/atlas';
import {
  createLocaleRequestHandler,
  toWebRequest,
  writeNodeResponse,
} from '@neolorn/atlas/http';
import { configuration } from '#i18n';

import { localeCookie } from './app/locale-cookie';
import { publishedRoutes } from './app/app.routes.server';
import {
  routePolicy,
  appRouteProjection,
  SITE_ORIGIN,
} from './app/localization.routes';

/**
 * The policy this build can serve, which is not always the policy the application declared.
 *
 * `localization.routes.ts` gives every locale this application means to have an address, including
 * `en-Arab-XB`, which exists only in a build made with `--pseudo`. Resolving against the declared
 * policy in an ordinary build answers `/en-arab-xb/second` with a 200 in markup labelled
 * `lang="en-Arab-XB"`, and sends a visitor whose cookie remembers that locale to it. Narrowing once
 * here is the whole fix, and it is one line because Atlas made it one.
 */
const servedPolicy = builtLocalePolicy(routePolicy, configuration);

/**
 * The one place a locale URL policy has to be registered twice, written so it is still one list.
 *
 * `@angular/ssr` answers `400` before the application runs for any `Host` header it does not
 * recognise, and by default it recognises loopback and nothing else. Under a `locale-host` policy
 * that is every one of the application's own domains, so the site would answer nothing anywhere.
 * Atlas cannot check this, a build cannot reach the server configuration, so what it does
 * instead is derive the list, and this is the line a consumer writes.
 *
 * `servedPolicy` rather than `routePolicy`, for the same reason as everywhere else here: a build
 * that does not carry a locale must not advertise or admit its origin.
 *
 * Empty under this fixture's path-prefix policy, which serves one origin and needs no entry beyond
 * the loopback pair the harness reaches it at. That is the point of writing it anyway: the line
 * keeps saying the truth on the day the policy changes.
 */
const engine = new AngularNodeAppEngine({
  allowedHosts: ['127.0.0.1', 'localhost', ...allowedLocaleHosts(servedPolicy)],
});

/**
 * An address Atlas declined to localize, handed back to the server that owns it.
 *
 * `passthrough` has to answer with a `Response` because the handler is written against Fetch and
 * knows nothing about Express. This deployment's answer is "not mine, keep going", which is
 * `next()`, so a sentinel comes back and is recognised below. A real consumer serving files from
 * a directory would return the file here instead and never need this.
 */
const PASS_THROUGH = 'x-consumer-passthrough';

/**
 * What this deployment owns, and nothing else: two durations, and where it reads a preference.
 *
 * `successMaxAge` is deliberately not `0`. A zero is a deployment that revalidates every request,
 * which makes a response marked `public` behave privately and hides the difference between a
 * correct classification and a leaked one. This fixture is what the gate reads; a fixture that is
 * safe whatever Atlas says cannot show that Atlas is right.
 *
 * `cookie` names the cookie this deployment remembers a choice in. Naming it is what tells Atlas
 * that answers here vary by something a shared cache must not key on, and that is a fact stated
 * once rather than a directive string retyped per classification. A chain of conditionals mapping
 * classifications to directive text by hand works, and goes on working, wrongly and silently, the
 * first time a classification changes meaning. A conditional chain always has a last branch, so it
 * never stops compiling and never stops answering.
 *
 * The cookie itself is `localeCookie`, declared in `app/locale-cookie.ts` and read here and in
 * `app.config.ts` both. It is one declaration because it was two: the name and the attributes were
 * written out separately on each side, they disagreed about `Secure`, and only WebKit ever said so.
 * That reasoning lives with the declaration rather than here, so there is one place to read it and
 * one place to change it.
 */
const localeRequests = createLocaleRequestHandler({
  policy: servedPolicy,
  projection: appRouteProjection,
  cache: { successMaxAge: 600, permanentRedirectMaxAge: 86_400 },
  cookie: localeCookie,
  passthrough: () =>
    new Response(null, { status: 204, headers: { [PASS_THROUGH]: '1' } }),
  render: ({ resolution }) => {
    // A not-found under a supported locale is answered by the application's own routing, which is
    // what a real consumer does: the locale resolved, only the page is unknown, and the application
    // has a not-found page written in it. Anything else (a malformed address, an unsupported
    // locale) never reached Angular before and does not now.
    if (resolution.status === 'success' || resolution.status === 'not-found') {
      return new Response(null, { headers: { 'x-consumer-render': '1' } });
    }
    const locale = resolution.presentationLocale;
    const direction = locale === 'ar-EG' ? 'rtl' : 'ltr';
    const message =
      locale === 'ar-EG' ? 'الصفحة غير متاحة' : 'Page unavailable';
    return new Response(
      `<!doctype html><html lang="${locale}" dir="${direction}"><head><meta name="robots" content="noindex"></head><body><h1>${message}</h1></body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  },
});

function createProbeContext(request: {
  headers: { host?: string | undefined };
  url?: string | undefined;
}) {
  const host = request.headers.host ?? 'localhost';
  const url = new URL(request.url ?? '/', `http://${host}`);
  const requestedLabel = url.searchParams.get('label')?.trim();
  return {
    requestId: randomUUID(),
    url: request.url ?? '/',
    label:
      requestedLabel === undefined || requestedLabel.length === 0
        ? 'default'
        : requestedLabel.slice(0, 64),
  };
}

/**
 * The sitemap, which this deployment owns the delivery of.
 *
 * Atlas produces the files: their names, their contents, the split when there is one. Where they
 * are served from, and the `Sitemap:` line in `robots.txt` beside them, are this application's,
 * under section 10 of the routing specification. Serving them from the same handler is what this
 * deployment does; writing them into the built output beside `index.html` would do as well.
 *
 * `publishedRoutes` is the render table's own list, so the pages here are the pages this build
 * renders and the article slug is written in one place. `route:_index` is added because the home
 * page is answered by the fallback rather than declared, and it is still a page.
 *
 * `SITE_ORIGIN` and not the request host, because it is the same constant the router builds every
 * canonical and alternate URL from. That is what makes the addresses in this file and the addresses
 * in the head of every page one set rather than two that happen to agree, and it is why the harness
 * reaching this on a loopback port still reads the site's own addresses out of it.
 *
 * Built once at module scope. The set does not vary by request: what it lists is what this build
 * generated, which is settled before the first request arrives.
 */
const sitemapFiles: ReadonlyMap<string, string> = new Map(
  projectSitemap({
    policy: servedPolicy,
    projection: appRouteProjection,
    configuration,
    origin: SITE_ORIGIN,
    routes: [...publishedRoutes, { routeId: 'route:_index' }],
  }).map((file) => [`/${file.name}`, file.contents]),
);

export const reqHandler = createNodeRequestHandler(
  async (request, response, next) => {
    try {
      const host = request.headers.host ?? 'localhost';
      const requested = new URL(request.url ?? '/', `http://${host}`).pathname;
      if (
        requested === '/sitemap.xml' ||
        /^\/sitemap-\d+\.xml$/u.test(requested)
      ) {
        const file = sitemapFiles.get(requested);
        if (file === undefined) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/xml; charset=utf-8');
        response.end(file);
        return;
      }
      const resolved = await localeRequests(
        toWebRequest(request, `http://${request.headers.host ?? 'localhost'}`),
      );

      if (resolved.headers.has(PASS_THROUGH)) {
        next();
        return;
      }

      // Atlas decided the status, the language, the indexing and the cacheability. Angular renders
      // the body. The two are joined here rather than in Atlas because rendering is the one part
      // that needs the Node request and the application's own engine.
      if (resolved.headers.get('x-consumer-render') === '1') {
        const rendered = await engine.handle(
          request,
          createProbeContext(request),
        );
        if (rendered === null) {
          next();
          return;
        }
        for (const [name, value] of resolved.headers) {
          if (name === 'x-consumer-render') continue;
          if (name === 'set-cookie') response.appendHeader(name, value);
          else response.setHeader(name, value);
        }
        response.statusCode = resolved.status;
        await writeResponseToNodeResponse(rendered, response);
        return;
      }

      await writeNodeResponse(resolved, response);
    } catch (error: unknown) {
      next(error);
    }
  },
);
