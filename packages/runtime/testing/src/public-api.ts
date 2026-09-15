// Seven exports, and the reason two of them are about the environment rather than the runtime.
//
// `specs/06-runtime-and-angular.spec.md` section 12 fixes this surface: the testing providers, an
// in-memory loader factory, a controllable participant, a controller over deferred loads and
// participant attempts, a rendered-text helper, an environment reset, and a server seat. Nothing
// here reaches the network or shares state between specs.
//
// The reset is here because an Angular test host reuses one DOM across spec files, so every file
// in a worker sees the same address bar, cookie jar and web storage, and Atlas reads the locale
// from the address when routing is installed and from a store when persistence is. Every consumer
// inherits both halves together, so the reset that puts that state back is published rather than
// described.

export {
  answeredHead,
  createLocalizedServerSeat,
  type AnsweredAddress,
  type AnsweredHead,
  type AnsweredLink,
  type AnsweredPageOutcome,
  type AnsweredRequestInit,
  type LocalizedServerSeat,
  type LocalizedServerSeatOptions,
} from './server-seat.js';

import {
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import {
  LocalizationError,
  provideLocalizationSetup,
  type CatalogLoaders,
  type LocalizationFeature,
  type LocalizationParticipant,
  type LocalizationParticipantCommitReport,
  type LocalizationParticipantContext,
  type LocalizationParticipantOperationalReason,
  type LocalizationParticipantReport,
  type LocalizationScope,
  type LocalizationSetup,
} from '@neolorn/atlas';

interface DeferredPlan {
  readonly started: Promise<void>;
  readonly gate: Promise<void>;
  start(): void;
  release(): void;
  fail(): void;
}

/**
 * A hold placed on one catalog load, so a test can watch the application while it is waiting.
 *
 * The load is suspended after it has been asked for and before it answers. Nothing else in the
 * transaction is held, so what a test observes in that window is what a reader would see.
 */
export interface DeferredCatalogLoad {
  /** Settles once the application has asked for this catalog. Await it before asserting. */
  readonly started: Promise<void>;
  /** Lets the load finish and deliver the catalog it was always going to deliver. */
  release(): void;
  /** Ends the load as an operational failure instead, which is what a lost network looks like. */
  fail(): void;
}

interface ParticipantPlan {
  readonly started: Promise<LocalizationParticipantContext>;
  readonly gate: Promise<LocalizationParticipantReport>;
  start(context: LocalizationParticipantContext): void;
  complete(report: LocalizationParticipantReport): void;
  reject(): void;
}

/**
 * A hold placed on one participant preparation, so a test decides when and how that vote lands.
 *
 * Every other participant runs normally while this one is held, which is what makes the ordering
 * of a locale change observable rather than inferred from timing.
 */
export interface DeferredParticipantAttempt {
  /**
   * Settles with the context the participant was prepared with, once preparation has begun.
   *
   * The context names the locale being moved to and the scopes in the transaction, so a test can
   * assert on what was asked before deciding what to answer.
   */
  readonly started: Promise<LocalizationParticipantContext>;
  /** Answers with the report given, which is how a test supplies a vote of any shape. */
  complete(report: LocalizationParticipantReport): void;
  /**
   * Answers with a failed report, defaulting to an internal failure.
   *
   * This is the ordinary way a participant refuses: the transaction is abandoned and every
   * participant that already prepared is rolled back.
   */
  fail(reason?: LocalizationParticipantOperationalReason): void;
  /**
   * Throws out of preparation instead of reporting.
   *
   * A participant that throws rather than returns is the case an application does not write on
   * purpose, and the one whose handling is worth a test.
   */
  reject(): void;
}

function catalogIdentity(scope: LocalizationScope, locale: string): string {
  return `${scope.providerId}:${scope.scopeId}:${locale}`;
}

function deferredPlan(): DeferredPlan {
  let start!: () => void;
  let release!: () => void;
  let reject!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const gate = new Promise<void>((resolve, rejectPromise) => {
    release = resolve;
    reject = () =>
      rejectPromise(
        new LocalizationError({
          code: 'catalog-load-failed',
          outcome: 'operational-failure',
          message: 'The deterministic testing catalog load failed.',
        }),
      );
  });
  return { started, gate, start, release, fail: reject };
}

function participantPlan(): ParticipantPlan {
  let start!: (context: LocalizationParticipantContext) => void;
  let complete!: (report: LocalizationParticipantReport) => void;
  let reject!: () => void;
  const started = new Promise<LocalizationParticipantContext>((resolve) => {
    start = resolve;
  });
  const gate = new Promise<LocalizationParticipantReport>(
    (resolve, rejectPromise) => {
      complete = resolve;
      reject = () =>
        rejectPromise(
          new LocalizationError({
            code: 'participant-failed',
            outcome: 'operational-failure',
            message: 'The deterministic testing participant failed.',
          }),
        );
    },
  );
  return { started, gate, start, complete, reject };
}

/**
 * A participant that records what it was asked and answers when a test tells it to.
 *
 * Registered like any other participant. Left alone it reports ready and gets out of the way, so
 * it can stand in for a real participant in a test that is about something else. `deferNext` is
 * what turns it into an instrument: it holds the next preparation open until the test answers.
 *
 * The four arrays are the record of the transaction from this participant's side, in the order the
 * calls arrived, so a test asserts on the sequence rather than on a final state that cannot say
 * how it was reached.
 */
export class ControllableLocalizationParticipant implements LocalizationParticipant {
  private readonly plans: ParticipantPlan[] = [];
  private readonly defaultReport: LocalizationParticipantReport;
  /** Every preparation this participant was asked for, oldest first. */
  readonly contexts: LocalizationParticipantContext[] = [];
  /** The commit report for each transaction that went through, oldest first. */
  readonly committed: LocalizationParticipantCommitReport[] = [];
  /** The commit report for each transaction that was undone after this one had prepared. */
  readonly rolledBack: LocalizationParticipantCommitReport[] = [];
  /**
   * One entry per preparation that was thrown away before it could be committed.
   *
   * The entry is the report this participant gave, or `undefined` when it never got to give one,
   * which is what a transaction superseded mid-flight looks like from here.
   */
  readonly discarded: (LocalizationParticipantReport | undefined)[] = [];
  /** How many times this participant has been torn down. Anything above one is a defect. */
  disposeCount = 0;

  constructor(
    /** Identifies this participant in reports and in the diagnostics of a failed change. */
    readonly id: string,
    defaultReport: LocalizationParticipantReport = Object.freeze({
      status: 'ready',
      representation: Object.freeze({ kind: 'language-independent' }),
    }),
  ) {
    this.defaultReport = defaultReport;
  }

  /**
   * Holds the next preparation open and returns the handle that answers it.
   *
   * Calling it more than once queues the holds, one per preparation, in the order they were made.
   * A preparation that arrives with the queue empty gets the default report immediately.
   */
  deferNext(): DeferredParticipantAttempt {
    const plan = participantPlan();
    this.plans.push(plan);
    return Object.freeze({
      started: plan.started,
      complete: (report: LocalizationParticipantReport) =>
        plan.complete(report),
      fail: (
        reason: LocalizationParticipantOperationalReason = 'internal-failure',
      ) =>
        plan.complete(
          Object.freeze({
            status: 'failed',
            outcome: 'operational-failure',
            reason,
          }),
        ),
      reject: () => plan.reject(),
    });
  }

  /**
   * Records the context and answers it: with a queued hold if there is one, otherwise at once.
   *
   * Called by the locale transaction rather than by a test.
   */
  prepare(
    context: LocalizationParticipantContext,
  ):
    | LocalizationParticipantReport
    | PromiseLike<LocalizationParticipantReport> {
    this.contexts.push(context);
    const plan = this.plans.shift();
    if (plan === undefined) return this.defaultReport;
    plan.start(context);
    return plan.gate;
  }

  /** Records the commit. Called by the transaction once every participant has agreed. */
  commit(
    _context: LocalizationParticipantContext,
    report: LocalizationParticipantCommitReport,
  ): void {
    this.committed.push(report);
  }

  /** Records the rollback. Called by the transaction when a later participant refused. */
  rollback(
    _context: LocalizationParticipantContext,
    report: LocalizationParticipantCommitReport,
  ): void {
    this.rolledBack.push(report);
  }

  /**
   * Records a preparation that will never be committed. Called by the transaction.
   *
   * The report is absent when this participant had not answered yet.
   */
  discard(
    _context: LocalizationParticipantContext,
    report?: LocalizationParticipantReport,
  ): void {
    this.discarded.push(report);
  }

  /** Counts the teardown. Called when the injector this participant was registered in goes away. */
  dispose(): void {
    this.disposeCount += 1;
  }
}

/**
 * The handle on catalog loading, injected from the providers `provideLocalizationTesting` installs.
 *
 * It wraps the loaders a setup declares rather than replacing them, so what a test exercises is the
 * application's own generated catalogs. What it adds is a way to hold one load open and a count of
 * how many times each was asked for, which is how loading once rather than on every render is
 * something a test can state.
 */
export class LocalizationTestingController {
  private readonly plans = new Map<string, DeferredPlan[]>();
  private readonly counts = new Map<string, number>();
  /**
   * The wrapped loaders to hand to the setup, in place of the ones it declared.
   *
   * `provideLocalizationTesting` does that substitution already. Reach for this only when
   * assembling the providers by hand.
   */
  readonly catalogLoaders: CatalogLoaders;

  constructor(loaders: CatalogLoaders) {
    this.catalogLoaders = Object.freeze(
      Object.fromEntries(
        Object.entries(loaders).map(([identity, loader]) => [
          identity,
          async () => {
            this.counts.set(identity, (this.counts.get(identity) ?? 0) + 1);
            const plan = this.plans.get(identity)?.shift();
            if (plan !== undefined) {
              plan.start();
              await plan.gate;
            }
            return loader();
          },
        ]),
      ),
    );
  }

  /**
   * Holds the next load of one scope in one locale, and returns the handle that releases it.
   *
   * Takes the scope and the locale tag that name the catalog. Calling it more than once for the
   * same pair queues the holds in order. It throws if the setup declares no loader for that pair,
   * because a hold on a load that will never happen would make a test wait for nothing.
   */
  deferNext(scope: LocalizationScope, locale: string): DeferredCatalogLoad {
    const identity = catalogIdentity(scope, locale);
    if (typeof this.catalogLoaders[identity] !== 'function') {
      throw new LocalizationError({
        code: 'scope-unavailable',
        outcome: 'localized-representation-unavailable',
        message: `No generated testing catalog exists for ${identity}.`,
      });
    }
    const plan = deferredPlan();
    const queue = this.plans.get(identity) ?? [];
    queue.push(plan);
    this.plans.set(identity, queue);
    return Object.freeze({
      started: plan.started,
      release: () => plan.release(),
      fail: () => plan.fail(),
    });
  }

  /**
   * How many times one catalog has been asked for, counting from when the controller was made.
   *
   * Returns zero for a pair that has never been loaded, including one no loader exists for.
   */
  loadCount(scope: LocalizationScope, locale: string): number {
    return this.counts.get(catalogIdentity(scope, locale)) ?? 0;
  }
}

/**
 * The providers a spec installs instead of `provideLocalizationSetup`.
 *
 * Takes the same setup and the same features, and adds a `LocalizationTestingController` that a
 * test injects. The setup's catalog loaders are wrapped before they are installed, so loading goes
 * through the controller without the setup being written differently for a test.
 *
 * Nothing here reaches the network or keeps state between specs, which is what makes an assertion
 * about ordering repeatable.
 */
export function provideLocalizationTesting(
  setup: LocalizationSetup,
  ...features: readonly LocalizationFeature[]
): EnvironmentProviders {
  const controller = new LocalizationTestingController(setup.catalogLoaders);
  return makeEnvironmentProviders([
    {
      provide: LocalizationTestingController,
      useValue: controller,
    },
    provideLocalizationSetup(
      {
        ...setup,
        catalogLoaders: controller.catalogLoaders,
      },
      ...features,
    ),
  ]);
}

/**
 * Catalog loaders over artifacts a test already holds.
 *
 * A thunk that resolves the wrapper it was handed rather than the compiled catalog inside it
 * delivers an object catalog admission refuses, which leaves the helper unusable. The compiled
 * artifact is a named field for that reason: `catalog` and `{ key }` are indistinguishable to a
 * reader when only one of them is spelled out.
 */
export function createInMemoryCatalogLoaders(
  catalogs: readonly {
    readonly key: {
      readonly providerId: string;
      readonly scopeId: string;
      readonly catalogLocale: string;
    };
    /** The compiled catalog artifact, exactly as generation emits it. */
    readonly catalog: unknown;
  }[],
): CatalogLoaders {
  return Object.freeze(
    Object.fromEntries(
      catalogs.map(({ key, catalog }) => [
        catalogIdentity(key, key.catalogLocale),
        () => Promise.resolve(catalog),
      ]),
    ),
  );
}

/**
 * The text of an element with its whitespace collapsed, so an assertion reads like the sentence.
 *
 * Takes any element and returns its text with runs of whitespace reduced to one space and the ends
 * trimmed. A template's own line breaks and indentation are the reason a rendered message rarely
 * equals the string it came from, and they are not what a test is about.
 */
export function renderedText(element: Element): string {
  return element.textContent.replace(/\s+/gu, ' ').trim();
}

/**
 * Put back the environment state a localization test moves.
 *
 * A test host that reuses one DOM across spec files hands every file in a worker the same address
 * bar, the same cookie jar and the same web storages. Angular's own unit-test builder does exactly
 * that by default (`isolate: false`, chosen to match the runner it replaced) and Atlas resolves
 * the locale from the address when routing is configured, and from a persistence store when one is.
 * So a spec that navigates hands the next file a page in another locale: an Arabic heading under an
 * English assertion, in an application with nothing wrong in it. How many files share a DOM is the
 * worker count, and the worker count is the core count, so whether it happens at all is a property
 * of the machine: green on a developer's thirty-two threads, red on a runner's two.
 *
 * Every consumer inherits both halves of that together, Angular's default and Atlas's address
 * source, so the reset belongs to Atlas rather than to each application that has to remember it.
 * Call it from a global `afterEach`. It takes no arguments, so it can be passed as one, and it does
 * nothing where there is nothing to reset: a server-side test environment has no document, and the
 * same setup file is loaded for both.
 */
export function resetLocalizationTestEnvironment(): void {
  if (typeof document !== 'undefined') {
    // Only what a path of `/` can reach, which is what Atlas's own stores write.
    for (const pair of document.cookie.split(';')) {
      const name = pair.split('=')[0]?.trim();
      if (name !== undefined && name !== '') {
        document.cookie = `${name}=; Path=/; Max-Age=0`;
      }
    }
  }
  if (typeof history !== 'undefined') {
    history.replaceState(null, '', '/');
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
  }
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.clear();
  }
}
