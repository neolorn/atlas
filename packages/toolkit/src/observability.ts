/**
 * What the toolkit reports while it works, in codes rather than sentences.
 *
 * `specs/11-diagnostics-and-observability.spec.md` section 7 bounds an event to a profile
 * marker, a code, a phase, a status, bounded identities, and bounded counts and durations, and
 * lets the toolkit carry its own shape under its own marker. A compilation phase and a
 * transition phase are different vocabularies, and one union of both would name neither.
 */

import type { AtlasDiagnosticCode } from './diagnostics.js';

/**
 * The version stamp every toolkit event carries, so a reader knows what shape it is reading.
 *
 * Distinct from the runtime's own stamp, because a compilation phase and a locale transition are
 * different vocabularies and one union of both would name neither.
 */
export const ATLAS_TOOLKIT_OBSERVABILITY_PROFILE =
  'atlas-toolkit-observability-event/1' as const;

/**
 * The three areas the toolkit reports on, as stable codes for filtering a log.
 *
 * A code never changes and is never reused. The wording of an event may change; the code is the
 * identity.
 */
export const ATLAS_TOOLKIT_EVENT_CODES = Object.freeze({
  compilation: 'ATL-E1001',
  interchange: 'ATL-E1002',
  migration: 'ATL-E1003',
} as const);

/** Any of the three codes. Worth naming when a sink switches on one. */
export type AtlasToolkitEventCode =
  (typeof ATLAS_TOOLKIT_EVENT_CODES)[keyof typeof ATLAS_TOOLKIT_EVENT_CODES];

/**
 * Which part of the work an event is about, in words rather than as a code.
 *
 * Carried beside the code, so a log reads without a lookup table. The eight follow the order the
 * work happens in, from reading the configuration to writing the generated tree.
 */
export type AtlasToolkitEventPhase =
  | 'configuration'
  | 'catalog'
  | 'analysis'
  | 'compilation'
  | 'generation'
  | 'interchange'
  | 'migration'
  | 'integration';

/**
 * How the reported work ended.
 *
 * `started` pairs with a later one. `unchanged` is a success that wrote nothing, which is the
 * ordinary outcome of building a project nobody has edited.
 */
export type AtlasToolkitEventStatus =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'unchanged';

/**
 * One thing the toolkit reports, with no message text and no file content in it.
 *
 * Everything past the first four fields is optional and present only where it means something.
 * Identities are bounded and counts are checked before they go on an event, so a field that
 * survived is one a log can hold.
 */
export interface AtlasToolkitObservabilityEvent {
  /** The event shape's version. */
  readonly profile: typeof ATLAS_TOOLKIT_OBSERVABILITY_PROFILE;
  /** Which of the three areas this is about. */
  readonly code: AtlasToolkitEventCode;
  /** Which part of the work, in words. */
  readonly phase: AtlasToolkitEventPhase;
  /** How it ended. */
  readonly status: AtlasToolkitEventStatus;
  /** The first diagnostic's code, on a failure, so a log can say why without carrying the text. */
  readonly diagnosticCode?: AtlasDiagnosticCode;
  /** Which package's catalogs this concerns. */
  readonly providerId?: string;
  /** Which scope within that package. */
  readonly scopeId?: string;
  /** Which locale, on work that is per locale. */
  readonly locale?: string;
  /** Ties several events to one invocation, so a build's events group together. */
  readonly operationId?: string;
  /** How many of whatever was counted: files written, catalogs compiled, messages migrated. */
  readonly count?: number;
  /** How long the work took. Absent where there was nothing to time. */
  readonly durationMilliseconds?: number;
}

/**
 * Where toolkit events go. Supply one on an operation; with none, no event is built at all.
 *
 * Atlas ships no transport and knows no endpoint, so this is the whole contract. It must not throw
 * and must not block: an event is raised in the middle of a build somebody is waiting on.
 */
export interface AtlasToolkitObservabilitySink {
  /** Called once per event, in the order the events occur. */
  emit(event: AtlasToolkitObservabilityEvent): void;
}

/** Mixed into every operation that may report: a sink, or nothing and no reporting. */
export interface AtlasToolkitObservabilityOptions {
  /** Where to send events. Omit it and none are built. */
  readonly observability?: AtlasToolkitObservabilitySink;
}

type EventInput = Omit<AtlasToolkitObservabilityEvent, 'profile'>;

interface SinkState {
  readonly failures: Map<string, number>;
}

const sinkStates = new WeakMap<AtlasToolkitObservabilitySink, SinkState>();

function boundedIdentity(value: string | undefined): string | undefined {
  return value === undefined ||
    value.length === 0 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    ? undefined
    : value;
}

function boundedCount(value: number | undefined): number | undefined {
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

export function emitAtlasToolkitEvent(
  sink: AtlasToolkitObservabilitySink | undefined,
  input: EventInput,
): void {
  if (sink === undefined) return;
  const providerId = boundedIdentity(input.providerId);
  const scopeId = boundedIdentity(input.scopeId);
  const locale = boundedIdentity(input.locale);
  const operationId = boundedIdentity(input.operationId);
  const count = boundedCount(input.count);
  const durationMilliseconds = boundedDuration(input.durationMilliseconds);
  const event: AtlasToolkitObservabilityEvent = Object.freeze({
    profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
    code: input.code,
    phase: input.phase,
    status: input.status,
    ...(input.diagnosticCode === undefined
      ? {}
      : { diagnosticCode: input.diagnosticCode }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(scopeId === undefined ? {} : { scopeId }),
    ...(locale === undefined ? {} : { locale }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(count === undefined ? {} : { count }),
    ...(durationMilliseconds === undefined ? {} : { durationMilliseconds }),
  });

  if (event.status === 'failed') {
    const now = Date.now();
    const key = [
      event.code,
      event.phase,
      event.diagnosticCode ?? '',
      event.providerId ?? '',
      event.scopeId ?? '',
      event.locale ?? '',
    ].join('\u0000');
    const state =
      sinkStates.get(sink) ??
      Object.freeze({ failures: new Map<string, number>() });
    sinkStates.set(sink, state);
    const previous = state.failures.get(key);
    if (previous !== undefined && now - previous < 1_000) return;
    if (state.failures.size >= 128) {
      const oldest = state.failures.keys().next().value as string | undefined;
      if (oldest !== undefined) state.failures.delete(oldest);
    }
    state.failures.set(key, now);
  }

  try {
    sink.emit(event);
  } catch {
    // Observability is optional and cannot affect compiler or authoring work.
  }
}
