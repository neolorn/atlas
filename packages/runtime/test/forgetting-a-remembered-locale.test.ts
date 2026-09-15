/**
 * Removing a remembered choice, and saying where the removal did not land.
 *
 * Section 8 of `specs/03-locale-identity-and-resolution.spec.md` keeps removal optional on the
 * persistence port, so a store written against the two-method version keeps compiling, and requires
 * a store that offers none to count as one the removal did not reach. A removal reported as
 * complete while any store still holds the value leaves the choice in force: the next visit reads
 * it back from whichever store kept it.
 */

// First, and on its own line, for the reason `locale-cookie-defaults.test.ts` states: the stores
// reach `@angular/common`, whose bundle carries `PlatformLocation`, and that class is linked at
// initialization time and needs a compiler that no plain Node process has.
import '@angular/compiler';

import { describe, expect, it } from 'vitest';

import { LocaleResolution } from '../src/locale-resolution.js';
import { memoryStore, profileStore } from '../src/persistence.js';
import type { LocalizationPersistenceStore } from '../src/persistence.js';
import type { LocalizationSnapshot } from '@neolorn/atlas/core';

const resolutionOver = (stores: readonly LocalizationPersistenceStore[]) =>
  new LocaleResolution({
    persistence: stores,
    initialLocale: undefined,
    requestContext: undefined,
    preferredLanguages: undefined,
    localeUrl: undefined,
    localeSources: undefined,
    defaultLocale: 'en-US',
    localeList: Object.freeze(['en-US', 'ar-EG']),
    supportedLocales: new Set(['en-US', 'ar-EG']),
    seeded: Promise.resolve(),
    canonicalLocale: (locale: string) => locale,
    observability: undefined,
  });

/** `persistLocale` reads the id and the primary locale, and nothing else on the snapshot. */
const committed = (id: number, primaryLocale: string): LocalizationSnapshot =>
  ({ id, primaryLocale }) as unknown as LocalizationSnapshot;

describe('forgetting what the stores remember', () => {
  it('drops the value and reports that it reached everything', async () => {
    const store = memoryStore()();
    await store.write('ar-EG');

    const report = await resolutionOver([store]).forgetPersistedLocale();

    expect(await store.read()).toBeUndefined();
    expect(report.complete).toBe(true);
    expect(report.unreached).toEqual([]);
  });

  it('counts a store that implements no removal as one it did not reach', async () => {
    // The shape the port has to keep admitting. A release that required the method would stop
    // every store written against the previous port from compiling, so the answer is to report it
    // rather than to demand it.
    let remembered: string | undefined = 'ar-EG';
    const withoutRemoval: LocalizationPersistenceStore = {
      id: 'legacy',
      read: () => remembered,
      write: (locale: string) => {
        remembered = locale;
      },
    };
    const withRemoval = memoryStore()();
    await withRemoval.write('ar-EG');

    const report = await resolutionOver([
      withoutRemoval,
      withRemoval,
    ]).forgetPersistedLocale();

    expect(report.complete).toBe(false);
    expect(report.unreached).toEqual([
      { storeId: 'legacy', reason: 'no-removal' },
    ]);
    // And the stores that can are still cleared, so one store without a removal does not stop the
    // others being asked.
    expect(await withRemoval.read()).toBeUndefined();
    expect(remembered).toBe('ar-EG');
  });

  it('counts a removal that threw as one that did not reach', async () => {
    const failing: LocalizationPersistenceStore = {
      id: 'profile',
      read: () => 'ar-EG',
      write: () => undefined,
      forget: () => {
        throw new Error('the preference endpoint is down');
      },
    };

    const report = await resolutionOver([failing]).forgetPersistedLocale();

    expect(report.complete).toBe(false);
    expect(report.unreached).toEqual([
      { storeId: 'profile', reason: 'failed' },
    ]);
  });

  it('runs after a write that was already queued, rather than beside it', async () => {
    // A choice made a moment before the reader asked to be forgotten is still on its way to a slow
    // store. Racing the two leaves that store holding the value the removal was for.
    let released!: () => void;
    const held = new Promise<void>((resolve) => {
      released = resolve;
    });
    let remembered: string | undefined;
    const slow: LocalizationPersistenceStore = {
      id: 'slow',
      read: () => remembered,
      write: async (locale: string) => {
        await held;
        remembered = locale;
      },
      forget: () => {
        remembered = undefined;
      },
    };

    const resolution = resolutionOver([slow]);
    resolution.persistLocale(committed(1, 'ar-EG'), 'en-US');
    const removal = resolution.forgetPersistedLocale();
    released();
    const report = await removal;

    expect(report.complete).toBe(true);
    expect(remembered).toBeUndefined();
  });
});

describe('a profile store over the application’s own transport', () => {
  it('offers no removal where the transport has none', () => {
    const store = profileStore({
      read: () => 'ar-EG',
      write: () => undefined,
    })();

    expect(store.forget).toBeUndefined();
  });

  it('calls the transport’s own removal where it has one', async () => {
    let cleared = false;
    const store = profileStore({
      read: () => 'ar-EG',
      write: () => undefined,
      forget: () => {
        cleared = true;
      },
    })();

    await store.forget?.();

    expect(cleared).toBe(true);
  });
});
