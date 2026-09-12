import { TestBed } from '@angular/core/testing';
import { makeStateKey, TransferState } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_EVENT_CODES,
  RUNTIME_OBSERVABILITY_PROFILE,
  Localization,
  createLocalizationContext,
  provideLocalizationSetup,
  withObservability,
  withOverlayLocale,
  type LocalizationObservabilityEvent,
  type LocalizationObservabilitySink,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { messages, providerId, scopeId } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';

const scope = Object.freeze({ providerId, scopeId });

function setup() {
  return {
    configuration,
    catalogSet,
    catalogLoaders,
    extensions: atlasRuntimeExtensions,
  } as const;
}

function context(observability?: LocalizationObservabilitySink) {
  return createLocalizationContext({
    setup: setup(),
    bootstrapScopes: [scope],
    ...(observability === undefined ? {} : { observability }),
  });
}

function collectingSink(
  events: LocalizationObservabilityEvent[],
): LocalizationObservabilitySink {
  return Object.freeze({
    emit: (event: LocalizationObservabilityEvent): void => {
      events.push(event);
    },
  });
}

describe('runtime observability contract', () => {
  it('does no observability clock or suppression work when no sink exists', async () => {
    const now = vi.spyOn(Date, 'now');
    const localization = context();
    try {
      await localization.initialize();
      await expect(
        localization.changeLocale('en-x-no-observability'),
      ).resolves.toMatchObject({ status: 'failed' });
      expect(now).not.toHaveBeenCalled();
    } finally {
      localization.dispose();
      now.mockRestore();
    }
  });

  it('emits frozen, exact, content-free lifecycle shapes', async () => {
    const events: LocalizationObservabilityEvent[] = [];
    const localization = context(collectingSink(events));
    await localization.initialize();

    expect(events.filter(({ phase }) => phase === 'initialization')).toEqual([
      {
        profile: RUNTIME_OBSERVABILITY_PROFILE,
        code: RUNTIME_EVENT_CODES.initialization,
        phase: 'initialization',
        status: 'started',
        transitionId: 0,
      },
      {
        profile: RUNTIME_OBSERVABILITY_PROFILE,
        code: RUNTIME_EVENT_CODES.initialization,
        phase: 'initialization',
        status: 'succeeded',
        targetLocale: 'en-US',
        transitionId: 0,
        snapshotId: 1,
      },
    ]);
    expect(events.every(Object.isFrozen)).toBe(true);

    const hostileLocale = 'en-x-private\u202esecret-catalog-body';
    await expect(
      localization.changeLocale(hostileLocale),
    ).resolves.toMatchObject({
      status: 'failed',
    });
    const transitionFailures = events.filter(
      ({ phase, status }) => phase === 'transition' && status === 'failed',
    );
    const failure = transitionFailures[transitionFailures.length - 1];
    expect(failure).toEqual({
      profile: RUNTIME_OBSERVABILITY_PROFILE,
      code: RUNTIME_EVENT_CODES.transition,
      phase: 'transition',
      status: 'failed',
      reason: 'unsupported-locale',
      transitionId: 1,
    });
    expect(JSON.stringify(failure)).not.toContain('secret-catalog-body');
    localization.dispose();
  });

  it('contains sink exceptions without changing localization semantics', async () => {
    const control = context();
    let attempts = 0;
    const observed = context({
      emit: () => {
        attempts += 1;
        throw new Error('sink failure must stay contained');
      },
    });
    await Promise.all([control.initialize(), observed.initialize()]);
    const [controlResult, observedResult] = await Promise.all([
      control.changeLocale('ar-EG'),
      observed.changeLocale('ar-EG'),
    ]);

    expect(attempts).toBeGreaterThan(0);
    expect(observedResult).toMatchObject({
      status: controlResult.status,
      targetLocale: controlResult.targetLocale,
    });
    expect(observed.snapshot()).toEqual(control.snapshot());
    expect(observed.text(messages.appTitle)).toBe(
      control.text(messages.appTitle),
    );
    expect(observed.lifecycle()).toBe(control.lifecycle());
    control.dispose();
    observed.dispose();
  });

  it('suppresses duplicate failures in a bounded per-context window', async () => {
    const events: LocalizationObservabilityEvent[] = [];
    const localization = context(collectingSink(events));
    await localization.initialize();
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      await localization.changeLocale('en-x-observe-0');
      await localization.changeLocale('en-x-observe-0');
      for (let index = 1; index <= 128; index += 1) {
        await localization.changeLocale(`en-x-observe-${index}`);
      }
      await localization.changeLocale('en-x-observe-0');

      expect(
        events.filter(
          ({ phase, status }) => phase === 'transition' && status === 'failed',
        ),
      ).toHaveLength(130);
    } finally {
      now.mockRestore();
      localization.dispose();
    }
  });

  it('isolates duplicate suppression between contexts sharing one sink', async () => {
    const events: LocalizationObservabilityEvent[] = [];
    const sink = collectingSink(events);
    const first = context(sink);
    const second = context(sink);
    await Promise.all([first.initialize(), second.initialize()]);
    const now = vi.spyOn(Date, 'now').mockReturnValue(20_000);
    try {
      await first.changeLocale('en-x-request-isolation');
      await first.changeLocale('en-x-request-isolation');
      await second.changeLocale('en-x-request-isolation');
      const failures = events.filter(
        ({ phase, status }) => phase === 'transition' && status === 'failed',
      );
      expect(failures).toHaveLength(2);
      expect(failures.map(({ transitionId }) => transitionId)).toEqual([1, 1]);
    } finally {
      now.mockRestore();
      first.dispose();
      second.dispose();
    }
  });
});

describe('Angular observability boundaries', () => {
  it('reports rejected hydration state without exposing transferred content', async () => {
    TestBed.resetTestingModule();
    const events: LocalizationObservabilityEvent[] = [];
    const transferState = new TransferState();
    transferState.set(
      makeStateKey<unknown>('@neolorn/atlas:localization-state/1'),
      {
        profile: 'hostile-transfer-secret',
        primaryLocale: 'ar-EG',
      },
    );
    await TestBed.configureTestingModule({
      providers: [
        { provide: TransferState, useValue: transferState },
        provideLocalizationSetup(
          setup(),
          withObservability(collectingSink(events)),
        ),
      ],
    }).compileComponents();

    const localization = TestBed.inject(Localization);
    expect(events.filter(({ phase }) => phase === 'ssr-hydration')).toEqual([
      {
        profile: RUNTIME_OBSERVABILITY_PROFILE,
        code: RUNTIME_EVENT_CODES.ssrHydration,
        phase: 'ssr-hydration',
        status: 'started',
      },
      {
        profile: RUNTIME_OBSERVABILITY_PROFILE,
        code: RUNTIME_EVENT_CODES.ssrHydration,
        phase: 'ssr-hydration',
        status: 'failed',
        reason: 'invalid-configuration',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('hostile-transfer-secret');
    await localization.initialize();
    expect(localization.snapshot()?.primaryLocale).toBe('en-US');
    localization.dispose();
    TestBed.resetTestingModule();
  });

  it('reports integration failure after rollback at the commit boundary', async () => {
    TestBed.resetTestingModule();
    const events: LocalizationObservabilityEvent[] = [];
    let fail = false;
    await TestBed.configureTestingModule({
      providers: [
        provideLocalizationSetup(
          setup(),
          withObservability(collectingSink(events)),
          withOverlayLocale(() => ({
            apply: () => {
              if (fail) throw new Error('secret integration payload');
            },
          })),
        ),
      ],
    }).compileComponents();
    const localization = TestBed.inject(Localization);
    await localization.initialize();
    fail = true;
    await expect(localization.changeLocale('ar-EG')).resolves.toMatchObject({
      status: 'failed',
    });

    expect(
      events.filter(
        ({ phase, status }) => phase === 'integration' && status === 'failed',
      ),
    ).toEqual([
      {
        profile: RUNTIME_OBSERVABILITY_PROFILE,
        code: RUNTIME_EVENT_CODES.integration,
        phase: 'integration',
        status: 'failed',
        reason: 'internal-invariant',
        targetLocale: 'ar-EG',
        snapshotId: 2,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('secret integration payload');
    expect(localization.snapshot()?.primaryLocale).toBe('en-US');
    localization.dispose();
    TestBed.resetTestingModule();
  });
});
