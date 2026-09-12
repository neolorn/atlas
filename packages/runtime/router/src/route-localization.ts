/**
 * What the document says about itself once a navigation and a locale have both settled.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 10 composes every published URL from
 * three parts, the origin, the mount point and the address, so the address a crawler is given
 * and the address this build resolves are two readings of one value rather than two settings
 * that can disagree. A variant joins the alternate cluster only when the policy addresses it,
 * the build generated it, and the address serves it.
 *
 * Section 14 of `specs/07-routing-rendering-and-seo.spec.md` is why the title, the description,
 * the alternates and the social block move with the commit rather than after it: they are
 * claims about which representation this is, and a page whose head names one locale while its
 * text is in another has told a crawler something untrue.
 */

import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  EnvironmentInjector,
  effect,
  inject,
  isDevMode,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  ROUTER_CONFIGURATION,
  RedirectCommand,
  Router,
} from '@angular/router';
import {
  LOCALE_URL_POLICY,
  DocumentLocalization,
  Localization,
  LocalizationInteractionRestore,
  LocalizationError,
  addressSelectsLocale,
  applicationBaseHref,
  buildLocalizedRoute,
  localizedRouteAddresses,
  projectRouteSeo,
  resolveLocalizedRoute,
  type DocumentLocalizationProjection,
  type LocaleChangeMode,
  type LocaleChangeResult,
  type LocalizationRouteSnapshot,
  type LocalizationSnapshot,
  type LocalizationDiagnostic,
  type LocalizedParameterSpellings,
  type PlainMessageHandle,
  type LocalizationScope,
  type GeneratedConfiguration,
  type LocaleUrlPolicy,
  type RouteResolution,
  type RouteRuntimeProjection,
} from '@neolorn/atlas';

import { LocalizedAddressSync } from './address-sync.js';
import { LocalizedRouteParameters } from './route-parameters.js';

/** Which route was reached, and on which navigation, for the metadata callback to read. */
export interface RouteLocalizationContext {
  /**
   * The route that matched, its parameters, and the locale it was reached in.
   *
   * Narrowed to a success: the callback runs only for a navigation that arrived somewhere, so a
   * redirect or an unknown address is never described.
   */
  readonly resolution: Extract<RouteResolution, { readonly status: 'success' }>;
  /**
   * Angular's id for this navigation, which is what distinguishes two visits to one address.
   *
   * Worth carrying into a fetch so a slow answer that arrives after the visitor has moved on can
   * be recognized as belonging to a navigation that is over.
   */
  readonly navigationId: number;
}

/**
 * What the Router integration needs beyond the routing an application already declared.
 *
 * The URL policy and the route projection are not here. They are declared once, in
 * `withRouting()` inside `provideLocalization()`, and this reads them from there. Taking them
 * again would let an application state its locale URL policy in two places, and two copies of a
 * policy are two policies as soon as one of them is edited.
 */
export interface RouteLocalizationOptions {
  /**
   * Whether a locale change holds the old page until everything is ready, or swaps as it goes.
   *
   * The default is the coordinated one, which is the answer that never shows two languages at
   * once.
   */
  readonly mode?: LocaleChangeMode;
  /**
   * Scopes that must be loaded before a navigation completes, either for every route or per route
   * id.
   *
   * A scope named here holds the navigation. Naming too much makes every page wait for text most
   * of them do not show.
   */
  readonly requiredScopes?:
    | readonly LocalizationScope[]
    | Readonly<Record<string, readonly LocalizationScope[]>>;
  /**
   * Scopes loaded alongside the navigation rather than ahead of it, either globally or per route
   * id.
   *
   * The page renders without them and picks them up when they arrive, which is the right shape for
   * text below the fold or behind an interaction.
   */
  readonly progressiveScopes?:
    | readonly LocalizationScope[]
    | Readonly<Record<string, readonly LocalizationScope[]>>;
  /**
   * The absolute origin the head's alternates and canonical are written against.
   *
   * Required for server rendering, where there is no address bar to read one from. In a browser it
   * defaults to the current origin, and supplying it there pins the head to one deployment.
   */
  readonly origin?: string;
  /**
   * What each route's document says, declared once per route id and authored as messages.
   *
   * A route's title and description are *sentences a visitor reads*, so they belong in a catalog
   * like every other sentence: unlike a route's path spelling, which is an address. Authoring
   * them as `MessageHandle`s rather than as a bespoke metadata format is what makes
   * `atlas check --require-complete` answer for them: a title missing from a target catalog is
   * ATL1307, at `error` severity under that flag, with no new diagnostic and no second
   * completeness mechanism to keep in step with the first.
   *
   * Keyed by the route ids in the projection, which is also what makes a typo visible: a key
   * naming no route is reported at startup rather than silently describing nothing.
   */
  readonly documentMetadata?: Readonly<Record<string, RouteDocumentMessages>>;
  /**
   * The dynamic half, for what a catalog cannot hold.
   *
   * Runs after `documentMetadata` and its result is merged over it, field by field, so a route
   * whose title depends on fetched content overrides only the title and keeps the declared
   * description. A route that needs nothing dynamic does not appear here at all, which is the point:
   * as the only mechanism this puts every route's metadata through one conditional chain, and a
   * conditional chain always has a last branch. It never stops compiling and never stops
   * answering, however wrongly.
   */
  readonly document?: (
    context: RouteLocalizationContext,
    localization: Localization,
  ) => Omit<DocumentLocalizationProjection, 'seo'>;
}

/**
 * One route's document metadata, as messages.
 *
 * Every field is optional and a field left out is not supplied rather than supplied empty: an
 * absent description emits no `<meta name="description">`, which is what a page with nothing to say
 * about itself should do. A route with no title at all is reported when it is visited, because the
 * one thing every page needs is the one thing nothing else can substitute for.
 */
export interface RouteDocumentMessages {
  /** What the tab and the search result say. The one field whose absence is reported. */
  readonly title?: PlainMessageHandle;
  /** The page's own summary of itself, written for a reader rather than for a crawler. */
  readonly description?: PlainMessageHandle;
  /** Social copy, for the fields Atlas cannot derive and a catalog can hold. */
  readonly imageAlt?: PlainMessageHandle;
  /**
   * What the site calls itself in this locale, for the social card.
   *
   * Usually the same message on every route, and stated per route because a section that presents
   * itself under its own name is ordinary.
   */
  readonly siteName?: PlainMessageHandle;
}

interface ResolvedRouteLocalizationOptions extends RouteLocalizationOptions {
  readonly policy: LocaleUrlPolicy;
  readonly projection: RouteRuntimeProjection;
  /**
   * Read from the same token as the policy, for the same reason the policy is read from it: the
   * application declared it once to `provideLocalization()`, and the `hreflang` alternates below
   * may only name locales this build actually generated.
   */
  readonly configuration: GeneratedConfiguration;
}

interface PendingRoute {
  readonly context: RouteLocalizationContext;
  readonly previousUrl: string;
  readonly scopes: readonly LocalizationScope[];
  readonly progressiveScopes: readonly LocalizationScope[];
  readonly restoreOnly: boolean;
  /** The snapshot to put back if this navigation never lands. */
  readonly previousSnapshot: LocalizationSnapshot | undefined;
  readonly result: LocaleChangeResult;
}

function configuredScopes(
  configured:
    | readonly LocalizationScope[]
    | Readonly<Record<string, readonly LocalizationScope[]>>
    | undefined,
  routeId: string,
): readonly LocalizationScope[] {
  if (configured === undefined) return Object.freeze([]);
  if (Array.isArray(configured)) {
    return configured as unknown as readonly LocalizationScope[];
  }
  return (
    (configured as Readonly<Record<string, readonly LocalizationScope[]>>)[
      routeId
    ] ?? Object.freeze([])
  );
}

/** The scopes the generated route table says this route brings in. */
function derivedScopes(
  projection: RouteRuntimeProjection,
  routeId: string,
): readonly LocalizationScope[] {
  const entry = projection.generated.routes.find(({ id }) => id === routeId);
  return entry?.scopes ?? Object.freeze([]);
}

function mergeScopes(
  ...groups: readonly (readonly LocalizationScope[])[]
): readonly LocalizationScope[] {
  const merged = new Map<string, LocalizationScope>();
  for (const group of groups) {
    for (const scope of group) {
      merged.set(`${scope.providerId}\u0000${scope.scopeId}`, scope);
    }
  }
  return Object.freeze([...merged.values()]);
}

function navigationDiagnostic(message: string): LocalizationDiagnostic {
  return Object.freeze({
    code: 'route-unavailable',
    outcome: 'operational-failure',
    message,
  });
}

/**
 * The diagnostic a locale change carries, for the two outcomes that carry one.
 *
 * `committed` succeeded and `redirected` is a document navigation: neither is a defect and
 * neither has anything to report. Written as a function rather than as a narrowing at the call site
 * because a fourth outcome added later must be a compile error here, and not a property access that
 * quietly yields `undefined`.
 */
function transactionDiagnostic(
  result: LocaleChangeResult,
): LocalizationDiagnostic | undefined {
  switch (result.status) {
    case 'committed':
    case 'redirected':
      return undefined;
    default:
      return result.diagnostic;
  }
}

function effectDiagnostic(message: string): LocalizationDiagnostic {
  return Object.freeze({
    code: 'effect-failed',
    outcome: 'operational-failure',
    message,
  });
}

/**
 * Thrown when a navigation reached an address that did not resolve to a route in that locale.
 *
 * It carries the resolution rather than only a message, so a handler can tell an unknown address
 * from one that exists in another locale and act differently. Reached through the Router's error
 * handling, not by catching around a navigation call.
 */
export class RouteLocalizationError extends Error {
  /** Recognizable by a handler without an `instanceof`. */
  override readonly name = 'RouteLocalizationError';

  constructor(
    /** What resolution returned, including the status that says why it did not arrive. */
    readonly resolution: RouteResolution,
  ) {
    super(`Localized route resolution failed with ${resolution.status}.`);
  }
}

/**
 * The Router integration: what keeps the address, the document and the committed locale in step.
 *
 * Installed by `provideLocalizedRouter`. An application injects it to read which route it is on in
 * localization's terms, and otherwise leaves it alone: it drives the locale transaction for a
 * navigation, writes the head, and moves the address bar at a stated point in the commit rather
 * than whenever it notices.
 */
export class RouteLocalization {
  private readonly router = inject(Router);
  private readonly routerConfiguration = inject(ROUTER_CONFIGURATION, {
    optional: true,
  });
  private readonly localization = inject(Localization);
  private readonly hostDocument = inject(DOCUMENT);
  // Claimed at construction: from here the runtime hands its restores to this adapter instead of
  // running them itself, because only this knows when the Router has stopped moving the page.
  private readonly interaction = ((coordinator) => {
    coordinator.ɵclaim();
    return coordinator;
  })(inject(LocalizationInteractionRestore));
  private readonly document = inject(DocumentLocalization, { optional: true });
  private addresses:
    | {
        readonly navigationId: number;
        readonly spellings: LocalizedParameterSpellings | undefined;
        readonly value: Readonly<Record<string, string>>;
      }
    | undefined;
  /** The same, narrowed to the addresses a switcher may offer, on the same key. */
  private switchable:
    | {
        readonly navigationId: number;
        readonly spellings: LocalizedParameterSpellings | undefined;
        readonly value: Readonly<Record<string, string>> | undefined;
      }
    | undefined;
  private readonly parameters = inject(LocalizedRouteParameters);
  /**
   * The address bar's keeper, injected so its step can be handed to the commit list.
   *
   * Read here rather than left to run on its own: what moves the address bar is now a call at a
   * stated position in a locale commit, and this is where that position is claimed.
   */
  private readonly addressSync = inject(LocalizedAddressSync);
  /**
   * Where this application is mounted, read once from the same resolution the locale source reads.
   *
   * Read here rather than passed in as an option, and that is the whole of the design: the
   * deployment tells Angular its mount point once, and every part of Atlas that needs it asks the
   * same question of the same injector. An option would let an application answer twice, and the
   * two answers would disagree the first time one of them was edited, with the head advertising
   * addresses this build refuses to resolve, which is the failure hardest to see from inside the
   * application that has it.
   *
   * Constant for the life of the injector, like the base href itself: `Location` reads it once in
   * its own constructor, so nothing downstream could follow a value that changed.
   */
  private readonly baseHref = applicationBaseHref();
  /** The declaration the head was last built from, so a re-projection happens once per change. */
  private declaredSpellings: LocalizedParameterSpellings | undefined;
  /** Route ids already reported as untitled, so the warning is said once and not once a navigation. */
  private readonly untitledRoutes = new Set<string>();
  private readonly environmentInjector = inject(EnvironmentInjector);
  private readonly pending = new Map<number, PendingRoute>();
  private commitPromise: Promise<LocaleChangeResult> | undefined;
  private restoringUrl = false;
  /** The language the document currently states, as against the locale that is committed. */
  private documentLocale: string | undefined;

  /**
   * The route currently settled, and `undefined` before the first navigation completes.
   *
   * It changes when a navigation finishes rather than when one starts, so reading it during a
   * transition gives the page still on screen.
   */
  readonly context = signal<RouteLocalizationContext | undefined>(undefined);

  private readonly options: ResolvedRouteLocalizationOptions;

  constructor(options: RouteLocalizationOptions) {
    const declared = inject(LOCALE_URL_POLICY, { optional: true });
    if (declared === null) {
      throw new LocalizationError({
        code: 'invalid-configuration',
        outcome: 'operational-failure',
        message:
          'Localized routing requires a locale URL policy. Declare one with withRouting() inside provideLocalization().',
      });
    }
    this.options = Object.freeze({
      ...options,
      policy: declared.policy,
      projection: declared.projection,
      configuration: declared.configuration,
    });

    if (this.routerConfiguration?.urlUpdateStrategy === 'eager') {
      // The adapter commits the locale immediately before the router activates the destination, so
      // the view and the language it is written in change together. An eager URL update moves the
      // address bar at the start of navigation instead, which puts the new locale's URL over the
      // old locale's page for the whole of guards and resolution: the same incoherence in a
      // different place, and one this adapter cannot close from where it sits. Refused rather than
      // left to be discovered, which is what leaving it to fixture convention amounted to.
      throw new LocalizationError({
        code: 'invalid-configuration',
        outcome: 'operational-failure',
        message:
          "Localized routing requires the Router's default deferred URL update; 'eager' publishes a localized URL before its page exists.",
      });
    }
    // Two positions in the runtime's commit list rather than two effects of our own. The steps are
    // this side's, only routing can spell an address or project a head, but when they run is a
    // property of the commit, and an order that emerges from service construction is one nothing
    // states and no test can read.
    //
    // Claimed in one call, and given up in one, because the two belong to the same integration:
    // an adapter that is torn down leaves no half-registered sequence behind.
    this.localization.ɵclaimRoutingCommit({
      writeAddress: () => this.addressSync.ɵreconcile(),
      projectDocument: (locale) => {
        this.onLocaleCommitted(locale);
        this.releaseInteraction();
      },
    });
    effect(() => {
      // Called with a sentinel when there is no page, because the point of the call here is to
      // subscribe. A declaration arrives after the fetch that produced it, which is after the head
      // was built, so this is the ordinary path rather than a repair: the alternates for a route
      // whose slug is loaded are correct only from this projection onwards.
      const active = untracked(this.context);
      this.onParametersDeclared(
        this.parameters.ɵforNavigation(active?.navigationId ?? -1),
      );
    });
    const subscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        const pending = this.pending.get(event.id);
        if (pending !== undefined) {
          this.pending.delete(event.id);
          if (!pending.restoreOnly) {
            this.commitPromise = this.applyDocument(pending);
          }
        }
        // Last, and that is the whole reason it happens here. The locale commits in the resolver,
        // before this route activates, so a restore scheduled with the commit runs before the
        // Router does its own scrolling, and an application that asked the Router to restore
        // scroll position then has that scroll overwrite the visitor's place, silently.
        this.interaction.ɵflush(this.hostDocument.defaultView);
      } else if (
        event instanceof NavigationCancel ||
        event instanceof NavigationError
      ) {
        const pending = this.pending.get(event.id);
        this.pending.delete(event.id);
        // The locale was committed before activation, and this navigation never arrived. Putting
        // the previous snapshot back is what keeps the specification's promise that a cancelled or
        // failed navigation leaves the snapshot, document, and URL as they were.
        if (pending !== undefined && !pending.restoreOnly) {
          void this.restoreSnapshot(pending.previousSnapshot);
        }
        // A navigation that never arrived leaves nothing to return the visitor to.
        this.interaction.ɵdiscard();
      }
    });
    // Registered for every policy and answering for one, because what decides is the policy this
    // adapter was configured with and that is fixed. See `crossOriginAddress` below.
    this.localization.ɵclaimLocaleChange((locale) =>
      this.crossOriginAddress(locale),
    );
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      this.pending.clear();
      this.localization.ɵclaimLocaleChange(undefined);
      this.localization.ɵclaimRoutingCommit(undefined);
    });
  }

  /**
   * Where a locale lives when it does not live here, and the move to it.
   *
   * Under `locale-host` the locale is the origin. A switch is therefore not a transition: cookies,
   * storage, in-memory state and the running application all stop at the origin boundary, so there
   * is nothing this document could carry across and nothing to coordinate. Running the transition
   * anyway commits the locale, then fails in `reresolve` because the target address is on another
   * origin, and leaves the reader on an English page with Arabic committed and no way back but the
   * browser's own Back.
   *
   * So the change is a document navigation, and this is where it starts. The address is the one
   * the head and the switcher already publish for this page in that locale, taken from the same
   * derivation rather than built again here: one page has one address per locale, however it is
   * being read.
   *
   * `undefined` for everything else, which is most things. Every other policy kind keeps every
   * locale in one origin, and under a host policy the locale this origin already serves is an
   * ordinary in-place change. The locale arrives canonical, `changeLocale` canonicalizes before
   * asking, so it is compared against `policy.locales` as it comes.
   *
   * `defaultView` is `null` while server rendering, and then nothing moves. The address is still
   * the honest answer to what was asked, and reporting it is better than committing a locale this
   * origin does not serve.
   */
  private crossOriginAddress(locale: string): string | undefined {
    const { policy } = this.options;
    if (policy.kind !== 'locale-host') return undefined;
    const origin = policy.locales[locale];
    if (origin === undefined || origin === this.declaredOrigin()) {
      return undefined;
    }
    const active = untracked(this.context);
    const address =
      active === undefined
        ? origin
        : (this.addressesFor(
            active,
            this.parameters.ɵforNavigation(active.navigationId),
          )[locale] ?? origin);
    this.hostDocument.defaultView?.location.assign(address);
    return address;
  }

  /**
   * The origin this build answers at, as an origin rather than as the string it was written as.
   *
   * `provideLocalizedRouter` refuses a host policy whose origins do not name this one, so under
   * that policy there is always a value here and it is always one of them, but it may have been
   * written with a trailing slash or a default port, and `policy.locales` holds the normalized
   * form. Comparing the two spellings directly would make `https://example.com/` a different origin
   * from `https://example.com` and claim a locale change that is already at home.
   */
  private declaredOrigin(): string | undefined {
    const declared = this.options.origin;
    if (declared === undefined) return undefined;
    try {
      return new URL(declared).origin;
    } catch {
      return undefined;
    }
  }

  /**
   * `undefined` means the locale is settled and this application's own routing should answer.
   * That is the shape of an address the projection does not contain: a not-found, a locale this
   * application does not support, or one it has declared gone.
   */
  async prepare(
    target: string,
  ): Promise<RouteLocalizationContext | RedirectCommand | undefined> {
    const resolution = resolveLocalizedRoute(
      target,
      this.options.policy,
      this.options.projection,
      {
        ...(this.options.origin === undefined
          ? {}
          : { origin: this.options.origin }),
      },
    );
    if (resolution.status === 'redirect') {
      return new RedirectCommand(this.router.parseUrl(resolution.location), {
        replaceUrl: resolution.reason === 'canonical-correction',
      });
    }
    if (
      resolution.status === 'not-found' ||
      resolution.status === 'unsupported-locale' ||
      resolution.status === 'gone'
    ) {
      // Not a localization failure. The address is one this application does not serve, or names a
      // locale it does not support, and in both cases the locale to answer in is known. Throwing
      // here abandoned the navigation, so an application's own not-found page never rendered and
      // an unsupported locale produced nothing at all rather than an answer in the default one.
      //
      // The locale is committed and the navigation continues, which lets the application's own
      // routing answer. The status a visitor receives is the host's to set, from the same
      // resolution, and `routeHttpDescriptor` states it.
      await this.localization.changeLocale(resolution.presentationLocale, {
        mode: this.options.mode ?? 'coordinated',
      });
      return undefined;
    }
    if (resolution.status !== 'success') {
      throw new RouteLocalizationError(resolution);
    }
    const navigation = this.router.getCurrentNavigation();
    if (navigation === null) {
      throw new RouteLocalizationError(
        Object.freeze({
          status: 'malformed',
          httpStatus: 400,
          presentationLocale: this.options.policy.defaultLocale,
          diagnostic: navigationDiagnostic(
            'Route localization preparation requires an active navigation.',
          ),
        }),
      );
    }
    // What this route needs, and what the application additionally asked for. The derived set is
    // the reason a deferred scope is safe to defer: the route's code arrives when it activates and
    // its messages arrive with it, without anything listing scopes per route.
    const scopes = mergeScopes(
      derivedScopes(this.options.projection, resolution.routeId),
      configuredScopes(this.options.requiredScopes, resolution.routeId),
    );
    const progressiveScopes = configuredScopes(
      this.options.progressiveScopes,
      resolution.routeId,
    );
    await Promise.all(
      scopes.map((scope) =>
        this.localization.preloadScope(scope, resolution.locale),
      ),
    );
    const context = Object.freeze({
      resolution,
      navigationId: navigation.id,
    });
    const previousUrl = this.router.url;
    const previousSnapshot = this.localization.snapshot();
    const restoreOnly = this.restoringUrl;

    // The commit happens here, in the resolver, and that placement is the point. The router runs
    // resolvers after every guard has passed and before it constructs the destination component,
    // so committing here is what lets that component be built against the locale it is for. On
    // NavigationEnd, after activation, the Arabic page is constructed from the English snapshot,
    // painted in English, and corrected a moment later. An application that offers a locale
    // control on every page, the ordinary placement, shows that to every user on every switch,
    // not to an unlucky few.
    //
    // The scopes above are already loaded by the time this runs, so the transaction settles in
    // microtasks and the browser gets no opportunity to paint between the commit and the view that
    // belongs to it.
    const result = restoreOnly
      ? undefined
      : await this.localization.changeLocale(resolution.locale, {
          mode: this.options.mode ?? 'coordinated',
          ...(scopes.length === 0 ? {} : { requiredScopes: scopes }),
          ...(progressiveScopes.length === 0 ? {} : { progressiveScopes }),
          // With the addresses this navigation can already build. A route whose slug is loaded has
          // declared no spellings yet, so its own address is all there is until it does, and
          // `onParametersDeclared` restates when the rest arrives, on the same lifecycle as the
          // head. Committing them here rather than only at `NavigationEnd` is what keeps an
          // ordinary navigation to one publish: the restate that follows finds the same record.
          route: this.routeRecord(
            context,
            this.switchableAddresses(
              context,
              this.parameters.ɵforNavigation(navigation.id),
            ),
          ),
        });
    if (result !== undefined && result.status !== 'committed') {
      // Failing the resolver is better than the commit-then-restore this replaced: the router
      // abandons the navigation with the address bar untouched, so there is nothing to put back.
      this.commitPromise = Promise.resolve(result);
      throw new RouteLocalizationError(
        Object.freeze({
          status: 'malformed',
          httpStatus: 400,
          presentationLocale: resolution.locale,
          diagnostic:
            transactionDiagnostic(result) ??
            navigationDiagnostic(
              'The localized route transaction did not commit.',
            ),
        }),
      );
    }
    if (result !== undefined) this.commitPromise = Promise.resolve(result);
    this.pending.set(navigation.id, {
      context,
      previousUrl,
      scopes,
      progressiveScopes,
      restoreOnly,
      previousSnapshot,
      result:
        result ??
        Object.freeze({
          status: 'committed',
          transitionId: 0,
          mode: this.options.mode ?? 'coordinated',
          targetLocale: resolution.locale,
          snapshot:
            this.localization.snapshot() ??
            (previousSnapshot as LocalizationSnapshot),
        }),
    });
    return context;
  }

  /**
   * Resolves once the locale change this navigation started has finished, however it finished.
   *
   * Returns the result of that change, which says whether it committed and what it committed to. It
   * never rejects: a refused change is a failed result rather than a thrown error, because a
   * caller waiting for the page to settle wants to know what happened rather than to handle an
   * exception. With nothing in flight it resolves immediately with the last result.
   */
  settled(): Promise<LocaleChangeResult> {
    return (
      this.commitPromise ??
      Promise.resolve(
        this.localization.lastResult() ??
          Object.freeze({
            status: 'failed',
            transitionId: 0,
            mode: this.options.mode ?? 'coordinated',
            targetLocale:
              this.localization.snapshot()?.primaryLocale ??
              this.options.policy.defaultLocale,
            diagnostic: navigationDiagnostic(
              'No localized route transaction has completed.',
            ),
          }),
      )
    );
  }

  /**
   * The effects that belong to the page that landed, rather than to the locale.
   *
   * Title, description, and SEO projection describe the destination document, so they run once the
   * router has actually arrived there. The locale itself was committed before activation.
   */
  private async applyDocument(
    pending: PendingRoute,
  ): Promise<LocaleChangeResult> {
    const { resolution } = pending.context;
    const previousSnapshot = pending.previousSnapshot;
    const result = pending.result;
    let addresses: Readonly<Record<string, string>> | undefined;
    try {
      addresses = this.projectDocument(pending.context);
    } catch {
      const representationRestored =
        await this.restoreSnapshot(previousSnapshot);
      const urlRestored = await this.restoreUrl(pending.previousUrl);
      return Object.freeze({
        status: 'failed',
        transitionId: result.transitionId,
        mode: result.mode,
        targetLocale: resolution.locale,
        diagnostic: effectDiagnostic(
          representationRestored && urlRestored
            ? 'Localized route document effects failed and the prior representation was restored.'
            : 'Localized route document effects failed and the prior representation could not be fully restored.',
        ),
      });
    }
    this.context.set(pending.context);
    this.documentLocale = pending.context.resolution.locale;
    // After `documentLocale`, for the reason `onLocaleCommitted` states: this publishes, and the
    // publish re-runs the locale effect. For a route that declared no spellings this record equals
    // the one the resolver already committed and the restate is dropped by its own guard, which is
    // what keeps a navigation to one publish.
    this.localization.ɵrestateRoute(
      this.routeRecord(pending.context, addresses),
    );
    return result;
  }

  /**
   * A page that reached a visitor with no title, said once per route.
   *
   * Reported when it happens rather than checked at startup, because "this route has no title" is
   * not a static fact: the declaration may be complete and the dynamic callback may still return
   * nothing for a route whose content had not loaded. The condition that matters is the one a
   * visitor met, so that is the one measured.
   *
   * Once per route id. A diagnostic that repeats on every navigation is one people filter out, and
   * the second occurrence carries no information the first did not.
   */
  private reportUntitledRoute(
    routeId: string,
    projection: Omit<DocumentLocalizationProjection, 'seo'>,
  ): void {
    if (!isDevMode()) return;
    if (projection.title !== undefined) return;
    if (this.untitledRoutes.has(routeId)) return;
    this.untitledRoutes.add(routeId);
    console.warn(
      `[Atlas] Route ${JSON.stringify(routeId)} rendered with no document title. Declare one in documentMetadata, or return one from the document callback. The page keeps whatever title the previous one left, which reads as a navigation that did not happen.`,
    );
  }

  /**
   * The declared metadata for one route, resolved in the locale that has just committed.
   *
   * `undefined` for a field with no handle, rather than an empty string: the projection treats an
   * absent field as "do not emit this" and an empty one as "emit nothing here", and those describe
   * different pages.
   */
  private declaredDocument(
    routeId: string,
  ): Omit<DocumentLocalizationProjection, 'seo'> {
    const declared = this.options.documentMetadata?.[routeId];
    if (declared === undefined) return {};
    const text = (
      handle: PlainMessageHandle | undefined,
    ): string | undefined =>
      handle === undefined ? undefined : this.localization.text(handle);
    const title = text(declared.title);
    const description = text(declared.description);
    const imageAlt = text(declared.imageAlt);
    const siteName = text(declared.siteName);
    return {
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(imageAlt === undefined && siteName === undefined
        ? {}
        : {
            social: {
              ...(imageAlt === undefined ? {} : { imageAlt }),
              ...(siteName === undefined ? {} : { siteName }),
            },
          }),
    } as Omit<DocumentLocalizationProjection, 'seo'>;
  }

  /**
   * Where this page lives in each locale, derived once per navigation.
   *
   * Twice per navigation would be the ordinary shape, the resolver commits a record and the head
   * projects a moment later, and the second call is free because the answer cannot have changed:
   * the address of a route in another locale is built from the route id, its parameters, the query
   * and the fragment, and none of those move while a navigation is one navigation. The locale the
   * reader is *in* is not an input, which is why a locale commit reuses this too.
   *
   * Keyed on the declared spellings as well, because those are the one input that does arrive late:
   * a route whose slug is loaded declares them after activation, and the entry recomputes when it
   * does.
   */
  private addressesFor(
    context: RouteLocalizationContext,
    spellings: LocalizedParameterSpellings | undefined,
  ): Readonly<Record<string, string>> {
    const cached = this.addresses;
    if (
      cached !== undefined &&
      cached.navigationId === context.navigationId &&
      cached.spellings === spellings
    ) {
      return cached.value;
    }
    const value = localizedRouteAddresses(
      context.resolution,
      this.options.policy,
      this.options.projection,
      spellings,
    );
    this.addresses = {
      navigationId: context.navigationId,
      spellings,
      value,
    };
    return value;
  }

  /**
   * The addresses a switcher may offer, which are the ones that select the locale they are for.
   *
   * A switcher option becomes an `href` on an anchor, and an `href` is a public claim that
   * following it takes the reader to that locale: in a new tab, from a copied link, from the
   * status bar. That is the same claim the head's `hreflang` makes to a crawler, so it is decided
   * by the same question and the same function: does arriving at this address, with nothing said
   * about preference, yield this locale?
   *
   * Under `path-prefix` and `locale-host` the answer is yes for every locale, because the prefix or
   * the origin is the locale, and the switcher is unchanged. Under `locale-neutral` it is yes only
   * where the route's own spelling distinguishes the locale: an address that every locale shares
   * serves whoever asks whatever their preference says, and an address built from a per-locale slug
   * answers `308` back to the default spelling. Offering either as a link sends a reader who opened
   * it deliberately to a page in the wrong language.
   *
   * The switch itself is untouched by any of this. It runs in place, on the choice's locale, with
   * or without an address, which under a neutral policy is the only way a locale is ever chosen.
   *
   * This is *not* what `crossOriginAddress` reads. That answers where a host switch has to move the
   * document, which is a fact about the policy rather than a claim made to anyone, and it must stay
   * true for an origin whose address this filter would drop.
   */
  private switchableAddresses(
    context: RouteLocalizationContext,
    spellings: LocalizedParameterSpellings | undefined,
  ): Readonly<Record<string, string>> | undefined {
    const cached = this.switchable;
    if (
      cached !== undefined &&
      cached.navigationId === context.navigationId &&
      cached.spellings === spellings
    ) {
      return cached.value;
    }
    const { policy, projection } = this.options;
    const offered = Object.entries(
      this.addressesFor(context, spellings),
    ).filter(([locale, address]) =>
      addressSelectsLocale(address, locale, policy, projection),
    );
    // Absent rather than empty, because that is what the snapshot's contract says an address record
    // means: a reader that has none is not a reader whose record failed to build.
    const value =
      offered.length === 0
        ? undefined
        : Object.freeze(Object.fromEntries(offered));
    this.switchable = {
      navigationId: context.navigationId,
      spellings,
      value,
    };
    return value;
  }

  /**
   * One route record, with the addresses a switcher can move to when there are any.
   *
   * `undefined` addresses is not a degraded record: a route whose slug has not been declared yet
   * has no address to give until it is.
   */
  private routeRecord(
    context: RouteLocalizationContext,
    addresses?: Readonly<Record<string, string>>,
  ): LocalizationRouteSnapshot {
    return Object.freeze({
      routeId: context.resolution.routeId,
      projectionIdentity: this.options.projection.generated.identity,
      canonicalPath: context.resolution.canonicalPath,
      ...(addresses === undefined ? {} : { addresses }),
    });
  }

  /**
   * Title, description and SEO for one route context, and the addresses that go on the record.
   *
   * Returns them rather than restating here, because publishing a snapshot re-runs the effect that
   * calls this: `onLocaleCommitted` guards against its own publish with `documentLocale`, and a
   * restate from inside would fire before that guard is armed. Each caller pushes at the point it
   * has already made safe.
   *
   * Throws; every caller decides what that means.
   */
  private projectDocument(
    context: RouteLocalizationContext,
  ): Readonly<Record<string, string>> | undefined {
    // By navigation id rather than "whatever is current". This projection and the declaration
    // service are both driven by `NavigationEnd` on one event stream, so asking for the current
    // declaration would make the head depend on which subscriber Angular calls first.
    const spellings = this.parameters.ɵforNavigation(context.navigationId);
    this.declaredSpellings = spellings;
    // One derivation, read twice. The head adds the origin and its eligibility rules below; the
    // switcher adds nothing and needs no origin, which is why this is derived here and not taken
    // out of the SEO projection: an application that configures no canonical origin projects no
    // SEO at all and still has a switcher.
    const addresses = this.addressesFor(context, spellings);
    const switchable = this.switchableAddresses(context, spellings);
    if (this.document === null) return switchable;
    const declared = this.declaredDocument(context.resolution.routeId);
    const dynamic =
      this.options.document === undefined
        ? {}
        : runInInjectionContext(this.environmentInjector, () =>
            this.options.document?.(context, this.localization),
          );
    // Merged field by field, and `social` merged one level deeper, because the two halves answer
    // different questions about one block: a catalog holds the alt text and the site name, and only
    // the application knows the image URL. A shallow merge would make declaring either one discard
    // the other, which is the kind of loss that shows up as a missing `og:image` on exactly the
    // routes that bothered to localize their alt text.
    const documentProjection = {
      ...declared,
      ...(dynamic ?? {}),
      ...(declared.social === undefined && dynamic?.social === undefined
        ? {}
        : { social: { ...declared.social, ...dynamic?.social } }),
    } as Omit<DocumentLocalizationProjection, 'seo'>;
    this.reportUntitledRoute(context.resolution.routeId, documentProjection);
    const seo =
      this.options.origin === undefined
        ? undefined
        : projectRouteSeo(
            context.resolution,
            this.options.policy,
            this.options.projection,
            this.options.configuration,
            this.options.origin,
            spellings,
            addresses,
            this.baseHref,
          );
    this.document.apply({
      ...documentProjection,
      // The locale is supplied here, not by the application. It is the locale Atlas has just
      // committed, and a projection that carried its own would be a second answer able to disagree
      // with the head, the URL and the catalogs at once.
      locale: context.resolution.locale,
      ...(seo === undefined ? {} : { seo }),
    });
    return switchable;
  }

  /**
   * The document projection follows the locale, not only the navigation.
   *
   * A locale change is not a navigation. With the address in the locale's spelling and the page
   * canonical, changing locale moves the address bar and nothing else, so nothing fires
   * `NavigationEnd` and without this the title, description and `hreflang` alternates would keep
   * the previous language on every switch. `lang` and `dir` do not need it: they are
   * written by a commit hook inside the locale transaction.
   *
   * A failure here is reported and not rolled back. The transaction that changed the locale
   * already committed, and undoing it from outside because a title write threw would be a larger
   * wrong than a stale title. Making this write part of the transaction is a real design, and it
   * would have to settle the `TitleStrategy` ordering to be one.
   */
  private onLocaleCommitted(locale: string): void {
    // The comparison is against the language the document currently states, not against the
    // previous value of this signal. An effect's first flush is not guaranteed to fall between
    // `initialize()` and the first `changeLocale`, in a zoneless test it does not, so a guard
    // written as "skip the first commit" skips the switch itself and the title never moves. This
    // one is a fact about the document rather than about how often the effect has run.
    if (locale === this.documentLocale) return;
    // Not while a navigation is in flight. `prepare` commits the locale before activation, so
    // this effect fires with the *previous* route's context still current: projecting it would
    // write the outgoing page's title a moment before `applyDocument` writes the incoming one's.
    if (this.pending.size > 0) return;
    const active = untracked(this.context);
    if (active === undefined) return;
    // Re-resolved, not reused. A context carries the resolution it was built from, and that
    // resolution names the locale it resolved *to*, so projecting the old one again reproduces
    // the outgoing language exactly. The rebuild produces the destination address for the target
    // locale, which is what the SEO projection and the consumer's `document` callback both need
    // to see.
    const rebuilt = this.reresolve(active, locale);
    if (rebuilt === undefined) return;
    try {
      const addresses = this.projectDocument(rebuilt);
      this.context.set(rebuilt);
      this.documentLocale = locale;
      // The same rebuild, stated once more where the snapshot can be read. `changeLocale` carries
      // the active record forward when the caller names none, and a switch names none, so without
      // this the snapshot reports the locale it moved to and the address it moved from. Set after
      // `documentLocale`, because publishing re-runs this effect and that is the guard that stops
      // it going round again.
      this.localization.ɵrestateRoute(this.routeRecord(rebuilt, addresses));
    } catch {
      this.commitPromise = Promise.resolve(
        Object.freeze({
          status: 'failed',
          transitionId: 0,
          mode: this.options.mode ?? 'coordinated',
          targetLocale: locale,
          diagnostic: effectDiagnostic(
            'Localized document effects failed after a locale change; the locale itself is committed.',
          ),
        }),
      );
    }
  }

  /**
   * Put the reader back when no navigation is going to do it.
   *
   * The same hazard as the document projection above, in the other direction. This adapter claims
   * the interaction coordinator at construction, so from then on every commit's focus, caret and
   * scroll restore is *parked* rather than run, and only `NavigationEnd` releases it. That was
   * right while a locale switch was a navigation. It is not one any more, so the restore was
   * parked and never released, and then fired on the next real navigation, putting the previous
   * page's scroll position on the page the reader had just opened.
   *
   * Running it here is safe precisely because nothing moved: with no navigation there is no
   * `RouterScroller` sending the page to the top, so the restore puts the reader where they
   * already are, and the important half is that the parked restore is cleared.
   *
   * `getCurrentNavigation()` rather than this adapter's own bookkeeping, because the answer wanted
   * is the Router's: mid-navigation the flush is skipped and `NavigationEnd` releases it, and once
   * that has happened `ɵflush` finds nothing parked and does nothing.
   */
  private releaseInteraction(): void {
    if (this.router.getCurrentNavigation() !== null) return;
    this.interaction.ɵflush(this.hostDocument.defaultView);
  }

  /**
   * Rebuild the head when the page declares its parameter spellings.
   *
   * A route whose slug has to be loaded has no localized alternates at the moment it commits,
   * the codec cannot produce them and nothing has declared them yet, so the head that
   * `NavigationEnd` built is correct and incomplete. This is what completes it.
   *
   * Nothing happens mid-navigation: `applyDocument` is about to project the incoming page with the
   * declaration already staged for it, and projecting here as well would write the outgoing page's
   * head a moment before.
   */
  private onParametersDeclared(
    spellings: LocalizedParameterSpellings | undefined,
  ): void {
    if (spellings === this.declaredSpellings) return;
    this.declaredSpellings = spellings;
    if (this.pending.size > 0) return;
    const active = untracked(this.context);
    if (active === undefined) return;
    try {
      // The declaration is what completes the addresses as well as the head: until it arrived, a
      // loaded slug had no spelling in any other locale, so the switcher had no link either.
      this.localization.ɵrestateRoute(
        this.routeRecord(active, this.projectDocument(active)),
      );
    } catch {
      // Same judgement as a failed locale commit: the page is on screen and correct, and the head
      // is missing alternates it did not have a moment ago either. Reported by the projection's
      // own diagnostics rather than turned into a navigation failure.
    }
  }

  /**
   * The same route, in another locale.
   *
   * `undefined` when the policy cannot express it as a path: under `locale-host` the address is
   * on another origin, and switching to it is a document navigation rather than anything this can
   * do. The document is then left stating the locale it still shows, which is the honest outcome.
   */
  private reresolve(
    context: RouteLocalizationContext,
    locale: string,
  ): RouteLocalizationContext | undefined {
    const { resolution } = context;
    if (resolution.locale === locale) return context;
    const target = buildLocalizedRoute(
      this.options.policy,
      this.options.projection,
      resolution.routeId,
      locale,
      resolution.parameters,
      resolution.query,
      resolution.fragment,
      this.parameters.ɵforNavigation(context.navigationId),
    );
    const next = resolveLocalizedRoute(
      target,
      this.options.policy,
      this.options.projection,
      {
        ...(this.options.origin === undefined
          ? {}
          : { origin: this.options.origin }),
      },
    );
    return next.status === 'success'
      ? Object.freeze({ resolution: next, navigationId: context.navigationId })
      : undefined;
  }

  private async restoreSnapshot(
    snapshot: ReturnType<Localization['snapshot']>,
  ): Promise<boolean> {
    if (snapshot === undefined) return false;
    const result = await this.localization.changeLocale(
      snapshot.primaryLocale,
      {
        mode: this.options.mode ?? 'coordinated',
        requiredScopes: snapshot.requiredScopes,
        route: snapshot.route ?? null,
      },
    );
    if (result.status !== 'committed') return false;
    const required = new Set(
      snapshot.requiredScopes.map(
        ({ providerId, scopeId }) => `${providerId}\u0000${scopeId}`,
      ),
    );
    try {
      for (const scope of snapshot.loadedScopes) {
        if (required.has(`${scope.providerId}\u0000${scope.scopeId}`)) continue;
        await this.localization.ensureScope(scope);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async restoreUrl(url: string): Promise<boolean> {
    if (this.router.url === url) return true;
    this.restoringUrl = true;
    try {
      return await this.router.navigateByUrl(url, { replaceUrl: true });
    } catch {
      return false;
    } finally {
      this.restoringUrl = false;
    }
  }
}
