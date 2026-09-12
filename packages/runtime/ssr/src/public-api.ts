// Server rendering, configured once, from the same projection the client was.
//
// A secondary entry point rather than part of `@neolorn/atlas`, because this is the only Atlas
// code that imports `@angular/ssr`, and `specs/02-packages-and-platform.spec.md` section 6 states
// that an optional integration must not put its peer on the primary entry point.
// `specs/02-packages-and-platform.spec.md` section 2 permits the entry point on exactly this
// condition, a capability carrying a distinct optional peer, so a browser-only consumer
// installs neither the peer nor this code.
//
// **Why the policy and projection are arguments and not read from DI.** They cannot be. This is
// called in `app.config.server.ts` at module scope, where no injector exists, and
// `withRoutes(routes: ServerRoute[])` takes a concrete array at call time rather than a factory
// (`@angular/ssr` 22.1.7, `ssr.mjs:296-306`). Its own token is private, `SERVER_ROUTES_CONFIG`
// is constructed at `ssr.mjs:295` and is not in the module's export list, so a factory-based
// install would mean naming a private API, which the fundamental rules forbid without approval.
// The client can do this because `ROUTES` is public and the Router reads it at injection time.
//
// The three arguments come from the one place they are already declared. Passing a *different*
// policy or projection here than `withRouting()` received is the mistake worth preventing, and it
// is the one Atlas cannot see from inside a single call, so it stays a consumer discipline. The
// configuration is the one third of it Atlas can see: a configuration that does not list the
// locale its own policy makes default is refused rather than quietly emitting a table with no
// addresses in it.
//
// The table this builds is `specs/07-routing-rendering-and-seo.spec.md` section 9: a prerendered
// route has no request, so every locale's copy is its own address that has to exist in the build,
// and the expansion is derived from the projection and the narrowed policy rather than declared
// once per locale.

import type { EnvironmentProviders } from '@angular/core';
import {
  provideServerRendering,
  withAppShell,
  withRoutes,
  type RenderMode,
  type ServerRenderingOptions,
} from '@angular/ssr';
import {
  localizedServerRoutes,
  type GeneratedConfiguration,
  type LocaleUrlPolicy,
  type LocalizedServerRouteDeclaration,
  type LocalizedServerRoutesOptions,
  type RouteRuntimeProjection,
} from '@neolorn/atlas';

/**
 * What `provideLocalizedServerRendering` accepts beyond the routes themselves.
 *
 * Carries the route-declaration options a localized server route set takes, plus the two things
 * Angular's server rendering leaves to an application. Every field is optional; the default is a
 * server that renders the declared routes and nothing else.
 */
export interface LocalizedServerRenderingOptions extends LocalizedServerRoutesOptions<RenderMode> {
  /**
   * The application shell, and the only Angular server-rendering feature a consumer can supply.
   *
   * Atlas owns `withRoutes`, so a second one cannot be passed and there is no variadic feature
   * list to admit one. The type is read off `withAppShell` rather than restated: `@angular/ssr`
   * exports no `ServerRenderingFeature` or `ServerRenderingFeatureKind`, and a hand-written copy
   * of a shape Angular does not publish would be Atlas asserting a contract it does not have.
   */
  readonly appShell?: Parameters<typeof withAppShell>[0];
  /** Passed through to `provideServerRendering` unchanged. Atlas reads nothing in it. */
  readonly rendering?: ServerRenderingOptions;
}

/**
 * One server install: the localized route table, the canonical suppression, and the fallback.
 *
 * Replaces a consumer's `app.routes.server.ts` and the `provideServerRendering(withRoutes(...))`
 * line in `app.config.server.ts` with a single call that imports nothing from `@angular/ssr`
 * except the render modes the declarations name.
 */
export function provideLocalizedServerRendering<
  const Projection extends RouteRuntimeProjection,
>(
  policy: LocaleUrlPolicy,
  projection: Projection,
  configuration: GeneratedConfiguration,
  declarations: readonly LocalizedServerRouteDeclaration<
    RenderMode,
    Projection
  >[],
  options: LocalizedServerRenderingOptions = {},
): EnvironmentProviders {
  const routes = localizedServerRoutes(
    policy,
    projection,
    configuration,
    declarations,
    options,
  );
  const features = [
    withRoutes(routes),
    ...(options.appShell === undefined ? [] : [withAppShell(options.appShell)]),
  ];
  return options.rendering === undefined
    ? provideServerRendering(...features)
    : provideServerRendering(options.rendering, ...features);
}
