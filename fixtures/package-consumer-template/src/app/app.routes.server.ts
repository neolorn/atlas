import { RenderMode } from '@angular/ssr';
import { provideLocalizedServerRendering } from '@neolorn/atlas/ssr';
import { configuration } from '#i18n';

import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * One entry per route, not one per route per locale.
 *
 * A prerendered route has no request, so nothing negotiates a locale for it: every locale's copy
 * is a separate address that has to exist in the build. Spelling all of them out here
 * (`en-us/second`, `ar-eg/second`, `en-us/items/:id`, `ar-eg/items/:id`) is a line to re-edit on
 * every route added and, worse, on every locale added. Missing one is not an error anywhere. It is
 * a page that is simply absent in Arabic.
 *
 * The `article` route shows the part that is genuinely hard by hand: its slug is spelled
 * differently per locale, so its prerendered addresses are `/en-us/articles/atlas-handbook` and
 * `/ar-eg/articles/دليل-أطلس`, from one declaration and the codecs the projection already carries.
 *
 * `routeId` is checked against the projection, so a misspelling here is a compile error rather
 * than a throw when this module is first evaluated, and `RenderMode` is the only thing still
 * imported from `@angular/ssr`.
 *
 * The generated `configuration` is the third argument and it is what decides which locales get
 * addresses. The policy names three; a production build generates two, so two are emitted. The
 * same table under `atlas generate --pseudo` emits six. Nothing here changes between the two
 * builds, which is the point: a development locale must not cost a source edit in either
 * direction.
 */
/**
 * The routes this deployment publishes, and the values that make them into pages.
 *
 * Exported because `server.ts` builds the sitemap from it. A sitemap needs the same two facts a
 * render table needs, which routes and which parameter values, and nothing else can supply the
 * second: a parameterised route is a pattern, and a pattern is not a page. So the list is written
 * once and read twice, rather than a second list that has to be remembered when an article is
 * added.
 *
 * What a page claims in a sitemap is not here. That is on the route, through `withRouting`, so a
 * route's own data says what kind of page it is and this stays a table about rendering.
 */
export const publishedRoutes = [
  { routeId: 'route:second', renderMode: RenderMode.Prerender },
  {
    routeId: 'article',
    renderMode: RenderMode.Prerender,
    prerender: [{ slug: 'atlas-handbook' }],
  },
  { routeId: 'item', renderMode: RenderMode.Client },
] as const;

export const serverRendering = provideLocalizedServerRendering(
  routePolicy,
  appRouteProjection,
  configuration,
  publishedRoutes,
  {
    // The addresses the two-layer table produces and nobody visits: `/second`, `/articles/:slug`,
    // `/items/:id`. Rendered on demand, so the build writes a file only where a visitor can
    // actually arrive. Atlas refuses to emit the table without this under a prefixing policy:
    // leaving it to the `**` fallback worked, and worked equally well if someone answered the
    // build error by declaring them `Prerender` instead.
    canonicalRenderMode: RenderMode.Server,
    fallback: RenderMode.Server,
  },
);
