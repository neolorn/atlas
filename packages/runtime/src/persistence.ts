import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { PLATFORM_ID, REQUEST, inject } from '@angular/core';

/**
 * Where a locale choice is remembered between visits.
 *
 * `specs/03-locale-identity-and-resolution.spec.md` section 8 provides typed opt-in stores for
 * memory, a cookie, browser storage and an authenticated profile, and leaves their order, names,
 * attributes, lifetimes, scope, endpoints, credentials and synchronization to the consumer. None of
 * the four existed: what shipped was a description
 * of how to write one, which a four-application workspace would have written four times,
 * differently. The shared wrapper that normally prevents that duplication is
 * not always available: a workspace whose architecture forbids one application's code reaching
 * another's has nowhere to put it, which is the ordinary shape of a multi-application repository
 * rather than an unusual constraint.
 *
 * The port is deliberately two methods. Everything that needs to be identical across stores
 * (when a write happens, which writes may overwrite which, what a read has to look like before
 * it is believed, what happens when a store fails) belongs to the runtime, in one place, rather than
 * being repeated in each store and drifting.
 */
export interface LocalizationPersistenceStore {
  /** Names the store in diagnostics. Never used as a storage key. */
  readonly id: string;
  /**
   * The remembered locale, or `undefined` when there is none *or* when this store cannot be read
   * in the current environment. A store that cannot read where it is asked reports nothing rather
   * than failing: `localStorage` during server rendering is absent, not broken.
   */
  read(): string | undefined | Promise<string | undefined>;
  /**
   * Remembers a locale that has already been validated and committed.
   *
   * Called after the change succeeds, never during it, so a store never holds a locale the
   * application did not end up on. A store that cannot write where it is asked returns without
   * writing rather than throwing.
   */
  write(locale: string): void | Promise<void>;
}

/**
 * Stores are created per injector, not per configuration.
 *
 * An Angular application config is usually a module-level constant, so a store object created
 * there would be shared by every server-rendered request in the process.
 * `specs/06-runtime-and-angular.spec.md` section 6 makes persistence state context-local and
 * requires an adapter holding request state to be created by the context that owns it; a factory
 * is what makes that true by construction rather than by asking consumers to remember it.
 */
export type LocalizationPersistenceStoreFactory =
  () => LocalizationPersistenceStore;

/** Longest locale text any store will hand back. A BCP 47 tag is far shorter. */
const MAXIMUM_STORED_LENGTH = 64;

/**
 * Stored text is untrusted: a cookie is whatever the client sent.
 *
 * Rejected rather than repaired. `specs/03-locale-identity-and-resolution.spec.md` section 3 bounds
 * untrusted locale text and forbids using it directly as an identity or a protocol field, and a
 * value that needed repairing was not the value Atlas wrote.
 */
function storedLocaleText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length === 0 ||
    value.length > MAXIMUM_STORED_LENGTH ||
    !/^[A-Za-z0-9-]+$/u.test(value)
    ? undefined
    : value;
}

/**
 * Remembers the choice for as long as the page is open, and no longer.
 *
 * The store to reach for when a preference must not outlive the session, and the one to use in
 * tests, where a real cookie or a real `localStorage` would leak between cases.
 */
export function memoryStore(): LocalizationPersistenceStoreFactory {
  return () => {
    let remembered: string | undefined;
    return Object.freeze({
      id: 'memory',
      read: () => remembered,
      write: (locale: string) => {
        remembered = locale;
      },
    });
  };
}

/**
 * The cookie's name and attributes, all optional and all defaulted to something a browser keeps.
 *
 * A combination a browser would discard is refused when the store is built rather than ignored when
 * it is written, so a misconfiguration surfaces before the first render instead of as a language
 * that never sticks.
 */
export interface CookieStoreOptions {
  /** What the cookie is called. Defaults to `atlas-locale`. */
  readonly name?: string;
  /** Which paths it is sent for. Defaults to `/`, and a `__Host-` name allows nothing else. */
  readonly path?: string;
  /**
   * Which hosts it is sent to, defaulting to the exact host that set it.
   *
   * Set it to share one choice across subdomains. A `__Host-` name may not carry it at all.
   */
  readonly domain?: string;
  /** How long it lives, in seconds. Defaults to a year. */
  readonly maxAgeSeconds?: number;
  /**
   * How it behaves on cross-site requests. Defaults to `Lax`.
   *
   * `None` requires `secure`, which is checked rather than corrected.
   */
  readonly sameSite?: 'Lax' | 'Strict' | 'None';
  /**
   * Whether it is sent over HTTPS only. Defaults to true.
   *
   * Turning it off is what local development over plain HTTP sometimes needs, and is what a
   * `__Secure-` or `__Host-` name forbids.
   */
  readonly secure?: boolean;
}

const DEFAULT_COOKIE_NAME = 'atlas-locale';
const ONE_YEAR_SECONDS = 31_536_000;

function cookieValue(header: string, name: string): string | undefined {
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    const raw = entry.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape is not a locale. Reporting nothing is the whole response:
      // the value came from the client and has no claim on being repaired.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Refuses a cookie configuration a browser would discard, at the point it is written down.
 *
 * `draft-ietf-httpbis-rfc6265bis-22` section 5.7 ignores a newly created cookie *entirely* in four
 * cases this store can be configured into: `SameSite=None` without `Secure` (step 19), a
 * `__Secure-` name without `Secure` (step 20), and a `__Host-` name that is not `Secure`, or
 * carries a `Domain`, or has a `Path` other than `/` (step 21).
 *
 * Every one of them writes a header the browser drops on the floor. Nothing throws, `read` answers
 * `undefined` for the life of the application, and the server renders the default language on every
 * first visit, which is the single thing this store exists to prevent, so the failure is invisible
 * in exactly the place it costs the most.
 *
 * It refuses rather than repairs. Turning `Secure` on because `SameSite` is `None` would silently
 * replace what the consumer wrote with something else, which is the same silence one layer in.
 *
 * The check is here rather than in `write` because the options are static: a configuration that can
 * never store anything is wrong before the first render, not on the first write, and an application
 * config is usually evaluated at import.
 */
function assertStorableCookie(
  name: string,
  path: string,
  domain: string | undefined,
  sameSite: 'Lax' | 'Strict' | 'None',
  secure: boolean,
): void {
  const refuse = (rule: string): never => {
    throw new Error(
      `Atlas cookieStore: ${rule} A browser ignores such a cookie entirely, so nothing would ever be stored or read.`,
    );
  };
  if (sameSite === 'None' && !secure) {
    refuse('SameSite=None requires Secure (rfc6265bis section 5.7 step 19).');
  }
  const prefix = name.toLowerCase();
  if (prefix.startsWith('__secure-') && !secure) {
    refuse(
      'a __Secure- name requires Secure (rfc6265bis section 5.7 step 20).',
    );
  }
  if (prefix.startsWith('__host-')) {
    if (!secure) {
      refuse(
        'a __Host- name requires Secure (rfc6265bis section 5.7 step 21).',
      );
    }
    if (domain !== undefined) {
      refuse(
        'a __Host- name must not set Domain (rfc6265bis section 5.7 step 21).',
      );
    }
    if (path !== '/') {
      refuse(
        `a __Host- name requires Path=/ , not ${JSON.stringify(path)} (rfc6265bis section 5.7 step 21).`,
      );
    }
  }
}

/**
 * The only store that can fix the language of the first render.
 *
 * A server render happens before any script runs, so `localStorage` and an authenticated profile
 * fetch are both unavailable to it; a cookie arrives with the request. That is the whole reason
 * this store exists separately, and the reason a server-rendered application needs it: without it
 * the server renders the default language and the browser corrects it after hydration, which is a
 * visible flash of the wrong language on every visit.
 *
 * Writing happens only in the browser. Setting a cookie on the server means setting a response
 * header, and Atlas does not own the response; the consumer's server does. Nothing is lost: the
 * browser writes the same cookie as soon as it takes over.
 */
export function cookieStore(
  options: CookieStoreOptions = {},
): LocalizationPersistenceStoreFactory {
  const name = options.name ?? DEFAULT_COOKIE_NAME;
  const path = options.path ?? '/';
  const maxAge = options.maxAgeSeconds ?? ONE_YEAR_SECONDS;
  const sameSite = options.sameSite ?? 'Lax';
  const secure = options.secure ?? true;
  assertStorableCookie(name, path, options.domain, sameSite, secure);
  return () => {
    const platformId = inject(PLATFORM_ID);
    const browser = isPlatformBrowser(platformId);
    const document = inject(DOCUMENT);
    const request = inject(REQUEST, { optional: true });
    return Object.freeze({
      id: 'cookie',
      read: () => {
        const header = browser
          ? document.cookie
          : (request?.headers.get('cookie') ?? undefined);
        return header === undefined || header.length === 0
          ? undefined
          : storedLocaleText(cookieValue(header, name));
      },
      write: (locale: string) => {
        if (!browser) return;
        document.cookie = [
          `${name}=${encodeURIComponent(locale)}`,
          `Path=${path}`,
          `Max-Age=${maxAge}`,
          `SameSite=${sameSite}`,
          ...(options.domain === undefined ? [] : [`Domain=${options.domain}`]),
          ...(secure ? ['Secure'] : []),
        ].join('; ');
      },
    });
  };
}

/** Which key the choice is kept under. */
export interface LocalStorageStoreOptions {
  /** The storage key. Defaults to the same name the cookie store uses. */
  readonly key?: string;
}

/**
 * Remembers the choice on the device, and is invisible to the server.
 *
 * Correct for an application that renders in the browser, wrong on its own for one that renders on
 * the server: nothing here reaches the first response, so the server picks a language and the
 * browser changes it afterwards. Pair it with the cookie store, or use the cookie store instead.
 */
export function localStorageStore(
  options: LocalStorageStoreOptions = {},
): LocalizationPersistenceStoreFactory {
  const key = options.key ?? DEFAULT_COOKIE_NAME;
  return () => {
    const browser = isPlatformBrowser(inject(PLATFORM_ID));
    return Object.freeze({
      id: 'local-storage',
      read: () => {
        if (!browser) return undefined;
        try {
          return storedLocaleText(localStorage.getItem(key) ?? undefined);
        } catch {
          // Storage can be disabled or full, and reading it can throw outright. A preference
          // nobody can read is a preference that is absent, which the chain already handles.
          return undefined;
        }
      },
      write: (locale: string) => {
        if (!browser) return;
        localStorage.setItem(key, locale);
      },
    });
  };
}

/**
 * The consumer's own transport to an authenticated preference.
 *
 * Deliberately thin. `specs/03-locale-identity-and-resolution.spec.md` section 8 gives the consumer
 * the endpoints, the credentials, the antiforgery and the synchronization, so a store that added
 * any of those would be taking back what the specification handed over. What it adds is uniformity: the
 * signed-in preference becomes one more ordered source, subject to the same commit ordering,
 * validation and failure handling as the cookie beside it, instead of a bespoke integration each
 * application wires differently.
 */
export interface LocalizationProfileTransport {
  /**
   * Fetches the signed-in reader's remembered locale, or nothing when there is none.
   *
   * Anything that is not a usable locale tag is treated as nothing, so a transport may answer with
   * whatever the endpoint returned without screening it first.
   */
  read(): string | undefined | Promise<string | undefined>;
  /** Sends a committed locale to wherever the application keeps the reader's preferences. */
  write(locale: string): void | Promise<void>;
}

/**
 * Turns an application's own preference endpoint into one more ordered source.
 *
 * Takes the two-method transport and returns a store factory to list among the others. The
 * preference is then subject to the same ordering, validation and failure handling as the cookie
 * beside it.
 *
 * Reading is asynchronous, so this store cannot fix the language of a server-rendered first
 * response. Pair it with the cookie store where that matters.
 */
export function profileStore(
  transport: LocalizationProfileTransport,
): LocalizationPersistenceStoreFactory {
  return () =>
    Object.freeze({
      id: 'profile',
      read: async () => storedLocaleText(await transport.read()),
      write: (locale: string) => transport.write(locale),
    });
}
