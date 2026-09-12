import { RenderMode } from '@angular/ssr';
import {
  buildLocalizedRoute,
  defineRouteProjection,
  type Localization,
} from '@neolorn/atlas';
import { provideLocalizedServerRendering } from '@neolorn/atlas/ssr';
import { configuration } from '#i18n';
import { routeProjection } from '#i18n/routes';

import { skuFormatAdapter, skuParseAdapter } from './app/runtime-extensions';
import { routePolicy, appRouteProjection } from './app/localization.routes';

declare const localization: Localization;

/**
 * Route calls that must not compile.
 *
 * Separate from the template cases because the Angular compiler reports template diagnostics only
 * when the program it is checking has no ordinary TypeScript errors; a file carrying both would
 * silently prove only half of what it claims. The verifier checks each negative file on its own.
 *
 * The generated projection is written `as const` and knows its own route identities, and
 * `RouteRuntimeProjection` threw that away on assignment, so `buildLocalizedRoute` had become
 * `(routeId: string) => string` and a typo compiled and threw at runtime.
 */

// A route identity that does not exist. This compiled and threw at runtime, from a function whose
// declared return type is a string.
// EXPECT: Argument of type '"itemm"' is not assignable
buildLocalizedRoute(routePolicy, appRouteProjection, 'itemm', 'en-US', {
  id: 42,
});

// A route that takes parameters, built without them.
// EXPECT: Expected 5-8 arguments, but got 4
buildLocalizedRoute(routePolicy, appRouteProjection, 'item', 'en-US');

// EXPECT: Type 'string' is not assignable to type 'number'
buildLocalizedRoute(routePolicy, appRouteProjection, 'item', 'en-US', {
  id: 'forty-two',
});

// EXPECT: 'ident' does not exist in type '{ readonly id: number; }'
buildLocalizedRoute(routePolicy, appRouteProjection, 'item', 'en-US', {
  ident: 42,
});

// A projection that omits a codec for a route that has parameters. This was optional in the type
// and mandatory in fact, so it produced a runtime throw from whichever entry point validated the
// projection first.
// EXPECT: Property 'parameters' is missing in type
defineRouteProjection({ generated: routeProjection });

// An adapter addressed by an unchecked identifier, with a value unrelated to it. Untyped, both
// compile and fail at runtime.
// EXPECT: is not assignable to parameter of type 'RuntimeFormattingAdapterBinding<string>'
localization.formatWithAdapter('feature:sku-format', 'atlas-42');

// EXPECT: Argument of type 'number' is not assignable to parameter of type 'string'
localization.formatWithAdapter(skuFormatAdapter, 42);

// A caller that declares the parsed type itself is making an assertion rather than holding a
// contract: nothing checks it against what the adapter returns.
// EXPECT: Property 'sku' does not exist on type 'FeatureSku'
const parsed = localization.parseWithAdapter(skuParseAdapter, 'sku-atlas-42');
if (parsed.status === 'valid') {
  void parsed.value.sku;
}

// The same identity contract, on the server table, where the earlier fix never reached. `routeId`
// was declared `string` while the client half already used `RouteIdOf`, so a typo
// here type-checked and then threw from `routeById` the moment the module was evaluated. The
// build does fail that way, but at the wrong moment, with no completion on the way there, and
// with an error that names the identity rather than the line that wrote it (5.2).
// EXPECT: Type '"itemm"' is not assignable to type
// EXPECT: Did you mean '"item"'?
provideLocalizedServerRendering(
  routePolicy,
  appRouteProjection,
  configuration,
  [{ routeId: 'itemm', renderMode: RenderMode.Client }],
);
