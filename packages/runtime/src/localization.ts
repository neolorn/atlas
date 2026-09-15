/**
 * The runtime state: what is committed, what is being prepared, and what supplied each answer.
 *
 * `specs/06-runtime-and-angular.spec.md` section 4 keeps those three locales apart. The committed
 * primary locale is on the snapshot, the target locale is transition state that is never inferred
 * from the primary one, and the supplying locale is reported per result and per region. Folded
 * into one value, a page mid-transition reports a locale nothing was rendered in.
 *
 * The lifecycle is `specs/06-runtime-and-angular.spec.md` section 5: five states, with fallback
 * content a flag on a valid ready snapshot rather than a state of its own.
 */

import { computed, signal, type Signal } from '@angular/core';
import {
  type LocalizationParticipantRegistration,
  type LocalizationState,
} from './angular-contracts';

import {
  directionForLocale,
  GENERATED_ABI,
  localeProfile,
  LocalizationError,
  type ChildLocalizationOptions,
  type DecimalValue,
  type DurationValue,
  type FormattingContext,
  type FormattingResult,
  type InstantValue,
  type LocaleCapabilityResult,
  type LocaleChangeMode,
  type LocaleChangeOptions,
  type LocaleChangeResult,
  type LocaleFormattingOverride,
  type LocaleMetadata,
  type LocaleSelectorChoice,
  type LocalizationClock,
  type LocalizationContextOptions,
  type LocalizationLifecycle,
  type LocalizationParticipant,
  type LocalizationParticipantOptions,
  type LocalizationParticipantState,
  type LocalizationRouteSnapshot,
  type LocalizationScope,
  type LocalizationSetup,
  type LocalizationSnapshot,
  type LocalizedInputResult,
  type LocalizedParts,
  type LocalizedSegment,
  type LocalizedText,
  type MeasurementValue,
  type MessageHandle,
  type MessageInputArguments,
  type MoneyValue,
  type PercentagePointsValue,
  type PercentValue,
  type PersonNameFormatOptions,
  type PersonNameValue,
  type PlainDateTimeValue,
  type PlainDateValue,
  type PlainTimeValue,
  type RuntimeFormattingAdapterBinding,
  type RuntimeParsingAdapterBinding,
  type ScopeReadiness,
  type ZonedDateTimeValue,
} from '@neolorn/atlas/core';
import {
  LocalCatalogStore,
  scopeIdentity,
  type CatalogLease,
  type CompiledCatalog,
  type CompiledMessage,
} from './catalog-runtime';
import {
  evaluateCandidate,
  catalogConsultationOrder,
  findEvaluationCandidate,
  FormatterCache,
} from './evaluator';
import { RuntimeExtensions } from './extensions';
import { FormattingSurface } from './formatting-runtime';
import type {
  LocaleRemovalReport,
  LocalizationPersistenceStore,
} from './persistence';
import {
  type RelativeTimeOutcome,
  type RelativeTimePolicy,
} from './relative-time-policy';
import {
  type AsReceived,
  RUNTIME_LIMITS,
  asDiagnostic,
  operationalDiagnostic,
  hasExactKeys,
  hasOwn,
  isDataRecord,
  safeDiagnosticIdentifier,
  snapshotInertJson,
} from './runtime-safety';
import {
  LocaleResolution,
  type LocaleUrlResolutionSetup,
  type LocalizationLocaleSource,
} from './locale-resolution';
import {
  RUNTIME_EVENT_CODES,
  createLocalizationEventEmitter,
  type LocalizationEventEmitter,
  type LocalizationEventInput,
  type LocalizationObservabilityOptions,
  type LocalizationObservabilitySink,
} from './observability';
import {
  ParticipantCoordinator,
  type ParticipantTransferRecord,
  type PreparedParticipant,
  type RegisteredParticipant,
} from './participant-runtime';

/**
 * What a routing integration does once a locale is committed, in the order the runtime decides.
 *
 * Both run after publication rather than during the transaction, and that is forced rather than
 * chosen: each spells something in the locale that has just landed (the address bar through
 * `prepareExternalUrl`, the head through the route resolved for it) and both read that locale
 * back off the published snapshot. Run inside the transaction they would spell the previous one.
 */
export interface RoutingCommitSteps {
  /** Bring the address bar into line with the route and the locale now current. */
  readonly writeAddress: () => void;
  /** Project the document metadata, the head, and the addresses the switcher offers. */
  readonly projectDocument: (locale: string) => void;
}

export interface LocalizationCommitHook {
  apply(snapshot: LocalizationSnapshot): void;
  rollback?(snapshot: LocalizationSnapshot | undefined): void;
  committed?(snapshot: LocalizationSnapshot): void;
  dispose?(): void;
}

const LOCALE_FORMATTING_KEYS = Object.freeze([
  'numberingSystem',
  'calendar',
  'hourCycle',
]);
const HOUR_CYCLES = Object.freeze(['h11', 'h12', 'h23', 'h24']);

/**
 * Whether a generated per-locale formatting table is the shape it says it is.
 *
 * Read as unknown data rather than as its declared type, because that is what it is until this
 * returns: the value arrives through `snapshotInertJson` from a generated module, and a table keyed
 * by a locale this application does not serve is one built against a different configuration.
 * An unknown option name is refused rather than ignored: a misspelled `numberingsystem` that
 * passed quietly would render the locale's own digits while the file said otherwise, which is the
 * defect this whole layer exists to remove.
 */
function isGeneratedLocaleFormatting(
  value: unknown,
  locales: readonly string[],
): boolean {
  if (!isDataRecord(value) || Object.keys(value).length > locales.length) {
    return false;
  }
  return Object.entries(value).every(([locale, entry]) => {
    if (!locales.includes(locale) || !isDataRecord(entry)) return false;
    return Object.entries(entry).every(([key, option]) => {
      if (!LOCALE_FORMATTING_KEYS.includes(key)) return false;
      if (key === 'hourCycle') return HOUR_CYCLES.includes(String(option));
      return (
        typeof option === 'string' && option.length > 0 && option.length <= 128
      );
    });
  });
}

/**
 * The generated fallback chains, checked on the same terms as the formatting table above.
 *
 * A chain is trusted about what it means and never about its shape. Every key and every member is
 * a locale this application ships, a chain never contains its own locale, and no locale appears in
 * one twice, because each of those would make the evaluator consult a catalog twice or loop.
 */
function isGeneratedLocaleFallbacks(
  value: unknown,
  locales: readonly string[],
): boolean {
  if (!isDataRecord(value) || Object.keys(value).length > locales.length) {
    return false;
  }
  return Object.entries(value).every(([locale, chain]) => {
    if (!locales.includes(locale) || !Array.isArray(chain)) return false;
    if (chain.length === 0 || chain.length > locales.length) return false;
    const seen = new Set<string>([locale]);
    return chain.every((parent) => {
      if (typeof parent !== 'string' || !locales.includes(parent)) return false;
      if (seen.has(parent)) return false;
      seen.add(parent);
      return true;
    });
  });
}

export interface LocalizationRuntimeOptions {
  readonly setup: LocalizationSetup;
  readonly bootstrapScopes: readonly LocalizationScope[];
  readonly initialLocale?: string;
  readonly requestContext?: unknown;
  readonly recoveryMessageIdentity?: string;
  readonly recoveryRetryLabelIdentity?: string;
  readonly formattingContext?: Omit<FormattingContext, 'locale'>;
  /**
   * The formatting context the server actually rendered `initialLocale` with.
   *
   * Set from the transferred snapshot and from nothing else. It is the committed context for one
   * locale, not an application-wide default, and keeping those apart is what stops one locale's
   * declaration from following the reader into the next: a server that rendered `ar-EG` in Western
   * digits transfers that fact about `ar-EG`, and a later switch to `fa-IR` is still written the
   * way `fa-IR` is written.
   */
  readonly initialFormattingContext?: Omit<FormattingContext, 'locale'>;
  readonly initialRoute?: LocalizationRouteSnapshot;
  readonly commitHooks?: readonly LocalizationCommitHook[];
  /**
   * Where a routing integration's two commit steps are put once it claims them.
   *
   * The steps themselves are the routing side's, only it knows how to spell an address or
   * project a head, but *when* they run is not, and that is the whole reason this exists. As
   * Angular effects they would be scheduled in whatever order their services happened to be
   * constructed, which puts two of the five things a locale commit does outside the one list that
   * orders the other three. This hands them to the layer that owns the list, so the sequence is one
   * array in one file and a test can read it off the document.
   */
  readonly claimRoutingCommit?: (steps: RoutingCommitSteps | undefined) => void;
  readonly transferredCatalogs?: readonly unknown[];
  readonly transferredParticipants?: readonly ParticipantTransferRecord[];
  readonly observability?: LocalizationObservabilitySink;
  readonly clock?: LocalizationClock;
  readonly relativeTimePolicy?: RelativeTimePolicy;
  readonly persistence?: readonly LocalizationPersistenceStore[];
  readonly localeSources?: readonly LocalizationLocaleSource[];
  readonly localeUrl?: LocaleUrlResolutionSetup;
  readonly preferredLanguages?: readonly string[];
}

export type { LocaleUrlResolutionSetup, LocalizationLocaleSource };

/**
 * The one thing an application injects: what locale is committed, and everything read in it.
 *
 * Every member reads the committed snapshot rather than taking a locale, so a component asks for
 * text or a formatted value without knowing which locale it is in, and a locale change rewrites
 * every one of them at once. The signals are what a template binds; the promises are what a guard
 * or a resolver awaits.
 *
 * It is abstract so that it is a dependency-injection token as well as a type. An application
 * never constructs one: `provideLocalizationSetup` installs it, `inject(Localization)` or
 * `injectLocalization()` obtains it.
 */
export abstract class Localization {
  /**
   * Every published signal in one object, for passing the whole of the current state somewhere.
   *
   * The same signals this class exposes individually, not copies, so reading either is reading the
   * same value.
   */
  abstract readonly state: LocalizationState;
  /**
   * Where localization is in its own life: starting, ready, moving between locales, or failed.
   *
   * A failed lifecycle is recoverable: `retry` is what leaves it.
   */
  abstract readonly lifecycle: Signal<LocalizationLifecycle>;
  /** Whether there is a committed snapshot to read. False before the first one and after a failure. */
  abstract readonly ready: Signal<boolean>;
  /**
   * Everything committed together: the locale, the catalogs, the formatting context, the route.
   *
   * `undefined` until the first commit. It changes as a whole and never in part, which is what
   * makes a locale change atomic to anything reading it.
   */
  abstract readonly snapshot: Signal<LocalizationSnapshot | undefined>;
  /**
   * The locale a change is moving towards while one is in flight, and `undefined` otherwise.
   *
   * Not the locale on screen. Read the snapshot for that: until a change commits, the page is
   * still in the locale it was in.
   */
  abstract readonly targetLocale: Signal<string | undefined>;
  /**
   * What to show when there is nothing to read: the recovery message, or `undefined` while there
   * is.
   *
   * Present only when localization itself could not be established, which is the one case where an
   * application has no messages to write its own error with.
   */
  abstract readonly recovery: Signal<LocalizedText | undefined>;
  /**
   * The retry control's wording in the locale recovery is rendering, when one was selected.
   *
   * Resolved from the same payload and the same lookup as `recovery`, so it falls back to the
   * source locale on its own and a renderer does not have to.
   */
  abstract readonly recoveryRetryLabel: Signal<LocalizedText | undefined>;
  /**
   * How the last locale change ended, and `undefined` before any has been attempted.
   *
   * It says whether the change committed, was refused, was superseded, or was answered with an
   * address, and which participant decided it. This is where a refusal is read from; the change
   * itself does not throw.
   */
  abstract readonly lastResult: Signal<LocaleChangeResult | undefined>;
  /**
   * Every registered participant and where each stands in the current transaction.
   *
   * For showing progress during a coordinated change, and for finding which one is holding it up.
   */
  abstract readonly participants: Signal<
    readonly LocalizationParticipantState[]
  >;

  /**
   * The locale this document's server-rendered HTML was written in, when there was one.
   *
   * `undefined` in a browser that rendered the page itself, and on the server. It exists because
   * hydration *claims* DOM rather than writing it: content produced under one locale and hydrated
   * under another keeps the words the server chose, and no later change detection corrects it,
   * because the binding's stored value is already the new one. Anything deciding whether to claim
   * server HTML or build it fresh has to be able to ask which locale that HTML is in.
   */
  abstract renderedLocale(): string | undefined;

  /**
   * Starts localization and resolves with the first committed snapshot.
   *
   * Called for you when the providers are installed, so an application needs it only to await the
   * first commit somewhere that must not render before it, such as a route guard. Calling it again
   * once it has started returns the same work rather than starting over.
   */
  abstract initialize(): Promise<LocalizationSnapshot>;
  /**
   * Starts again after a failure, and resolves with the snapshot if this attempt gets one.
   *
   * The control the recovery message offers. It re-runs the load that failed; it does not change
   * the locale, so a locale that cannot load will fail again until whatever it depends on is back.
   */
  abstract retry(): Promise<LocalizationSnapshot>;
  /**
   * Moves the whole application to another locale, as one transaction.
   *
   * Takes the locale tag and, optionally, the mode and the scopes this particular change needs.
   * Resolves with what happened; it does not reject when the change is refused, because a refusal
   * is an outcome a page has to show rather than an exception to escape through.
   *
   * Nothing is visible until every participant has agreed. A participant that fails rolls back the
   * ones that already prepared, and the page stays in the locale it was in.
   */
  abstract changeLocale(
    locale: string,
    options?: LocaleChangeOptions,
  ): Promise<LocaleChangeResult>;
  /**
   * Abandons a locale change that is still in flight, leaving the committed locale alone.
   *
   * Does nothing when nothing is in flight. The pending change resolves as superseded rather than
   * hanging.
   */
  abstract cancelTransition(): void;
  /**
   * Drops the remembered locale from every configured store, and leaves the page where it is.
   *
   * Not a locale change: nothing on screen moves, and the next visit resolves from the URL, the
   * client's languages and the default rather than from what was stored.
   * `specs/03-locale-identity-and-resolution.spec.md` section 8 keeps the two apart because
   * neither alone does what a reader asking to be forgotten means: forgetting leaves the page in
   * the stored language, and the operation that moves the page records a new choice. Pair this
   * with `changeLocale(locale, { remember: false })`.
   *
   * Resolves with what the removal reached. A store that implements no removal, and one whose
   * removal threw, are both reported: a value dropped from one store and still held by another is
   * read back at the next visit.
   */
  abstract forgetRememberedLocale(): Promise<LocaleRemovalReport>;
  /**
   * Adds something that has to agree before a locale change commits, and returns how to remove it.
   *
   * For state that is written in a language and cannot simply be re-rendered: fetched content, a
   * draft, an open editor. Registering from a component means unregistering when it goes away, and
   * the returned registration is what does that.
   */
  abstract registerParticipant(
    participant: LocalizationParticipant,
    options?: LocalizationParticipantOptions,
  ): LocalizationParticipantRegistration;
  /**
   * Fetches a scope's catalog ahead of time, without waiting for it and without making it required.
   *
   * Takes the scope and, optionally, a locale other than the committed one, which is how a switcher
   * warms the language a reader is hovering over. Resolves when the fetch settles; a failure is
   * reported through observability rather than thrown, because nothing is waiting on it.
   */
  abstract preloadScope(
    scope: LocalizationScope,
    locale?: string,
  ): Promise<void>;
  /**
   * Waits until a scope is loaded in the committed locale, fetching it if it is not.
   *
   * What a lazily loaded feature awaits before it renders. It rejects if the scope cannot be
   * loaded, because a caller that awaited it is about to render text it does not have.
   */
  abstract ensureScope(scope: LocalizationScope): Promise<void>;

  /**
   * Restate the snapshot's route record for the locale that is now current.
   *
   * A switch is not a navigation, so nothing re-resolves the address on its own, and the record
   * the transaction carried forward names an address in the locale being left. Only the routing
   * adapter can build the replacement (`canonicalPath` for `(routeId, locale)` needs the route's
   * parameters and the declared spellings, and this side holds the policy and projection and not
   * the live spellings) so the adapter derives it and hands it back here.
   *
   * Published as its own small transaction rather than written into the snapshot in place, because
   * a transaction is the only way a snapshot is published. Restating the record it already holds
   * publishes nothing.
   */
  abstract ɵrestateRoute(route: LocalizationRouteSnapshot): void;

  /**
   * Let the routing integration take a locale change out of this document.
   *
   * Some locale changes cannot happen where they were asked for. Under a `locale-host` policy the
   * locale *is* the origin, and application state does not cross origins, so running the
   * transition would commit a locale the origin does not serve and leave the reader on a page in
   * the language they were trying to leave. There is nothing to coordinate: the answer is an
   * address.
   *
   * `claim` is asked for that address, and answers `undefined` for every locale this document can
   * reach, which is every locale under every other policy, and the one this origin serves under a
   * host policy. An address means the change belongs elsewhere: `changeLocale` reports `redirected`
   * and runs no transition, and in a browser the claim has already started moving the document.
   *
   * Registered from the routing side rather than decided here, because only that side holds the
   * policy, the projection and the route the reader is on. Passing `undefined` unregisters, which
   * is what a torn-down adapter does.
   */
  abstract ɵclaimLocaleChange(
    claim: ((locale: string) => string | undefined) | undefined,
  ): void;

  /**
   * Let the routing integration take its two places in the commit sequence.
   *
   * Registered from the routing side for the reason above it is: only that side can write an
   * address or project a head. Ordered from this one, because the order is a property of the
   * commit and not of either step, and because an order that emerges from service construction
   * is an order nothing states and no test can read. Passing `undefined` unregisters, which is
   * what a torn-down adapter does.
   */
  abstract ɵclaimRoutingCommit(steps: RoutingCommitSteps | undefined): void;
  /**
   * Whether one scope is loaded in the committed locale, as a signal to bind.
   *
   * For a template that shows a placeholder for part of a page rather than holding the whole
   * navigation. The signal for a scope follows every later locale change, so it is safe to read
   * once and keep.
   */
  abstract scopeReadiness(scope: LocalizationScope): Signal<ScopeReadiness>;
  /**
   * Resolves a plain message and returns the text with the locale that actually supplied it.
   *
   * Takes the generated handle and its inputs, typed to that handle, so a missing input is a
   * compile error. The supplying locale is part of the answer because it need not be the committed
   * one: a message absent from a target catalog falls back, and the text's language decides its
   * direction on the page.
   */
  abstract evaluateText<
    Handle extends MessageHandle & { readonly resultKind: 'plain' },
  >(handle: Handle, ...inputs: MessageInputArguments<Handle>): LocalizedText;
  /**
   * The resolved string alone, for the common case where the supplying locale does not matter.
   *
   * Read once at the moment it is called. In a template that has to follow a locale change, bind
   * `textSignal` or the message pipe instead.
   */
  abstract text<
    Handle extends MessageHandle & { readonly resultKind: 'plain' },
  >(handle: Handle, ...inputs: MessageInputArguments<Handle>): string;
  /**
   * A message as a signal, so a template follows every later locale change on its own.
   *
   * Inputs may be given as values or as a signal of them, which is how a message whose input
   * changes stays one binding. Calling it twice with the same handle and the same inputs gives back
   * the same signal, so it is cheap in a loop.
   */
  abstract textSignal<
    Handle extends MessageHandle & { readonly resultKind: 'plain' },
  >(
    handle: Handle,
    inputs?:
      | MessageInputArguments<Handle>[0]
      | Signal<MessageInputArguments<Handle>[0]>,
  ): Signal<string>;
  /**
   * Resolves a structured message into its parts, for a sentence with markup inside it.
   *
   * The parts say which runs are text and which are slots the template fills, so a link or a bold
   * run can sit inside a translated sentence without the translation containing markup. Rendering
   * them is the structured-message component's job.
   */
  abstract parts<
    Handle extends MessageHandle & { readonly resultKind: 'structured' },
  >(handle: Handle, ...inputs: MessageInputArguments<Handle>): LocalizedParts;
  /** The parts as a signal, memoized per handle and inputs the way the text one is. */
  abstract partsSignal<
    Handle extends MessageHandle & { readonly resultKind: 'structured' },
  >(
    handle: Handle,
    inputs?:
      | MessageInputArguments<Handle>[0]
      | Signal<MessageInputArguments<Handle>[0]>,
  ): Signal<LocalizedParts>;
  /** Writes a decimal in the committed locale, with its numbering system and conventions. */
  abstract formatNumber(
    value: DecimalValue,
    options?: Intl.NumberFormatOptions,
  ): FormattingResult;
  /** Writes an amount with its currency. The currency comes from the value and cannot be passed. */
  abstract formatMoney(
    value: MoneyValue,
    options?: Omit<Intl.NumberFormatOptions, 'currency' | 'style'>,
  ): FormattingResult;
  /** Writes a quantity with its unit in the locale's measurement wording. The unit is the value's. */
  abstract formatMeasurement(
    value: MeasurementValue,
    options?: Omit<Intl.NumberFormatOptions, 'style' | 'unit'>,
  ): FormattingResult;
  /** Writes a proportion as a percentage, converting from whichever scale the value carries. */
  abstract formatPercent(
    value: PercentValue,
    options?: Omit<Intl.NumberFormatOptions, 'style'>,
  ): FormattingResult;
  /** Writes a difference between proportions, which most locales word differently from a percentage. */
  abstract formatPercentagePoints(
    value: PercentagePointsValue,
    options?: Intl.NumberFormatOptions,
  ): FormattingResult;
  /**
   * Writes a moment as a date and time in the committed formatting context's zone.
   *
   * Options are required, because which fields to show is a decision no default can make. A
   * context with no zone reports rather than falling back to the host's, which differs between a
   * server and a browser.
   */
  abstract formatInstant(
    value: InstantValue,
    options: Intl.DateTimeFormatOptions,
  ): FormattingResult;
  /** Writes a calendar date in the locale's field order. No zone is involved. */
  abstract formatPlainDate(
    value: PlainDateValue,
    options?: Intl.DateTimeFormatOptions,
  ): FormattingResult;
  /** Writes a time of day on the locale's clock, or the hour cycle the context names. */
  abstract formatPlainTime(
    value: PlainTimeValue,
    options?: Intl.DateTimeFormatOptions,
  ): FormattingResult;
  /** Writes a wall-clock date and time, joined the way the locale joins them. */
  abstract formatPlainDateTime(
    value: PlainDateTimeValue,
    options?: Intl.DateTimeFormatOptions,
  ): FormattingResult;
  /**
   * Writes a moment in the zone the value carries, which lets one page show several zones.
   *
   * Options are required, for the reason an instant's are.
   */
  abstract formatZonedDateTime(
    value: ZonedDateTimeValue,
    options: Intl.DateTimeFormatOptions,
  ): FormattingResult;
  /** Writes two decimals as one range, with the locale's separator and its collapsing rules. */
  abstract formatNumberRange(
    start: DecimalValue,
    end: DecimalValue,
    options?: Intl.NumberFormatOptions,
  ): FormattingResult;
  /** Writes two moments as one range, showing only the fields that differ where the locale allows. */
  abstract formatInstantRange(
    start: InstantValue,
    end: InstantValue,
    options: Intl.DateTimeFormatOptions,
  ): FormattingResult;
  /** Writes a length of time in the locale's unit words. Reports on a host without duration support. */
  abstract formatDuration(
    value: DurationValue,
    options?: Readonly<Record<string, unknown>>,
  ): FormattingResult;
  /** Joins already-localized strings the way the locale joins them. It arranges, it does not translate. */
  abstract formatList(
    values: readonly string[],
    options?: Intl.ListFormatOptions,
  ): FormattingResult;
  /** Writes a signed offset in the unit given. The caller chooses the unit; `relativeTime` picks one. */
  abstract formatRelativeTime(
    value: DecimalValue,
    unit: Intl.RelativeTimeFormatUnit,
    options?: Intl.RelativeTimeFormatOptions,
  ): FormattingResult;
  /**
   * Describes a moment against now, choosing the unit and deciding whether words are right at all.
   *
   * Reads the installed clock rather than the host's, so a server and a browser agree. Returns
   * either the phrase or the decision that this moment is too far away to be worth wording, which
   * is where a page falls back to a date.
   */
  abstract relativeTime(
    target: InstantValue,
    options?: Intl.RelativeTimeFormatOptions,
  ): RelativeTimeOutcome;
  /** Names a language, region, script or currency in the committed locale's words. */
  abstract formatDisplayName(
    value: string,
    options: Intl.DisplayNamesOptions,
  ): FormattingResult;
  /**
   * Writes a name in the order and length asked for.
   *
   * The arrangement follows the name's own language rather than the committed locale, so a name
   * keeps its order on a page in another language.
   */
  abstract formatPersonName(
    value: PersonNameValue,
    options?: PersonNameFormatOptions,
  ): FormattingResult;
  /**
   * Which plural category a number falls in here.
   *
   * For something a message cannot express. Ordinary plurals belong inside the message, where a
   * translator can see the branches.
   */
  abstract selectPlural(
    value: DecimalValue,
    options?: Intl.PluralRulesOptions,
  ): LocaleCapabilityResult<Intl.LDMLPluralRule>;
  /** Orders two strings the way the committed locale orders them, for any list a reader sees. */
  abstract compare(
    left: string,
    right: string,
    options?: Intl.CollatorOptions,
  ): LocaleCapabilityResult<-1 | 0 | 1>;
  /** Splits text on grapheme, word or sentence boundaries, so a truncation lands somewhere legible. */
  abstract segment(
    input: string,
    options?: Intl.SegmenterOptions,
  ): LocaleCapabilityResult<readonly LocalizedSegment[]>;
  /** What the committed locale implies: direction, calendar, numbering system, first day of the week. */
  abstract localeMetadata(): LocaleCapabilityResult<LocaleMetadata>;
  /**
   * Format a value through an installed adapter.
   *
   * Takes the adapter rather than its identifier. An identifier is a string the compiler cannot
   * check, and the value that went with it was unrelated to the adapter that would receive it, so
   * a typo and a value of the wrong shape both compiled and failed at runtime. The adapter knows
   * its own identity and its own value type, which is the same reason a message is
   * addressed by handle rather than by name.
   */
  abstract formatWithAdapter<Value>(
    adapter: RuntimeFormattingAdapterBinding<Value>,
    value: Value,
  ): FormattingResult;
  /**
   * Reads text back into a value through an installed adapter, in the committed locale.
   *
   * Takes the adapter rather than its name, for the reason formatting through one does: the
   * adapter carries its own identity and its own value type, so neither can be mistyped.
   */
  abstract parseWithAdapter<Value>(
    adapter: RuntimeParsingAdapterBinding<Value>,
    text: string,
  ): LocalizedInputResult<Value>;
  /**
   * A second localization, for a region of the page that is deliberately in another locale.
   *
   * A quoted document, a preview beside an editor, a language sample. It has its own committed
   * locale and its own transaction; changing the parent's locale does not change it. Dispose it
   * when the region goes away.
   */
  abstract createChildContext(options?: ChildLocalizationOptions): Localization;
  /**
   * The configured locales as switchable options, one signal, recomputed only when the answer
   * changes.
   *
   * This replaces `localeSelector()`, which returned a fresh model object on every call whose
   * `choices` getter allocated a new array of new objects on every read. It tracked signals
   * correctly inside a template and could not be memoised with `computed` by anyone, because there
   * was no signal to memoise. It also carried a second vocabulary for the lifecycle (`ready`,
   * `switching`, `failed`, `uninitialized`) beside the one on `state`, and a `select` method
   * beside `changeLocale`. One list, one verb.
   */
  abstract readonly localeChoices: Signal<readonly LocaleSelectorChoice[]>;
  /**
   * Releases everything this localization holds: participants, loaded catalogs, pending work.
   *
   * The injector calls it for the one it provides. Call it yourself only for a child context you
   * made.
   */
  abstract dispose(): void;
}

interface ScopeActivation {
  readonly scope: LocalizationScope;
  /** Held for the life of the activation and released together. */
  readonly leases: readonly CatalogLease[];
  /**
   * The catalogs this scope consults, in the order it consults them: the locale's own, then each
   * parent locale that ships one, then the source. The source is always the last member, and it is
   * always present, because a scope without it cannot answer at all.
   */
  readonly catalogs: readonly CompiledCatalog[];
  /**
   * The locales among those that the target locale actually inherits from, itself included.
   *
   * Empty means the scope is served entirely by the source locale, which is the one thing a strict
   * policy refuses and the one thing `degraded` reports. It is not the same as the locale's own
   * catalog being absent: `en-AU` served from `en` is `en-AU` behaving as CLDR says it should, so
   * it is neither degraded nor a refusal.
   */
  readonly inheritedLocales: ReadonlySet<string>;
}

const NO_INHERITED_LOCALES: readonly string[] = Object.freeze([]);

interface ActiveSnapshot {
  readonly publicSnapshot: LocalizationSnapshot;
  readonly scopes: ReadonlyMap<string, ScopeActivation>;
}

interface PreparedSnapshot {
  readonly active: ActiveSnapshot;
  readonly transitionId: number;
  readonly participants: readonly PreparedParticipant[];
  release(): void;
}

interface PendingTransition {
  readonly id: number;
  readonly key: string;
  readonly targetLocale: string;
  readonly mode: LocaleChangeMode;
  readonly controller: AbortController;
  readonly promise: Promise<LocaleChangeResult>;
  cancellation: 'cancelled' | 'superseded';
}

interface TransferSnapshot {
  readonly profile: 'atlas-transfer-state/1';
  readonly primaryLocale: string;
  readonly formatting: FormattingContext;
  readonly route?: LocalizationRouteSnapshot;
  readonly catalogs: readonly CompiledCatalog[];
  readonly participants: readonly ParticipantTransferRecord[];
}

const internals = new WeakMap<Localization, LocalizationInternal>();

function freezeScope(scope: LocalizationScope): LocalizationScope {
  const properties = isDataRecord(scope)
    ? Object.getOwnPropertyDescriptors(scope)
    : undefined;
  const providerId = properties?.['providerId'];
  const scopeId = properties?.['scopeId'];
  if (
    !isDataRecord(scope) ||
    !hasExactKeys(
      scope,
      ['providerId', 'scopeId'],
      [
        'applicationContractFingerprint',
        'semanticRegistryFingerprint',
        'requiredExtensions',
        // Whether the first render uses this scope. Optional, so a configuration generated before
        // Atlas derived it still admits.
        'startup',
      ],
    ) ||
    providerId === undefined ||
    providerId.get !== undefined ||
    providerId.set !== undefined ||
    typeof providerId.value !== 'string' ||
    providerId.value.length === 0 ||
    providerId.value.length > 256 ||
    scopeId === undefined ||
    scopeId.get !== undefined ||
    scopeId.set !== undefined ||
    typeof scopeId.value !== 'string' ||
    scopeId.value.length === 0 ||
    scopeId.value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(String(providerId.value)) ||
    /[\u0000-\u001f\u007f]/u.test(String(scopeId.value))
  ) {
    throw new LocalizationError(
      operationalDiagnostic(
        'invalid-configuration',
        'A localization scope must contain bounded own data identifiers.',
      ),
    );
  }
  return Object.freeze({
    providerId: providerId.value as string,
    scopeId: scopeId.value as string,
  });
}

function transitionKey(
  locale: string,
  mode: LocaleChangeMode,
  requiredScopes: readonly LocalizationScope[],
  progressiveScopes: readonly LocalizationScope[],
  participantRevision: number,
  route?: LocalizationRouteSnapshot | null,
): string {
  const scopes = (values: readonly LocalizationScope[]) =>
    values.map(scopeIdentity).sort().join(',');
  const routeKey =
    route === undefined
      ? 'preserve'
      : route === null
        ? 'clear'
        : `${route.projectionIdentity}\u0000${route.routeId}\u0000${route.canonicalPath}`;
  return `${locale}\u0000${mode}\u0000${scopes(requiredScopes)}\u0000${scopes(progressiveScopes)}\u0000${participantRevision}\u0000${routeKey}`;
}

function sameScopes(
  left: readonly LocalizationScope[],
  right: readonly LocalizationScope[],
): boolean {
  if (left.length !== right.length) return false;
  const identities = new Set(left.map(scopeIdentity));
  return right.every((scope) => identities.has(scopeIdentity(scope)));
}

function releaseActivations(activations: Iterable<ScopeActivation>): void {
  const released = new Set<CatalogLease>();
  for (const activation of activations) {
    for (const lease of activation.leases) {
      if (released.has(lease)) continue;
      released.add(lease);
      lease.release();
    }
  }
}

function splitMessageIdentity(identity: string):
  | {
      readonly providerId: string;
      readonly scopeId: string;
      readonly messageId: string;
    }
  | undefined {
  const messageSeparator = identity.lastIndexOf(':');
  const scopeSeparator = identity.lastIndexOf(':', messageSeparator - 1);
  if (scopeSeparator < 1 || messageSeparator <= scopeSeparator + 1)
    return undefined;
  return {
    providerId: identity.slice(0, scopeSeparator),
    scopeId: identity.slice(scopeSeparator + 1, messageSeparator),
    messageId: identity.slice(messageSeparator + 1),
  };
}

/**
 * Two address records that say the same thing.
 *
 * By value, because every one of these is rebuilt from the route on each projection, so identity
 * is never equal and a guard written on it would publish a new snapshot on every navigation of
 * every application that has a switcher.
 */
function sameAddresses(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => left[key] === right[key]);
}

function recoveryOutputBound(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 1;
  const record = body as Readonly<Record<string, unknown>>;
  if (record['kind'] === 'pattern' && Array.isArray(record['pattern'])) {
    return Math.max(1, record['pattern'].length);
  }
  if (record['kind'] === 'select' && Array.isArray(record['variants'])) {
    return Math.max(
      1,
      ...record['variants'].map((variant) => {
        if (typeof variant !== 'object' || variant === null) return 1;
        const pattern = (variant as Readonly<Record<string, unknown>>)[
          'pattern'
        ];
        return Array.isArray(pattern) ? Math.max(1, pattern.length) : 1;
      }),
    );
  }
  return 1;
}

/**
 * The bare language subtag, from the same profile the direction comes from.
 *
 * `lang` on a single option is the language it is written in, and `en-US` in that attribute claims
 * the option is written in American English rather than in English. The fallback is the tag's first
 * subtag, for the same reason `localeSelfName` falls back to the tag itself: a locale list is
 * validated before it reaches here, and a switcher that throws is worse than one that is slightly
 * less specific.
 */
function localeLanguage(locale: string): string {
  try {
    return localeProfile(locale).language;
  } catch {
    return locale.split('-')[0] ?? locale;
  }
}

/**
 * What the switcher calls this locale.
 *
 * The generated configuration carries the name, decided at build time from the toolkit's pinned
 * CLDR release, so every engine and both sides of hydration render the same string. The fallback
 * to `Intl.DisplayNames` is right for a locale the build had no name for: the engine's answer is
 * not wrong, it is merely the engine's, and a name from the visitor's own CLDR beats a tag.
 */
function localeSelfName(
  locale: string,
  names: Readonly<Record<string, string>> | undefined,
): string {
  const generated =
    names !== undefined && Object.hasOwn(names, locale)
      ? names[locale]
      : undefined;
  if (generated !== undefined) return generated;
  try {
    return (
      new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale
    );
  } catch {
    return locale;
  }
}

class LocalizationInternal {
  private readonly lifecycleValue =
    signal<LocalizationLifecycle>('uninitialized');
  /**
   * What is current, held once.
   *
   * One field with a projection of it, rather than the activation and the public snapshot inside
   * it held as two fields assigned on consecutive lines at three call sites. A pairing kept by call
   * sites is a pairing one call site can break, and the break would not be caught: the signal is
   * what the application reads and the activation is what the runtime reads, so the two would
   * simply disagree about what the locale is. One field makes that state unrepresentable rather
   * than merely tested for.
   */
  private readonly activeValue = signal<ActiveSnapshot | undefined>(undefined);
  private readonly snapshotValue = computed(
    () => this.activeValue()?.publicSnapshot,
  );
  private readonly targetLocaleValue = signal<string | undefined>(undefined);
  private readonly recoveryValue = signal<LocalizedText | undefined>(undefined);
  private readonly recoveryRetryLabelValue = signal<LocalizedText | undefined>(
    undefined,
  );
  private readonly lastResultValue = signal<LocaleChangeResult | undefined>(
    undefined,
  );
  private readonly scopeReadinessValue = signal<
    Readonly<Record<string, ScopeReadiness>>
  >(Object.freeze({}));
  private readonly store: LocalCatalogStore;
  private readonly formatterCache: FormatterCache;
  private readonly extensions: RuntimeExtensions;
  readonly formatter: FormattingSurface;
  private readonly localeResolution: LocaleResolution;
  private readonly participantCoordinator: ParticipantCoordinator;
  private readonly observability: LocalizationEventEmitter | undefined;
  private readonly seedPromise: Promise<void>;
  private readonly sourceLocale: string;
  private readonly defaultLocale: string;
  private readonly localeList: readonly string[];
  private readonly aliases: Readonly<Record<string, string>>;
  private readonly localeFormatting: Readonly<
    Record<string, LocaleFormattingOverride>
  >;
  private readonly localeFallbacks: Readonly<Record<string, readonly string[]>>;
  private readonly bootstrapScopes: readonly LocalizationScope[];
  private readonly supportedLocales: ReadonlySet<string>;
  private readonly knownScopes: ReadonlyMap<string, LocalizationScope>;
  private readonly lifetimeController = new AbortController();
  private readonly operationControllers = new Set<AbortController>();
  private initialization: Promise<LocalizationSnapshot> | undefined;
  private initializationController: AbortController | undefined;
  private pending: PendingTransition | undefined;
  private readonly progressiveControllers = new Set<AbortController>();
  private nextSnapshotId = 0;
  private nextTransitionId = 0;
  private committedTransitionId = 0;
  private disposed = false;
  /** True while `committed` hooks are running, so a hook that publishes is queued behind them. */
  private publishing = false;
  private queuedRoute: LocalizationRouteSnapshot | undefined;
  /** See `Localization.ɵclaimLocaleChange`. Registered by the routing adapter, or by nothing. */
  private localeChangeClaim:
    | ((locale: string) => string | undefined)
    | undefined;

  readonly state: LocalizationState;

  constructor(
    readonly facade: Localization,
    readonly options: LocalizationRuntimeOptions,
  ) {
    this.observability =
      options.observability === undefined
        ? undefined
        : createLocalizationEventEmitter(options.observability);
    const configuration = snapshotInertJson(options.setup.configuration, {
      maximumDepth: 32,
      maximumNodes: 250_000,
      maximumCodeUnits: 4_194_304,
    }).value as unknown as AsReceived<
      typeof options.setup.configuration,
      'generatedAbi'
    >;
    if (
      configuration.generatedAbi !== GENERATED_ABI ||
      !Array.isArray(configuration.locales) ||
      configuration.locales.length === 0 ||
      configuration.locales.length > 512 ||
      !Array.isArray(configuration.scopes) ||
      configuration.scopes.length === 0 ||
      configuration.scopes.length > 250_000 ||
      configuration.locales.some(
        (locale) =>
          typeof locale !== 'string' ||
          locale.length === 0 ||
          locale.length > 128,
      ) ||
      new Set(configuration.locales).size !== configuration.locales.length ||
      !configuration.locales.includes(configuration.sourceLocale) ||
      !configuration.locales.includes(configuration.defaultLocale) ||
      !isDataRecord(configuration.aliases) ||
      Object.keys(configuration.aliases).length > 2_048 ||
      Object.entries(configuration.aliases).some(
        ([alias, locale]) =>
          alias.length === 0 ||
          alias.length > 128 ||
          typeof locale !== 'string' ||
          !configuration.locales.includes(locale),
      ) ||
      // Checked on the same terms as the aliases above, and for the same reason: a generated table
      // is trusted about what it means, never about its shape.
      (configuration.formatting !== undefined &&
        !isGeneratedLocaleFormatting(
          configuration.formatting,
          configuration.locales,
        )) ||
      (configuration.localeFallbacks !== undefined &&
        !isGeneratedLocaleFallbacks(
          configuration.localeFallbacks,
          configuration.locales,
        ))
    ) {
      throw new LocalizationError(
        operationalDiagnostic(
          'invalid-configuration',
          'The generated locale configuration is inconsistent.',
        ),
      );
    }
    // Every stamp and every table in it has been read and compared, so the declared type
    // describes this configuration rather than being claimed over it.
    const checked = configuration as typeof options.setup.configuration;
    this.sourceLocale = configuration.sourceLocale;
    this.defaultLocale = configuration.defaultLocale;
    this.localeList = Object.freeze([...configuration.locales]);
    this.aliases = configuration.aliases;
    this.localeFormatting = configuration.formatting ?? {};
    this.localeFallbacks = configuration.localeFallbacks ?? {};
    this.supportedLocales = new Set(this.localeList);
    const knownScopes = new Map(
      configuration.scopes.map((scope) => [
        scopeIdentity(scope),
        freezeScope(scope),
      ]),
    );
    if (knownScopes.size !== configuration.scopes.length) {
      throw new LocalizationError(
        operationalDiagnostic(
          'invalid-configuration',
          'Generated localization scopes contain a duplicate identity.',
        ),
      );
    }
    this.knownScopes = knownScopes;
    this.extensions = new RuntimeExtensions(
      options.setup.extensions ?? [],
      configuration.scopes.flatMap((scope) => scope.requiredExtensions),
    );
    if (
      !Array.isArray(options.bootstrapScopes) ||
      options.bootstrapScopes.length === 0
    ) {
      throw new LocalizationError(
        operationalDiagnostic(
          'invalid-configuration',
          'At least one generated bootstrap scope is required.',
        ),
      );
    }
    this.bootstrapScopes = this.normalizeScopes(
      options.bootstrapScopes,
      'bootstrapScopes',
    );
    this.store = new LocalCatalogStore(
      checked,
      options.setup.catalogSet,
      options.setup.catalogLoaders,
      options.setup.maximumCachedCatalogs,
    );
    const formatterCapacity = Math.min(
      RUNTIME_LIMITS.formatterCacheEntries,
      Math.max(1, this.store.artifactCount * 8),
    );
    this.formatterCache = new FormatterCache(formatterCapacity);
    this.participantCoordinator = new ParticipantCoordinator(
      options.transferredParticipants ?? [],
    );
    if (
      !Array.isArray(options.transferredCatalogs ?? []) ||
      (options.transferredCatalogs?.length ?? 0) >
        RUNTIME_LIMITS.catalogsPerTransfer
    ) {
      throw new LocalizationError(
        operationalDiagnostic(
          'invalid-configuration',
          'Transferred catalogs exceed the fixed runtime ceiling.',
        ),
      );
    }
    this.seedPromise = Promise.all(
      (options.transferredCatalogs ?? []).map((catalog) =>
        this.store.seed(catalog, this.lifetimeController.signal),
      ),
    ).then(() => undefined);
    void this.seedPromise.catch(() => undefined);
    this.localeResolution = new LocaleResolution({
      persistence: options.persistence,
      initialLocale: options.initialLocale,
      requestContext: options.requestContext,
      preferredLanguages: options.preferredLanguages,
      localeUrl: options.localeUrl,
      localeSources: options.localeSources,
      defaultLocale: this.defaultLocale,
      localeList: this.localeList,
      supportedLocales: this.supportedLocales,
      seeded: this.seedPromise,
      canonicalLocale: (locale) => this.canonicalLocale(locale),
      observability: this.observability,
    });
    this.formatter = new FormattingSurface({
      snapshot: () => this.formattingSnapshot(),
      clock: options.clock,
      relativeTimePolicy: options.relativeTimePolicy,
      personNames: options.setup.personNames,
      extensions: this.extensions,
    });
    const localeNames = options.setup.configuration.localeNames;
    // The half of a choice that cannot change, resolved once.
    //
    // A locale's endonym, its bare language subtag and its direction are properties of the locale.
    // `Intl.DisplayNames` and the likely-subtags maximisation behind `localeProfile` are not free,
    // and the old selector ran both on every read of `choices`.
    const identities = Object.freeze(
      this.localeList.map((locale) =>
        Object.freeze({
          locale,
          language: localeLanguage(locale),
          selfName: localeSelfName(locale, localeNames),
          direction: directionForLocale(locale),
        }),
      ),
    );
    this.state = Object.freeze({
      lifecycle: this.lifecycleValue.asReadonly(),
      ready: computed(() => this.lifecycleValue() === 'ready'),
      snapshot: this.snapshotValue,
      targetLocale: this.targetLocaleValue.asReadonly(),
      recovery: this.recoveryValue.asReadonly(),
      recoveryRetryLabel: this.recoveryRetryLabelValue.asReadonly(),
      lastResult: this.lastResultValue.asReadonly(),
      participants: this.participantCoordinator.states,
      localeChoices: computed(() => {
        const current = this.snapshotValue()?.primaryLocale;
        const pending = this.targetLocaleValue();
        return Object.freeze(
          identities.map((identity) =>
            Object.freeze({
              ...identity,
              current: identity.locale === current,
              pending: identity.locale === pending,
            }),
          ),
        );
      }),
    });
  }

  observe(input: LocalizationEventInput): void {
    this.observability?.emit(input);
  }

  private get active(): ActiveSnapshot | undefined {
    return this.activeValue();
  }

  /**
   * Scopes an application has asked to have ready and that have not landed yet.
   *
   * A locale transaction reads this and loads them for the locale it is committing, which is what
   * makes a superseded scope load a discarded *load* rather than a discarded *request*.
   */
  private readonly outstandingRequiredScopes = new Map<
    string,
    LocalizationScope
  >();

  private withOutstandingRequiredScopes(
    scopes: readonly LocalizationScope[],
  ): readonly LocalizationScope[] {
    if (this.outstandingRequiredScopes.size === 0) return scopes;
    const present = new Set(scopes.map(scopeIdentity));
    const missing = [...this.outstandingRequiredScopes.entries()]
      .filter(([key]) => !present.has(key))
      .map(([, scope]) => scope);
    return missing.length === 0 ? scopes : [...scopes, ...missing];
  }

  /**
   * The only way a snapshot becomes current.
   *
   * A scope load finishing does everything publication does: it mints a snapshot id, rebuilds the
   * scope map, recomputes `degraded` and runs every `committed` hook. Left to do that on its own it
   * is a second publisher that nothing names as one, so nothing governs it, and two publishers
   * drift into two supersede rules without either being written down.
   *
   * So publication is a single door and everything goes through it, including the clear on disposal.
   * A hook that throws here cannot invalidate a snapshot that is already coherent, it has been
   * published, so the failure is reported and the remaining hooks still run. That reporting used
   * to happen on the transaction's path and be swallowed on the other one, which is the kind of
   * difference two doors produce and one door cannot.
   */
  private publish(
    next: ActiveSnapshot | undefined,
    superseded: Iterable<ScopeActivation>,
  ): void {
    this.activeValue.set(next);
    if (next !== undefined) {
      this.publishing = true;
      try {
        for (const hook of this.options.commitHooks ?? []) {
          try {
            hook.committed?.(next.publicSnapshot);
          } catch (error: unknown) {
            this.reportCommitHookFailure(error, next.publicSnapshot);
          }
        }
      } finally {
        this.publishing = false;
      }
    }
    releaseActivations(superseded);
    // A hook that publishes, published after this one finishes rather than inside it.
    //
    // The routing integration's document step restates the route record, and restating publishes:
    // it is one of the two small transactions this door already carries. Called from a `committed`
    // hook that would be re-entry: the inner publication would set a newer snapshot while the
    // outer loop still had hooks to run, and every one of them would then be handed a snapshot that
    // had already been superseded. Queued instead, so the two publications are sequential and each
    // hook sees each snapshot exactly once, in order. Only the last is kept: a restatement is the
    // current route record rather than an event, so an older one is not information that was lost.
    const queued = this.queuedRoute;
    if (queued === undefined) return;
    this.queuedRoute = undefined;
    this.restateRoute(queued);
  }

  private reportCommitHookFailure(
    error: unknown,
    snapshot: LocalizationSnapshot,
  ): void {
    if (this.observability === undefined) return;
    const diagnostic = asDiagnostic(error);
    this.observability.emit({
      code: RUNTIME_EVENT_CODES.integration,
      phase: 'integration',
      status: 'failed',
      reason: diagnostic.code,
      targetLocale: snapshot.primaryLocale,
      ...(diagnostic.participantId === undefined
        ? {}
        : { participantId: diagnostic.participantId }),
      snapshotId: snapshot.id,
    });
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new LocalizationError(
        operationalDiagnostic(
          'disposed',
          'The localization context is disposed.',
        ),
      );
    }
  }

  private normalizeScopes(
    values: readonly LocalizationScope[],
    label: string,
  ): readonly LocalizationScope[] {
    if (!Array.isArray(values) || values.length > this.knownScopes.size) {
      throw new LocalizationError(
        operationalDiagnostic(
          'invalid-configuration',
          `${label} exceeds the generated scope ceiling.`,
        ),
      );
    }
    const seen = new Set<string>();
    const scopes = values.map((scope) => {
      const admitted = this.assertScope(scope);
      const identity = scopeIdentity(admitted);
      if (seen.has(identity)) {
        throw new LocalizationError(
          operationalDiagnostic(
            'invalid-configuration',
            `${label} contains a duplicate generated scope.`,
          ),
        );
      }
      seen.add(identity);
      return admitted;
    });
    return Object.freeze(scopes);
  }

  private beginOperation(): AbortController {
    this.assertActive();
    const controller = new AbortController();
    if (this.lifetimeController.signal.aborted) {
      controller.abort(this.lifetimeController.signal.reason);
    }
    this.operationControllers.add(controller);
    return controller;
  }

  private finishOperation(controller: AbortController): void {
    this.operationControllers.delete(controller);
  }

  private assertScope(scope: LocalizationScope): LocalizationScope {
    const admitted = freezeScope(scope);
    const known = this.knownScopes.get(scopeIdentity(admitted));
    if (known === undefined) {
      throw new LocalizationError(
        operationalDiagnostic(
          'scope-unavailable',
          `Localization scope ${safeDiagnosticIdentifier(admitted.providerId)}/${safeDiagnosticIdentifier(admitted.scopeId)} is not generated for this context.`,
          {
            providerId: admitted.providerId,
            scopeId: admitted.scopeId,
          },
        ),
      );
    }
    return known;
  }

  private canonicalLocale(locale: string): string {
    if (
      typeof locale !== 'string' ||
      locale.length === 0 ||
      locale.length > 128
    ) {
      throw new LocalizationError(
        operationalDiagnostic(
          'unsupported-locale',
          'The requested locale is malformed or unsupported.',
        ),
      );
    }
    const alias = hasOwn(this.aliases, locale)
      ? this.aliases[locale]
      : undefined;
    if (alias !== undefined) return alias;
    let canonical: string;
    try {
      canonical = Intl.getCanonicalLocales(locale)[0] as string;
    } catch (cause) {
      throw new LocalizationError(
        operationalDiagnostic(
          'unsupported-locale',
          'The requested locale is malformed or unsupported.',
          { reason: 'malformed-input' },
        ),
        { cause },
      );
    }
    const canonicalAlias = hasOwn(this.aliases, canonical)
      ? this.aliases[canonical]
      : undefined;
    const resolved = canonicalAlias ?? canonical;
    if (!this.supportedLocales.has(resolved)) {
      throw new LocalizationError(
        operationalDiagnostic(
          'unsupported-locale',
          `Locale ${safeDiagnosticIdentifier(resolved)} is not supported by this localization context.`,
          { targetLocale: resolved },
        ),
      );
    }
    return resolved;
  }

  private updateReadiness(
    scope: LocalizationScope,
    readiness: Omit<ScopeReadiness, 'scope'>,
  ): void {
    const key = scopeIdentity(scope);
    this.scopeReadinessValue.update((current) => {
      const previous = current[key];
      if ((previous?.transitionId ?? -1) > (readiness.transitionId ?? -1)) {
        return current;
      }
      return Object.freeze({
        ...current,
        [key]: Object.freeze({ scope, ...readiness }),
      });
    });
  }

  private async acquireScope(
    scopeValue: LocalizationScope,
    targetLocale: string,
    transitionId: number,
    signalValue: AbortSignal,
  ): Promise<ScopeActivation> {
    const scope = this.assertScope(scopeValue);
    this.observability?.emit({
      code: RUNTIME_EVENT_CODES.catalog,
      phase: 'catalog',
      status: 'started',
      targetLocale,
      providerId: scope.providerId,
      scopeId: scope.scopeId,
      transitionId,
    });
    this.updateReadiness(scope, {
      targetLocale,
      status: 'loading',
      supplyingLocales: Object.freeze([]),
      transitionId,
    });
    const sourceLocale = this.sourceLocale;
    // The chain is resolved at build time and arrives in the generated configuration; a locale
    // with no entry has no parent and behaves as every locale did before this existed.
    const order = catalogConsultationOrder(
      targetLocale,
      this.localeFallbacks[targetLocale] ?? NO_INHERITED_LOCALES,
      sourceLocale,
      (locale) => this.store.has(scope, locale),
    );
    if (
      order.inherited.size === 0 &&
      targetLocale !== sourceLocale &&
      this.options.setup.fallbackPolicy === 'strict'
    ) {
      const diagnostic = Object.freeze({
        code: 'scope-unavailable' as const,
        outcome: 'localized-representation-unavailable' as const,
        message: `Strict localization requires ${scope.providerId}/${scope.scopeId} in ${targetLocale}.`,
        targetLocale,
        providerId: scope.providerId,
        scopeId: scope.scopeId,
        transitionId,
      });
      this.updateReadiness(scope, {
        targetLocale,
        status: 'failed',
        supplyingLocales: Object.freeze([]),
        transitionId,
        diagnostic,
      });
      this.observability?.emit({
        code: RUNTIME_EVENT_CODES.catalog,
        phase: 'catalog',
        status: 'unavailable',
        reason: diagnostic.code,
        targetLocale,
        providerId: scope.providerId,
        scopeId: scope.scopeId,
        transitionId,
      });
      throw new LocalizationError(diagnostic);
    }
    if (!this.store.has(scope, sourceLocale)) {
      const diagnostic = operationalDiagnostic(
        'invalid-configuration',
        `The source catalog is missing for ${scope.providerId}/${scope.scopeId}.`,
        {
          targetLocale,
          providerId: scope.providerId,
          scopeId: scope.scopeId,
          transitionId,
        },
      );
      this.updateReadiness(scope, {
        targetLocale,
        status: 'failed',
        supplyingLocales: Object.freeze([]),
        transitionId,
        diagnostic,
      });
      this.observability?.emit({
        code: RUNTIME_EVENT_CODES.catalog,
        phase: 'catalog',
        status: 'failed',
        reason: diagnostic.code,
        targetLocale,
        providerId: scope.providerId,
        scopeId: scope.scopeId,
        transitionId,
      });
      throw new LocalizationError(diagnostic);
    }
    const settled = await Promise.allSettled(
      order.locales.map((locale) =>
        this.store.acquire(scope, locale, signalValue),
      ),
    );
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) {
      for (const result of settled) {
        if (result.status === 'fulfilled') result.value.release();
      }
      const diagnostic = asDiagnostic(failure.reason);
      this.updateReadiness(scope, {
        targetLocale,
        status: 'failed',
        supplyingLocales: Object.freeze([]),
        transitionId,
        diagnostic,
      });
      this.observability?.emit({
        code: RUNTIME_EVENT_CODES.catalog,
        phase: 'catalog',
        status:
          diagnostic.code === 'scope-unavailable'
            ? 'unavailable'
            : diagnostic.code === 'cancelled' || diagnostic.code === 'disposed'
              ? 'cancelled'
              : diagnostic.code === 'superseded'
                ? 'superseded'
                : 'failed',
        reason: diagnostic.code,
        targetLocale,
        providerId: scope.providerId,
        scopeId: scope.scopeId,
        transitionId,
      });
      throw failure.reason;
    }
    const leases = settled.map(
      (result) => (result as PromiseFulfilledResult<CatalogLease>).value,
    );
    const supplyingLocales = Object.freeze(
      leases
        .map((lease) => lease.catalog.key.catalogLocale)
        .filter((locale, index, all) => all.indexOf(locale) === index),
    );
    this.updateReadiness(scope, {
      targetLocale,
      status: 'ready',
      supplyingLocales,
      transitionId,
    });
    this.observability?.emit({
      code: RUNTIME_EVENT_CODES.catalog,
      phase: 'catalog',
      status: 'succeeded',
      targetLocale,
      supplyingLocale: supplyingLocales[0] as string,
      providerId: scope.providerId,
      scopeId: scope.scopeId,
      transitionId,
      count: supplyingLocales.length,
    });
    return Object.freeze({
      scope,
      leases: Object.freeze(leases),
      catalogs: Object.freeze(leases.map((lease) => lease.catalog)),
      inheritedLocales: order.inherited,
    });
  }

  /**
   * The formatting context one locale is rendered with.
   *
   * Three layers, narrowest last. The application-wide context is the default every locale
   * inherits. The generated configuration's entry for this locale overrides it, because how a
   * language is written is a fact about that language and not about the application. What neither
   * of them sets is whatever CLDR says for the locale, which is the standard's choice arriving as
   * an absent option rather than as a gap.
   *
   * The transferred context is layered on top for the locale the server actually rendered, and for
   * that locale only. It is a committed snapshot rather than a default, and the difference is the
   * whole reason it is a separate option: adopting it as the default made every later locale
   * inherit the one the first response happened to be written in.
   */
  private formatting(locale: string): FormattingContext {
    return Object.freeze({
      locale,
      ...(this.options.formattingContext ?? {}),
      ...(this.localeFormatting[locale] ?? {}),
      ...(locale === this.options.initialLocale
        ? (this.options.initialFormattingContext ?? {})
        : {}),
    });
  }

  private async prepare(
    targetLocale: string,
    requiredScopesValue: readonly LocalizationScope[],
    transitionId: number,
    signalValue: AbortSignal,
    route?: LocalizationRouteSnapshot,
    requiredParticipants: readonly RegisteredParticipant[] = [],
  ): Promise<PreparedSnapshot> {
    const requiredScopes = this.normalizeScopes(
      requiredScopesValue,
      'requiredScopes',
    );
    const results = await Promise.allSettled(
      requiredScopes.map((scope) =>
        this.acquireScope(scope, targetLocale, transitionId, signalValue),
      ),
    );
    const activations = results
      .filter(
        (result): result is PromiseFulfilledResult<ScopeActivation> =>
          result.status === 'fulfilled',
      )
      .map(({ value }) => value);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) {
      releaseActivations(activations);
      throw failure.reason;
    }
    let participants: readonly PreparedParticipant[];
    try {
      participants = await this.participantCoordinator.prepareRequired(
        requiredParticipants,
        targetLocale,
        this.formatting(targetLocale),
        transitionId,
        signalValue,
      );
    } catch (error: unknown) {
      releaseActivations(activations);
      if (this.observability !== undefined) {
        const diagnostic = asDiagnostic(error);
        this.observability.emit({
          code: RUNTIME_EVENT_CODES.integration,
          phase: 'integration',
          status: 'failed',
          reason: diagnostic.code,
          targetLocale,
          ...(diagnostic.participantId === undefined
            ? {}
            : { participantId: diagnostic.participantId }),
          transitionId,
        });
      }
      throw error;
    }
    const scopes = new Map(
      activations.map((activation) => [
        scopeIdentity(activation.scope),
        activation,
      ]),
    );
    // A scope is degraded when nothing the locale inherits from answered, so the reader is being
    // shown the source language. A regional locale served by its parent is not degraded: that is
    // what declaring the parent means.
    const degraded = activations.some(
      (activation) => activation.inheritedLocales.size === 0,
    );
    const publicSnapshot: LocalizationSnapshot = Object.freeze({
      id: (this.nextSnapshotId += 1),
      primaryLocale: targetLocale,
      direction: directionForLocale(targetLocale),
      requiredScopes,
      loadedScopes: Object.freeze(activations.map(({ scope }) => scope)),
      degraded,
      generatedAbi: GENERATED_ABI,
      standardsProfile: 'atlas-1',
      catalogSetIds: this.store.catalogSetIds(),
      formatting: this.formatting(targetLocale),
      ...(route === undefined ? {} : { route: Object.freeze({ ...route }) }),
    });
    let released = false;
    return {
      active: { publicSnapshot, scopes },
      transitionId,
      participants,
      release: () => {
        if (released) return;
        released = true;
        this.participantCoordinator.discardPrepared(participants);
        releaseActivations(activations);
      },
    };
  }

  private commit(prepared: PreparedSnapshot): LocalizationSnapshot {
    this.assertActive();
    const previous = this.active;
    const applied: LocalizationCommitHook[] = [];
    try {
      for (const hook of this.options.commitHooks ?? []) {
        applied.push(hook);
        hook.apply(prepared.active.publicSnapshot);
      }
      this.participantCoordinator.commitPrepared(prepared.participants);
    } catch (error: unknown) {
      for (const hook of applied.reverse()) {
        try {
          hook.rollback?.(previous?.publicSnapshot);
        } catch {
          // Preserve the original coherence-critical effect failure.
        }
      }
      prepared.release();
      if (this.observability !== undefined) {
        const diagnostic = asDiagnostic(error);
        this.observability.emit({
          code: RUNTIME_EVENT_CODES.integration,
          phase: 'integration',
          status: 'failed',
          reason: diagnostic.code,
          targetLocale: prepared.active.publicSnapshot.primaryLocale,
          ...(diagnostic.participantId === undefined
            ? {}
            : { participantId: diagnostic.participantId }),
          snapshotId: prepared.active.publicSnapshot.id,
        });
      }
      throw error;
    }
    // Cleared before the snapshot lands rather than part way through publication. No `committed`
    // hook can observe it, a hook is handed the snapshot and nothing else, and an effect sees the
    // settled state, so nothing can read a half-published state.
    this.committedTransitionId = prepared.transitionId;
    this.recoveryValue.set(undefined);
    this.recoveryRetryLabelValue.set(undefined);
    this.publish(
      prepared.active,
      previous === undefined ? [] : previous.scopes.values(),
    );
    return prepared.active.publicSnapshot;
  }

  private recoveryText(
    identity: string | undefined,
    targetLocale: string,
  ): LocalizedText | undefined {
    const payload = this.options.setup.recoveryPayload;
    if (identity === undefined || payload === undefined) return undefined;
    const sourceLocale = this.sourceLocale;
    const representation =
      payload.find(
        (item) => item.identity === identity && item.locale === targetLocale,
      ) ??
      payload.find(
        (item) => item.identity === identity && item.locale === sourceLocale,
      );
    const parsed = splitMessageIdentity(identity);
    if (representation === undefined || parsed === undefined) return undefined;
    const message: CompiledMessage = {
      messageId: parsed.messageId,
      kind: 'message',
      resultKind: 'plain',
      sourceFingerprint: representation.sourceFingerprint,
      inputs: Object.freeze([]),
      slots: Object.freeze([]),
      body: representation.body,
    };
    const outputBound = recoveryOutputBound(representation.body);
    const catalog: CompiledCatalog = {
      profile: 'atlas-compiled-ir/1',
      generatedAbi: GENERATED_ABI,
      standardsProfile: 'atlas-1',
      key: {
        providerId: parsed.providerId,
        scopeId: parsed.scopeId,
        catalogLocale: representation.locale,
      },
      applicationContractFingerprint: 'recovery',
      semanticRegistryFingerprint: 'recovery',
      requiredExtensions: Object.freeze([]),
      messages: Object.freeze([message]),
      resources: {
        profile: 'atlas-resource-summary/1',
        decodedBytes: 0,
        messages: 1,
        identifiers: 1,
        literals: 1,
        irNodes: 1,
        depth: 1,
        selectors: 0,
        variants: 0,
        inputs: 0,
        slots: 0,
        references: 0,
        functions: 0,
        outputParts: outputBound,
        maximumMessage: {
          irNodes: outputBound,
          depth: 1,
          selectors: 0,
          variants: 0,
          inputs: 0,
          slots: 0,
          outputParts: outputBound,
        },
      },
    };
    const handle: MessageHandle = {
      generatedAbi: GENERATED_ABI,
      providerId: parsed.providerId,
      scopeId: parsed.scopeId,
      messageId: parsed.messageId,
      identity,
      resultKind: 'plain',
      inputNames: Object.freeze([]),
      slotNames: Object.freeze([]),
    };
    const result = evaluateCandidate(
      handle,
      findEvaluationCandidate(handle, targetLocale, [catalog]),
      undefined,
      this.formatting(targetLocale),
      this.formatterCache,
      this.extensions,
    );
    return result.kind === 'text' ? result : undefined;
  }

  /**
   * Bringing the runtime from configured to ready, once.
   *
   * Two callers arriving together share one attempt: the in-flight promise is handed back rather
   * than a second resolution started, because two boots would resolve the locale twice and commit
   * twice over the same scopes. A runtime that is already active answers with what it has, and
   * `force` is how a retry says that is not what it wants.
   *
   * The order is what the rest of the surface rests on. The locale is resolved first, the
   * bootstrap scopes and the required participants are prepared against it, and only a prepared
   * result is committed, so nothing ever observes a half-changed runtime. Progressive
   * participants start after the commit, because they are the ones an application declared it
   * can render without and starting them first would make the first paint wait for them.
   *
   * A failure leaves the lifecycle at `failed`, publishes recovery text in a locale that can be
   * rendered, and rethrows. An application with nothing to show on a failed boot shows a blank
   * page, so the text is published before the error leaves here.
   *
   * Disposal during the attempt releases what was prepared instead of committing it, because a
   * commit after disposal installs catalogs into a context nothing will release.
   */
  initialize(force = false): Promise<LocalizationSnapshot> {
    this.assertActive();
    if (this.active !== undefined && !force) {
      return Promise.resolve(this.active.publicSnapshot);
    }
    if (this.initialization !== undefined) return this.initialization;
    this.lifecycleValue.set('initializing');
    const controller = new AbortController();
    this.initializationController = controller;
    const transitionId = force ? (this.nextTransitionId += 1) : 0;
    this.observability?.emit({
      code: RUNTIME_EVENT_CODES.initialization,
      phase: 'initialization',
      status: 'started',
      transitionId,
    });
    const requiredParticipants = this.participantCoordinator.required();
    const progressiveParticipants = this.participantCoordinator.progressive();
    const initialization = this.localeResolution
      .resolveInitialLocale(controller.signal)
      .then(async (locale) => {
        this.targetLocaleValue.set(locale);
        const prepared = await this.prepare(
          locale,
          this.bootstrapScopes,
          transitionId,
          controller.signal,
          this.options.initialRoute,
          requiredParticipants,
        );
        if (this.disposed) {
          prepared.release();
          throw new LocalizationError(
            operationalDiagnostic(
              'disposed',
              'The localization context is disposed.',
            ),
          );
        }
        const snapshot = this.commit(prepared);
        this.lifecycleValue.set('ready');
        this.targetLocaleValue.set(undefined);
        this.startIndependentParticipants(
          progressiveParticipants,
          locale,
          snapshot.formatting,
          transitionId,
        );
        this.observability?.emit({
          code: RUNTIME_EVENT_CODES.initialization,
          phase: 'initialization',
          status: 'succeeded',
          targetLocale: snapshot.primaryLocale,
          transitionId,
          snapshotId: snapshot.id,
        });
        return snapshot;
      })
      .catch((error: unknown) => {
        this.observability?.emit({
          code: RUNTIME_EVENT_CODES.initialization,
          phase: 'initialization',
          status: this.disposed ? 'cancelled' : 'failed',
          reason: asDiagnostic(error).code,
          targetLocale: this.targetLocaleValue() ?? this.defaultLocale,
          transitionId,
        });
        if (this.disposed) throw error;
        const locale = this.targetLocaleValue() ?? this.defaultLocale;
        this.lifecycleValue.set('failed');
        this.recoveryValue.set(
          this.recoveryText(this.options.recoveryMessageIdentity, locale),
        );
        this.recoveryRetryLabelValue.set(
          this.recoveryText(this.options.recoveryRetryLabelIdentity, locale),
        );
        this.targetLocaleValue.set(undefined);
        throw error;
      })
      .finally(() => {
        if (this.initialization === initialization)
          this.initialization = undefined;
        if (this.initializationController === controller) {
          this.initializationController = undefined;
        }
      });
    this.initialization = initialization;
    return initialization;
  }

  retry(): Promise<LocalizationSnapshot> {
    this.assertActive();
    if (this.lifecycleValue() !== 'failed') {
      throw new LocalizationError(
        operationalDiagnostic(
          'invalid-configuration',
          'retry() is available only after initialization failure.',
        ),
      );
    }
    return this.initialize(true);
  }

  registerParticipant(
    participant: LocalizationParticipant,
    options: LocalizationParticipantOptions = {},
  ): LocalizationParticipantRegistration {
    this.assertActive();
    const registration = this.participantCoordinator.register(
      participant,
      options,
      (participantId) => this.retryParticipant(participantId),
    );
    this.scheduleRegisteredParticipant(registration.id);
    return registration;
  }

  private scheduleRegisteredParticipant(participantId: string): void {
    const settling = this.pending?.promise ?? this.initialization;
    if (settling !== undefined) {
      void settling.then(
        () => this.scheduleRegisteredParticipant(participantId),
        () => undefined,
      );
      return;
    }
    const active = this.active;
    if (active === undefined || this.disposed) return;
    const registration = this.participantCoordinator
      .registrations()
      .find(({ id }) => id === participantId);
    if (
      registration === undefined ||
      this.participantCoordinator.pendingFor(
        [registration],
        active.publicSnapshot.primaryLocale,
      ).length === 0
    ) {
      return;
    }
    void this.retryParticipant(participantId).catch(() => undefined);
  }

  private async retryParticipant(
    participantId: string,
  ): Promise<LocalizationParticipantState> {
    this.assertActive();
    if (this.pending !== undefined) await this.pending.promise;
    if (this.active === undefined) await this.initialize();
    const active = this.active as ActiveSnapshot;
    const registration = this.participantCoordinator
      .registrations()
      .find(({ id }) => id === participantId);
    if (registration === undefined) {
      return this.participantCoordinator.state(participantId);
    }
    const controller = new AbortController();
    const transitionId = (this.nextTransitionId += 1);
    this.progressiveControllers.add(controller);
    try {
      return await this.participantCoordinator.runIndependent(
        registration,
        active.publicSnapshot.primaryLocale,
        active.publicSnapshot.formatting,
        transitionId,
        controller.signal,
      );
    } finally {
      this.progressiveControllers.delete(controller);
    }
  }

  private startIndependentParticipants(
    registrations: readonly RegisteredParticipant[],
    locale: string,
    formatting: FormattingContext,
    transitionId: number,
  ): void {
    if (registrations.length === 0) return;
    const controller = new AbortController();
    this.progressiveControllers.add(controller);
    void Promise.allSettled(
      registrations.map((registration) =>
        this.participantCoordinator.runIndependent(
          registration,
          locale,
          formatting,
          transitionId,
          controller.signal,
        ),
      ),
    ).finally(() => this.progressiveControllers.delete(controller));
  }

  /**
   * One locale change, from the request to the outcome.
   *
   * `specs/06-runtime-and-angular.spec.md` section 7 fixes the five outcomes and the rule that
   * decides between them: equivalent requests coalesce, the latest distinct intent wins, and a
   * superseded transition is invalidated by its identity even where cancellation did not reach
   * the work it started. A redirect is an outcome rather than a failure, because a locale served
   * by another origin has no transition to run.
   */
  changeLocale(
    localeValue: string,
    options: LocaleChangeOptions = {},
  ): Promise<LocaleChangeResult> {
    this.assertActive();
    const mode = options.mode ?? 'coordinated';
    let locale: string;
    try {
      locale = this.canonicalLocale(localeValue);
    } catch (error: unknown) {
      const id = (this.nextTransitionId += 1);
      const result: LocaleChangeResult = Object.freeze({
        status: 'failed',
        transitionId: id,
        mode,
        targetLocale: safeDiagnosticIdentifier(localeValue),
        diagnostic: asDiagnostic(error),
      });
      this.lastResultValue.set(result);
      this.observability?.emit({
        code: RUNTIME_EVENT_CODES.transition,
        phase: 'transition',
        status: 'failed',
        reason: result.diagnostic.code,
        targetLocale: localeValue,
        transitionId: id,
      });
      return Promise.resolve(result);
    }
    // Asked before anything is scheduled, and after the locale is canonical so that a claim is
    // asked about the same locale a transition would have run for. A claimed change runs no
    // transition at all: nothing is loaded, no participant is called, and no snapshot is published,
    // because none of it would survive the origin the reader is being moved to.
    const claimedAddress = this.localeChangeClaim?.(locale);
    if (claimedAddress !== undefined) {
      const id = (this.nextTransitionId += 1);
      const result: LocaleChangeResult = Object.freeze({
        status: 'redirected',
        transitionId: id,
        mode,
        targetLocale: locale,
        address: claimedAddress,
      });
      this.lastResultValue.set(result);
      this.observability?.emit({
        code: RUNTIME_EVENT_CODES.transition,
        phase: 'transition',
        status: 'redirected',
        targetLocale: locale,
        transitionId: id,
      });
      return Promise.resolve(result);
    }
    // A scope somebody is still waiting on is re-requested for the locale being committed.
    //
    // Its own load is for a locale that will never be current and gets discarded, but the request
    // outlives the load: an application that asked for a scope to be ready asked about the
    // application, not about the locale that happened to be current when it asked. Without this the
    // switch would answer that request with `superseded` and the scope would simply not be there.
    // Folded in whatever the caller passed, because the caller of `changeLocale` and the caller of
    // `ensureScope` are usually not the same code and neither knows about the other.
    const required = this.normalizeScopes(
      this.withOutstandingRequiredScopes(
        options.requiredScopes ??
          this.active?.publicSnapshot.requiredScopes ??
          this.bootstrapScopes,
      ),
      'requiredScopes',
    );
    const progressive = this.normalizeScopes(
      options.progressiveScopes ?? [],
      'progressiveScopes',
    );
    const requiredIdentities = new Set(required.map(scopeIdentity));
    if (
      progressive.some((scope) => requiredIdentities.has(scopeIdentity(scope)))
    ) {
      throw new LocalizationError(
        operationalDiagnostic(
          'invalid-configuration',
          'requiredScopes and progressiveScopes cannot overlap.',
        ),
      );
    }
    const requiredParticipants =
      mode === 'coordinated'
        ? this.participantCoordinator.required()
        : Object.freeze([]);
    const independentParticipants =
      mode === 'coordinated'
        ? this.participantCoordinator.progressive()
        : this.participantCoordinator.registrations();
    const key = transitionKey(
      locale,
      mode,
      required,
      progressive,
      this.participantCoordinator.registrationRevision(),
      options.route,
    );
    if (this.pending?.key === key) return this.pending.promise;
    const id = (this.nextTransitionId += 1);
    this.participantCoordinator.supersedeAll();
    for (const background of this.progressiveControllers) {
      background.abort(
        new LocalizationError(
          operationalDiagnostic(
            'superseded',
            'A newer locale intent superseded progressive scope loading.',
          ),
        ),
      );
    }
    this.progressiveControllers.clear();
    if (this.pending !== undefined) {
      this.pending.cancellation = 'superseded';
      this.pending.controller.abort(
        new LocalizationError(
          operationalDiagnostic(
            'superseded',
            'A newer locale intent superseded this transition.',
          ),
        ),
      );
    }
    const controller = new AbortController();
    const pending = {} as PendingTransition;
    const promise = Promise.resolve()
      .then(async () => {
        if (this.active === undefined) await this.initialize();
        const activeRoute = this.active?.publicSnapshot.route;
        const requestedRoute =
          options.route === undefined
            ? activeRoute
            : (options.route ?? undefined);
        const sameRoute =
          (activeRoute === undefined && requestedRoute === undefined) ||
          (requestedRoute !== undefined &&
            activeRoute?.routeId === requestedRoute.routeId &&
            activeRoute.projectionIdentity ===
              requestedRoute.projectionIdentity &&
            activeRoute.canonicalPath === requestedRoute.canonicalPath);
        const sameRequiredScopes =
          this.active !== undefined &&
          sameScopes(this.active.publicSnapshot.requiredScopes, required);
        if (
          this.active?.publicSnapshot.primaryLocale === locale &&
          sameRoute &&
          sameRequiredScopes
        ) {
          const pendingRequired = this.participantCoordinator.pendingFor(
            requiredParticipants,
            locale,
          );
          if (pendingRequired.length > 0) {
            this.lifecycleValue.set('transitioning');
            this.targetLocaleValue.set(locale);
            const preparedParticipants =
              await this.participantCoordinator.prepareRequired(
                pendingRequired,
                locale,
                this.active.publicSnapshot.formatting,
                id,
                controller.signal,
              );
            if (this.pending !== pending || controller.signal.aborted) {
              this.participantCoordinator.discardPrepared(preparedParticipants);
              throw controller.signal.reason;
            }
            this.participantCoordinator.commitPrepared(preparedParticipants);
          }
          this.lifecycleValue.set('ready');
          this.targetLocaleValue.set(undefined);
          const unloadedProgressive = progressive.filter(
            (scope) => !this.active?.scopes.has(scopeIdentity(scope)),
          );
          if (mode === 'progressive' && unloadedProgressive.length > 0) {
            void this.loadProgressive(locale, unloadedProgressive, id);
          }
          this.startIndependentParticipants(
            this.participantCoordinator.pendingFor(
              independentParticipants,
              locale,
            ),
            locale,
            this.active.publicSnapshot.formatting,
            id,
          );
          return Object.freeze({
            status: 'committed',
            transitionId: id,
            mode,
            targetLocale: locale,
            snapshot: this.active.publicSnapshot,
          }) satisfies LocaleChangeResult;
        }
        this.lifecycleValue.set('transitioning');
        this.targetLocaleValue.set(locale);
        const participantsToPrepare =
          this.active?.publicSnapshot.primaryLocale === locale
            ? this.participantCoordinator.pendingFor(
                requiredParticipants,
                locale,
              )
            : requiredParticipants;
        const prepared = await this.prepare(
          locale,
          required,
          id,
          controller.signal,
          requestedRoute,
          participantsToPrepare,
        );
        if (this.pending !== pending || controller.signal.aborted) {
          prepared.release();
          throw controller.signal.reason;
        }
        const previousLocale = this.active?.publicSnapshot.primaryLocale;
        const snapshot = this.commit(prepared);
        this.lifecycleValue.set('ready');
        this.targetLocaleValue.set(undefined);
        // Only a deliberate change is remembered. Persisting the locale that initialization
        // negotiated would freeze an accidental answer: a visitor who never chose anything would
        // carry the first guess forever, and changing their browser's language afterwards would
        // stop working. Decision section 7 keeps an explicit choice outside the resolution chain
        // for the same reason, and this is that rule on the way out.
        // `remember: false` moves the page and records nothing. It is the half of forgetting that
        // moves the reader: the only operation that changes the locale would otherwise store a new
        // choice, so a reader asking to be forgotten would end up with a fresh one.
        if (options.remember !== false) {
          this.localeResolution.persistLocale(snapshot, previousLocale);
        }
        const unloadedProgressive = progressive.filter(
          (scope) => !this.active?.scopes.has(scopeIdentity(scope)),
        );
        if (mode === 'progressive' && unloadedProgressive.length > 0) {
          void this.loadProgressive(locale, unloadedProgressive, id);
        }
        this.startIndependentParticipants(
          this.participantCoordinator.pendingFor(
            independentParticipants,
            locale,
          ),
          locale,
          snapshot.formatting,
          id,
        );
        return Object.freeze({
          status: 'committed',
          transitionId: id,
          mode,
          targetLocale: locale,
          snapshot,
        }) satisfies LocaleChangeResult;
      })
      .catch((error: unknown) => {
        const cancellation = pending.cancellation;
        const status = controller.signal.aborted ? cancellation : 'failed';
        const diagnostic = controller.signal.aborted
          ? operationalDiagnostic(
              status === 'superseded' ? 'superseded' : 'cancelled',
              status === 'superseded'
                ? 'A newer locale intent superseded this transition.'
                : 'The locale transition was cancelled.',
              { targetLocale: locale, transitionId: id },
            )
          : asDiagnostic(error);
        if (this.pending === pending) {
          this.targetLocaleValue.set(undefined);
          this.lifecycleValue.set(
            this.active === undefined ? 'failed' : 'ready',
          );
        }
        return Object.freeze({
          status,
          transitionId: id,
          mode,
          targetLocale: locale,
          diagnostic,
        }) satisfies LocaleChangeResult;
      })
      .then((result) => {
        if (this.pending === pending) {
          this.pending = undefined;
          this.lastResultValue.set(result);
        }
        this.observability?.emit({
          code: RUNTIME_EVENT_CODES.transition,
          phase: 'transition',
          status: result.status === 'committed' ? 'succeeded' : result.status,
          ...(result.status === 'committed'
            ? { snapshotId: result.snapshot.id }
            : { reason: result.diagnostic.code }),
          targetLocale: result.targetLocale,
          transitionId: result.transitionId,
        });
        return result;
      });
    Object.assign(pending, {
      id,
      key,
      targetLocale: locale,
      mode,
      controller,
      promise,
      cancellation: 'cancelled',
    });
    this.pending = pending;
    this.observability?.emit({
      code: RUNTIME_EVENT_CODES.transition,
      phase: 'transition',
      status: 'started',
      targetLocale: locale,
      transitionId: id,
    });
    return promise;
  }

  private async loadProgressive(
    locale: string,
    scopes: readonly LocalizationScope[],
    transitionId: number,
  ): Promise<void> {
    // The transaction this load belongs to, which is not the same as the transition that asked for
    // it: a same-locale change on the same route starts progressive work without committing
    // anything, so its own id is never a committed one and comparing against it would discard every
    // load that path starts. What supersedes a load is a transaction committing after it was
    // requested, and this is the id that says whether one has.
    const requestedAgainst = this.committedTransitionId;
    const controller = new AbortController();
    this.progressiveControllers.add(controller);
    const results = await Promise.allSettled(
      scopes.map((scope) =>
        this.acquireScope(scope, locale, transitionId, controller.signal),
      ),
    ).finally(() => this.progressiveControllers.delete(controller));
    // A progressive load belongs to the snapshot it was requested against, and it lands after that
    // snapshot is current as its own small transaction. If a later locale transaction has committed
    // meanwhile, this content is for a locale that will never be current again and is discarded
    // rather than published: nothing waited on it, because nothing required it.
    //
    // The test is the transaction's identity rather than the committed locale's name. Testing the
    // name is i18next's rule and carries i18next's blind spot: two transactions to the same locale
    // are the same string, so a load belonging to the first publishes into the second.
    if (this.committedTransitionId !== requestedAgainst || this.disposed) {
      releaseActivations(
        results
          .filter(
            (result): result is PromiseFulfilledResult<ScopeActivation> =>
              result.status === 'fulfilled',
          )
          .map(({ value }) => value),
      );
      return;
    }
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      this.commitScopeActivation(result.value);
    }
  }

  claimLocaleChange(
    claim: ((locale: string) => string | undefined) | undefined,
  ): void {
    this.localeChangeClaim = claim;
  }

  claimRoutingCommit(steps: RoutingCommitSteps | undefined): void {
    this.options.claimRoutingCommit?.(steps);
  }

  /**
   * The route record restated for the locale that is now current, as its own small transaction.
   *
   * Restating an address is not a fourth writer. It goes through `publish` like the others, so a `committed` hook cannot tell a locale change from a catalog
   * arriving from an address being restated, which is the property that makes one publisher worth
   * having rather than merely tidier.
   */
  restateRoute(route: LocalizationRouteSnapshot): void {
    const current = this.active;
    if (current === undefined || this.disposed) return;
    if (this.publishing) {
      this.queuedRoute = route;
      return;
    }
    const existing = current.publicSnapshot.route;
    if (
      existing !== undefined &&
      existing.routeId === route.routeId &&
      existing.projectionIdentity === route.projectionIdentity &&
      existing.canonicalPath === route.canonicalPath &&
      sameAddresses(existing.addresses, route.addresses)
    ) {
      return;
    }
    const publicSnapshot = Object.freeze({
      ...current.publicSnapshot,
      id: (this.nextSnapshotId += 1),
      // Frozen one level deeper than the spread reaches. The addresses are a record, and a shallow
      // freeze over it publishes a mutable object on a snapshot whose whole contract is that it
      // cannot change under a reader.
      route: Object.freeze({
        ...route,
        ...(route.addresses === undefined
          ? {}
          : { addresses: Object.freeze({ ...route.addresses }) }),
      }),
    });
    this.publish({ publicSnapshot, scopes: current.scopes }, []);
  }

  /**
   * A scope that finished loading, committed as its own small transaction.
   *
   * This is the second publisher, named as what it always was. It does the same three things the
   * locale transaction does (mint a snapshot id, build the snapshot that supersedes the current
   * one, publish it) for a smaller change: one more scope is loaded and the locale has not moved.
   * It goes through the same door, so a `committed` hook cannot tell which kind of transaction it is
   * observing, which is the property that made two publishers wrong rather than merely untidy.
   */
  private commitScopeActivation(activation: ScopeActivation): void {
    const current = this.active;
    if (current === undefined || this.disposed) {
      releaseActivations([activation]);
      return;
    }
    const key = scopeIdentity(activation.scope);
    const previous = current.scopes.get(key);
    const scopes = new Map(current.scopes);
    scopes.set(key, activation);
    const loadedScopes = Object.freeze(
      [...scopes.values()].map(({ scope }) => scope),
    );
    const publicSnapshot = Object.freeze({
      ...current.publicSnapshot,
      id: (this.nextSnapshotId += 1),
      loadedScopes,
      degraded: [...scopes.values()].some(
        ({ inheritedLocales }) => inheritedLocales.size === 0,
      ),
    });
    this.publish(
      { publicSnapshot, scopes },
      previous === undefined ? [] : [previous],
    );
  }

  cancelTransition(): void {
    this.assertActive();
    if (this.pending === undefined) return;
    this.pending.cancellation = 'cancelled';
    this.pending.controller.abort(
      new LocalizationError(
        operationalDiagnostic(
          'cancelled',
          'The locale transition was cancelled.',
        ),
      ),
    );
  }

  forgetRememberedLocale(): Promise<LocaleRemovalReport> {
    this.assertActive();
    return this.localeResolution.forgetPersistedLocale();
  }

  /**
   * The locale the server rendered this document in.
   *
   * `initialLocale` is set from the transferred snapshot and from nothing else, so it is exactly
   * that: absent when the browser rendered the page itself, and absent on the server.
   */
  renderedLocale(): string | undefined {
    const rendered = this.options.initialLocale;
    return rendered === undefined ? undefined : this.canonicalLocale(rendered);
  }

  async preloadScope(
    scopeValue: LocalizationScope,
    localeValue?: string,
  ): Promise<void> {
    this.assertActive();
    const scope = this.assertScope(scopeValue);
    const locale = this.canonicalLocale(
      localeValue ??
        this.targetLocaleValue() ??
        this.active?.publicSnapshot.primaryLocale ??
        this.defaultLocale,
    );
    const controller = this.beginOperation();
    try {
      const source = this.sourceLocale;
      const requests = [this.store.preload(scope, source, controller.signal)];
      if (locale !== source && this.store.has(scope, locale)) {
        requests.push(this.store.preload(scope, locale, controller.signal));
      }
      await Promise.all(requests);
      this.assertActive();
    } finally {
      this.finishOperation(controller);
    }
  }

  async ensureScope(scopeValue: LocalizationScope): Promise<void> {
    this.assertActive();
    if (this.active === undefined) await this.initialize();
    const active = this.active as ActiveSnapshot;
    const scope = this.assertScope(scopeValue);
    const key = scopeIdentity(scope);
    if (active.scopes.has(key)) return;
    // The transaction this request belongs to, rather than the snapshot id: a scope landing is
    // itself a small transaction and bumps that id, so a progressive scope arriving beside this one
    // makes a request that nothing has superseded report itself as superseded.
    const requestedAgainst = this.committedTransitionId;
    this.outstandingRequiredScopes.set(key, scope);
    const controller = this.beginOperation();
    try {
      const activation = await this.acquireScope(
        scope,
        active.publicSnapshot.primaryLocale,
        this.nextTransitionId,
        controller.signal,
      );
      if (this.disposed || controller.signal.aborted) {
        releaseActivations([activation]);
        throw new LocalizationError(
          operationalDiagnostic(
            'disposed',
            'The localization context is disposed.',
          ),
        );
      }
      if (this.committedTransitionId !== requestedAgainst) {
        // Superseded. The content is for a locale that will never be current, so it is dropped,
        // and the request is not, because the transaction that superseded it re-requested this
        // scope for the locale it was committing. Waiting for that transaction is what makes the
        // scope ready, and it is ready in the locale the visitor is actually in.
        releaseActivations([activation]);
        await (this.pending?.promise ?? this.initialization);
        if (this.active?.scopes.has(key) === true) return;
        throw new LocalizationError(
          operationalDiagnostic(
            'superseded',
            'Scope readiness was superseded by a locale transaction that did not carry the scope.',
          ),
        );
      }
      this.commitScopeActivation(activation);
    } finally {
      this.outstandingRequiredScopes.delete(key);
      this.finishOperation(controller);
    }
  }

  /**
   * What one scope is doing, in the locale the current transition is preparing.
   *
   * `specs/06-runtime-and-angular.spec.md` section 9 requires a newly activated scope to stay
   * behind this boundary or keep its previous compatible content, so a caller can tell a scope
   * that is loading from one that is ready in a locale other than the target.
   */
  scopeReadiness(scopeValue: LocalizationScope): Signal<ScopeReadiness> {
    const scope = this.assertScope(scopeValue);
    const key = scopeIdentity(scope);
    return computed(
      () =>
        this.scopeReadinessValue()[key] ??
        Object.freeze({
          scope,
          targetLocale:
            this.targetLocaleValue() ??
            this.active?.publicSnapshot.primaryLocale ??
            this.defaultLocale,
          status: 'idle',
          supplyingLocales: Object.freeze([]),
        }),
    );
  }

  private evaluate(
    handle: AsReceived<MessageHandle, 'generatedAbi'>,
    inputs: unknown,
  ): LocalizedText | LocalizedParts {
    this.assertActive();
    const publicSnapshot = this.snapshotValue();
    const active = this.active;
    if (publicSnapshot === undefined || active === undefined) {
      throw new LocalizationError(
        operationalDiagnostic(
          'scope-unavailable',
          'Localization is not ready; initialize it before synchronous evaluation.',
        ),
      );
    }
    if (handle.generatedAbi !== GENERATED_ABI) {
      throw new LocalizationError(
        operationalDiagnostic(
          'invalid-configuration',
          'The generated message handle ABI is incompatible with this runtime.',
        ),
      );
    }
    // The stamp has been read and compared, so the declared type describes this handle rather
    // than being claimed over it.
    const checked = handle as MessageHandle;
    const activation = active.scopes.get(
      scopeIdentity({ providerId: handle.providerId, scopeId: handle.scopeId }),
    );
    if (activation === undefined) {
      throw new LocalizationError(
        operationalDiagnostic(
          'scope-unavailable',
          `Scope ${handle.providerId}/${handle.scopeId} is not ready for synchronous evaluation.`,
          { providerId: handle.providerId, scopeId: handle.scopeId },
        ),
      );
    }
    const candidate = findEvaluationCandidate(
      checked,
      publicSnapshot.primaryLocale,
      activation.catalogs,
    );
    // Strict refuses the source locale and nothing else, which is
    // `specs/03-locale-identity-and-resolution.spec.md` section 9. A message that came from a
    // locale the primary one inherits from is the primary locale's own answer, which is also what
    // the release completeness gate counts, so refusing it here would let
    // `atlas check --require-complete` report green on a project this throws in.
    if (
      this.options.setup.fallbackPolicy === 'strict' &&
      !activation.inheritedLocales.has(candidate.catalog.key.catalogLocale)
    ) {
      throw new LocalizationError(
        Object.freeze({
          code: 'message-unavailable',
          outcome: 'localized-representation-unavailable',
          message:
            'Strict localization rejects source-locale fallback for this message.',
          targetLocale: publicSnapshot.primaryLocale,
          supplyingLocale: candidate.catalog.key.catalogLocale,
          providerId: handle.providerId,
          scopeId: handle.scopeId,
        }),
      );
    }
    return evaluateCandidate(
      checked,
      candidate,
      inputs,
      publicSnapshot.formatting,
      this.formatterCache,
      this.extensions,
    );
  }

  private formattingSnapshot(): FormattingContext {
    this.assertActive();
    const snapshot = this.snapshotValue();
    if (snapshot === undefined) {
      throw new LocalizationError(
        operationalDiagnostic(
          'scope-unavailable',
          'Localization is not ready; initialize it before formatting.',
        ),
      );
    }
    return snapshot.formatting;
  }

  evaluateText(handle: MessageHandle, inputs?: unknown): LocalizedText {
    if (handle.resultKind !== 'plain') {
      throw new LocalizationError(
        operationalDiagnostic(
          'invalid-rich-message',
          'Structured messages must be evaluated with parts().',
        ),
      );
    }
    const result = this.evaluate(handle, inputs);
    if (result.kind !== 'text') throw new Error('Atlas text invariant failed.');
    return result;
  }

  evaluateParts(handle: MessageHandle, inputs?: unknown): LocalizedParts {
    if (handle.resultKind !== 'structured') {
      throw new LocalizationError(
        operationalDiagnostic(
          'invalid-rich-message',
          'Plain messages must be evaluated with text().',
        ),
      );
    }
    const result = this.evaluate(handle, inputs);
    if (result.kind !== 'parts')
      throw new Error('Atlas parts invariant failed.');
    return result;
  }

  createChild(options: ChildLocalizationOptions = {}): Localization {
    this.assertActive();
    const primaryLocale =
      options.initialLocale ??
      this.active?.publicSnapshot.primaryLocale ??
      this.options.initialLocale;
    return new RuntimeLocalization({
      ...this.options,
      ...options,
      ...(primaryLocale === undefined ? {} : { initialLocale: primaryLocale }),
      setup: this.options.setup,
      bootstrapScopes: options.bootstrapScopes ?? this.bootstrapScopes,
      commitHooks: [],
      transferredCatalogs: [],
    });
  }

  transferSnapshot(): TransferSnapshot | undefined {
    if (this.active === undefined) return undefined;
    const catalogs = new Map<string, CompiledCatalog>();
    for (const activation of this.active.scopes.values()) {
      for (const lease of activation.leases) {
        catalogs.set(lease.key, lease.catalog);
      }
    }
    return Object.freeze({
      profile: 'atlas-transfer-state/1',
      primaryLocale: this.active.publicSnapshot.primaryLocale,
      formatting: this.active.publicSnapshot.formatting,
      ...(this.active.publicSnapshot.route === undefined
        ? {}
        : { route: this.active.publicSnapshot.route }),
      catalogs: Object.freeze([...catalogs.values()]),
      participants: this.participantCoordinator.transferRecords(),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const reason = new LocalizationError(
      operationalDiagnostic(
        'disposed',
        'The localization context is disposed.',
      ),
    );
    this.lifetimeController.abort(reason);
    this.participantCoordinator.dispose();
    this.initializationController?.abort(reason);
    this.pending?.controller.abort(reason);
    for (const controller of this.operationControllers)
      controller.abort(reason);
    this.operationControllers.clear();
    for (const controller of this.progressiveControllers)
      controller.abort(reason);
    this.progressiveControllers.clear();
    if (this.active !== undefined)
      releaseActivations(this.active.scopes.values());
    for (const hook of [...(this.options.commitHooks ?? [])].reverse()) {
      try {
        hook.dispose?.();
      } catch (error: unknown) {
        // Disposal is best-effort so one consumer adapter cannot strand others.
        this.observability?.emit({
          code: RUNTIME_EVENT_CODES.integration,
          phase: 'integration',
          status: 'failed',
          reason: asDiagnostic(error).code,
          ...(this.active === undefined
            ? {}
            : {
                targetLocale: this.active.publicSnapshot.primaryLocale,
                snapshotId: this.active.publicSnapshot.id,
              }),
        });
      }
    }
    this.store.dispose();
    // Through the same door, so there is exactly one assignment to what is current.
    this.publish(undefined, []);
    this.targetLocaleValue.set(undefined);
    this.lifecycleValue.set('failed');
  }
}

class RuntimeLocalization implements Localization {
  private readonly noInputsSignalKey = Object.freeze({});
  private readonly textSignals = new WeakMap<
    object,
    WeakMap<object, Signal<string>>
  >();
  private readonly partsSignals = new WeakMap<
    object,
    WeakMap<object, Signal<LocalizedParts>>
  >();
  readonly state: LocalizationState;
  readonly lifecycle: Signal<LocalizationLifecycle>;
  readonly ready: Signal<boolean>;
  readonly snapshot: Signal<LocalizationSnapshot | undefined>;
  readonly targetLocale: Signal<string | undefined>;
  readonly recovery: Signal<LocalizedText | undefined>;
  readonly recoveryRetryLabel: Signal<LocalizedText | undefined>;
  readonly lastResult: Signal<LocaleChangeResult | undefined>;
  readonly participants: Signal<readonly LocalizationParticipantState[]>;
  readonly localeChoices: Signal<readonly LocaleSelectorChoice[]>;

  constructor(options: LocalizationRuntimeOptions) {
    const internal = new LocalizationInternal(this, options);
    internals.set(this, internal);
    this.state = internal.state;
    this.lifecycle = internal.state.lifecycle;
    this.ready = internal.state.ready;
    this.snapshot = internal.state.snapshot;
    this.targetLocale = internal.state.targetLocale;
    this.recovery = internal.state.recovery;
    this.recoveryRetryLabel = internal.state.recoveryRetryLabel;
    this.lastResult = internal.state.lastResult;
    this.participants = internal.state.participants;
    this.localeChoices = internal.state.localeChoices;
  }

  private internal(): LocalizationInternal {
    const value = internals.get(this);
    if (value === undefined)
      throw new Error('Atlas localization invariant failed.');
    return value;
  }

  initialize(): Promise<LocalizationSnapshot> {
    return this.internal().initialize();
  }

  retry(): Promise<LocalizationSnapshot> {
    return this.internal().retry();
  }

  changeLocale(
    locale: string,
    options?: LocaleChangeOptions,
  ): Promise<LocaleChangeResult> {
    return this.internal().changeLocale(locale, options);
  }

  cancelTransition(): void {
    this.internal().cancelTransition();
  }

  forgetRememberedLocale(): Promise<LocaleRemovalReport> {
    return this.internal().forgetRememberedLocale();
  }

  registerParticipant(
    participant: LocalizationParticipant,
    options?: LocalizationParticipantOptions,
  ): LocalizationParticipantRegistration {
    return this.internal().registerParticipant(participant, options);
  }

  renderedLocale(): string | undefined {
    return this.internal().renderedLocale();
  }

  preloadScope(scope: LocalizationScope, locale?: string): Promise<void> {
    return this.internal().preloadScope(scope, locale);
  }

  ensureScope(scope: LocalizationScope): Promise<void> {
    return this.internal().ensureScope(scope);
  }

  ɵrestateRoute(route: LocalizationRouteSnapshot): void {
    this.internal().restateRoute(route);
  }

  ɵclaimLocaleChange(
    claim: ((locale: string) => string | undefined) | undefined,
  ): void {
    this.internal().claimLocaleChange(claim);
  }

  ɵclaimRoutingCommit(steps: RoutingCommitSteps | undefined): void {
    this.internal().claimRoutingCommit(steps);
  }

  scopeReadiness(scope: LocalizationScope): Signal<ScopeReadiness> {
    return this.internal().scopeReadiness(scope);
  }

  evaluateText<Handle extends MessageHandle & { readonly resultKind: 'plain' }>(
    handle: Handle,
    ...[inputs]: MessageInputArguments<Handle>
  ): LocalizedText {
    return this.internal().evaluateText(handle, inputs);
  }

  text<Handle extends MessageHandle & { readonly resultKind: 'plain' }>(
    handle: Handle,
    ...[inputs]: MessageInputArguments<Handle>
  ): string {
    return this.internal().evaluateText(handle, inputs).value;
  }

  textSignal<Handle extends MessageHandle & { readonly resultKind: 'plain' }>(
    handle: Handle,
    inputs?:
      | MessageInputArguments<Handle>[0]
      | Signal<MessageInputArguments<Handle>[0]>,
  ): Signal<string> {
    const inputKey =
      (typeof inputs === 'object' && inputs !== null) ||
      typeof inputs === 'function'
        ? (inputs as object)
        : this.noInputsSignalKey;
    let byInput = this.textSignals.get(handle);
    if (byInput === undefined) {
      byInput = new WeakMap<object, Signal<string>>();
      this.textSignals.set(handle, byInput);
    }
    const existing = byInput.get(inputKey);
    if (existing !== undefined) return existing;
    const localized = computed(
      () =>
        this.internal().evaluateText(
          handle,
          typeof inputs === 'function'
            ? (inputs as Signal<MessageInputArguments<Handle>[0]>)()
            : inputs,
        ).value,
    );
    byInput.set(inputKey, localized);
    return localized;
  }

  parts<Handle extends MessageHandle & { readonly resultKind: 'structured' }>(
    handle: Handle,
    ...[inputs]: MessageInputArguments<Handle>
  ): LocalizedParts {
    return this.internal().evaluateParts(handle, inputs);
  }

  partsSignal<
    Handle extends MessageHandle & { readonly resultKind: 'structured' },
  >(
    handle: Handle,
    inputs?:
      | MessageInputArguments<Handle>[0]
      | Signal<MessageInputArguments<Handle>[0]>,
  ): Signal<LocalizedParts> {
    const inputKey =
      (typeof inputs === 'object' && inputs !== null) ||
      typeof inputs === 'function'
        ? (inputs as object)
        : this.noInputsSignalKey;
    let byInput = this.partsSignals.get(handle);
    if (byInput === undefined) {
      byInput = new WeakMap<object, Signal<LocalizedParts>>();
      this.partsSignals.set(handle, byInput);
    }
    const existing = byInput.get(inputKey);
    if (existing !== undefined) return existing;
    const localized = computed(() =>
      this.internal().evaluateParts(
        handle,
        typeof inputs === 'function'
          ? (inputs as Signal<MessageInputArguments<Handle>[0]>)()
          : inputs,
      ),
    );
    byInput.set(inputKey, localized);
    return localized;
  }

  formatNumber(
    value: DecimalValue,
    options?: Intl.NumberFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatNumber(value, options);
  }

  formatMoney(
    value: MoneyValue,
    options?: Omit<Intl.NumberFormatOptions, 'currency' | 'style'>,
  ): FormattingResult {
    return this.internal().formatter.formatMoney(value, options);
  }

  formatMeasurement(
    value: MeasurementValue,
    options?: Omit<Intl.NumberFormatOptions, 'style' | 'unit'>,
  ): FormattingResult {
    return this.internal().formatter.formatMeasurement(value, options);
  }

  formatPercent(
    value: PercentValue,
    options?: Omit<Intl.NumberFormatOptions, 'style'>,
  ): FormattingResult {
    return this.internal().formatter.formatPercent(value, options);
  }

  formatPercentagePoints(
    value: PercentagePointsValue,
    options?: Intl.NumberFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatPercentagePoints(value, options);
  }

  formatInstant(
    value: InstantValue,
    options: Intl.DateTimeFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatInstant(value, options);
  }

  formatPlainDate(
    value: PlainDateValue,
    options?: Intl.DateTimeFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatPlainDate(value, options);
  }

  formatPlainTime(
    value: PlainTimeValue,
    options?: Intl.DateTimeFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatPlainTime(value, options);
  }

  formatPlainDateTime(
    value: PlainDateTimeValue,
    options?: Intl.DateTimeFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatPlainDateTime(value, options);
  }

  formatZonedDateTime(
    value: ZonedDateTimeValue,
    options: Intl.DateTimeFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatZonedDateTime(value, options);
  }

  formatNumberRange(
    start: DecimalValue,
    end: DecimalValue,
    options?: Intl.NumberFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatNumberRange(start, end, options);
  }

  formatInstantRange(
    start: InstantValue,
    end: InstantValue,
    options: Intl.DateTimeFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatInstantRange(start, end, options);
  }

  formatDuration(
    value: DurationValue,
    options?: Readonly<Record<string, unknown>>,
  ): FormattingResult {
    return this.internal().formatter.formatDuration(value, options);
  }

  formatList(
    values: readonly string[],
    options?: Intl.ListFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatList(values, options);
  }

  formatRelativeTime(
    value: DecimalValue,
    unit: Intl.RelativeTimeFormatUnit,
    options?: Intl.RelativeTimeFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatRelativeTime(value, unit, options);
  }

  relativeTime(
    target: InstantValue,
    options?: Intl.RelativeTimeFormatOptions,
  ): RelativeTimeOutcome {
    return this.internal().formatter.relativeTime(target, options);
  }

  formatDisplayName(
    value: string,
    options: Intl.DisplayNamesOptions,
  ): FormattingResult {
    return this.internal().formatter.formatDisplayName(value, options);
  }

  formatPersonName(
    value: PersonNameValue,
    options?: PersonNameFormatOptions,
  ): FormattingResult {
    return this.internal().formatter.formatPersonName(value, options);
  }

  selectPlural(
    value: DecimalValue,
    options?: Intl.PluralRulesOptions,
  ): LocaleCapabilityResult<Intl.LDMLPluralRule> {
    return this.internal().formatter.selectPlural(value, options);
  }

  compare(
    left: string,
    right: string,
    options?: Intl.CollatorOptions,
  ): LocaleCapabilityResult<-1 | 0 | 1> {
    return this.internal().formatter.compare(left, right, options);
  }

  segment(
    input: string,
    options?: Intl.SegmenterOptions,
  ): LocaleCapabilityResult<readonly LocalizedSegment[]> {
    return this.internal().formatter.segment(input, options);
  }

  localeMetadata(): LocaleCapabilityResult<LocaleMetadata> {
    return this.internal().formatter.localeMetadata();
  }

  formatWithAdapter<Value>(
    adapter: RuntimeFormattingAdapterBinding<Value>,
    value: Value,
  ): FormattingResult {
    return this.internal().formatter.formatWithAdapter(adapter, value);
  }

  parseWithAdapter<Value>(
    adapter: RuntimeParsingAdapterBinding<Value>,
    text: string,
  ): LocalizedInputResult<Value> {
    return this.internal().formatter.parseWithAdapter<Value>(adapter, text);
  }

  createChildContext(options: ChildLocalizationOptions = {}): Localization {
    return this.internal().createChild(options);
  }

  dispose(): void {
    this.internal().dispose();
  }
}

/**
 * Builds a localization context outside Angular's injector.
 *
 * For a server handler, a script, or a test: anywhere there is work to localize and no application
 * to inject from. Inside an Angular application `provideLocalization` does this, and injecting
 * `Localization` is how it is reached.
 *
 * Takes the generated setup, optionally the locale to start in, the scopes to load at start-up, the
 * formatting defaults, the recovery messages, the initial route, an opaque request context, and a
 * sink to report to. With no scopes named it loads every scope the configuration declares.
 *
 * Returns a context that owns its own caches and participants, so one per request keeps concurrent
 * requests from sharing state. Dispose it when the work it was made for is over.
 */
export function createLocalizationContext(
  options: LocalizationContextOptions & LocalizationObservabilityOptions,
): Localization {
  const bootstrapScopes =
    options.bootstrapScopes ??
    Object.freeze(
      options.setup.configuration.scopes.map(({ providerId, scopeId }) =>
        Object.freeze({ providerId, scopeId }),
      ),
    );
  return new RuntimeLocalization({
    setup: options.setup,
    bootstrapScopes,
    ...(options.initialLocale === undefined
      ? {}
      : { initialLocale: options.initialLocale }),
    ...(options.requestContext === undefined
      ? {}
      : { requestContext: options.requestContext }),
    ...(options.recoveryMessage === undefined
      ? {}
      : { recoveryMessageIdentity: options.recoveryMessage.identity }),
    ...(options.recoveryRetryLabel === undefined
      ? {}
      : { recoveryRetryLabelIdentity: options.recoveryRetryLabel.identity }),
    ...(options.formattingContext === undefined
      ? {}
      : { formattingContext: options.formattingContext }),
    ...(options.initialRoute === undefined
      ? {}
      : { initialRoute: options.initialRoute }),
    ...(options.observability === undefined
      ? {}
      : { observability: options.observability }),
  });
}

export function createLocalizationRuntime(
  options: LocalizationRuntimeOptions,
): Localization {
  return new RuntimeLocalization(options);
}

export function localizationTransferSnapshot(
  localization: Localization,
): TransferSnapshot | undefined {
  return internals.get(localization)?.transferSnapshot();
}

export function emitLocalizationRuntimeEvent(
  localization: Localization,
  input: LocalizationEventInput,
): void {
  internals.get(localization)?.observe(input);
}
