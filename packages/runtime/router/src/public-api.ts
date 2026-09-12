export {
  provideLocalizedRouter,
  type LocalizedRouterOptions,
} from './provide.js';

export {
  RouteLocalization,
  RouteLocalizationError,
  type RouteDocumentMessages,
  type RouteLocalizationContext,
  type RouteLocalizationOptions,
} from './route-localization.js';

export { LocalizedRouteParameters } from './route-parameters.js';

export { LocalizedTitleStrategy } from './title-strategy.js';

export {
  localizedRouteTable,
  type LocalizedRouteTable,
  type LocalizedRouteTableProblem,
} from './route-table.js';

// `LocalizedLocationStrategy`, `LocalizedUrlHandlingStrategy` and `LocalizedAddressSync` are
// deliberately not published. `provideLocalizedRouter` installs all three, no consumer names any of
// them, and the escape hatch for either strategy is Angular's own (`PathLocationStrategy`, and
// the default `UrlHandlingStrategy`) rather than a subclass of Atlas's. Publishing them would be
// surface with no caller; adding them later, if a caller appears, is additive.
