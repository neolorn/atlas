/**
 * The Angular-free core: Atlas's vocabulary, its locale profiles, and its route classification.
 *
 * This entry point exists for an *environment* boundary, which is the second of the three reasons
 * `specs/02-packages-and-platform.spec.md` section 2 allows, rather than the optional-peer reason
 * `forms`, `router` and `ssr` sit on. Every other entry point of this
 * package fails to load outside a browser or an Angular server: importing `@neolorn/atlas` in plain
 * Node throws `The injectable 'PlatformLocation' needs to be compiled using the JIT compiler`,
 * because the primary carries the Angular integration. Nothing here imports `@angular/*` at all, so
 * a worker, a Lambda, or a Fastify process can hold Atlas's classification without holding Angular.
 *
 * **Why the core is below the primary rather than beside it.** `@neolorn/atlas` re-exports this
 * surface, so a consumer already using the primary sees no change and need not know this entry point
 * exists. The dependency runs one way because the core has to load where Angular is absent. It is
 * also the only arrangement that yields *one* copy: a secondary entry point's bundle keeps a
 * sibling as an external import, but anything it reaches relatively is compiled into it, so a file
 * imported both ways is published twice.
 *
 * **And two copies is a defect rather than a size cost.** `LocalizationError` is a class.
 * Duplicated, an error thrown here is not an `instanceof` the copy the Angular runtime tests
 * against, and the eight `instanceof LocalizationError` checks in the primary, including the one
 * that turns a thrown error back into a `LocalizationDiagnostic`, stop matching. The error does not
 * fail loudly; it loses its diagnostic and arrives unrecognized, for one entry point only.
 * `verify-package-structure.mjs` enforces the single copy against the built distributable rather
 * than against review.
 */

export * from './contracts';
export * from './routing';

export {
  pageAbsent,
  pageGone,
  pageOperationalFailure,
  pageOutcomeHttpDescriptor,
  ɵopenPageOutcomeChannel,
  ɵrememberPageOutcome,
  ɵtakePageOutcome,
  type DeclaredPageOutcomeDescriptor,
  type PageOutcomeAbsent,
  type PageOutcomeDeclaration,
  type PageOutcomeGone,
  type PageOutcomeOperationalFailure,
} from './page-outcome';

export {
  directionForLocale,
  localeProfile,
  openGraphAlternates,
  openGraphLocale,
  type LocaleProfile,
} from './locale-profile';

export {
  LOCALE_DATA_PROFILE,
  RTL_SCRIPTS,
  RTL_STRONG_CHARACTERS,
} from './locale-profile.generated';
