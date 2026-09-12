// What Atlas reports about its own operation, in codes rather than sentences.
//
// `specs/08-formatting-parsing-and-domain.spec.md` section 11 keeps localized text out of a log,
// a metric, an analytics record, a security event and a protocol field, so an event means the
// same thing whichever language the page was rendered in and can still be searched a year later
// by whoever is holding the incident. A localized presentation is derived from an event at an
// explicit boundary, which leaves the event itself unchanged.
//
// `specs/11-diagnostics-and-observability.spec.md` section 6 keeps the sink optional and the
// transport out. Atlas has no endpoint, no account and no collector, and with no sink
// configured it builds no event at all, so an application that wants none pays nothing for
// the capability.

import { type LocalizationFailureCode } from '@neolorn/atlas/core';

/**
 * The version stamp every runtime event carries, so a consumer of the stream can tell what shape
 * it is reading. It changes when the event's fields change in a way a reader would notice.
 */
export const RUNTIME_OBSERVABILITY_PROFILE =
  'atlas-runtime-observability-event/1' as const;

/**
 * One stable code per area the runtime reports on, for filtering a log without matching on words.
 *
 * The codes never change and are never reused, which is what lets a dashboard written today keep
 * working. The wording of an event may change; the code is the identity.
 */
export const RUNTIME_EVENT_CODES = Object.freeze({
  initialization: 'ATL-E2001',
  catalog: 'ATL-E2002',
  transition: 'ATL-E2003',
  formatting: 'ATL-E2004',
  cache: 'ATL-E2005',
  ssrHydration: 'ATL-E2006',
  integration: 'ATL-E2007',
  persistence: 'ATL-E2008',
} as const);

/** Any of the eight codes. Worth naming when a sink switches on one. */
export type LocalizationEventCode =
  (typeof RUNTIME_EVENT_CODES)[keyof typeof RUNTIME_EVENT_CODES];

/**
 * Which part of localization an event is about, in words rather than as a code.
 *
 * It matches the code one for one and is carried alongside it, so a log is readable without a
 * lookup table.
 */
export type LocalizationEventPhase =
  | 'initialization'
  | 'catalog'
  | 'transition'
  | 'formatting'
  | 'cache'
  | 'ssr-hydration'
  | 'integration'
  | 'persistence';

/** How the work ended. Seven of the eight are terminal; `started` pairs with a later one. */
export type LocalizationEventStatus =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'superseded'
  | 'unavailable'
  | 'recovered'
  /**
   * The work was not done here, and the event names where it belongs instead.
   *
   * A locale change under a `locale-host` policy is the case: the locale is the origin, so the
   * change is a document navigation rather than a transition. `succeeded` would claim a transition
   * that never ran, and `failed` would claim a defect: this is the correct outcome, reported.
   */
  | 'redirected';

/**
 * One thing the runtime reports, with no localized text anywhere in it.
 *
 * Everything beyond the first four fields is optional and present only where it means something,
 * so a formatting failure carries no participant and a transition carries no scope. Identities are
 * bounded and counts are checked before they are put on an event, so a field that survived is one a
 * log can hold.
 */
export interface LocalizationObservabilityEvent {
  /** The event shape's version, so a reader knows what the rest of the fields are. */
  readonly profile: typeof RUNTIME_OBSERVABILITY_PROFILE;
  /** What this is about, as the stable code. */
  readonly code: LocalizationEventCode;
  /** The same thing in words, so the line reads without a lookup. */
  readonly phase: LocalizationEventPhase;
  /** How it ended. */
  readonly status: LocalizationEventStatus;
  /** Why it failed, as a code from the diagnostic vocabulary. Present only on a failure. */
  readonly reason?: LocalizationFailureCode;
  /** The locale the work was for, which on a change is the one being moved to. */
  readonly targetLocale?: string;
  /** The locale that actually answered, which differs from the target when something fell back. */
  readonly supplyingLocale?: string;
  /** Which package's catalogs this concerns, for an application that composes several. */
  readonly providerId?: string;
  /** Which scope within that provider. */
  readonly scopeId?: string;
  /** Which participant this is about, on an event raised by one. */
  readonly participantId?: string;
  /** Ties this to work outside Atlas, when the application supplied an identifier to tie it to. */
  readonly correlationId?: string;
  /** Which locale change this belongs to, so the events of one transaction group together. */
  readonly transitionId?: number;
  /** Which committed snapshot was current, so an event can be placed against what was on screen. */
  readonly snapshotId?: number;
  /** How many were counted: catalogs loaded, messages evaluated, participants prepared. */
  readonly count?: number;
  /** How long the work took. Absent where there was nothing to time. */
  readonly durationMilliseconds?: number;
}

/**
 * Where events go. Supply one with `withObservability`; with none, no event is built at all.
 *
 * Atlas ships no transport and knows no endpoint, so this is the whole of the contract: forwarding,
 * batching and sampling belong to whoever implements it. It must not throw and must not block; an
 * event is raised in the middle of work a reader is waiting on.
 */
export interface LocalizationObservabilitySink {
  /** Called once per event, in the order the events occur. */
  emit(event: LocalizationObservabilityEvent): void;
}

/** Mixed into anything that may report: a sink, or nothing and no reporting. */
export interface LocalizationObservabilityOptions {
  /** Where to send events. Omit it and none are built. */
  readonly observability?: LocalizationObservabilitySink;
}

export type LocalizationEventInput = Omit<
  LocalizationObservabilityEvent,
  'profile'
>;

export interface LocalizationEventEmitter {
  emit(input: LocalizationEventInput): void;
}

// `specs/11-diagnostics-and-observability.spec.md` section 8 bounds what a failing system can
// emit. A broken catalog, a retry loop or a missing message repeats at whatever rate the
// application renders at, so equivalent failures collapse inside the window, and the set of
// identities remembered is capped and gives up the oldest first so the map cannot grow with
// the failures it is there to suppress.
const FAILURE_DEDUPLICATION_WINDOW_MILLISECONDS = 1_000;
const MAXIMUM_FAILURE_IDENTITIES = 128;

function boundedIdentity(value: string | undefined): string | undefined {
  return value === undefined ||
    value.length === 0 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    ? undefined
    : value;
}

function boundedInteger(value: number | undefined): number | undefined {
  return value === undefined ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 1_000_000_000
    ? undefined
    : value;
}

function boundedDuration(value: number | undefined): number | undefined {
  return value === undefined ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 86_400_000
    ? undefined
    : Math.round(value * 1000) / 1000;
}

function emitLocalizationEvent(
  sink: LocalizationObservabilitySink | undefined,
  failures: Map<string, number>,
  input: LocalizationEventInput,
): void {
  if (sink === undefined) return;
  const targetLocale = boundedIdentity(input.targetLocale);
  const supplyingLocale = boundedIdentity(input.supplyingLocale);
  const providerId = boundedIdentity(input.providerId);
  const scopeId = boundedIdentity(input.scopeId);
  const participantId = boundedIdentity(input.participantId);
  const correlationId = boundedIdentity(input.correlationId);
  const transitionId = boundedInteger(input.transitionId);
  const snapshotId = boundedInteger(input.snapshotId);
  const count = boundedInteger(input.count);
  const durationMilliseconds = boundedDuration(input.durationMilliseconds);
  const event: LocalizationObservabilityEvent = Object.freeze({
    profile: RUNTIME_OBSERVABILITY_PROFILE,
    code: input.code,
    phase: input.phase,
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(targetLocale === undefined ? {} : { targetLocale }),
    ...(supplyingLocale === undefined ? {} : { supplyingLocale }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(scopeId === undefined ? {} : { scopeId }),
    ...(participantId === undefined ? {} : { participantId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(transitionId === undefined ? {} : { transitionId }),
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(count === undefined ? {} : { count }),
    ...(durationMilliseconds === undefined ? {} : { durationMilliseconds }),
  });

  if (
    event.status === 'failed' ||
    event.status === 'unavailable' ||
    event.status === 'cancelled' ||
    event.status === 'superseded'
  ) {
    const now = Date.now();
    const key = [
      event.code,
      event.phase,
      event.status,
      event.reason ?? '',
      event.providerId ?? '',
      event.scopeId ?? '',
      event.targetLocale ?? '',
    ].join('\u0000');
    const previous = failures.get(key);
    if (
      previous !== undefined &&
      now - previous < FAILURE_DEDUPLICATION_WINDOW_MILLISECONDS
    ) {
      return;
    }
    if (failures.size >= MAXIMUM_FAILURE_IDENTITIES) {
      const oldest = failures.keys().next().value as string | undefined;
      if (oldest !== undefined) failures.delete(oldest);
    }
    failures.set(key, now);
  }

  try {
    sink.emit(event);
  } catch {
    // Optional sinks cannot influence localization state or escape SSR requests.
  }
}

export function createLocalizationEventEmitter(
  sink: LocalizationObservabilitySink | undefined,
): LocalizationEventEmitter | undefined {
  if (sink === undefined) return undefined;
  const failures = new Map<string, number>();
  return Object.freeze({
    emit: (input: LocalizationEventInput): void => {
      emitLocalizationEvent(sink, failures, input);
    },
  });
}
