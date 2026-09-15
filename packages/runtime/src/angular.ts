import {
  APP_BASE_HREF,
  DOCUMENT,
  PlatformLocation,
  isPlatformBrowser,
  isPlatformServer,
} from '@angular/common';
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  PLATFORM_ID,
  REQUEST,
  TransferState,
  inject,
  makeEnvironmentProviders,
  makeStateKey,
  provideAppInitializer,
  type EnvironmentProviders,
} from '@angular/core';

import {
  builtLocalePolicy,
  LocalizationError,
  openGraphAlternates,
  openGraphLocale,
  validateRouteProjection,
  withoutBasePath,
  type FormattingContext,
  type GeneratedConfiguration,
  type LocaleUrlPolicy,
  type LocalizationClock,
  type LocalizationRouteSnapshot,
  type LocalizationSetup,
  type LocalizationSnapshot,
  type MessageHandle,
  type RouteIndexingPolicy,
  type RouteSitemapPolicy,
  type RouteRuntimeProjection,
  type RouteSeoProjection,
  type RuntimeExtensionBinding,
} from '@neolorn/atlas/core';
import {
  Localization,
  createLocalizationRuntime,
  emitLocalizationRuntimeEvent,
  localizationTransferSnapshot,
  type LocalizationCommitHook,
  type LocalizationLocaleSource,
  type LocalizationRuntimeOptions,
} from './localization';
import {
  RUNTIME_EVENT_CODES,
  type LocalizationObservabilitySink,
} from './observability';
import {
  sanitizeParticipantTransferRecords,
  type ParticipantTransferRecord,
} from './participant-runtime';
import type { RelativeTimePolicy } from './relative-time-policy';
import { parseAcceptLanguage } from './locale-negotiation';
import type { LocalizationPersistenceStoreFactory } from './persistence';
import {
  RUNTIME_LIMITS,
  areTransferredAddresses,
  isTransferredPath,
  hasExactKeys,
  isDataRecord,
  snapshotInertJson,
} from './runtime-safety';

/**
 * The sub-path this application is deployed under, as Atlas reads it.
 *
 * One fact with one resolution, because three things now depend on it agreeing with itself: the
 * locale is read out of an address with the base taken off, the address bar is written with it put
 * back, and the canonical and `hreflang` URLs in the head are composed with it in the middle. Two
 * of those live in different packages, so this is exported rather than repeated: a second copy of
 * the precedence is a second answer the day either one is edited, and the failure it produces is a
 * head that advertises addresses the same build will not resolve.
 *
 * **The precedence is Angular's, not a choice made here.** The explicit token first, then the
 * document's own `<base href>`: `PathLocationStrategy` composes it that way (`@angular/common`
 * 22.1.3, `_location-chunk.mjs:70`) and `@angular/ssr` 22.1.7 reads the same two in the same order
 * when it extracts routes to prerender (`ssr.mjs:773-775`). Measured on both surfaces rather than
 * assumed symmetric: on a server the document's value comes back as the raw attribute, so an
 * absolute `<base href>` stays absolute, where a browser resolves it to a path first. Every reader
 * here hands the value to `withoutBasePath`, `withBasePath` or `projectRouteSeo`, and all three
 * reduce it through one normalizer that accepts either spelling.
 *
 * Resolved from the tokens rather than by injecting the `LocationStrategy`, which is not provided
 * when an application uses Atlas without the Router, and which injects `Localization` and would
 * close a cycle on the runtime being constructed. Requires an injection context.
 *
 * Angular's last fallback, the document origin, is deliberately not reproduced: it exists so that
 * `prepareExternalUrl` can join something, and as a base path it means the same as no base at all.
 * It still arrives here through `getBaseHrefFromDOM()` on some platforms, and the normalizer
 * reduces it to nothing, which is what it is.
 */
export function applicationBaseHref(): string {
  return (
    inject(APP_BASE_HREF, { optional: true }) ??
    inject(PlatformLocation, { optional: true })?.getBaseHrefFromDOM() ??
    ''
  );
}

/**
 * The locale URL policy this application uses, when it has one.
 *
 * A token rather than a value passed around because more than one thing reads it: the `url` locale
 * source, canonical URLs, reciprocal `hreflang` links, and the Router integration. `withRouting()`
 * is the only thing that supplies it, so there is exactly one copy to read.
 *
 * The configuration rides along because the URL layer needs both halves of the same question: the
 * policy says where a locale lives, and the configuration says whether this build has it. It is
 * added here rather than asked of the consumer a second time: `provideLocalization()` already
 * received it, and a second copy would be a second answer as soon as one of them was edited.
 */
export const LOCALE_URL_POLICY = new InjectionToken<{
  readonly policy: LocaleUrlPolicy;
  readonly projection: RouteRuntimeProjection;
  readonly configuration: GeneratedConfiguration;
}>('LOCALE_URL_POLICY');

/**
 * The twelve things a feature can configure, one name each.
 *
 * Present in the type rather than left open so that a feature is installed at most once and the
 * duplicate is refused by name. Not something an application writes: each `with` function states
 * its own.
 */
export type LocalizationFeatureKind =
  | 'document-locale'
  | 'formatting-context'
  | 'recovery-message'
  | 'locale-announcement'
  | 'overlay-locale'
  | 'observability'
  | 'localization-clock'
  | 'relative-time-policy'
  | 'persistence'
  | 'locale-sources'
  | 'routing'
  | 'extensions';

/**
 * What every `with` function returns, and what `provideLocalization` takes a list of.
 *
 * Opaque by design. An application passes these along and never reads inside one, so what a feature
 * carries is free to change without that being a change to the surface.
 */
export interface LocalizationFeature<
  Kind extends LocalizationFeatureKind = LocalizationFeatureKind,
> {
  /** Which feature this is. Internal wiring, named here only because the type has to say it. */
  readonly ɵkind: Kind;
}

/** Present only to switch document state off; its presence is the whole message. */
interface DocumentLocaleFeature extends LocalizationFeature<'document-locale'> {}

interface FormattingContextFeature extends LocalizationFeature<'formatting-context'> {
  readonly context: Omit<FormattingContext, 'locale'>;
}

interface RecoveryMessageFeature extends LocalizationFeature<'recovery-message'> {
  readonly identity: string;
  readonly retryLabelIdentity?: string;
}

interface LocaleAnnouncementFeature extends LocalizationFeature<'locale-announcement'> {
  readonly format: (snapshot: LocalizationSnapshot) => string | undefined;
}

interface LocalizationClockFeature extends LocalizationFeature<'localization-clock'> {
  readonly clock: LocalizationClock;
}

interface RelativeTimePolicyFeature extends LocalizationFeature<'relative-time-policy'> {
  readonly policy: RelativeTimePolicy;
}

interface PersistenceFeature extends LocalizationFeature<'persistence'> {
  readonly factories: readonly LocalizationPersistenceStoreFactory[];
}

interface LocaleSourcesFeature extends LocalizationFeature<'locale-sources'> {
  readonly sources: readonly LocalizationLocaleSource[];
}

/**
 * Everything about routing that Atlas cannot derive from the application's sources.
 *
 * The route table is not here: Atlas generated it, and the generated `provideLocalization()`
 * passes it. What an application owns is the URL policy, the localized path spellings, the
 * parameter codecs, the outcomes of addresses that no longer exist, and the name of its own
 * route-data field, which Atlas reads at build time rather than inventing.
 */
export interface RoutingOptions {
  /**
   * Where the locale sits in an address: a leading path segment, a host, or nowhere at all.
   *
   * The one routing decision that shows in every URL the application emits, so it belongs to the
   * deployment rather than to the generated table.
   */
  readonly policy: LocaleUrlPolicy;
  /**
   * The route projection, passed rather than restated.
   *
   * One field rather than `localizedPaths`, `parameters` and `historical` restated here, which are
   * the three fields `RouteRuntimeProjection` already carries. Restated, a consumer declares them
   * once in `defineRouteProjection()` for the server route table and hands the same three back
   * here for the runtime, with nothing checking that the two copies agree. The verification
   * consumer wrote that at nine call sites, two lines each, always the same two lines, and
   * renaming a route's path in one locale was then a data edit plus a wiring edit whose omission
   * said nothing.
   *
   * One object, referenced wherever it is needed. `localizedServerRoutes()` takes this same value.
   */
  readonly projection: RouteRuntimeProjection;
  /**
   * Read from this file's source text when Atlas compiles the owner, and inert at runtime: by the
   * time this object exists, every route already carries the class it was classified into.
   *
   * Editing it therefore changes generated output, so it takes effect on the next generate: the
   * one a consumer's build script already runs.
   */
  readonly indexing?: RouteIndexingPolicy;
  /**
   * What a route claims in a sitemap, read the same way and at the same moment as `indexing`.
   *
   * Read from this file's source text, inert at runtime, and in effect on the next generate. The
   * two are one declaration in two halves: a route that may not be indexed is not in a sitemap at
   * all, and one that may is there with whatever this says about it.
   */
  readonly sitemap?: RouteSitemapPolicy;
}

interface RoutingFeature extends LocalizationFeature<'routing'> {
  readonly options: RoutingOptions;
}

interface ExtensionsFeature extends LocalizationFeature<'extensions'> {
  readonly bindings: readonly RuntimeExtensionBinding[];
}

/**
 * How content rendered outside the application's own tree is told which language it is in.
 *
 * A dialog, a menu or a tooltip that a component library attaches to the document body is not
 * inside anything Atlas marks up, so its language and direction have to be set by whoever owns
 * those roots. Built through `withOverlayLocale`, per injector rather than per configuration.
 */
export interface LocalizationOverlayAdapter {
  /**
   * Sets the overlay roots to the committed locale.
   *
   * Called on each commit. It must be safe to call with the same snapshot twice, because a commit
   * that changes nothing still calls it.
   */
  apply(snapshot: LocalizationSnapshot): void;
  /**
   * Puts the overlay roots back to the previous snapshot when a locale change was abandoned.
   *
   * The argument is `undefined` when there was no previous one, which is a change that failed
   * before the first commit. Omit this and a failed change leaves the overlays as the attempt left
   * them.
   */
  rollback?(snapshot: LocalizationSnapshot | undefined): void;
  /** Releases whatever the adapter holds. Called once, when the injector that made it goes. */
  dispose?(): void;
}

/**
 * Overlay adapters are created per injector, not per configuration.
 *
 * An adapter holds the overlay roots of one application instance and is disposed with it. Under
 * server rendering there is one injector per request and one Angular application config for the
 * whole process, so an adapter object created where the feature is declared is shared by every
 * concurrent request, and the first request to finish disposes it for all of them, permanently.
 */
export type LocalizationOverlayAdapterFactory =
  () => LocalizationOverlayAdapter;

interface OverlayLocaleFeature extends LocalizationFeature<'overlay-locale'> {
  readonly create: LocalizationOverlayAdapterFactory;
}

interface ObservabilityFeature extends LocalizationFeature<'observability'> {
  readonly sink: LocalizationObservabilitySink;
}

/**
 * The social-preview facts only a deployment can supply.
 *
 * `image` is required rather than optional, and it decides whether Atlas emits an Open Graph block
 * at all. [ogp.me](https://ogp.me/) names four properties required on every page (`og:title`,
 * `og:type`, `og:image`, `og:url`) and `og:image` is the one Atlas can never derive: an absolute
 * product image URL is consumer content, and putting one in Atlas would be the neutrality violation
 * this project exists not to commit.
 *
 * So the rule is that **Atlas completes an Open Graph block the deployment started**, and emits none
 * otherwise. A block missing `og:image` claims a page is annotated for sharing when it is not, and
 * an `og:locale` with no other Open Graph tags describes markup that is not there. This is the same
 * division as the cache directives: Atlas emits what it fully determines, and the deployment
 * supplies what only it knows.
 */
export interface DocumentSocialProjection {
  /** Absolute URL of the preview image. Required: `og:image` is, and Atlas cannot invent one. */
  readonly image: string;
  /** Alternative text for the preview image. */
  readonly imageAlt?: string;
  /**
   * The Open Graph object type. Defaults to `website`, which ogp.me describes as how an unmarked
   * page is to be treated, so it is the one value that asserts nothing the deployment did not say.
   */
  readonly type?: string;
  /**
   * The card layout X should use. Defaults to `summary`.
   *
   * The only card field Atlas emits, because X's card processor "first checks for the
   * Twitter-specific property, and if not present, falls back to the supported Open Graph
   * property", so title, description and image are already answered by the block above, and
   * emitting `twitter:title` beside `og:title` would be two places to change one string.
   */
  readonly card?: 'summary' | 'summary_large_image';
  /** The site's name, as Open Graph's `og:site_name`. */
  readonly siteName?: string;
}

/**
 * What goes into the document head for the page currently shown, already localized.
 *
 * Assembled by the Router integration from the route's own messages and its resolution, and applied
 * whole: everything Atlas wrote before is removed and replaced, so the head never carries a mixture
 * of two pages.
 */
export interface DocumentLocalizationProjection {
  /** The document title. Bounded at 512 code points, and refused if it carries controls. */
  readonly title?: string;
  /** The meta description. Bounded at 2048 code points, under the same refusal. */
  readonly description?: string;
  /**
   * The canonical address, the reciprocal alternates, and the default-language link.
   *
   * Every URL in it is checked before it reaches the head, because these are addresses a reader and
   * a crawler are both sent to.
   */
  readonly seo?: RouteSeoProjection;
  /**
   * The committed locale, supplied by the router rather than by the application.
   *
   * Present so the head can carry `og:locale`. It is not something a consumer sets: the locale that
   * a page's metadata is marked up in is the locale Atlas just committed, and letting it be passed
   * separately would create a second answer that can disagree with the first.
   */
  readonly locale?: string;
  /** The social-preview facts only a deployment can supply. No block is written without it. */
  readonly social?: DocumentSocialProjection;
}

interface AtlasTransferSnapshot {
  readonly profile: 'atlas-transfer-state/1';
  readonly primaryLocale: string;
  readonly formatting: FormattingContext;
  readonly route?: LocalizationRouteSnapshot;
  readonly catalogs: readonly unknown[];
  readonly participants: readonly ParticipantTransferRecord[];
}

const transferStateKey = makeStateKey<AtlasTransferSnapshot>(
  '@neolorn/atlas:localization-state/1',
);

function freezeFeature<Feature extends LocalizationFeature>(
  feature: Feature,
): Feature {
  return Object.freeze(feature);
}

/** What recovery renders when the runtime could not reach a usable state. */
export interface RecoveryMessageOptions {
  /** What a visitor reads when the translations could not be loaded. */
  readonly message: MessageHandle & { readonly resultKind: 'plain' };
  /**
   * The retry control's wording.
   *
   * Optional, because a deployment may have nowhere for a retry to lead. Supplying it is what makes
   * the control appear, and supplying it as a handle rather than a string is what puts it in the
   * recovery payload: the wording then arrives in the locale the recovery region is already
   * marked as, instead of in whichever language the call site was typed in.
   */
  readonly retryLabel?: MessageHandle & { readonly resultKind: 'plain' };
}

/**
 * Gives the recovery region something to say when localization could not reach a usable state.
 *
 * Takes the message and, optionally, the wording of a retry control. Both must be plain messages
 * with no inputs, and a handle that declares any is refused when the feature is built rather than
 * when the failure happens, because a failure path that fails is no path at all.
 *
 * Without this feature the region renders nothing and a start-up failure is a hard failure.
 */
export function withRecoveryMessage(
  options: RecoveryMessageOptions,
): LocalizationFeature<'recovery-message'> {
  const plain = (handle: MessageHandle): void => {
    if (handle.inputNames.length > 0) {
      throw new LocalizationError({
        code: 'invalid-configuration',
        outcome: 'operational-failure',
        message: 'A recovery message must be plain and have no inputs.',
      });
    }
  };
  plain(options.message);
  if (options.retryLabel !== undefined) plain(options.retryLabel);
  return freezeFeature<RecoveryMessageFeature>({
    ɵkind: 'recovery-message',
    identity: options.message.identity,
    ...(options.retryLabel === undefined
      ? {}
      : { retryLabelIdentity: options.retryLabel.identity }),
  });
}

/**
 * Sets the formatting defaults every call inherits: the time zone, the calendar, the numbering
 * system, the hour cycle.
 *
 * The locale is not among them, and cannot be: it is whichever one is committed, and a second
 * answer here would be one that disagrees. A single call site can still override any of these.
 *
 * The zone is the one worth setting deliberately. Without it a server and the browser that
 * rehydrates its output read the same instant off two different clocks.
 */
export function withFormattingContext(
  context: Omit<FormattingContext, 'locale'>,
): LocalizationFeature<'formatting-context'> {
  return freezeFeature<FormattingContextFeature>({
    ɵkind: 'formatting-context',
    context: Object.freeze({ ...context }),
  });
}

/**
 * The reference instant relative-time phrasing is measured against.
 *
 * A port rather than a call to `Date.now()` because a reference instant that cannot be supplied
 * cannot be tested, and because a server render and the browser render that rehydrates it must be
 * able to agree on what "now" was. Defaults to the system clock.
 */
export function withLocalizationClock(
  clock: LocalizationClock,
): LocalizationFeature<'localization-clock'> {
  return freezeFeature<LocalizationClockFeature>({
    ɵkind: 'localization-clock',
    clock,
  });
}

/**
 * Where relative phrasing stops.
 *
 * Atlas owns the selection rule, largest unit the span reaches, because it is the same rule in
 * every application. The thresholds are the consumer's, because "3 days ago" is right for a message
 * and wrong for an invoice, and Atlas has no basis for choosing between them.
 */
export function withRelativeTimePolicy(
  policy: RelativeTimePolicy,
): LocalizationFeature<'relative-time-policy'> {
  return freezeFeature<RelativeTimePolicyFeature>({
    ɵkind: 'relative-time-policy',
    policy: Object.freeze({ ...policy }),
  });
}

/**
 * Where a locale choice is remembered, and in what authority order.
 *
 * Stores are read in the order given and the first believable answer wins, so an authenticated
 * profile placed ahead of a cookie outranks it. Writes go to every store, because a device that
 * later goes offline should still remember what the signed-in profile knows.
 *
 * Only the cookie store can be read during server rendering, so it is the only one that fixes the
 * language of the first response; the others correct it after hydration, which the visitor sees.
 */
export function withPersistence(
  ...stores: readonly LocalizationPersistenceStoreFactory[]
): LocalizationFeature<'persistence'> {
  if (stores.length === 0) {
    throw new LocalizationError({
      code: 'invalid-configuration',
      outcome: 'operational-failure',
      message: 'Locale persistence requires at least one store.',
    });
  }
  return freezeFeature<PersistenceFeature>({
    ɵkind: 'persistence',
    factories: Object.freeze([...stores]),
  });
}

/**
 * Which sources decide the locale of a first request, and in what order.
 *
 * Atlas implements every source; the consumer says which ones are live and which outranks which.
 * First answer wins and an omitted source is disabled, so `withLocaleSources('url', 'default')`
 * is an application that honours links and ignores everything else.
 *
 * **The default is `'url'`, `'stored'`, `'browser'`, `'default'`, in that order, and an application
 * that wants it should not call this function.** Writing the default out changes nothing and creates
 * a second place to maintain: Atlas can no longer improve the order for anyone who restated it, and
 * a reader cannot tell a deliberate choice from a copied line. Call this only to depart from that
 * order: to drop a source, or to rank them differently.
 *
 * The reasoning behind the order, since departing from it should be a decision rather than a
 * preference: the URL comes first because it is the only source that is a statement rather than a
 * preference, so a shared link must open in the language it names. Then what this visitor chose
 * before, then what their client asked for, then the configured default.
 *
 * `'stored'` is inert until a consumer installs somewhere to store to. It costs nothing in an
 * application with no `withPersistence`, which is why it is in the default at all.
 *
 * An explicit `changeLocale()` is not a source and never queues behind one: a deliberate action
 * is a decision already taken.
 *
 * A single decider is the point. Where each part of an application answers "which locale?" for
 * itself, two of them eventually disagree, and the resulting bug is invisible until a visitor sees
 * one region of the page in a language the rest of it is not using.
 */
export function withLocaleSources(
  ...sources: readonly LocalizationLocaleSource[]
): LocalizationFeature<'locale-sources'> {
  if (sources.length === 0) {
    throw new LocalizationError({
      code: 'invalid-configuration',
      outcome: 'operational-failure',
      message: 'Locale resolution requires at least one source.',
    });
  }
  if (new Set(sources).size !== sources.length) {
    throw new LocalizationError({
      code: 'invalid-configuration',
      outcome: 'operational-failure',
      message: 'Each locale source may be declared only once.',
    });
  }
  return freezeFeature<LocaleSourcesFeature>({
    ɵkind: 'locale-sources',
    sources: Object.freeze([...sources]),
  });
}

/**
 * The runtime bindings for this application's declared extensions.
 *
 * A binding is a function, so it cannot be generated into a data file and cannot live in
 * configuration: it is written by the application and passed here. Everything Atlas generates for
 * itself is already closed over by the generated `provideLocalization()`.
 */
export function withExtensions(
  bindings: readonly RuntimeExtensionBinding[],
): LocalizationFeature<'extensions'> {
  return freezeFeature<ExtensionsFeature>({
    ɵkind: 'extensions',
    bindings: Object.freeze([...bindings]),
  });
}

/**
 * The application's URL policy, and the route data Atlas could not derive.
 *
 * Atlas supplies the route table it generated; this supplies the half that is a decision. Both
 * meet in one projection, so the `url` locale source, canonical URLs, reciprocal `hreflang`
 * links, and locale redirects all read the same copy: there is no second copy to drift.
 *
 * `indexing` is the exception in this object: it is an input to code generation rather than to
 * the runtime. Atlas reads the field name and the value table out of this call's source text when
 * it compiles the owner, and classifies each route then.
 */
export function withRouting(
  options: RoutingOptions,
): LocalizationFeature<'routing'> {
  // A caller who is not type-checked reaches this the same way a type-checked one does, so the
  // policy is read as whatever was passed rather than as the field the options declare.
  const policy: unknown = options.policy;
  if (policy === undefined) {
    throw new LocalizationError({
      code: 'invalid-configuration',
      outcome: 'operational-failure',
      message: 'withRouting() requires a locale URL policy.',
    });
  }
  return freezeFeature<RoutingFeature>({
    ɵkind: 'routing',
    options: Object.freeze({ ...options }),
  });
}

/**
 * Stop Atlas maintaining the document's `lang` and `dir`.
 *
 * Maintaining them is the default, because a page whose text is Arabic and whose `dir` is `ltr` is
 * broken in a way no application intends. This exists for the one case that is not a mistake: a
 * widget rendered inside a host page that maintains its own document state.
 *
 * Named for the deviation rather than taking a flag, so there is no way to write a call that says
 * what would have happened anyway.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 10 requires the language and direction to
 * follow the committed snapshot without being asked, and allows exactly this withdrawal for an
 * application that does not own the document.
 */
export function withoutDocumentLocale(): LocalizationFeature<'document-locale'> {
  return freezeFeature<DocumentLocaleFeature>({
    ɵkind: 'document-locale',
  });
}

/**
 * Says what a screen reader hears when the language has finished changing.
 *
 * Takes a function from the committed snapshot to the sentence to announce, so the wording is the
 * application's and can be in the language just arrived at. Called once per commit, and what it
 * returns goes into a live region.
 *
 * Returning `undefined` replaces the wording with none, which is what an application announcing the
 * change through a region of its own needs: the change is then announced once rather than twice.
 * `specs/09-safe-content-and-ux.spec.md` section 11 requires that to be accepted rather than read
 * as a mistake, so nothing is thrown and nothing is reported. The region stays where it is, saying
 * nothing, and `withoutDocumentLocale()` is what removes it.
 *
 * Without this feature Atlas announces the locale's own name for itself, which is correct and says
 * nothing about what the reader is now looking at.
 */
export function withLocaleAnnouncement(
  format: (snapshot: LocalizationSnapshot) => string | undefined,
): LocalizationFeature<'locale-announcement'> {
  return freezeFeature<LocaleAnnouncementFeature>({
    ɵkind: 'locale-announcement',
    format,
  });
}

/**
 * Where overlay content takes its language and direction from.
 *
 * Takes a factory rather than an adapter. On server-rendered and prerendered routes the overlay
 * state has to be present before components paint, and the server and the client have to agree
 * on overlay-root direction, which is Atlas-owned, so an Atlas overlay adapter is live
 * during server rendering, where one adapter per process is one adapter shared by every
 * concurrent request. A factory gives each request its own.
 */
export function withOverlayLocale(
  create: LocalizationOverlayAdapterFactory,
): LocalizationFeature<'overlay-locale'> {
  return freezeFeature<OverlayLocaleFeature>({
    ɵkind: 'overlay-locale',
    create,
  });
}

/**
 * Turns on event reporting and says where the events go.
 *
 * Takes the sink to hand each event to. Without this feature no event is built at all, so an
 * application that reports nothing pays nothing for the reporting.
 */
export function withObservability(
  sink: LocalizationObservabilitySink,
): LocalizationFeature<'observability'> {
  return freezeFeature<ObservabilityFeature>({
    ɵkind: 'observability',
    sink,
  });
}

function oneFeature<Kind extends LocalizationFeatureKind>(
  features: readonly LocalizationFeature[],
  kind: Kind,
): Extract<LocalizationFeature, { readonly ɵkind: Kind }> | undefined {
  const matches = features.filter(({ ɵkind }) => ɵkind === kind);
  if (matches.length > 1) {
    throw new LocalizationError({
      code: 'invalid-configuration',
      outcome: 'operational-failure',
      message: `Localization feature ${kind} was installed more than once.`,
    });
  }
  return matches[0] as
    | Extract<LocalizationFeature, { readonly ɵkind: Kind }>
    | undefined;
}

class DocumentLocaleCommitHook implements LocalizationCommitHook {
  private readonly originalLanguage: string | null;
  private readonly originalDirection: string | null;

  constructor(private readonly document: Document) {
    this.originalLanguage = document.documentElement.getAttribute('lang');
    this.originalDirection = document.documentElement.getAttribute('dir');
  }

  apply(snapshot: LocalizationSnapshot): void {
    const root = this.document.documentElement;
    const previousLanguage = root.getAttribute('lang');
    const previousDirection = root.getAttribute('dir');
    try {
      root.setAttribute('lang', snapshot.primaryLocale);
      root.setAttribute('dir', snapshot.direction);
    } catch (error: unknown) {
      if (previousLanguage === null) root.removeAttribute('lang');
      else root.setAttribute('lang', previousLanguage);
      if (previousDirection === null) root.removeAttribute('dir');
      else root.setAttribute('dir', previousDirection);
      throw error;
    }
  }

  rollback(snapshot: LocalizationSnapshot | undefined): void {
    const root = this.document.documentElement;
    const language = snapshot?.primaryLocale ?? this.originalLanguage;
    const direction = snapshot?.direction ?? this.originalDirection;
    if (language === null) root.removeAttribute('lang');
    else root.setAttribute('lang', language);
    if (direction === null) root.removeAttribute('dir');
    else root.setAttribute('dir', direction);
  }

  dispose(): void {
    const root = this.document.documentElement;
    if (this.originalLanguage === null) root.removeAttribute('lang');
    else root.setAttribute('lang', this.originalLanguage);
    if (this.originalDirection === null) root.removeAttribute('dir');
    else root.setAttribute('dir', this.originalDirection);
  }
}

/**
 * What writes the head: the title, the description, the alternates and the social block.
 *
 * Provided by `provideLocalization` and driven by the Router integration. An application injects it
 * only to read what is currently applied; writing to it directly means writing a head the next
 * navigation overwrites.
 */
@Injectable()
export class DocumentLocalization {
  private readonly document = inject(DOCUMENT);
  private readonly originalTitle = this.document.title;
  private activeProjection: DocumentLocalizationProjection | undefined;

  /**
   * Replaces everything Atlas has written in the head with this projection.
   *
   * Throws when a title or description is out of bounds or carries control characters, and when any
   * address in it is not one a reader can safely be sent to. Refusing is deliberate: a head is
   * where an edited string becomes a link somebody clicks.
   */
  apply(projection: DocumentLocalizationProjection): void {
    if (
      projection.title !== undefined &&
      ([...projection.title].length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(projection.title))
    ) {
      throw new LocalizationError({
        code: 'effect-failed',
        outcome: 'operational-failure',
        message: 'The localized document title is invalid or outside bounds.',
      });
    }
    if (
      projection.description !== undefined &&
      ([...projection.description].length > 2048 ||
        /[\u0000-\u001f\u007f]/u.test(projection.description))
    ) {
      throw new LocalizationError({
        code: 'effect-failed',
        outcome: 'operational-failure',
        message:
          'The localized document description is invalid or outside bounds.',
      });
    }
    const seo = projection.seo;
    // `og:image` joins the same list rather than getting a check of its own. It is consumer-supplied
    // and lands in the document exactly as the canonical and the alternates do, so a second
    // validation path would be a second answer to one question, and the weaker of the two would be
    // the one an attacker picks.
    for (const url of [
      seo?.canonical,
      seo?.xDefault,
      projection.social?.image,
      ...(seo?.alternates.map(({ url }) => url) ?? []),
    ]) {
      if (url === undefined) continue;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (cause) {
        throw new LocalizationError(
          {
            code: 'effect-failed',
            outcome: 'operational-failure',
            message: 'Localized document metadata contains an invalid URL.',
            reason: 'malformed-input',
          },
          { cause },
        );
      }
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username.length > 0 ||
        parsed.password.length > 0
      ) {
        throw new LocalizationError({
          code: 'effect-failed',
          outcome: 'operational-failure',
          message: 'Localized document metadata contains an unsafe URL.',
        });
      }
    }
    const previousTitle = this.document.title;
    const previousNodes = [
      ...this.document.head.querySelectorAll<HTMLElement>(
        '[data-atlas-document]',
      ),
    ];
    const replacements: Element[] = [];
    const meta = (name: string, content: string): void => {
      const node = this.document.createElement('meta');
      node.setAttribute('name', name);
      node.setAttribute('content', content);
      node.setAttribute('data-atlas-document', 'true');
      replacements.push(node);
    };
    const link = (rel: string, href: string, hreflang?: string): void => {
      const node = this.document.createElement('link');
      node.setAttribute('rel', rel);
      node.setAttribute('href', href);
      if (hreflang !== undefined) node.setAttribute('hreflang', hreflang);
      node.setAttribute('data-atlas-document', 'true');
      replacements.push(node);
    };
    /**
     * Open Graph is addressed by `property`, not by `name`, and the distinction is load-bearing.
     *
     * ogp.me writes every example with `property`; X's card tags are plain metadata and use `name`.
     * Swapping them does not fail, warn, or look wrong: the tag is simply ignored by the crawler
     * it was written for, which is why both spellings exist here as separate helpers rather than one
     * helper with a flag.
     */
    const property = (name: string, content: string): void => {
      const node = this.document.createElement('meta');
      node.setAttribute('property', name);
      node.setAttribute('content', content);
      node.setAttribute('data-atlas-document', 'true');
      replacements.push(node);
    };
    try {
      if (projection.description !== undefined) {
        meta('description', projection.description);
      }
      if (seo?.robots !== undefined) meta('robots', seo.robots);
      if (seo?.canonical !== undefined) link('canonical', seo.canonical);
      for (const alternate of seo?.alternates ?? []) {
        link('alternate', alternate.url, alternate.hreflang);
      }
      if (seo?.xDefault !== undefined) {
        link('alternate', seo.xDefault, 'x-default');
      }
      const social = projection.social;
      if (social !== undefined) {
        // Order follows ogp.me's own listing of the four required properties, so a reader comparing
        // the emitted head against the specification reads them in the same sequence.
        if (projection.title !== undefined)
          property('og:title', projection.title);
        property('og:type', social.type ?? 'website');
        property('og:image', social.image);
        if (seo?.canonical !== undefined) property('og:url', seo.canonical);
        if (projection.description !== undefined) {
          property('og:description', projection.description);
        }
        if (social.imageAlt !== undefined) {
          property('og:image:alt', social.imageAlt);
        }
        if (social.siteName !== undefined) {
          property('og:site_name', social.siteName);
        }
        // The part no consumer can get right by hand, and the reason this block is Atlas's job.
        const marked =
          projection.locale === undefined
            ? undefined
            : openGraphLocale(projection.locale);
        if (marked !== undefined) property('og:locale', marked);
        for (const spelled of openGraphAlternates(
          projection.locale,
          seo?.alternates ?? [],
        )) {
          property('og:locale:alternate', spelled);
        }
        // `name`, not `property`. See the helpers above.
        meta('twitter:card', social.card ?? 'summary');
      }
      if (projection.title !== undefined)
        this.document.title = projection.title;
      for (const node of previousNodes) node.parentNode?.removeChild(node);
      for (const node of replacements) this.document.head.appendChild(node);
      this.activeProjection = Object.freeze({ ...projection });
    } catch (error: unknown) {
      this.document.title = previousTitle;
      for (const node of replacements) node.parentNode?.removeChild(node);
      for (const node of previousNodes) this.document.head.appendChild(node);
      throw error;
    }
  }

  /** Puts the title back to what the document loaded with and removes every tag Atlas added. */
  dispose(): void {
    this.document.title = this.originalTitle;
    for (const node of this.document.head.querySelectorAll(
      '[data-atlas-document]',
    )) {
      node.parentNode?.removeChild(node);
    }
    this.activeProjection = undefined;
  }

  /** What is applied right now, or `undefined` when nothing is. Reading it changes nothing. */
  current(): DocumentLocalizationProjection | undefined {
    return this.activeProjection;
  }
}

/**
 * What a locale change says when the application has not said how to say it.
 *
 * The locale's own name, in that locale, which is what a person switching into it reads, and
 * what every application writing this by hand wrote.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 11 requires the announcement itself, so an
 * application supplying a format replaces the wording and nothing else.
 */
function defaultLocaleAnnouncement(snapshot: LocalizationSnapshot): string {
  try {
    return (
      new Intl.DisplayNames(snapshot.primaryLocale, { type: 'language' }).of(
        snapshot.primaryLocale,
      ) ?? snapshot.primaryLocale
    );
  } catch {
    return snapshot.primaryLocale;
  }
}

/**
 * One position in the commit sequence, held for a step the routing integration supplies.
 *
 * The step is filled in when `provideLocalizedRouter()` claims it and is absent in an application
 * that has no routing, which is why this is a hook with a slot rather than a hook per service. What
 * the slot buys is the ordering: the two things a routed commit does after publication, moving
 * the address bar and projecting the head. As Angular effects their turn comes when their service
 * happened to be constructed, which puts two of the five things a locale commit does outside the
 * list that orders the other three, in an order nothing states and no test can read.
 *
 * `committed` rather than `apply`, and that is forced. Both steps spell something in the locale
 * that has just landed, and both read that locale back off the published snapshot: the address bar
 * through `prepareExternalUrl`, the head through the route re-resolved for it. Run inside the
 * transaction, before publication, each would spell the locale being left.
 */
class RoutingCommitHook implements LocalizationCommitHook {
  step: ((locale: string) => void) | undefined;

  apply(): void {
    // Nothing. This hook's whole content is its position, and its position is after publication.
  }

  committed(snapshot: LocalizationSnapshot): void {
    // The locale comes from the snapshot being published rather than from a signal read, so a step
    // cannot act on a locale other than the one it was called for.
    this.step?.(snapshot.primaryLocale);
  }
}

class LocaleAnnouncementCommitHook implements LocalizationCommitHook {
  private previousLocale: string | undefined;
  private pending: string | undefined;
  private sequence = 0;
  private readonly region: HTMLElement | undefined;

  constructor(
    private readonly document: Document,
    enabled: boolean,
    private readonly format: (
      snapshot: LocalizationSnapshot,
    ) => string | undefined,
  ) {
    // Built now rather than at the first announcement. A live region has to be in the accessibility
    // tree before its text changes, because assistive technology reports a change to a region it is
    // already observing; one created and filled in the same task is frequently read as ordinary new
    // content, or not at all.
    this.region = enabled ? this.createRegion() : undefined;
  }

  private createRegion(): HTMLElement {
    const region = this.document.createElement('div');
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    region.setAttribute('data-atlas-announcer', 'true');
    // Set through the CSSOM rather than a style attribute or stylesheet, so a strict
    // `style-src` policy that forbids both still renders it.
    for (const [property, value] of [
      ['position', 'fixed'],
      ['inline-size', '1px'],
      ['block-size', '1px'],
      ['overflow', 'hidden'],
      ['clip-path', 'inset(50%)'],
      ['white-space', 'nowrap'],
    ] as const) {
      region.style.setProperty(property, value);
    }
    this.document.body.appendChild(region);
    return region;
  }

  private publish(message: string): void {
    if (this.region !== undefined) this.region.textContent = message;
  }

  apply(snapshot: LocalizationSnapshot): void {
    const previous = this.previousLocale;
    if (previous === undefined || previous === snapshot.primaryLocale) {
      this.previousLocale = snapshot.primaryLocale;
      return;
    }
    const wording = this.format(snapshot);
    if (wording === undefined) {
      // A replacement that supplies no wording, which is how an application announcing the change
      // through its own region says so. The sequence still moves, so an announcement queued for a
      // locale this commit has already left is dropped rather than read out after it.
      this.previousLocale = snapshot.primaryLocale;
      this.sequence += 1;
      this.pending = undefined;
      return;
    }
    const message = wording.normalize('NFC');
    if ([...message].length > 512 || /[\u0000-\u001f\u007f]/u.test(message)) {
      throw new LocalizationError({
        code: 'effect-failed',
        outcome: 'operational-failure',
        message: 'The locale announcement is invalid or outside bounds.',
      });
    }
    this.previousLocale = snapshot.primaryLocale;
    this.sequence += 1;
    this.pending = message;
  }

  /**
   * Announced after the commit, not with it.
   *
   * The message describes a locale the page has already moved to, so publishing it from `apply`
   * puts it in front of a screen reader while the controls it is about to describe still show the
   * previous locale. Waiting a frame is also what keeps it truthful when a commit is abandoned:
   * nothing was said yet, so there is nothing to retract.
   */
  committed(): void {
    const message = this.pending;
    this.pending = undefined;
    if (message === undefined) return;
    const sequence = this.sequence;
    const view = this.document.defaultView;
    const publish = () => {
      if (sequence === this.sequence) this.publish(message);
    };
    queueMicrotask(() => {
      if (view === null || typeof view.requestAnimationFrame !== 'function') {
        publish();
        return;
      }
      view.requestAnimationFrame(publish);
    });
  }

  rollback(snapshot: LocalizationSnapshot | undefined): void {
    this.sequence += 1;
    this.pending = undefined;
    this.previousLocale = snapshot?.primaryLocale;
    this.publish('');
  }

  dispose(): void {
    this.sequence += 1;
    this.pending = undefined;
    this.publish('');
    this.region?.remove();
  }
}

/**
 * When a captured interaction is put back.
 *
 * The runtime restores focus, selection and scroll on the frame after a commit, which is right
 * until something scrolls afterwards. A navigation that changes locale reaches `RouterScroller`,
 * and an application that asked the Router to restore scroll position gets that scroll at
 * `NavigationEnd`, after the commit and therefore after the restore, which it silently
 * overwrites. Measured in Firefox and WebKit, a page at `{block: 360, inline: 240}` came back at
 * the origin.
 *
 * The Router integration claims this and flushes it once the navigation has ended, so the restore
 * lands last. Nothing claims it in an application without localized routing, and the restore
 * happens on the frame after the commit exactly as before.
 *
 * A claim is not a promise that a navigation is coming. Under the address-translating strategy a
 * locale switch changes neither the internal address nor the route, so nothing reaches
 * `NavigationEnd` and a parked restore sits there until the next navigation and lands on the wrong
 * page. Whoever claims this owns releasing it on a commit no navigation follows, and the Router
 * integration does.
 *
 * There is no switch. Whether the reader keeps their place when the language changes is not a
 * decision an application makes differently from any other; a visitor forty paragraphs into an
 * article wants that paragraph in the new language, not the top of the page.
 *
 * What is restored, and the six bounds on the window that holds it, are
 * `specs/07-routing-rendering-and-seo.spec.md` section 8. The quantity is the logical distance
 * from the inline start, re-signed for the direction the document ends up in, and the scroll
 * range is read at neither end.
 */
@Injectable()
export class LocalizationInteractionRestore {
  private pending: (() => void) | undefined;
  private claimed = false;

  /** Called by whoever knows when the page has finished moving. */
  ɵclaim(): void {
    this.claimed = true;
  }

  /** Internal wiring: runs a restore now, or parks it when a navigation has claimed the window. */
  ɵschedule(restore: () => void, view: Window | null): void {
    if (this.claimed) {
      this.pending = restore;
      return;
    }
    this.run(restore, view);
  }

  /** Internal wiring: runs whatever was parked, once the page has finished moving. */
  ɵflush(view: Window | null): void {
    const restore = this.pending;
    this.pending = undefined;
    if (restore !== undefined) this.run(restore, view);
  }

  /** Internal wiring: drops a parked restore, for a commit no navigation follows. */
  ɵdiscard(): void {
    this.pending = undefined;
  }

  private run(restore: () => void, view: Window | null): void {
    queueMicrotask(() => {
      if (view === null || typeof view.requestAnimationFrame !== 'function') {
        restore();
        return;
      }
      view.requestAnimationFrame(() => restore());
    });
  }
}

/**
 * How many consecutive frames with nothing to correct mean the commit has settled and the window can
 * shut.
 *
 * This is what normally ends the hold; the frame budget below is a backstop. Two rather than one
 * because the reveal is not visible on the frame immediately after the restore: measured
 * twenty-five times out of twenty-five, the frame that follows the restore still shows the restored
 * position and the one after it shows the engine's. A window that shut on a single clean frame would
 * shut before the thing it exists for had happened.
 */
const scrollSettledFrames = 2;

/**
 * The most animation frames the restored position is held for, whatever else happens.
 *
 * **Sized from measurement, not chosen.** WebKit reveals an already-focused element when the
 * document's writing direction changes, some milliseconds after the restore has been applied, with
 * no scroll call from anybody in between. Measured twenty-five times out of twenty-five in a
 * reduction with no framework in it: the departure is visible on the *second* animation frame after
 * the restore, never later, and it is a single jump rather than an animation. Two distinct
 * positions over forty frames, the second held for the remaining thirty-nine. The browser gate's own
 * records agree from the other side: eleven occurrences, the movement landing 5 to 8ms after the
 * direction flip, inside the same frame interval every time.
 *
 * So the reveal is complete within two frames. Six is the backstop, sized to hold the whole measured
 * sequence (clean, moved, corrected, clean, clean) with a frame to spare, and it is reached only
 * when the page never settles. Counted in frames rather than milliseconds because the movement is
 * scheduled by the engine's rendering update, which is what a frame is; under load the gate's frames
 * come about 35ms apart and a wall-clock bound would mean something different there than on an idle
 * machine.
 *
 * Longer would be cheap against the engine and expensive against the application: while this window
 * is open, a programmatic scroll by the application is undone, because from inside this class it is
 * indistinguishable from the engine's own movement. That is the reason the window closes on settling
 * rather than running to its budget.
 */
const scrollHoldFrames = 6;

/**
 * And how long that window may last, whatever the frames are doing.
 *
 * The frame budget sizes the window; this stops it outliving the thing it guards. A frame budget is a
 * quantity of rendering, not of time: on a page producing frames every 35ms, which the browser
 * gate does under load, six of them is 210ms, and on a page that has stopped producing them it is
 * forever.
 * A hold that survives into the next piece of work will undo that work's own scrolling, because a
 * deliberate `scrollTo` by the application is indistinguishable, from inside this class, from the
 * engine's reveal. That is not hypothetical: it happened on the first run of this code, and the
 * caller trace named this tick as what moved the page.
 *
 * 150ms is over sixteen times the slowest reveal measured (9ms after the restore across
 * twenty-five reductions, 5 to 8ms across eleven gate occurrences) and it still allows four ticks
 * at the gate's loaded cadence, which is two more than settling needs. It is a ceiling rather than
 * the size of the window, and in practice the window has closed on settling long before it.
 */
const scrollHoldCeilingMs = 150;

/**
 * What counts as the visitor taking over.
 *
 * The window closes on the first of these, unconditionally. Chromium's own scroll restoration works
 * the same way, it re-applies across layout changes and stops the moment the visitor has scrolled,
 * and the reason is not politeness: a restore that keeps winning against a person is worse than
 * one that gives up early.
 */
const visitorScrollIntents = [
  'wheel',
  'touchstart',
  'pointerdown',
  'keydown',
] as const;

class InteractionPreservationCommitHook implements LocalizationCommitHook {
  private pendingRestore: (() => void) | undefined;
  private sequence = 0;

  constructor(
    private readonly document: Document,
    private readonly enabled: boolean,
    private readonly coordinator: LocalizationInteractionRestore,
  ) {}

  apply(snapshot: LocalizationSnapshot): void {
    const view = this.document.defaultView;
    if (!this.enabled || view === null) return;
    const active = this.document.activeElement;
    const focusable =
      active instanceof view.HTMLElement && typeof active.focus === 'function'
        ? active
        : undefined;
    const editable =
      active instanceof view.HTMLInputElement ||
      active instanceof view.HTMLTextAreaElement
        ? active
        : undefined;
    // The value comes along, because these offsets are only meaningful against it. See the guard
    // in the restore below.
    const selection =
      editable === undefined
        ? undefined
        : {
            start: editable.selectionStart,
            end: editable.selectionEnd,
            direction: editable.selectionDirection,
            value: editable.value,
          };
    // How far the visitor has travelled from the inline-start: the left edge in LTR, the right
    // edge in RTL. One expression for both, because that is what makes the quantity logical: in an
    // RTL document `scrollX` is `0` at the inline-start and runs to `-maximum` at the inline-end, so
    // its magnitude is the distance travelled in either direction.
    //
    // **Not `oldMaximum - Math.abs(scrollX)` in RTL, which is the physical distance from the
    // document's left edge.** Measured on all three engines with a strip of numbered cells: from
    // 240 of a 1980 range in LTR, the visitor is at cell 2; restoring the distance from the
    // inline-start returns them to cell 2, and restoring the distance from the left edge puts them
    // at cell 14. The physical reading moves the visitor to content they were never looking at, on
    // every locale commit and every engine.
    //
    // The document's scroll range is deliberately not read here, and not read in the restore either.
    // The old pair of expressions needed it twice and both readings happened while a direction change
    // was relaying the document out, which is the worst moment to ask a document how wide it is.
    // `scrollTo` clamps to the scrollable range on its own, so nothing is gained by clamping first.
    const logicalInline = Math.abs(view.scrollX);
    const block = view.scrollY;
    // Whether this commit turns the document around. Read here, where the document still carries the
    // direction it is leaving, and used for nothing but a comparison: no offset is derived from it
    // and the scroll range is still never asked for.
    const turnsAround =
      (this.document.documentElement.getAttribute('dir') === 'rtl'
        ? 'rtl'
        : 'ltr') !== snapshot.direction;
    const sequence = (this.sequence += 1);
    this.pendingRestore = () => {
      if (sequence !== this.sequence) return;
      // Restore focus only where the commit is what lost it.
      //
      // `specs/09-safe-content-and-ux.spec.md` section 12 asks for focus on the control that
      // started the switch, and only where nothing else has taken it since.
      //
      // This restore is scheduled during a commit and runs a frame or more later, by which time a
      // visitor can have moved on: pressed the next control, tabbed away, clicked into a field.
      // Putting focus back then is not restoring anything; it is taking focus off whatever the
      // visitor is actually using, and doing it invisibly, one frame after they acted.
      //
      // Measured: two keyboard switches in a row. The second control took focus, and the first
      // commit's restore landed 5ms afterwards and pulled focus back to the control the visitor had
      // already left. Two runs in five, on Chromium 149.
      //
      // So the test is whether focus is anywhere in particular now. The body, the documentElement,
      // or nothing at all means the commit dropped it and there is something to restore. Any real
      // element means somebody chose it, and that choice outranks a snapshot taken before the
      // commit, including the case where a later commit has not yet superseded this one, which is
      // what the sequence check above cannot see.
      const holder = this.document.activeElement;
      const focusWasLost =
        holder === null ||
        holder === this.document.body ||
        holder === this.document.documentElement ||
        holder === focusable;
      if (
        focusable !== undefined &&
        focusWasLost &&
        this.document.contains(focusable)
      ) {
        focusable.focus({ preventScroll: true });
        // Only when the text is the one these offsets were measured against.
        //
        // An offset is a position in a particular string. Where the value survives a locale commit
        // unchanged (an ordinary textarea, a plain input) putting the same numbers back is
        // exactly right, and it is what this coordinator is for. Where the value is rewritten, they
        // are numbers into a string that no longer exists, and only the component that rewrote it
        // knows how its characters moved.
        //
        // Restoring them anyway is what made the localized number input flicker: this wrote the
        // captured offsets, the input's own directive wrote remapped ones, and which landed last
        // decided the answer. Two owners, one selection, different arithmetic, and a race deciding
        // between them: measured as a wrong selection for about one frame, corrected at 16ms.
        // Skipping here leaves one owner and no window, rather than a wait that would have
        // certified the disagreement.
        if (
          editable !== undefined &&
          selection !== undefined &&
          selection.start !== null &&
          selection.end !== null &&
          editable.value === selection.value
        ) {
          editable.setSelectionRange(
            selection.start,
            selection.end,
            selection.direction ?? undefined,
          );
        }
      }
      // The same distance from the inline-start, signed for the direction the document is in now.
      // The browser clamps a scroll that overshoots the range, so a document that has not finished
      // growing costs the visitor accuracy rather than correctness, and asking it for a width
      // mid-relayout costs both.
      const inline =
        snapshot.direction === 'rtl' ? -logicalInline : logicalInline;
      try {
        view.scrollTo(inline, block);
      } catch {
        // Nonvisual test DOMs may expose scrollTo without implementing it.
      }
      // Only where the movement can arise. Both conditions come from the bisect rather than from
      // caution: with nothing focused the position holds on every engine, and with no direction
      // change it holds on every engine. A window opened anywhere else would guard against nothing
      // and would still undo whatever the application scrolled while it was open.
      if (turnsAround && focusable !== undefined) {
        this.holdScroll(view, inline, block, sequence);
      }
    };
  }

  /**
   * Keep the visitor where the restore put them, for a bounded window, against movement nobody
   * asked for.
   *
   * Writing the position once and stopping is what every router library in the field does, and it is
   * not what the browsers do. Chromium calls `RestoreScrollPositionAndViewState` again after the
   * load completes, "Retry restoring scroll offset since finishing loading disables content size
   * clamping", and again from `FrameRectsChanged`, which is to say whenever the geometry the
   * number was derived from moves. Fragment anchors are re-invoked on every layout until they stick.
   * The shape is: re-apply while the ground is still moving, stop when the visitor takes over.
   *
   * Atlas needs it for a sharper reason than late layout. On a direction change WebKit reveals an
   * already-focused element, overriding the position a moment after it is set, with no call from any
   * script and no way to prevent it: `focus({ preventScroll: true })` is honoured and is not what
   * moves the page. Reproduced with no Atlas and no framework in the document. So the position is
   * held rather than merely written.
   *
   * Three things bound it, and they are what keep this from being a fight:
   *
   *   - It is armed at all only on a commit that turns the document around while something has
   *     focus, which is the whole of what the bisect says produces the movement.
   *   - It closes as soon as the commit has settled: `scrollSettledFrames` consecutive frames with
   *     nothing to correct. This is what ends it in practice, and it is what keeps the window from
   *     still being open when the application does some scrolling of its own.
   *   - It runs for at most `scrollHoldFrames` frames, for a page that never settles.
   *   - It stops after `scrollHoldCeilingMs` regardless, so a page whose frames are slow or paused
   *     cannot carry the window into work that has nothing to do with this commit.
   *   - It closes on the first sign of the visitor scrolling.
   *   - It closes if a later commit supersedes this one, on the same sequence check as the restore.
   *
   * The scroll range is not read, here or anywhere in this restore. `scrollTo` clamps on its own, so
   * a document that is still growing simply lands closer to the mark on a later frame than it did on
   * an earlier one, which is the browsers' reason for retrying, arriving for free.
   */
  private holdScroll(
    view: Window,
    inline: number,
    block: number,
    sequence: number,
  ): void {
    if (
      typeof view.requestAnimationFrame !== 'function' ||
      typeof view.addEventListener !== 'function'
    ) {
      // Nonvisual test DOMs. The restore itself has already run; there is nothing to hold it
      // against, because nothing in such a DOM moves on its own.
      return;
    }

    let open = true;
    let frames = 0;
    let clean = 0;
    const startedAt = Date.now();
    // Passive, so this can never delay a scroll; capturing, so it is seen even where something in
    // the application stops the event before it bubbles.
    const listener = { capture: true, passive: true } as const;
    const close = () => {
      if (!open) return;
      open = false;
      for (const intent of visitorScrollIntents) {
        view.removeEventListener(intent, close, listener);
      }
    };
    for (const intent of visitorScrollIntents) {
      view.addEventListener(intent, close, listener);
    }

    const tick = () => {
      if (
        !open ||
        sequence !== this.sequence ||
        Date.now() - startedAt > scrollHoldCeilingMs
      ) {
        close();
        return;
      }
      // A pixel of tolerance: `scrollX` is fractional on a scaled display, and a restore that lands
      // half a pixel away is where the visitor was.
      if (
        Math.abs(view.scrollX - inline) > 1 ||
        Math.abs(view.scrollY - block) > 1
      ) {
        clean = 0;
        try {
          view.scrollTo(inline, block);
        } catch {
          // As above.
        }
      } else {
        clean += 1;
      }
      frames += 1;
      if (clean >= scrollSettledFrames || frames >= scrollHoldFrames) {
        close();
        return;
      }
      view.requestAnimationFrame(tick);
    };
    view.requestAnimationFrame(tick);
  }

  committed(): void {
    const restore = this.pendingRestore;
    this.pendingRestore = undefined;
    if (restore === undefined) return;
    this.coordinator.ɵschedule(restore, this.document.defaultView);
  }

  rollback(): void {
    this.sequence += 1;
    this.pendingRestore = undefined;
  }

  dispose(): void {
    this.sequence += 1;
    this.pendingRestore = undefined;
  }
}

class OverlayLocaleCommitHook implements LocalizationCommitHook {
  constructor(private readonly adapter: LocalizationOverlayAdapter) {}

  apply(snapshot: LocalizationSnapshot): void {
    this.adapter.apply(snapshot);
  }

  rollback(snapshot: LocalizationSnapshot | undefined): void {
    this.adapter.rollback?.(snapshot);
  }

  dispose(): void {
    this.adapter.dispose?.();
  }
}

class ServerTransferStateCommitHook implements LocalizationCommitHook {
  constructor(
    private readonly transferState: TransferState,
    private readonly localization: () => Localization | undefined,
    private readonly observable: boolean,
  ) {}

  apply(): void {
    // TransferState observes only snapshots that have completed every commit hook.
  }

  committed(committedSnapshot: LocalizationSnapshot): void {
    const localization = this.localization();
    if (localization === undefined) return;
    if (this.observable) {
      emitLocalizationRuntimeEvent(localization, {
        code: RUNTIME_EVENT_CODES.ssrHydration,
        phase: 'ssr-hydration',
        status: 'started',
        targetLocale: committedSnapshot.primaryLocale,
        snapshotId: committedSnapshot.id,
      });
    }
    const snapshot = localizationTransferSnapshot(localization);
    if (snapshot !== undefined) {
      this.transferState.set(transferStateKey, snapshot);
      if (this.observable) {
        emitLocalizationRuntimeEvent(localization, {
          code: RUNTIME_EVENT_CODES.ssrHydration,
          phase: 'ssr-hydration',
          status: 'succeeded',
          targetLocale: committedSnapshot.primaryLocale,
          snapshotId: committedSnapshot.id,
        });
      }
    } else if (this.observable) {
      emitLocalizationRuntimeEvent(localization, {
        code: RUNTIME_EVENT_CODES.ssrHydration,
        phase: 'ssr-hydration',
        status: 'failed',
        reason: 'internal-invariant',
        targetLocale: committedSnapshot.primaryLocale,
        snapshotId: committedSnapshot.id,
      });
    }
  }
}

/**
 * What the server wrote, or something that has been edited on the way back.
 *
 * `specs/05-compiled-artifacts-and-trust.spec.md` section 2 requires that a transfer be bounded and
 * revalidated field by field, and that anything unrecognized cost the whole transfer rather than
 * the field. Returning nothing is that rule: the document renders from its own generated defaults,
 * which are correct, where a partly adopted transfer would not be.
 *
 * What the browser then does with an accepted transfer is
 * `specs/06-runtime-and-angular.spec.md` section 10: adopt it whole, renegotiate no locale during
 * hydration, and reload no catalog it already carried.
 */
function sanitizeTransferSnapshot(
  value: unknown,
): AtlasTransferSnapshot | undefined {
  try {
    const admitted = snapshotInertJson(value, {
      maximumDepth: RUNTIME_LIMITS.jsonDepth + 12,
      maximumNodes: RUNTIME_LIMITS.jsonNodes,
      maximumCodeUnits: RUNTIME_LIMITS.transferBytes,
    });
    if (
      admitted.utf8Bytes > RUNTIME_LIMITS.transferBytes ||
      !isDataRecord(admitted.value) ||
      !hasExactKeys(
        admitted.value,
        ['profile', 'primaryLocale', 'formatting', 'catalogs', 'participants'],
        ['route'],
      ) ||
      admitted.value['profile'] !== 'atlas-transfer-state/1' ||
      typeof admitted.value['primaryLocale'] !== 'string' ||
      admitted.value['primaryLocale'].length === 0 ||
      admitted.value['primaryLocale'].length > 128
    ) {
      return undefined;
    }
    const primaryLocale = admitted.value['primaryLocale'];
    const formatting = admitted.value['formatting'];
    if (
      !isDataRecord(formatting) ||
      !hasExactKeys(
        formatting,
        ['locale'],
        ['timeZone', 'calendar', 'numberingSystem', 'hourCycle'],
      ) ||
      formatting['locale'] !== primaryLocale ||
      ['timeZone', 'calendar', 'numberingSystem'].some(
        (property) =>
          formatting[property] !== undefined &&
          (typeof formatting[property] !== 'string' ||
            formatting[property].length === 0 ||
            formatting[property].length > 128),
      ) ||
      (formatting['hourCycle'] !== undefined &&
        !['h11', 'h12', 'h23', 'h24'].includes(String(formatting['hourCycle'])))
    ) {
      return undefined;
    }
    const route = admitted.value['route'];
    if (
      route !== undefined &&
      (!isDataRecord(route) ||
        !hasExactKeys(
          route,
          ['routeId', 'projectionIdentity', 'canonicalPath'],
          ['addresses'],
        ) ||
        typeof route['routeId'] !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(route['routeId']) ||
        typeof route['projectionIdentity'] !== 'string' ||
        !/^sha256-[A-Za-z0-9_-]{43}$/u.test(route['projectionIdentity']) ||
        !isTransferredPath(route['canonicalPath']) ||
        !areTransferredAddresses(route['addresses']))
    ) {
      return undefined;
    }
    const catalogs = admitted.value['catalogs'];
    if (
      !Array.isArray(catalogs) ||
      catalogs.length > RUNTIME_LIMITS.catalogsPerTransfer
    ) {
      return undefined;
    }
    const participants = sanitizeParticipantTransferRecords(
      admitted.value['participants'],
    );
    if (participants === undefined) return undefined;
    return Object.freeze({
      profile: 'atlas-transfer-state/1',
      primaryLocale,
      formatting: formatting as unknown as FormattingContext,
      ...(route === undefined
        ? {}
        : { route: route as unknown as LocalizationRouteSnapshot }),
      catalogs: catalogs as readonly unknown[],
      participants,
    });
  } catch {
    return undefined;
  }
}

/**
 * Compose localization from a setup assembled by hand.
 *
 * The ordinary way to do this is `provideLocalization()` from the application's own `#i18n`, which
 * Atlas generates with the configuration, catalog set, loaders, recovery payload and startup
 * scopes already closed over. This is the path underneath it, for a caller assembling those parts
 * itself: a test constructing a deliberately broken loader, or a host composing Atlas around
 * artifacts it produced another way.
 *
 * Two functions of the same name in different modules would be a coin toss at every call site, so
 * the lower-level one is named for what distinguishes it: it takes the setup.
 */
export function provideLocalizationSetup(
  setup: LocalizationSetup,
  ...features: readonly LocalizationFeature[]
): EnvironmentProviders {
  const recovery = oneFeature(features, 'recovery-message') as
    | RecoveryMessageFeature
    | undefined;
  const formatting = oneFeature(features, 'formatting-context') as
    | FormattingContextFeature
    | undefined;
  const documentLocale = oneFeature(features, 'document-locale') as
    | DocumentLocaleFeature
    | undefined;
  const announcement = oneFeature(features, 'locale-announcement') as
    | LocaleAnnouncementFeature
    | undefined;
  const overlay = oneFeature(features, 'overlay-locale') as
    | OverlayLocaleFeature
    | undefined;
  const observability = oneFeature(features, 'observability') as
    | ObservabilityFeature
    | undefined;
  const clock = oneFeature(features, 'localization-clock') as
    | LocalizationClockFeature
    | undefined;
  const relativeTimePolicy = oneFeature(features, 'relative-time-policy') as
    | RelativeTimePolicyFeature
    | undefined;
  const persistence = oneFeature(features, 'persistence') as
    | PersistenceFeature
    | undefined;
  const localeSources = oneFeature(features, 'locale-sources') as
    | LocaleSourcesFeature
    | undefined;
  const extensions = oneFeature(features, 'extensions') as
    | ExtensionsFeature
    | undefined;
  const routing = oneFeature(features, 'routing') as RoutingFeature | undefined;
  if (routing !== undefined && setup.routeProjection === undefined) {
    throw new LocalizationError({
      code: 'invalid-configuration',
      outcome: 'operational-failure',
      message:
        'withRouting() requires a generated route projection. Regenerate this owner so that provideLocalization() carries one.',
    });
  }
  // The two halves have to be the same generated projection, and now they can say so.
  //
  // `setup.routeProjection` is what the generator emitted for this owner; `routing.options
  // .projection.generated` is what the consumer built their codecs and historical outcomes around.
  // Before, the second did not exist as a whole: Atlas assembled one from the first plus three
  // loose fields, so the question could not be asked. It can now, and it is worth asking: a
  // projection imported from a stale generated file, or from another owner in the same workspace,
  // produces route ids that resolve against nothing, and the symptom is routes silently failing to
  // localize rather than an error.
  if (
    routing !== undefined &&
    setup.routeProjection !== undefined &&
    routing.options.projection.generated.identity !==
      setup.routeProjection.identity
  ) {
    throw new LocalizationError({
      code: 'invalid-configuration',
      outcome: 'operational-failure',
      message: `withRouting() was given a route projection generated for something else. This owner generated ${JSON.stringify(setup.routeProjection.identity)} and the projection passed carries ${JSON.stringify(routing.options.projection.generated.identity)}. Regenerate, or pass the projection built from this owner's generated routes.`,
    });
  }
  const routeProjection: RouteRuntimeProjection | undefined =
    routing === undefined ? undefined : routing.options.projection;

  return makeEnvironmentProviders([
    ...(routing === undefined || routeProjection === undefined
      ? []
      : [
          {
            provide: LOCALE_URL_POLICY,
            useValue: Object.freeze({
              // Narrowed here, once, rather than at each place that reads it. What this token
              // provides is the policy this build can serve: the declared one with any locale the
              // generated configuration does not list removed from every table. So the resolver,
              // the client route table and anything a consumer writes against this token address
              // only locales that exist, without any of them having to remember to ask.
              policy: builtLocalePolicy(
                routing.options.policy,
                setup.configuration,
              ),
              projection: validateRouteProjection(routeProjection),
              configuration: setup.configuration,
            }),
          },
        ]),
    ...(documentLocale === undefined ? [DocumentLocalization] : []),
    LocalizationInteractionRestore,
    {
      provide: Localization,
      useFactory: () => {
        const transferState = inject(TransferState);
        const platformId = inject(PLATFORM_ID);
        const transferredValue =
          transferState.get<AtlasTransferSnapshot | null>(
            transferStateKey,
            null,
          );
        const transferred = sanitizeTransferSnapshot(transferredValue);
        const transferredParticipants =
          transferred === undefined
            ? undefined
            : sanitizeParticipantTransferRecords(transferred.participants);
        if (isPlatformBrowser(platformId) && transferred !== undefined) {
          transferState.remove(transferStateKey);
        }
        const hooks: LocalizationCommitHook[] = [];
        let localization: Localization | undefined;
        const document = inject(DOCUMENT);
        // The address being rendered, derived rather than received.
        //
        // `@angular/ssr` provides `REQUEST` and `REQUEST_CONTEXT` only when the render mode is
        // `Server`. A prerendered render has neither, so reading `REQUEST_CONTEXT` here meant
        // every prerendered page resolved to the default locale: Arabic addresses rendered in
        // English, written to disk, with nothing reported.
        //
        // `PlatformLocation` carries the rendered address under both prerendering and SSR,
        // because the server platform initializes it from that address. So the browser reads
        // `document.location` as it always did and the server reads `PlatformLocation`, and
        // `REQUEST_CONTEXT` stops being an input to locale resolution altogether. That also ends
        // a collision with a consumer's own `REQUEST_CONTEXT` and an `engine.handle` wiring
        // requirement that was documented nowhere and silent when omitted. A consumer steering
        // Atlas by address still has `RouteHttpDescriptor` and the standalone server API, both of
        // which take one explicitly.
        const platformLocation = inject(PlatformLocation, { optional: true });
        // The sub-path the application is deployed under, taken off before the address is read.
        //
        // An application served at `https://example.com/app` gets `/app/ar-eg/second` from both
        // surfaces below, and `/app` is a segment no policy names, so the locale fell back to the
        // default and an Arabic address rendered in English, with nothing reported. The Router half
        // never had this: `LocalizedLocationStrategy` strips the same value before delocalizing,
        // which is why the page and the route were right while the locale was wrong.
        const baseHref = applicationBaseHref();
        const requestContext = isPlatformBrowser(platformId)
          ? Object.freeze({
              url: withoutBasePath(
                `${document.location.pathname}${document.location.search}${document.location.hash}`,
                baseHref,
              ),
            })
          : platformLocation === null
            ? undefined
            : Object.freeze({
                url: withoutBasePath(
                  `${platformLocation.pathname}${platformLocation.search}${platformLocation.hash}`,
                  baseHref,
                ),
              });
        const localeUrl = inject(LOCALE_URL_POLICY, { optional: true });
        // What this client asked for, read from whichever surface exists. In the browser that is
        // the ordered list the user configured in their operating system; on the server it is the
        // header carrying the same list. Both are read here rather than in the runtime, which has
        // no business touching `navigator` or an HTTP request.
        const preferredLanguages = isPlatformBrowser(platformId)
          ? Object.freeze([...navigator.languages])
          : Object.freeze(
              parseAcceptLanguage(
                inject(REQUEST, { optional: true })?.headers.get(
                  'accept-language',
                ) ?? '',
              ),
            );
        if (overlay !== undefined) {
          // Built inside the injector that owns this request, and disposed with it.
          hooks.push(new OverlayLocaleCommitHook(overlay.create()));
        }
        // Focus and scroll survive a locale switch without being asked for. Losing the caret
        // mid-sentence because the page changed language is not behaviour an application opts
        // into; it is behaviour it would have to opt out of, and none would.
        hooks.push(
          new InteractionPreservationCommitHook(
            document,
            isPlatformBrowser(platformId),
            inject(LocalizationInteractionRestore),
          ),
        );
        if (documentLocale === undefined) {
          hooks.push(new DocumentLocaleCommitHook(document));
        }
        // The two routed steps, in the order a commit needs them and not in the order two services
        // happened to be constructed.
        //
        // The address bar comes first because the two after it describe a page that has one: the
        // head states where this page lives, and the announcement tells a reader the language
        // changed. Publishing either while the address bar still spells the previous locale is the
        // same incoherence as an English page at an Arabic address, held for as long as it takes
        // the rest of the list to run.
        //
        // The head is next, and before the announcement, because the announcement is the one thing
        // here a person perceives directly: everything the document says about itself (its
        // language, its address, its title, its canonical) is settled before anything is said out
        // loud. It would also be true by accident, since the announcement defers itself a frame,
        // and a sequence that is right by accident is one nobody can read.
        const routedAddress = new RoutingCommitHook();
        const routedDocument = new RoutingCommitHook();
        hooks.push(routedAddress, routedDocument);
        // Announced without being asked for, into a live region Atlas owns. A screen reader given
        // no notice that the page changed language reads the new text with the old pronunciation
        // rules, and an application cannot know to opt into a fix for a problem it cannot hear.
        // Withdrawn by `withoutDocumentLocale()`, which is the statement that Atlas does not touch
        // this document; a region appended to its body is exactly that.
        if (documentLocale === undefined) {
          hooks.push(
            new LocaleAnnouncementCommitHook(
              document,
              isPlatformBrowser(platformId),
              announcement?.format ?? defaultLocaleAnnouncement,
            ),
          );
        }
        if (isPlatformServer(platformId)) {
          hooks.push(
            new ServerTransferStateCommitHook(
              transferState,
              () => localization,
              observability !== undefined,
            ),
          );
        }
        const options: LocalizationRuntimeOptions = {
          // Extension bindings arrive as a feature because they are functions. Merged here so the
          // runtime keeps receiving one setup, and so a caller assembling a setup by hand can still
          // put them in it.
          setup:
            extensions === undefined
              ? setup
              : Object.freeze({ ...setup, extensions: extensions.bindings }),
          // Only what the first render uses, and never a list an application wrote:
          // `specs/06-runtime-and-angular.spec.md` section 9 derives this from the route tree. A
          // scope every one of whose uses sits behind a lazy route boundary loads when that
          // route activates, so startup cost follows the first screen rather than the total size
          // of an application's catalogs, and a scope used anywhere eager, or used nowhere Atlas
          // can see, stays a startup scope, because the safe direction is to load it.
          //
          // These are also loaded again for the target locale before a coordinated commit, under
          // section 5 of `specs/06-runtime-and-angular.spec.md`, which publishes one complete
          // snapshot or none.
          bootstrapScopes: Object.freeze(
            setup.configuration.scopes
              .filter(({ startup }) => startup !== false)
              .map(({ providerId, scopeId }) =>
                Object.freeze({ providerId, scopeId }),
              ),
          ),
          ...(transferred === undefined
            ? {}
            : { initialLocale: transferred.primaryLocale }),
          // Supplied whenever it exists, not only when a consumer resolver was installed. The
          // `url` locale source reads the same request, and gating it on an unrelated feature is
          // how it silently resolved nothing: the URL said `/ar-eg` and the runtime was handed no
          // request to read it from.
          ...(requestContext === undefined ? {} : { requestContext }),
          ...(recovery === undefined
            ? {}
            : { recoveryMessageIdentity: recovery.identity }),
          ...(recovery?.retryLabelIdentity === undefined
            ? {}
            : { recoveryRetryLabelIdentity: recovery.retryLabelIdentity }),
          // Two contexts, kept apart. The feature's is the application-wide default every locale
          // inherits; the transferred one is what the server rendered *this* locale with. They
          // were one field until the configuration gained a per-locale layer, and merging them
          // made the first response's locale the default for every locale after it: a server that
          // rendered `ar-EG` in Western digits handed `fa-IR` Western digits too, on the switch.
          ...(formatting === undefined
            ? {}
            : { formattingContext: formatting.context }),
          ...(transferred === undefined
            ? {}
            : {
                initialFormattingContext: Object.freeze(
                  Object.fromEntries(
                    Object.entries(transferred.formatting).filter(
                      ([name]) => name !== 'locale',
                    ),
                  ),
                ) as Omit<FormattingContext, 'locale'>,
              }),
          ...(transferred?.route === undefined
            ? {}
            : { initialRoute: transferred.route }),
          ...(hooks.length === 0 ? {} : { commitHooks: Object.freeze(hooks) }),
          claimRoutingCommit: (steps) => {
            routedAddress.step =
              steps === undefined ? undefined : () => steps.writeAddress();
            routedDocument.step =
              steps === undefined ? undefined : steps.projectDocument;
          },
          ...(transferred === undefined
            ? {}
            : { transferredCatalogs: transferred.catalogs }),
          ...(transferredParticipants === undefined
            ? {}
            : { transferredParticipants }),
          ...(observability === undefined
            ? {}
            : { observability: observability.sink }),
          ...(clock === undefined ? {} : { clock: clock.clock }),
          ...(relativeTimePolicy === undefined
            ? {}
            : { relativeTimePolicy: relativeTimePolicy.policy }),
          // Built here, inside the injector that owns this request. A store created where the
          // feature was declared would be a module-level constant shared by every server-rendered
          // request in the process, and one visitor's preference would leak into the next.
          ...(persistence === undefined
            ? {}
            : {
                persistence: Object.freeze(
                  persistence.factories.map((create) => create()),
                ),
              }),
          ...(localeSources === undefined
            ? {}
            : { localeSources: localeSources.sources }),
          ...(localeUrl === null ? {} : { localeUrl }),
          ...(preferredLanguages.length === 0 ? {} : { preferredLanguages }),
        };
        localization = createLocalizationRuntime(options);
        if (
          observability !== undefined &&
          isPlatformBrowser(platformId) &&
          transferredValue !== null
        ) {
          emitLocalizationRuntimeEvent(localization, {
            code: RUNTIME_EVENT_CODES.ssrHydration,
            phase: 'ssr-hydration',
            status: 'started',
          });
          emitLocalizationRuntimeEvent(localization, {
            code: RUNTIME_EVENT_CODES.ssrHydration,
            phase: 'ssr-hydration',
            status: transferred === undefined ? 'failed' : 'succeeded',
            ...(transferred === undefined
              ? { reason: 'invalid-configuration' }
              : { targetLocale: transferred.primaryLocale }),
          });
        }
        const documentLocalization =
          documentLocale !== undefined
            ? undefined
            : inject(DocumentLocalization);
        inject(DestroyRef).onDestroy(() => {
          localization.dispose();
          documentLocalization?.dispose();
        });
        return localization;
      },
    },
    provideAppInitializer(() => {
      const localization = inject(Localization);
      const transferState = inject(TransferState);
      const platformId = inject(PLATFORM_ID);
      return localization
        .initialize()
        .then(() => {
          if (!isPlatformServer(platformId)) return;
          const snapshot = localizationTransferSnapshot(localization);
          if (snapshot !== undefined)
            transferState.set(transferStateKey, snapshot);
        })
        .catch((error: unknown) => {
          // A rejected app initializer aborts bootstrap, so Angular never creates the component
          // tree, including whatever hosts <localization-recovery />. The result
          // was an empty <body> on precisely the failure the recovery feature exists for: a chunk
          // that 404s, a bad deploy, a catalog that will not load.
          //
          // The failure itself is not swallowed. initialize() has already set the lifecycle to
          // 'failed', published the recovery representation and emitted a failed initialization
          // event to the observability sink. No partial runtime is published: every message read
          // still throws, so nothing renders half-localized.
          //
          // Recovery is only reachable if the consumer configured one. Without it there is nothing
          // to show, and booting into an application whose every message throws is worse than the
          // hard failure, so that case still rejects.
          if (localization.recovery() === undefined) throw error;
        });
    }),
  ]);
}

/**
 * Reaches localization from a component, a directive or a service.
 *
 * The same thing as `inject(Localization)`, named so that a call site reads as localization rather
 * than as dependency injection. Subject to Angular's own rule: callable in a field initializer or a
 * constructor, and not in a method.
 */
export function injectLocalization(): Localization {
  return inject(Localization);
}
