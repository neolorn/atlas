/**
 * The regions of a page whose content is the application's rather than a catalog's.
 *
 * `specs/06-runtime-and-angular.spec.md` section 8 hands a participant the target locale, the
 * formatting context, the transition identity and a cancellation signal, and takes back a report
 * and nothing else. The payload stays in the consumer's own store, which is why a report carries
 * a representation and a bounded identity rather than content.
 *
 * The four report kinds are not interchangeable. Unavailable means the content exists in no
 * locale and fails a required transition; content that exists in another locale is reported ready
 * with that locale as the supplying one, so the region can declare the language it is really in.
 */

import {
  directionForLocale,
  LocalizationError,
  type FormattingContext,
  type LocalizationDiagnostic,
  type LocalizationParticipant,
  type LocalizationParticipantAttempt,
  type LocalizationParticipantCommitReport,
  type LocalizationParticipantContext,
  type LocalizationParticipantCoordination,
  type LocalizationParticipantCurrent,
  type LocalizationParticipantIdentity,
  type LocalizationParticipantOperationalReason,
  type LocalizationParticipantOptions,
  type LocalizationParticipantReport,
  type LocalizationParticipantRepresentation,
  type LocalizationParticipantState,
} from '@neolorn/atlas/core';
import { type LocalizationParticipantRegistration } from './angular-contracts';
import { computed, signal, type Signal } from '@angular/core';
import { isRecord } from './runtime-safety';

function validCoordination(
  value: unknown,
): value is LocalizationParticipantCoordination {
  return value === 'required' || value === 'progressive';
}

const MAXIMUM_PARTICIPANTS = 128;
const MAXIMUM_MULTILINGUAL_LANGUAGES = 16;
const MAXIMUM_DEADLINE_MILLISECONDS = 2_147_483_647;
const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

export interface ParticipantTransferAttempt {
  readonly status:
    | 'preparing'
    | 'prepared'
    | 'ready'
    | 'unavailable'
    | 'domain-outcome'
    | 'failed';
  readonly targetLocale: string;
  readonly transitionId: number;
  readonly report?: LocalizationParticipantReport;
}

export interface ParticipantTransferRecord {
  readonly profile: 'atlas-participant-state/1';
  readonly participantId: string;
  readonly coordination: LocalizationParticipantCoordination;
  readonly current?: LocalizationParticipantCurrent;
  readonly attempt?: ParticipantTransferAttempt;
}

export interface RegisteredParticipant {
  readonly id: string;
  readonly coordination: LocalizationParticipantCoordination;
  readonly deadlineMilliseconds?: number;
}

interface ParticipantAdapter extends RegisteredParticipant {
  readonly prepare: LocalizationParticipant['prepare'];
  readonly commit?: LocalizationParticipant['commit'];
  readonly rollback?: LocalizationParticipant['rollback'];
  readonly discard?: LocalizationParticipant['discard'];
  readonly dispose?: LocalizationParticipant['dispose'];
  readonly stateValue: ReturnType<typeof signal<LocalizationParticipantState>>;
  transferred: boolean;
  work?: ParticipantWork;
}

interface ParticipantWork {
  readonly transitionId: number;
  readonly targetLocale: string;
  readonly controller: AbortController;
}

export interface PreparedParticipant {
  readonly adapter: RegisteredParticipant;
  readonly context: LocalizationParticipantContext;
  readonly report: LocalizationParticipantCommitReport;
}

interface InternalPreparedParticipant extends PreparedParticipant {
  readonly adapter: ParticipantAdapter;
  readonly previousState: LocalizationParticipantState;
  readonly unlink: () => void;
  readonly clearDeadline: () => void;
  finalized: boolean;
}

function keysWithin(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function canonicalLanguage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    return undefined;
  }
  try {
    const canonical = Intl.getCanonicalLocales(value)[0];
    return canonical === value ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function validDirection(value: unknown): value is 'ltr' | 'rtl' {
  return value === 'ltr' || value === 'rtl';
}

function sanitizeIdentity(
  value: unknown,
): LocalizationParticipantIdentity | undefined | false {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !keysWithin(value, [
      'resourceId',
      'representationId',
      'revision',
      'correlationId',
    ]) ||
    typeof value['resourceId'] !== 'string' ||
    !SAFE_IDENTITY_PATTERN.test(value['resourceId'])
  ) {
    return false;
  }
  for (const key of [
    'representationId',
    'revision',
    'correlationId',
  ] as const) {
    const field = value[key];
    if (
      field !== undefined &&
      (typeof field !== 'string' || !SAFE_IDENTITY_PATTERN.test(field))
    ) {
      return false;
    }
  }
  return Object.freeze({
    resourceId: value['resourceId'],
    ...(value['representationId'] === undefined
      ? {}
      : { representationId: value['representationId'] as string }),
    ...(value['revision'] === undefined
      ? {}
      : { revision: value['revision'] as string }),
    ...(value['correlationId'] === undefined
      ? {}
      : { correlationId: value['correlationId'] as string }),
  });
}

function sanitizeRepresentation(
  value: unknown,
): LocalizationParticipantRepresentation | undefined {
  if (!isRecord(value) || typeof value['kind'] !== 'string') return undefined;
  const direction = value['direction'];
  switch (value['kind']) {
    case 'locale-bound': {
      if (
        !keysWithin(value, ['kind', 'supplyingLocale', 'direction']) ||
        !validDirection(direction)
      ) {
        return undefined;
      }
      const supplyingLocale = canonicalLanguage(value['supplyingLocale']);
      if (
        supplyingLocale === undefined ||
        directionForLocale(supplyingLocale) !== direction
      ) {
        return undefined;
      }
      return Object.freeze({
        kind: 'locale-bound',
        supplyingLocale,
        direction,
      });
    }
    case 'language-independent':
    case 'unknown-language': {
      if (
        !keysWithin(value, ['kind', 'direction']) ||
        (direction !== undefined && !validDirection(direction))
      ) {
        return undefined;
      }
      return Object.freeze({
        kind: value['kind'],
        ...(direction === undefined ? {} : { direction }),
      });
    }
    case 'user-authored': {
      if (
        !keysWithin(value, ['kind', 'language', 'direction']) ||
        (direction !== undefined && !validDirection(direction))
      ) {
        return undefined;
      }
      const language =
        value['language'] === undefined
          ? undefined
          : canonicalLanguage(value['language']);
      if (
        (value['language'] !== undefined && language === undefined) ||
        (language !== undefined &&
          direction !== undefined &&
          directionForLocale(language) !== direction)
      ) {
        return undefined;
      }
      return Object.freeze({
        kind: 'user-authored',
        ...(language === undefined ? {} : { language }),
        ...(direction === undefined ? {} : { direction }),
      });
    }
    case 'fixed-language': {
      if (
        !keysWithin(value, ['kind', 'language', 'direction']) ||
        !validDirection(direction)
      ) {
        return undefined;
      }
      const language = canonicalLanguage(value['language']);
      if (
        language === undefined ||
        directionForLocale(language) !== direction
      ) {
        return undefined;
      }
      return Object.freeze({
        kind: 'fixed-language',
        language,
        direction,
      });
    }
    case 'multilingual': {
      if (
        !keysWithin(value, ['kind', 'languages', 'direction']) ||
        !Array.isArray(value['languages']) ||
        value['languages'].length < 2 ||
        value['languages'].length > MAXIMUM_MULTILINGUAL_LANGUAGES ||
        (direction !== undefined && !validDirection(direction))
      ) {
        return undefined;
      }
      const languages = new Map<
        string,
        { readonly language: string; readonly direction: 'ltr' | 'rtl' }
      >();
      for (const candidate of value['languages'] as readonly unknown[]) {
        if (
          !isRecord(candidate) ||
          !keysWithin(candidate, ['language', 'direction']) ||
          !validDirection(candidate['direction'])
        ) {
          return undefined;
        }
        const language = canonicalLanguage(candidate['language']);
        if (
          language === undefined ||
          directionForLocale(language) !== candidate['direction'] ||
          languages.has(language)
        ) {
          return undefined;
        }
        languages.set(
          language,
          Object.freeze({
            language,
            direction: candidate['direction'],
          }),
        );
      }
      return Object.freeze({
        kind: 'multilingual',
        languages: Object.freeze([...languages.values()]),
        ...(direction === undefined ? {} : { direction }),
      });
    }
    default:
      return undefined;
  }
}

function participantDiagnostic(
  code: LocalizationDiagnostic['code'],
  message: string,
  participantId: string,
  context: LocalizationParticipantContext,
  outcome: LocalizationDiagnostic['outcome'] = 'operational-failure',
): LocalizationDiagnostic {
  return Object.freeze({
    code,
    outcome,
    message,
    participantId,
    targetLocale: context.targetLocale,
    transitionId: context.transitionId,
  });
}

function contractError(
  participantId: string,
  context: LocalizationParticipantContext,
): LocalizationError {
  return new LocalizationError(
    participantDiagnostic(
      'participant-contract-rejected',
      'A localization participant returned invalid or unbounded metadata.',
      participantId,
      context,
    ),
  );
}

export function sanitizeParticipantReport(
  value: unknown,
): LocalizationParticipantReport | undefined {
  if (!isRecord(value) || typeof value['status'] !== 'string') return undefined;
  const identity = sanitizeIdentity(value['identity']);
  if (identity === false) return undefined;
  switch (value['status']) {
    case 'ready': {
      if (!keysWithin(value, ['status', 'representation', 'identity'])) {
        return undefined;
      }
      const representation = sanitizeRepresentation(value['representation']);
      if (representation === undefined) return undefined;
      return Object.freeze({
        status: 'ready',
        representation,
        ...(identity === undefined ? {} : { identity }),
      });
    }
    case 'unavailable':
      if (
        !keysWithin(value, ['status', 'outcome', 'identity']) ||
        value['outcome'] !== 'localized-representation-unavailable'
      ) {
        return undefined;
      }
      return Object.freeze({
        status: 'unavailable',
        outcome: 'localized-representation-unavailable',
        ...(identity === undefined ? {} : { identity }),
      });
    case 'domain-outcome': {
      if (
        !keysWithin(value, [
          'status',
          'outcome',
          'code',
          'representation',
          'identity',
        ]) ||
        value['outcome'] !== 'consumer-domain-outcome' ||
        typeof value['code'] !== 'string' ||
        !SAFE_IDENTITY_PATTERN.test(value['code'])
      ) {
        return undefined;
      }
      const representation =
        value['representation'] === undefined
          ? undefined
          : sanitizeRepresentation(value['representation']);
      if (
        value['representation'] !== undefined &&
        representation === undefined
      ) {
        return undefined;
      }
      return Object.freeze({
        status: 'domain-outcome',
        outcome: 'consumer-domain-outcome',
        code: value['code'],
        ...(representation === undefined ? {} : { representation }),
        ...(identity === undefined ? {} : { identity }),
      });
    }
    case 'failed': {
      const reasons = new Set([
        'invalid-configuration',
        'unsupported-capability',
        'compatibility-rejection',
        'security-rejection',
        'environment-failure',
        'internal-failure',
      ]);
      if (
        !keysWithin(value, ['status', 'outcome', 'reason', 'identity']) ||
        value['outcome'] !== 'operational-failure' ||
        typeof value['reason'] !== 'string' ||
        !reasons.has(value['reason'])
      ) {
        return undefined;
      }
      return Object.freeze({
        status: 'failed',
        outcome: 'operational-failure',
        reason: value['reason'] as LocalizationParticipantOperationalReason,
        ...(identity === undefined ? {} : { identity }),
      });
    }
    default:
      return undefined;
  }
}

function validTransitionIdentity(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sanitizeCurrent(
  value: unknown,
): LocalizationParticipantCurrent | undefined {
  if (
    !isRecord(value) ||
    !keysWithin(value, ['targetLocale', 'transitionId', 'report'])
  ) {
    return undefined;
  }
  const targetLocale = canonicalLanguage(value['targetLocale']);
  const report = sanitizeParticipantReport(value['report']);
  if (
    targetLocale === undefined ||
    !validTransitionIdentity(value['transitionId']) ||
    report === undefined ||
    report.status === 'failed'
  ) {
    return undefined;
  }
  return Object.freeze({
    targetLocale,
    transitionId: value['transitionId'],
    report,
  });
}

function sanitizeTransferAttempt(
  value: unknown,
): ParticipantTransferAttempt | undefined {
  if (
    !isRecord(value) ||
    !keysWithin(value, ['status', 'targetLocale', 'transitionId', 'report']) ||
    ![
      'preparing',
      'prepared',
      'ready',
      'unavailable',
      'domain-outcome',
      'failed',
    ].includes(value['status'] as string)
  ) {
    return undefined;
  }
  const targetLocale = canonicalLanguage(value['targetLocale']);
  const report =
    value['report'] === undefined
      ? undefined
      : sanitizeParticipantReport(value['report']);
  if (
    targetLocale === undefined ||
    !validTransitionIdentity(value['transitionId']) ||
    (value['report'] !== undefined && report === undefined) ||
    (value['status'] === 'preparing' && report !== undefined) ||
    (value['status'] !== 'preparing' &&
      value['status'] !== 'failed' &&
      report === undefined) ||
    (report !== undefined &&
      value['status'] !== 'prepared' &&
      value['status'] !== report.status)
  ) {
    return undefined;
  }
  return Object.freeze({
    status: value['status'] as ParticipantTransferAttempt['status'],
    targetLocale,
    transitionId: value['transitionId'],
    ...(report === undefined ? {} : { report }),
  });
}

export function sanitizeParticipantTransferRecords(
  value: unknown,
): readonly ParticipantTransferRecord[] | undefined {
  if (!Array.isArray(value) || value.length > MAXIMUM_PARTICIPANTS) {
    return undefined;
  }
  const records = new Map<string, ParticipantTransferRecord>();
  for (const item of value as readonly unknown[]) {
    if (
      !isRecord(item) ||
      !keysWithin(item, [
        'profile',
        'participantId',
        'coordination',
        'current',
        'attempt',
      ]) ||
      item['profile'] !== 'atlas-participant-state/1' ||
      typeof item['participantId'] !== 'string' ||
      !PARTICIPANT_ID_PATTERN.test(item['participantId']) ||
      (item['coordination'] !== 'required' &&
        item['coordination'] !== 'progressive') ||
      records.has(item['participantId'])
    ) {
      return undefined;
    }
    const current =
      item['current'] === undefined
        ? undefined
        : sanitizeCurrent(item['current']);
    const attempt =
      item['attempt'] === undefined
        ? undefined
        : sanitizeTransferAttempt(item['attempt']);
    if (
      (item['current'] !== undefined && current === undefined) ||
      (item['attempt'] !== undefined && attempt === undefined)
    ) {
      return undefined;
    }
    records.set(
      item['participantId'],
      Object.freeze({
        profile: 'atlas-participant-state/1',
        participantId: item['participantId'],
        coordination: item[
          'coordination'
        ] as LocalizationParticipantCoordination,
        ...(current === undefined ? {} : { current }),
        ...(attempt === undefined ? {} : { attempt }),
      }),
    );
  }
  return Object.freeze([...records.values()]);
}

function idleAttempt(): LocalizationParticipantAttempt {
  return Object.freeze({ status: 'idle' });
}

function stateFromTransfer(
  id: string,
  coordination: LocalizationParticipantCoordination,
  record: ParticipantTransferRecord | undefined,
): LocalizationParticipantState {
  const attempt: LocalizationParticipantAttempt =
    record?.attempt === undefined
      ? idleAttempt()
      : Object.freeze({
          status: record.attempt.status,
          targetLocale: record.attempt.targetLocale,
          transitionId: record.attempt.transitionId,
          ...(record.attempt.report === undefined
            ? {}
            : { report: record.attempt.report }),
        });
  return Object.freeze({
    participantId: id,
    coordination,
    ...(record?.current === undefined ? {} : { current: record.current }),
    attempt,
  });
}

function publicStatus(
  report: LocalizationParticipantCommitReport,
): 'ready' | 'unavailable' | 'domain-outcome' {
  return report.status;
}

function abortDiagnosticStatus(
  diagnostic: LocalizationDiagnostic,
): 'failed' | 'cancelled' | 'superseded' {
  return diagnostic.code === 'superseded'
    ? 'superseded'
    : diagnostic.code === 'cancelled' || diagnostic.code === 'disposed'
      ? 'cancelled'
      : 'failed';
}

function invokeDiscard(
  adapter: ParticipantAdapter,
  context: LocalizationParticipantContext,
  report?: LocalizationParticipantReport,
): void {
  try {
    const result = adapter.discard?.(context, report);
    if (result !== undefined) {
      throw new Error('Participant discard callbacks must be synchronous.');
    }
  } catch {
    // A consumer discard failure cannot resurrect or commit stale work.
  }
}

function asyncCallbackRejected(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

export class ParticipantCoordinator {
  private readonly adapters = new Map<string, ParticipantAdapter>();
  private readonly registryVersion = signal(0);
  private readonly transferred = new Map<string, ParticipantTransferRecord>();
  private disposed = false;

  readonly states: Signal<readonly LocalizationParticipantState[]> = computed(
    () => {
      this.registryVersion();
      return Object.freeze(
        [...this.adapters.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((adapter) => adapter.stateValue()),
      );
    },
  );

  constructor(transferred: readonly ParticipantTransferRecord[] = []) {
    for (const record of transferred) {
      this.transferred.set(record.participantId, record);
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new LocalizationError({
        code: 'disposed',
        outcome: 'operational-failure',
        message: 'The localization participant coordinator is disposed.',
      });
    }
  }

  register(
    participant: LocalizationParticipant,
    options: LocalizationParticipantOptions,
    retry: (participantId: string) => Promise<LocalizationParticipantState>,
  ): LocalizationParticipantRegistration {
    this.assertActive();
    // A participant and its options arrive from application code, so the mode is read as what
    // was passed and settled by the check below.
    const coordination: unknown = options.coordination ?? 'required';
    const deadline = options.deadlineMilliseconds;
    if (
      typeof participant.id !== 'string' ||
      !PARTICIPANT_ID_PATTERN.test(participant.id) ||
      typeof participant.prepare !== 'function' ||
      !validCoordination(coordination) ||
      (deadline !== undefined &&
        (!Number.isSafeInteger(deadline) ||
          deadline < 1 ||
          deadline > MAXIMUM_DEADLINE_MILLISECONDS)) ||
      this.adapters.has(participant.id) ||
      this.adapters.size >= MAXIMUM_PARTICIPANTS
    ) {
      throw new LocalizationError({
        code: 'invalid-configuration',
        outcome: 'operational-failure',
        message:
          'A localization participant registration is invalid, duplicate, or exceeds runtime bounds.',
        ...(typeof participant.id === 'string'
          ? { participantId: participant.id }
          : {}),
      });
    }
    for (const callback of [
      participant.commit,
      participant.rollback,
      participant.discard,
      participant.dispose,
    ]) {
      if (callback !== undefined && typeof callback !== 'function') {
        throw new LocalizationError({
          code: 'invalid-configuration',
          outcome: 'operational-failure',
          message:
            'Localization participant lifecycle hooks must be functions.',
          participantId: participant.id,
        });
      }
    }
    const transfer = this.transferred.get(participant.id);
    const compatibleTransfer =
      transfer?.coordination === coordination ? transfer : undefined;
    const adapter: ParticipantAdapter = {
      id: participant.id,
      coordination,
      ...(deadline === undefined ? {} : { deadlineMilliseconds: deadline }),
      prepare: participant.prepare.bind(participant),
      ...(participant.commit === undefined
        ? {}
        : { commit: participant.commit.bind(participant) }),
      ...(participant.rollback === undefined
        ? {}
        : { rollback: participant.rollback.bind(participant) }),
      ...(participant.discard === undefined
        ? {}
        : { discard: participant.discard.bind(participant) }),
      ...(participant.dispose === undefined
        ? {}
        : { dispose: participant.dispose.bind(participant) }),
      stateValue: signal(
        stateFromTransfer(participant.id, coordination, compatibleTransfer),
      ),
      transferred: compatibleTransfer !== undefined,
    };
    this.adapters.set(adapter.id, adapter);
    this.transferred.delete(adapter.id);
    this.registryVersion.update((value) => value + 1);
    let registered = true;
    return Object.freeze({
      id: adapter.id,
      state: adapter.stateValue.asReadonly(),
      retry: () => {
        if (!registered || !this.adapters.has(adapter.id)) {
          return Promise.reject(
            new LocalizationError({
              code: 'disposed',
              outcome: 'operational-failure',
              message: 'The localization participant is unregistered.',
              participantId: adapter.id,
            }),
          );
        }
        return retry(adapter.id);
      },
      unregister: () => {
        if (!registered) return;
        registered = false;
        this.unregister(adapter.id);
      },
    });
  }

  private unregister(participantId: string): void {
    const adapter = this.adapters.get(participantId);
    if (adapter === undefined) return;
    adapter.work?.controller.abort(
      new LocalizationError({
        code: 'disposed',
        outcome: 'operational-failure',
        message: 'The localization participant was unregistered.',
        participantId,
        transitionId: adapter.work.transitionId,
        targetLocale: adapter.work.targetLocale,
      }),
    );
    try {
      const result = adapter.dispose?.();
      if (result !== undefined) {
        throw new Error('Participant disposal callbacks must be synchronous.');
      }
    } catch {
      // Disposal is best-effort and cannot retain a registration.
    }
    this.adapters.delete(participantId);
    this.registryVersion.update((value) => value + 1);
  }

  registrationRevision(): number {
    return this.registryVersion();
  }

  registrations(): readonly RegisteredParticipant[] {
    return Object.freeze(
      [...this.adapters.values()].map(
        ({ id, coordination, deadlineMilliseconds }) =>
          Object.freeze({
            id,
            coordination,
            ...(deadlineMilliseconds === undefined
              ? {}
              : { deadlineMilliseconds }),
          }),
      ),
    );
  }

  required(): readonly RegisteredParticipant[] {
    return Object.freeze(
      this.registrations().filter(
        ({ coordination }) => coordination === 'required',
      ),
    );
  }

  progressive(): readonly RegisteredParticipant[] {
    return Object.freeze(
      this.registrations().filter(
        ({ coordination }) => coordination === 'progressive',
      ),
    );
  }

  private adapter(registration: RegisteredParticipant): ParticipantAdapter {
    const adapter = this.adapters.get(registration.id);
    if (adapter === undefined) {
      throw new LocalizationError({
        code: 'disposed',
        outcome: 'operational-failure',
        message: 'A required localization participant was unregistered.',
        participantId: registration.id,
      });
    }
    return adapter;
  }

  private setAttempt(
    adapter: ParticipantAdapter,
    attempt: LocalizationParticipantAttempt,
  ): void {
    const current = adapter.stateValue();
    adapter.stateValue.set(
      Object.freeze({
        participantId: adapter.id,
        coordination: adapter.coordination,
        ...(current.current === undefined ? {} : { current: current.current }),
        attempt: Object.freeze(attempt),
      }),
    );
  }

  private linkedController(
    parent: AbortSignal,
    participantId: string,
    targetLocale: string,
    transitionId: number,
  ): { readonly controller: AbortController; readonly unlink: () => void } {
    const controller = new AbortController();
    const abort = () => {
      const reason =
        parent.reason instanceof LocalizationError
          ? parent.reason
          : new LocalizationError({
              code: 'cancelled',
              outcome: 'operational-failure',
              message: 'The localization participant transition was cancelled.',
              participantId,
              targetLocale,
              transitionId,
            });
      controller.abort(reason);
    };
    if (parent.aborted) abort();
    else parent.addEventListener('abort', abort, { once: true });
    return {
      controller,
      unlink: () => parent.removeEventListener('abort', abort),
    };
  }

  private cleanup(prepared: InternalPreparedParticipant): void {
    if (prepared.finalized) return;
    prepared.finalized = true;
    prepared.clearDeadline();
    prepared.unlink();
    if (prepared.adapter.work?.transitionId === prepared.context.transitionId) {
      delete prepared.adapter.work;
    }
  }

  private async prepareOne(
    registration: RegisteredParticipant,
    targetLocale: string,
    formatting: FormattingContext,
    transitionId: number,
    parentSignal: AbortSignal,
  ): Promise<InternalPreparedParticipant> {
    const adapter = this.adapter(registration);
    adapter.work?.controller.abort(
      new LocalizationError({
        code: 'superseded',
        outcome: 'operational-failure',
        message: 'New participant work superseded an older attempt.',
        participantId: adapter.id,
        targetLocale,
        transitionId,
      }),
    );
    const previousState = adapter.stateValue();
    const linked = this.linkedController(
      parentSignal,
      adapter.id,
      targetLocale,
      transitionId,
    );
    const context: LocalizationParticipantContext = Object.freeze({
      targetLocale,
      formatting: Object.freeze({ ...formatting }),
      transitionId,
      signal: linked.controller.signal,
      ...(adapter.transferred && previousState.current !== undefined
        ? { transferred: previousState.current }
        : {}),
    });
    adapter.transferred = false;
    const work: ParticipantWork = {
      transitionId,
      targetLocale,
      controller: linked.controller,
    };
    adapter.work = work;
    this.setAttempt(adapter, {
      status: 'preparing',
      targetLocale,
      transitionId,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (adapter.deadlineMilliseconds !== undefined) {
      timer = setTimeout(() => {
        linked.controller.abort(
          new LocalizationError(
            participantDiagnostic(
              'participant-timeout',
              'The configured localization participant deadline expired.',
              adapter.id,
              context,
            ),
          ),
        );
      }, adapter.deadlineMilliseconds);
    }
    const clearDeadline = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    let rejectAbort = (): void => undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(linked.controller.signal.reason);
      if (linked.controller.signal.aborted) rejectAbort();
      else
        linked.controller.signal.addEventListener('abort', rejectAbort, {
          once: true,
        });
    });
    let report: LocalizationParticipantReport | undefined;
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => adapter.prepare(context)),
        abortPromise,
      ]);
      linked.controller.signal.removeEventListener('abort', rejectAbort);
      if (adapter.work !== work || linked.controller.signal.aborted) {
        throw linked.controller.signal.reason;
      }
      report = sanitizeParticipantReport(raw);
      if (report === undefined) throw contractError(adapter.id, context);
      if (report.status === 'failed') {
        const diagnostic = participantDiagnostic(
          'participant-failed',
          'A localization participant reported an operational failure.',
          adapter.id,
          context,
        );
        throw new LocalizationError(diagnostic);
      }
      const prepared: InternalPreparedParticipant = {
        adapter,
        context,
        report,
        previousState,
        unlink: linked.unlink,
        clearDeadline,
        finalized: false,
      };
      clearDeadline();
      this.setAttempt(adapter, {
        status: 'prepared',
        targetLocale,
        transitionId,
        report,
      });
      return prepared;
    } catch (error: unknown) {
      clearDeadline();
      linked.unlink();
      linked.controller.signal.removeEventListener('abort', rejectAbort);
      if (adapter.work === work) delete adapter.work;
      const diagnostic =
        error instanceof LocalizationError
          ? error.diagnostic
          : participantDiagnostic(
              'participant-failed',
              'A localization participant failed without exposing consumer details.',
              adapter.id,
              context,
            );
      if (adapter.stateValue().attempt.transitionId === transitionId) {
        this.setAttempt(adapter, {
          status: abortDiagnosticStatus(diagnostic),
          targetLocale,
          transitionId,
          ...(report === undefined ? {} : { report }),
          diagnostic,
        });
      }
      invokeDiscard(adapter, context, report);
      throw new LocalizationError(diagnostic);
    }
  }

  async prepareRequired(
    registrations: readonly RegisteredParticipant[],
    targetLocale: string,
    formatting: FormattingContext,
    transitionId: number,
    signalValue: AbortSignal,
  ): Promise<readonly PreparedParticipant[]> {
    if (registrations.length === 0) return Object.freeze([]);
    const cohort = this.linkedController(
      signalValue,
      'participant-cohort',
      targetLocale,
      transitionId,
    );
    const promises = registrations.map((registration) =>
      this.prepareOne(
        registration,
        targetLocale,
        formatting,
        transitionId,
        cohort.controller.signal,
      ).catch((error: unknown) => {
        if (!cohort.controller.signal.aborted) {
          cohort.controller.abort(error);
        }
        throw error;
      }),
    );
    const settled = await Promise.allSettled(promises);
    cohort.unlink();
    const prepared = settled
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<InternalPreparedParticipant> =>
          result.status === 'fulfilled',
      )
      .map(({ value }) => value);
    const unavailable = prepared.find(
      ({ report }) => report.status === 'unavailable',
    );
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined || unavailable !== undefined) {
      for (const item of prepared) {
        if (item === unavailable) {
          this.setAttempt(item.adapter, {
            status: 'unavailable',
            targetLocale,
            transitionId,
            report: item.report,
          });
        } else {
          this.setAttempt(item.adapter, {
            status: 'cancelled',
            targetLocale,
            transitionId,
            report: item.report,
            diagnostic: participantDiagnostic(
              failure === undefined
                ? 'participant-unavailable'
                : 'participant-failed',
              'The coordinated participant cohort did not commit.',
              item.adapter.id,
              item.context,
              failure === undefined
                ? 'localized-representation-unavailable'
                : 'operational-failure',
            ),
          });
        }
        if (!item.finalized) {
          invokeDiscard(item.adapter, item.context, item.report);
          this.cleanup(item);
        }
      }
      if (failure !== undefined) throw failure.reason;
      if (unavailable === undefined) {
        throw new LocalizationError({
          code: 'internal-invariant',
          outcome: 'operational-failure',
          message: 'The participant cohort ended without a terminal outcome.',
          targetLocale,
          transitionId,
        });
      }
      throw new LocalizationError(
        participantDiagnostic(
          'participant-unavailable',
          'A required localized representation is unavailable.',
          unavailable.adapter.id,
          unavailable.context,
          'localized-representation-unavailable',
        ),
      );
    }
    return Object.freeze(prepared);
  }

  discardPrepared(prepared: readonly PreparedParticipant[]): void {
    for (const item of prepared as readonly InternalPreparedParticipant[]) {
      if (item.finalized) continue;
      invokeDiscard(item.adapter, item.context, item.report);
      this.cleanup(item);
    }
  }

  commitPrepared(prepared: readonly PreparedParticipant[]): void {
    const internal = prepared as readonly InternalPreparedParticipant[];
    const invoked: InternalPreparedParticipant[] = [];
    let failed: InternalPreparedParticipant | undefined;
    try {
      for (const item of internal) {
        failed = item;
        if (
          item.finalized ||
          this.adapters.get(item.adapter.id) !== item.adapter ||
          item.context.signal.aborted
        ) {
          const reason = item.context.signal.reason;
          throw reason instanceof LocalizationError
            ? reason
            : new LocalizationError(
                participantDiagnostic(
                  'disposed',
                  'A localization participant was unavailable before commit.',
                  item.adapter.id,
                  item.context,
                ),
              );
        }
        invoked.push(item);
        const result = item.adapter.commit?.(item.context, item.report);
        if (asyncCallbackRejected(result)) {
          throw contractError(item.adapter.id, item.context);
        }
      }
      for (const item of internal) {
        const current = Object.freeze({
          targetLocale: item.context.targetLocale,
          transitionId: item.context.transitionId,
          report: item.report,
        });
        item.adapter.stateValue.set(
          Object.freeze({
            participantId: item.adapter.id,
            coordination: item.adapter.coordination,
            current,
            attempt: Object.freeze({
              status: publicStatus(item.report),
              targetLocale: item.context.targetLocale,
              transitionId: item.context.transitionId,
              report: item.report,
            }),
          }),
        );
        this.cleanup(item);
      }
    } catch (error: unknown) {
      const diagnostic =
        error instanceof LocalizationError
          ? error.diagnostic
          : failed === undefined
            ? {
                code: 'participant-failed' as const,
                outcome: 'operational-failure' as const,
                message: 'A localization participant commit failed.',
              }
            : participantDiagnostic(
                'participant-failed',
                'A localization participant commit failed and was rolled back.',
                failed.adapter.id,
                failed.context,
              );
      for (const item of [...invoked].reverse()) {
        try {
          const result = item.adapter.rollback?.(item.context, item.report);
          if (asyncCallbackRejected(result)) {
            throw new Error(
              'Participant rollback callbacks must be synchronous.',
            );
          }
        } catch {
          // Preserve the original participant commit failure.
        }
      }
      for (const item of internal) {
        if (item.finalized) continue;
        item.adapter.stateValue.set(item.previousState);
        this.setAttempt(item.adapter, {
          status:
            item === failed ? abortDiagnosticStatus(diagnostic) : 'cancelled',
          targetLocale: item.context.targetLocale,
          transitionId: item.context.transitionId,
          report: item.report,
          diagnostic,
        });
        invokeDiscard(item.adapter, item.context, item.report);
        this.cleanup(item);
      }
      throw new LocalizationError(diagnostic);
    }
  }

  async runIndependent(
    registration: RegisteredParticipant,
    targetLocale: string,
    formatting: FormattingContext,
    transitionId: number,
    signalValue: AbortSignal,
  ): Promise<LocalizationParticipantState> {
    try {
      const prepared = await this.prepareOne(
        registration,
        targetLocale,
        formatting,
        transitionId,
        signalValue,
      );
      this.commitPrepared([prepared]);
    } catch {
      // Independent regional outcomes are exposed through participant state.
    }
    return this.adapter(registration).stateValue();
  }

  state(participantId: string): LocalizationParticipantState {
    const adapter = this.adapters.get(participantId);
    if (adapter === undefined) {
      throw new LocalizationError({
        code: 'invalid-configuration',
        outcome: 'operational-failure',
        message: 'The localization participant is not registered.',
        participantId,
      });
    }
    return adapter.stateValue();
  }

  pendingFor(
    registrations: readonly RegisteredParticipant[],
    targetLocale: string,
  ): readonly RegisteredParticipant[] {
    return Object.freeze(
      registrations.filter((registration) => {
        const adapter = this.adapters.get(registration.id);
        return (
          adapter?.transferred === true ||
          adapter?.stateValue().current?.targetLocale !== targetLocale
        );
      }),
    );
  }

  supersedeAll(
    targetLocale?: string,
    transitionId?: number,
    disposed = false,
  ): void {
    for (const adapter of this.adapters.values()) {
      const work = adapter.work;
      if (work === undefined) continue;
      work.controller.abort(
        new LocalizationError({
          code: disposed ? 'disposed' : 'superseded',
          outcome: 'operational-failure',
          message: disposed
            ? 'The localization context was disposed.'
            : 'A newer locale intent superseded participant work.',
          participantId: adapter.id,
          targetLocale: targetLocale ?? work.targetLocale,
          transitionId: transitionId ?? work.transitionId,
        }),
      );
    }
  }

  transferRecords(): readonly ParticipantTransferRecord[] {
    return Object.freeze(
      [...this.adapters.values()].map((adapter) => {
        const state = adapter.stateValue();
        const attempt = state.attempt;
        const transferableAttempt =
          attempt.status === 'idle' ||
          attempt.status === 'cancelled' ||
          attempt.status === 'superseded' ||
          attempt.targetLocale === undefined ||
          attempt.transitionId === undefined
            ? undefined
            : Object.freeze({
                status: attempt.status,
                targetLocale: attempt.targetLocale,
                transitionId: attempt.transitionId,
                ...(attempt.report === undefined
                  ? {}
                  : { report: attempt.report }),
              });
        return Object.freeze({
          profile: 'atlas-participant-state/1' as const,
          participantId: adapter.id,
          coordination: adapter.coordination,
          ...(state.current === undefined ? {} : { current: state.current }),
          ...(transferableAttempt === undefined
            ? {}
            : { attempt: transferableAttempt }),
        });
      }),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.supersedeAll(undefined, undefined, true);
    for (const adapter of [...this.adapters.values()].reverse()) {
      try {
        const result = adapter.dispose?.();
        if (asyncCallbackRejected(result)) {
          throw new Error(
            'Participant disposal callbacks must be synchronous.',
          );
        }
      } catch {
        // Disposal is best-effort and cannot retain another participant.
      }
    }
    this.adapters.clear();
    this.transferred.clear();
    this.registryVersion.update((value) => value + 1);
  }
}
