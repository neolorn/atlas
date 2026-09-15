import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ID, REQUEST } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  Localization,
  cookieStore,
  localStorageStore,
  memoryStore,
  profileStore,
  provideLocalizationSetup,
  withObservability,
  withPersistence,
  type LocalizationObservabilityEvent,
  type LocalizationPersistenceStoreFactory,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * Remembering a locale choice between visits.
 *
 * `specs/03-locale-identity-and-resolution.spec.md` section 8 says Atlas "exposes typed opt-in memory, browser, SSR-cookie, and
 * authenticated-profile ports". None of the four existed. What shipped was a description of how to
 * write one, which a four-application workspace would have written four times. The shared wrapper
 * that normally prevents that duplication is not always available either: a workspace whose
 * architecture forbids one application reaching another's code has nowhere to put it.
 *
 * The interesting part is not the four stores; a cookie is a cookie. It is the four rules that had
 * to be identical across all of them and would not have been if each application wrote its own:
 * a write happens only after a commit that succeeded, an older write never overwrites a newer
 * choice, a stored value is not believed until it still canonicalizes to a supported locale, and a
 * store that fails never rolls back a locale change that already worked.
 */

function setup(
  stores: readonly LocalizationPersistenceStoreFactory[],
  events?: LocalizationObservabilityEvent[],
): Localization {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideLocalizationSetup(
        {
          configuration,
          catalogSet,
          catalogLoaders,
          recoveryPayload,
          extensions: atlasRuntimeExtensions,
        },
        withPersistence(...stores),
        ...(events === undefined
          ? []
          : [
              withObservability({
                emit: (event) => {
                  events.push(event);
                },
              }),
            ]),
      ),
    ],
  });
  return TestBed.inject(Localization);
}

async function settled(): Promise<void> {
  // Persistence runs after the commit, so the write is in flight when changeLocale resolves.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('a remembered choice', () => {
  it('is written after the locale change and read back on the next visit', async () => {
    // One store instance shared across both setups stands in for a cookie surviving a reload.
    const shared = memoryStore()();
    const persistent: LocalizationPersistenceStoreFactory = () => shared;

    const first = setup([persistent]);
    await first.initialize();
    await first.changeLocale('ar-EG');
    await settled();

    const second = setup([persistent]);
    const snapshot = await second.initialize();

    expect(snapshot.primaryLocale).toBe('ar-EG');
  });

  it('is not written by initialization, only by a deliberate change', async () => {
    // The rule that keeps a first guess from becoming permanent. If initialization persisted what
    // it negotiated, a visitor who never chose anything would carry the first answer forever and
    // changing their browser language afterwards would stop working.
    const store = memoryStore()();
    const localization = setup([() => store]);
    await localization.initialize();
    await settled();

    expect(await store.read()).toBeUndefined();
  });

  it('does not write when the locale did not change', async () => {
    // The Router adapter runs a transaction for every navigation, including ones that stay in the
    // same language. Writing on each would mean an HTTP call per page view for a profile store.
    const written: string[] = [];
    const localization = setup([
      () => ({
        id: 'counting',
        read: () => undefined,
        write: (locale: string) => {
          written.push(locale);
        },
      }),
    ]);
    await localization.initialize();

    await localization.changeLocale('ar-EG');
    await localization.changeLocale('ar-EG');
    await localization.changeLocale('ar-EG');
    await settled();

    expect(written).toEqual(['ar-EG']);
  });

  it('does not persist a change that failed', async () => {
    const store = memoryStore()();
    const localization = setup([() => store]);
    await localization.initialize();

    const result = await localization.changeLocale('xx-ZZ');
    expect(result.status).toBe('failed');
    await settled();

    expect(await store.read()).toBeUndefined();
  });
});

describe('a reader who asks to be forgotten', () => {
  it('moves the page without recording a choice when the change says not to', async () => {
    // The half that moves the reader. The only operation that changes the locale is the one that
    // records a choice, so honouring the request with an ordinary change would store a fresh one
    // in place of the one just dropped.
    const store = memoryStore()();
    const localization = setup([() => store]);
    await localization.initialize();

    await localization.changeLocale('ar-EG', { remember: false });
    await settled();

    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
    expect(await store.read()).toBeUndefined();
  });

  it('drops what is stored and leaves the page where it is', async () => {
    // The other half. Forgetting alone leaves the reader looking at the language that was stored.
    const store = memoryStore()();
    const localization = setup([() => store]);
    await localization.initialize();
    await localization.changeLocale('ar-EG');
    await settled();
    expect(await store.read()).toBe('ar-EG');

    const report = await localization.forgetRememberedLocale();

    expect(report.complete).toBe(true);
    expect(await store.read()).toBeUndefined();
    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
  });

  it('puts the next visit back where resolution would have placed it', async () => {
    // The two used together, which is what a privacy page's control does. Neither alone is enough:
    // one leaves the page in the stored language, the other stores a new choice.
    const shared = memoryStore()();
    const persistent: LocalizationPersistenceStoreFactory = () => shared;

    const first = setup([persistent]);
    await first.initialize();
    await first.changeLocale('ar-EG');
    await settled();

    await first.forgetRememberedLocale();
    await first.changeLocale('en-US', { remember: false });
    await settled();

    const second = setup([persistent]);
    expect((await second.initialize()).primaryLocale).toBe('en-US');
  });

  it('names the stores it could not reach rather than reporting them done', async () => {
    const withRemoval = memoryStore()();
    const localization = setup([
      () => ({
        id: 'legacy',
        read: () => undefined,
        write: () => undefined,
      }),
      () => withRemoval,
    ]);
    await localization.initialize();
    await localization.changeLocale('ar-EG');
    await settled();

    const report = await localization.forgetRememberedLocale();

    expect(report.complete).toBe(false);
    expect(report.unreached).toEqual([
      { storeId: 'legacy', reason: 'no-removal' },
    ]);
    expect(await withRemoval.read()).toBeUndefined();
  });
});

describe('a stored value that cannot be believed', () => {
  it('is ignored when it is not a locale this application offers', async () => {
    // A language removed in a previous release. Restoring it would render an interface nobody can
    // supply, so the preference is stale and the default stands.
    const events: LocalizationObservabilityEvent[] = [];
    const localization = setup(
      [
        () => ({
          id: 'fake',
          read: () => 'fr-FR',
          write: () => undefined,
        }),
      ],
      events,
    );

    const snapshot = await localization.initialize();

    expect(snapshot.primaryLocale).toBe('en-US');
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'persistence',
        status: 'unavailable',
        reason: 'unsupported-locale',
      }),
    );
  });

  it('is ignored when it is malformed, and is never echoed back', async () => {
    // The value came from a cookie, which is to say from the client.
    const events: LocalizationObservabilityEvent[] = [];
    const localization = setup(
      [
        () => ({
          id: 'fake',
          read: () => '../../etc/passwd',
          write: () => undefined,
        }),
      ],
      events,
    );

    const snapshot = await localization.initialize();

    expect(snapshot.primaryLocale).toBe('en-US');
    const reported = events.filter(({ phase }) => phase === 'persistence');
    expect(reported.length).toBeGreaterThan(0);
    expect(JSON.stringify(reported)).not.toContain('passwd');
  });

  it('falls through to the next store rather than giving up', async () => {
    const localization = setup([
      () => ({ id: 'empty', read: () => undefined, write: () => undefined }),
      () => ({ id: 'stale', read: () => 'fr-FR', write: () => undefined }),
      () => ({ id: 'good', read: () => 'ar-EG', write: () => undefined }),
    ]);

    expect((await localization.initialize()).primaryLocale).toBe('ar-EG');
  });

  it('reads stores in the order the consumer declared them', async () => {
    // The consumer owns the authority order, so an authenticated profile ahead of a cookie
    // outranks it, and Atlas takes the first believable answer without reordering or merging.
    const localization = setup([
      () => ({ id: 'first', read: () => 'ar-EG', write: () => undefined }),
      () => ({ id: 'second', read: () => 'en-US', write: () => undefined }),
    ]);

    expect((await localization.initialize()).primaryLocale).toBe('ar-EG');
  });
});

describe('a store that misbehaves', () => {
  it('does not roll back a locale change that already succeeded', async () => {
    const events: LocalizationObservabilityEvent[] = [];
    const localization = setup(
      [
        () => ({
          id: 'broken',
          read: () => undefined,
          write: () => {
            throw new Error('storage is full');
          },
        }),
      ],
      events,
    );
    await localization.initialize();

    const result = await localization.changeLocale('ar-EG');
    await settled();

    // The locale changed. It simply will not be remembered, which is the smaller failure of the
    // two and the one `specs/06-runtime-and-angular.spec.md` section 11 requires.
    expect(result.status).toBe('committed');
    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
    expect(events).toContainEqual(
      expect.objectContaining({ phase: 'persistence', status: 'failed' }),
    );
  });

  it('never lets an older write outlast a newer choice', async () => {
    // The ordering rule, and the reason it belongs to the runtime rather than to each store.
    // Three changes with the first store blocked: the middle choice is superseded before its write
    // begins, so it is skipped outright, and the value left behind is the one the visitor chose
    // last rather than whichever write happened to finish last.
    const events: LocalizationObservabilityEvent[] = [];
    const written: string[] = [];
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;

    const localization = setup(
      [
        () => ({
          id: 'slow',
          read: () => undefined,
          write: async (locale: string) => {
            if (first) {
              first = false;
              await slow;
            }
            written.push(locale);
          },
        }),
      ],
      events,
    );
    await localization.initialize();

    await localization.changeLocale('ar-EG');
    await localization.changeLocale('en-US');
    await localization.changeLocale('ar-EG');
    release?.();
    await settled();
    await settled();

    expect(written.at(-1)).toBe('ar-EG');
    expect(written).not.toContain('en-US');
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'persistence',
        status: 'superseded',
        targetLocale: 'en-US',
      }),
    );
  });
});

describe('the shipped stores', () => {
  beforeEach(() => {
    document.cookie = 'atlas-locale=; Path=/; Max-Age=0';
    localStorage.clear();
  });

  it('round-trips through a cookie', async () => {
    const localization = setup([cookieStore({ secure: false })]);
    await localization.initialize();
    await localization.changeLocale('ar-EG');
    await settled();

    expect(document.cookie).toContain('atlas-locale=ar-EG');
    expect((await setup([cookieStore()]).initialize()).primaryLocale).toBe(
      'ar-EG',
    );
  });

  it('expires the cookie it wrote, rather than writing a second one beside it', async () => {
    // A browser matches a cookie on its name, path and domain, so an expiry written with any of
    // the three different leaves the original where it is and adds an expired one next to it. The
    // read-back is what tells the two apart: the value would still be there.
    const localization = setup([cookieStore({ secure: false })]);
    await localization.initialize();
    await localization.changeLocale('ar-EG');
    await settled();
    expect(document.cookie).toContain('atlas-locale=ar-EG');

    const report = await localization.forgetRememberedLocale();

    expect(report.complete).toBe(true);
    expect(document.cookie).not.toContain('atlas-locale=ar-EG');
    expect((await setup([cookieStore()]).initialize()).primaryLocale).toBe(
      'en-US',
    );
  });

  it('removes what it kept in local storage', async () => {
    const localization = setup([localStorageStore({ key: 'lang' })]);
    await localization.initialize();
    await localization.changeLocale('ar-EG');
    await settled();
    expect(localStorage.getItem('lang')).toBe('ar-EG');

    await localization.forgetRememberedLocale();

    expect(localStorage.getItem('lang')).toBeNull();
  });

  it('round-trips through local storage', async () => {
    const localization = setup([localStorageStore({ key: 'lang' })]);
    await localization.initialize();
    await localization.changeLocale('ar-EG');
    await settled();

    expect(localStorage.getItem('lang')).toBe('ar-EG');
    expect(
      (await setup([localStorageStore({ key: 'lang' })]).initialize())
        .primaryLocale,
    ).toBe('ar-EG');
  });

  it('carries the choice to a consumer-owned profile transport', async () => {
    const write = vi.fn();
    const localization = setup([
      profileStore({ read: async () => undefined, write }),
    ]);
    await localization.initialize();
    await localization.changeLocale('ar-EG');
    await settled();

    expect(write).toHaveBeenCalledWith('ar-EG');
  });

  it('writes to every configured store, and reads from the first that answers', async () => {
    const localization = setup([
      profileStore({ read: async () => undefined, write: () => undefined }),
      cookieStore({ secure: false }),
      localStorageStore({ key: 'lang' }),
    ]);
    await localization.initialize();
    await localization.changeLocale('ar-EG');
    await settled();

    // A device that later goes offline should still remember what the signed-in profile knew.
    expect(document.cookie).toContain('atlas-locale=ar-EG');
    expect(localStorage.getItem('lang')).toBe('ar-EG');
  });
});

describe('what a server render can see', () => {
  function underServerRender<T>(
    cookieHeader: string | undefined,
    body: () => T,
  ): T {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        {
          provide: REQUEST,
          useValue:
            cookieHeader === undefined
              ? null
              : new Request('https://example.test/', {
                  headers: { cookie: cookieHeader },
                }),
        },
      ],
    });
    return TestBed.runInInjectionContext(body);
  }

  it('reads the cookie from the request, before any script has run', async () => {
    // The property that makes this store different from the other three, and the reason a
    // server-rendered application needs it: a server render happens before any script exists, so
    // a cookie is the only remembered
    // preference that can reach the first response. Without it the server renders the default
    // language and the browser corrects it after hydration, which is a visible flash of the wrong
    // language on every single visit.
    const store = underServerRender('theme=dark; atlas-locale=ar-EG', () =>
      cookieStore()(),
    );

    expect(await store.read()).toBe('ar-EG');
  });

  it('sees nothing in local storage, which is the whole distinction', async () => {
    const store = underServerRender('atlas-locale=ar-EG', () =>
      localStorageStore()(),
    );

    expect(await store.read()).toBeUndefined();
  });

  it('does not try to write a cookie it has no response to write it to', async () => {
    // Setting a cookie on the server means setting a response header, and the response belongs to
    // the consumer's server. Nothing is lost: the browser writes the same cookie on hydration.
    document.cookie = 'atlas-locale=; Path=/; Max-Age=0';
    const store = underServerRender(undefined, () => cookieStore()());

    store.write('ar-EG');

    expect(document.cookie).not.toContain('atlas-locale=ar-EG');
  });

  it('ignores a cookie whose value is not a locale', async () => {
    // The value arrived from the client. It is rejected rather than repaired: a value that needed
    // repairing was not the value Atlas wrote.
    const store = underServerRender('atlas-locale=%2e%2e%2fetc', () =>
      cookieStore()(),
    );

    expect(await store.read()).toBeUndefined();
  });
});

/**
 * `draft-ietf-httpbis-rfc6265bis-22` section 5.7 ignores a newly created cookie
 * *entirely* in four cases this store can be configured into. Every one of them is silent: the
 * header is written, the browser drops it, `read` answers `undefined` for the life of the
 * application, and the server renders the default language on every first visit, which is the one
 * thing this store exists to prevent, so the failure hides in the place it costs the most.
 *
 * The store refuses rather than repairs. Turning `Secure` on because `SameSite` is `None` would
 * silently replace what the consumer wrote, which is the same silence one layer in.
 */
describe('a cookie configuration the browser would discard', () => {
  it('refuses SameSite=None without Secure', () => {
    // Step 19: "If the cookie's 'same-site-flag' is 'None', abort this algorithm and ignore the
    // cookie entirely unless the cookie's secure-only-flag is true."
    expect(() => cookieStore({ sameSite: 'None', secure: false })).toThrow(
      /SameSite=None/u,
    );
  });

  it('refuses a __Secure- name without Secure', () => {
    // Step 20. The same failure, reached through `name` rather than through `sameSite`, which is
    // why the rule is about configurations the storage model discards and not about one attribute.
    expect(() =>
      cookieStore({ name: '__Secure-locale', secure: false }),
    ).toThrow(/__Secure-/u);
  });

  it('refuses a __Host- name that is not secure, or scoped, or rooted', () => {
    // Step 21 has three conditions and all three are silent when broken.
    expect(() => cookieStore({ name: '__Host-locale', secure: false })).toThrow(
      /__Host-/u,
    );
    expect(() =>
      cookieStore({ name: '__Host-locale', domain: 'example.test' }),
    ).toThrow(/Domain/u);
    expect(() => cookieStore({ name: '__Host-locale', path: '/app' })).toThrow(
      /Path/u,
    );
  });

  it('reads the prefix case-insensitively, which is how the rule is written', () => {
    // "begins with a case-insensitive match for the string '__Secure-'". A store that matched the
    // canonical spelling only would refuse the tidy case and pass the untidy one through.
    expect(() =>
      cookieStore({ name: '__SECURE-locale', secure: false }),
    ).toThrow(/__Secure-/u);
    expect(() => cookieStore({ name: '__host-locale', path: '/app' })).toThrow(
      /Path/u,
    );
  });

  it('accepts every configuration the browser keeps', () => {
    // Without these the check would pass for a store that refused everything, which would be a
    // wall rather than a rule. `secure: false` on its own is fine: the default `SameSite` is `Lax`,
    // and step 19 is only about `None`.
    expect(() => cookieStore()).not.toThrow();
    expect(() => cookieStore({ secure: false })).not.toThrow();
    expect(() => cookieStore({ sameSite: 'None', secure: true })).not.toThrow();
    expect(() =>
      cookieStore({ sameSite: 'Strict', secure: false }),
    ).not.toThrow();
    expect(() => cookieStore({ name: '__Secure-locale' })).not.toThrow();
    expect(() => cookieStore({ name: '__Host-locale' })).not.toThrow();
    expect(() =>
      cookieStore({ name: '__Host-locale', path: '/', secure: true }),
    ).not.toThrow();
  });

  it('refuses before the first render rather than on the first write', () => {
    // The options are static, so a configuration that can never store anything is wrong when it is
    // written down. Deferring the check to `write` would mean the application starts, serves the
    // wrong language, and only then finds out, if anything were watching, which nothing is.
    expect(() => cookieStore({ sameSite: 'None', secure: false })).toThrow();
    const factory = cookieStore({ sameSite: 'None', secure: true });
    expect(typeof factory).toBe('function');
  });
});
