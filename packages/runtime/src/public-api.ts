export * from '@neolorn/atlas/core';

export {
  type LocalizationParticipantRegistration,
  type LocalizationState,
  type TrustedSlotBinding,
} from './angular-contracts';
export {
  applicationBaseHref,
  injectLocalization,
  provideLocalizationSetup,
  withExtensions,
  withoutDocumentLocale,
  withFormattingContext,
  withLocalizationClock,
  withPersistence,
  withLocaleSources,
  withRouting,
  type RoutingOptions,
  LOCALE_URL_POLICY,
  withRelativeTimePolicy,
  withLocaleAnnouncement,
  withObservability,
  withOverlayLocale,
  withRecoveryMessage,
  type RecoveryMessageOptions,
  DocumentLocalization,
  LocalizationInteractionRestore,
  type DocumentLocalizationProjection,
  type DocumentSocialProjection,
  type LocalizationFeature,
  type LocalizationFeatureKind,
  type LocalizationOverlayAdapter,
  type LocalizationOverlayAdapterFactory,
} from './angular';
export {
  Localization,
  createLocalizationContext,
  type LocaleUrlResolutionSetup,
  type LocalizationLocaleSource,
} from './localization';
export { LocalizedMessage, LocalizePipe } from './message-template';
export { LABEL_ATTRIBUTES, LocalizedLabel, type LabelAttribute } from './label';
export { LocaleChoice, type LocaleChoiceCurrent } from './locale-choice';
export { LocalizationRecovery } from './recovery';
export { defineRuntimeExtensions } from './extensions';
export * from './assets';
export * from './destinations';
export * from './localized-input';
export * from './presentation';
// Named rather than starred, the way `./angular`, `./localization`, `./label`, `./rich`,
// `./recovery` and `./extensions` already are. `validateRouteProjection` is the reason: it is the
// internal validator `angular.ts` and `routing.ts` both call, superseded for a consumer by
// `defineRouteProjection`, and a star export made it public because it needed the `export` keyword
// to cross a module boundary. That is the whole class of accident this list prevents: what the
// package publishes is now a decision rather than a consequence of where a function happens to live.
export {
  addressSelectsLocale,
  allowedLocaleHosts,
  buildLocalizedRoute,
  builtLocalePolicy,
  createDefaultLocalePrefixPolicy,
  createHostLocalePolicy,
  createIdentifierParameterCodec,
  createIntegerParameterCodec,
  createLocaleNeutralPolicy,
  createPathPrefixLocalePolicy,
  DEFAULT_ROUTE_INDEXING_FIELD,
  defineRouteProjection,
  LOCALE_DATA_PROFILE,
  localeFromRoute,
  localizedRouteAddresses,
  localizedServerRoutes,
  projectRouteSeo,
  resolveInitialRouteLocale,
  resolveLocalizedRoute,
  ROUTE_PROJECTION_PROFILE,
  routeCacheHeaders,
  routeHttpDescriptor,
  toExternalPath,
  toInternalPath,
  withBasePath,
  withoutBasePath,
  type GeneratedRouteProjection,
  type GeneratedRouteProjectionEntry,
  type HostLocalePolicy,
  type HostLocalePolicyOptions,
  type LocaleNeutralPolicy,
  type LocaleNeutralPolicyOptions,
  type LocalePreferenceSource,
  type LocaleUrlPolicy,
  type LocalizedAddressContext,
  type LocalizedParameterSpellings,
  type LocalizedRouteResolution,
  type LocalizedServerRoute,
  type LocalizedServerRouteDeclaration,
  type PrerenderParameterValues,
  type LocalizedServerRoutes,
  type LocalizedServerRoutesOptions,
  type PathPrefixLocalePolicy,
  type PathPrefixLocalePolicyOptions,
  type RouteAlternate,
  type RouteBuildArguments,
  type RouteCacheFreshness,
  type RouteCacheHeaders,
  type RouteHistoricalOutcome,
  type RouteHttpDescriptor,
  type RouteIdOf,
  type RouteIndexingClass,
  type RouteIndexingPolicy,
  type RouteParameterCodec,
  type RouteParameterContext,
  type RouteParameterParseResult,
  type RouteParametersOf,
  type RouteQueryValue,
  type RouteResolution,
  type RouteResolutionContext,
  type RouteRuntimeProjection,
  type RouteSeoProjection,
} from '@neolorn/atlas/core';
export {
  LocalizedDecimalPipe,
  LocalizedDurationPipe,
  LocalizedInstantPipe,
  LocalizedMeasurementPipe,
  LocalizedMoneyPipe,
  LocalizedPercentPipe,
  LocalizedPercentagePointsPipe,
  LocalizedPlainDatePipe,
  LocalizedPlainDateTimePipe,
  LocalizedPlainTimePipe,
  LocalizedZonedDateTimePipe,
} from './formatting-pipes';
export * from './locale-presentation';
export * from './relative-time-policy';
export * from './persistence';
export * from './issue-convention';
export * from './locale-negotiation';
// Published because it is enforced. A consumer that trips a ceiling gets an error naming a limit it
// had no way to read, while the toolkit has published its own equivalent all along.
export { RUNTIME_LIMITS } from './runtime-safety';
export {
  RUNTIME_EVENT_CODES,
  RUNTIME_OBSERVABILITY_PROFILE,
  type LocalizationEventCode,
  type LocalizationEventPhase,
  type LocalizationEventStatus,
  type LocalizationObservabilityEvent,
  type LocalizationObservabilityOptions,
  type LocalizationObservabilitySink,
} from './observability';
export {
  compareLocalized,
  decimal,
  duration,
  fixedClock,
  formatDisplayName,
  formatDuration,
  formatInstant,
  formatInstantRange,
  formatList,
  formatMeasurement,
  formatMoney,
  formatNumber,
  formatNumberRange,
  formatPercentagePoints,
  formatPercent,
  formatPersonName,
  formatPlainDateTime,
  formatPlainDate,
  formatPlainTime,
  formatRelativeTime,
  formatZonedDateTime,
  instant,
  localeMetadata,
  measurement,
  money,
  percent,
  percentagePoints,
  personName,
  plainDate,
  plainDateTime,
  plainTime,
  segmentText,
  selectPlural,
  systemClock,
  timeZone,
  zonedDateTime,
} from './formatting';
