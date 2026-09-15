import { describe, expect, it } from 'vitest';

import { PLATFORM_ID, REQUEST } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PlatformLocation } from '@angular/common';
import {
  MOCK_PLATFORM_LOCATION_CONFIG,
  MockPlatformLocation,
} from '@angular/common/testing';
import {
  Localization,
  negotiateLocale,
  parseAcceptLanguage,
  withRouting,
  provideLocalizationSetup,
  withLocaleSources,
  withPersistence,
  type LocalizationLocaleSource,
  type LocalizationPersistenceStoreFactory,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';

import { atlasRuntimeExtensions } from './runtime-extensions';
import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * Who decides the locale of a first request.
 *
 * `specs/03-locale-identity-and-resolution.spec.md` section 7 lists the sources, "authoritative locale URL, configured
 * persistence adapters, request or browser language preferences, and the configured default",
 * and says consumers "may omit or explicitly order optional sources". An option that takes a
 * function and leaves the consumer to write the chain implements none of them: the function this
 * fixture would carry is the `url` source, and four applications would write it four times.
 *
 * The rule that makes an order mean anything is that a source may decline. A URL with no locale
 * prefix has stated nothing; answering the default there would make every later source
 * unreachable, and the consumer's declared order would be decoration.
 */

interface Environment {
  readonly sources?: readonly LocalizationLocaleSource[];
  readonly stores?: readonly LocalizationPersistenceStoreFactory[];
  readonly url?: string;
  readonly acceptLanguage?: string;
  readonly withPolicy?: boolean;
}

function setup(environment: Environment): Localization {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      // A server platform with a real request is the only place both the URL and the client's
      // language preferences can be supplied deterministically, and it is the render that matters
      // most: it is the one the visitor sees first.
      { provide: PLATFORM_ID, useValue: 'server' },
      {
        provide: REQUEST,
        useValue: new Request('https://atlas.example/', {
          headers:
            environment.acceptLanguage === undefined
              ? {}
              : { 'accept-language': environment.acceptLanguage },
        }),
      },
      // The address, supplied the way Atlas now reads it on the server.
      //
      // Not `REQUEST_CONTEXT`. `@angular/ssr` provides that token only when the render mode is
      // `Server`, so a prerendered page has no address at all and resolves to the default locale:
      // Arabic addresses rendered in English and written to disk. Atlas derives the address from
      // `PlatformLocation`, which the server platform initializes from the address being rendered
      // under both prerendering and SSR.
      //
      // Absent when the environment names no URL, so the `url` source has nothing to read and
      // declines, which is the case the ordering tests below depend on.
      ...(environment.url === undefined
        ? []
        : [
            {
              provide: MOCK_PLATFORM_LOCATION_CONFIG,
              useValue: { startUrl: `https://atlas.example${environment.url}` },
            },
            { provide: PlatformLocation, useClass: MockPlatformLocation },
          ]),
      provideLocalizationSetup(
        {
          configuration,
          catalogSet,
          catalogLoaders,
          recoveryPayload,
          extensions: atlasRuntimeExtensions,
          routeProjection,
        },
        // One declaration of the locale URL policy, wherever it is read from.
        ...(environment.withPolicy === false
          ? []
          : [
              withRouting({
                policy: routePolicy,
                projection: appRouteProjection,
              }),
            ]),
        ...(environment.sources === undefined
          ? []
          : [withLocaleSources(...environment.sources)]),
        ...(environment.stores === undefined
          ? []
          : [withPersistence(...environment.stores)]),
      ),
    ],
  });
  return TestBed.inject(Localization);
}

function storeReturning(
  locale: string | undefined,
): LocalizationPersistenceStoreFactory {
  return () => ({
    id: 'test',
    read: () => locale,
    write: () => undefined,
  });
}

describe('reading what the client asked for', () => {
  it('orders ranges by quality, keeping header order within a tie', () => {
    expect(parseAcceptLanguage('en;q=0.7,ar-EG,fr;q=0.7,de;q=0.9')).toEqual([
      'ar-EG',
      'de',
      'en',
      'fr',
    ]);
  });

  it('drops a range that expresses no preference', () => {
    // `*` means "anything else will do", which is what the configured default already says. Taking
    // it as a match would let a header that asked for nothing outrank the source placed after it.
    expect(parseAcceptLanguage('*')).toEqual([]);
    expect(parseAcceptLanguage('ar,*;q=0.1')).toEqual(['ar']);
  });

  it('drops a range that is refused outright or malformed', () => {
    expect(parseAcceptLanguage('en;q=0')).toEqual([]);
    expect(parseAcceptLanguage('../etc/passwd')).toEqual([]);
    expect(parseAcceptLanguage('')).toEqual([]);
  });
});

describe('matching a request against what exists', () => {
  const supported = ['en-US', 'ar-EG'];
  const canonicalize = (value: string) => {
    try {
      return Intl.getCanonicalLocales(value)[0];
    } catch {
      return undefined;
    }
  };

  it('matches a different region of the same language', () => {
    // The case plain RFC 4647 lookup leaves unmatched. Answering English to an Arabic speaker
    // because the region differs is the wrong answer by a wide margin.
    expect(negotiateLocale(['ar-SA'], supported, canonicalize)).toBe('ar-EG');
    expect(negotiateLocale(['en-GB'], supported, canonicalize)).toBe('en-US');
  });

  it('resolves each range fully before considering the next', () => {
    // A client that prefers Arabic and accepts English must not be handed English because its
    // Arabic tag needed one more step to match.
    expect(negotiateLocale(['ar-SA', 'en-US'], supported, canonicalize)).toBe(
      'ar-EG',
    );
  });

  it('drops trailing subtags one at a time', () => {
    expect(negotiateLocale(['ar-EG-u-nu-arab'], supported, canonicalize)).toBe(
      'ar-EG',
    );
  });

  it('answers nothing when no range is related to anything supported', () => {
    expect(negotiateLocale(['ja-JP'], supported, canonicalize)).toBeUndefined();
    expect(negotiateLocale([], supported, canonicalize)).toBeUndefined();
  });
});

describe('the declared order', () => {
  it('takes the URL when the URL states a locale', async () => {
    const localization = setup({
      sources: ['url', 'stored', 'default'],
      stores: [storeReturning('en-US')],
      url: '/ar-eg/second',
    });

    expect((await localization.initialize()).primaryLocale).toBe('ar-EG');
  });

  it('steps past the URL when the URL states none', async () => {
    // The rule the whole ordering rests on. `/` carries no prefix, so it has stated nothing, and
    // the stored preference answers instead of being pre-empted by a default.
    const localization = setup({
      sources: ['url', 'stored', 'default'],
      stores: [storeReturning('ar-EG')],
      url: '/',
    });

    expect((await localization.initialize()).primaryLocale).toBe('ar-EG');
  });

  it('falls through to what the client asked for', async () => {
    const localization = setup({
      sources: ['url', 'stored', 'browser', 'default'],
      stores: [storeReturning(undefined)],
      url: '/',
      acceptLanguage: 'ar-SA,en;q=0.5',
    });

    expect((await localization.initialize()).primaryLocale).toBe('ar-EG');
  });

  it('reaches the default when every earlier source declines', async () => {
    const localization = setup({
      sources: ['url', 'stored', 'browser', 'default'],
      url: '/',
      acceptLanguage: 'ja-JP',
    });

    expect((await localization.initialize()).primaryLocale).toBe('en-US');
  });

  it('honours the order, not Atlas s opinion of it', async () => {
    // Storage ahead of the URL is unusual and legitimate: an application that deliberately pins a
    // signed-in user's language regardless of the link they followed.
    const localization = setup({
      sources: ['stored', 'url', 'default'],
      stores: [storeReturning('ar-EG')],
      url: '/en-us/second',
    });

    expect((await localization.initialize()).primaryLocale).toBe('ar-EG');
  });

  it('disables a source by leaving it out', async () => {
    const localization = setup({
      sources: ['url', 'default'],
      stores: [storeReturning('ar-EG')],
      url: '/',
    });

    // The store is installed and holds a usable value. It is simply not consulted, which is what
    // omitting a source has to mean if declaring one is to mean anything.
    expect((await localization.initialize()).primaryLocale).toBe('en-US');
  });

  it('declines the URL source when no policy was supplied', async () => {
    const localization = setup({
      sources: ['url', 'stored', 'default'],
      stores: [storeReturning('ar-EG')],
      url: '/ar-eg/second',
      withPolicy: false,
    });

    expect((await localization.initialize()).primaryLocale).toBe('ar-EG');
  });
});

/**
 * The order an application gets when it declares none.
 *
 * `app.config.ts` declares no sources. Writing `withLocaleSources('url', 'stored', 'browser',
 * 'default')` there restates Atlas's default, which says nothing and creates a second place to
 * maintain; leaving it out puts this application's behaviour on a constant, and every test above
 * passes an explicit `sources` rather than exercising it.
 *
 * So these four pin the default, and they pin it **by behaviour rather than by reading
 * `DEFAULT_LOCALE_SOURCES`**. Comparing the negotiated order against the constant that produces it
 * would agree whether or not either is right. Each test instead puts two sources in conflict and
 * asserts which one answers, which is the only thing that distinguishes one order from another.
 *
 * Together they fix all four ranks: url > stored > browser > default. Reordering any adjacent pair
 * fails at least one of them, and dropping a source from the default fails the test that depends on
 * it answering.
 */
describe('the order an application gets without declaring one', () => {
  it('takes the URL over a stored preference', async () => {
    const localization = setup({
      stores: [storeReturning('en-US')],
      url: '/ar-eg/second',
    });

    // Both sources have an answer and they disagree. Only the URL being ranked first explains
    // Arabic here.
    expect((await localization.initialize()).primaryLocale).toBe('ar-EG');
  });

  it('takes a stored preference over what the client asked for', async () => {
    const localization = setup({
      stores: [storeReturning('ar-EG')],
      url: '/',
      acceptLanguage: 'en-US',
    });

    expect((await localization.initialize()).primaryLocale).toBe('ar-EG');
  });

  it('takes what the client asked for over the configured default', async () => {
    const localization = setup({
      stores: [storeReturning(undefined)],
      url: '/',
      acceptLanguage: 'ar-SA,en;q=0.5',
    });

    // `en-US` is the configured default, so anything other than `ar-EG` here means the browser
    // source is either ranked below the default or absent from it.
    expect((await localization.initialize()).primaryLocale).toBe('ar-EG');
  });

  it('reaches the configured default when nothing earlier answers', async () => {
    const localization = setup({
      url: '/',
      acceptLanguage: 'ja-JP',
    });

    expect((await localization.initialize()).primaryLocale).toBe('en-US');
  });
});

describe('a configuration that cannot mean anything', () => {
  it('refuses an empty source list', () => {
    expect(() => withLocaleSources()).toThrow();
  });

  it('refuses a source declared twice', () => {
    // Two positions for one source is two different answers to "when is this consulted", and the
    // second is unreachable. Silently keeping the first would hide the contradiction.
    expect(() => withLocaleSources('url', 'stored', 'url')).toThrow();
  });
});
