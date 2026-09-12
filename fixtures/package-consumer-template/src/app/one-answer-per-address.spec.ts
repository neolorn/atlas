import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformLocation } from '@angular/common';
import { MOCK_PLATFORM_LOCATION_CONFIG } from '@angular/common/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  Router,
  RouterOutlet,
} from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import {
  Localization,
  createPathPrefixLocalePolicy,
  withRouting,
  type LocaleUrlPolicy,
} from '@neolorn/atlas';
import { provideLocalizedRouter } from '@neolorn/atlas/router';
import { provideLocalizationTesting } from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';

import { atlasRuntimeExtensions } from './runtime-extensions';
import { routes } from './app.routes';
import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * One address, one answer, whichever door the reader came through.
 *
 * The resolver answers some addresses with a redirect. A visitor arriving from outside gets that
 * answer from the server as an HTTP status and their browser acts on it. A visitor arriving from
 * inside (an in-app link, a `Location` write, a hydrated Back, a reload of a client-only build)
 * never reaches a server, and the address goes to the Router exactly as written. Without one rule
 * covering both doors the same address has two answers depending on which door was used, under
 * `omitDefaultPrefix` and on a retired path spelling alike.
 *
 * The rule is the resolution's own `httpStatus` rather than a list of reasons kept in step by hand,
 * and this file is written so that the two halves of that rule cannot pass together by accident:
 *
 * - The two `308`s, `canonical-correction` and `replacement`, **must** be followed. They
 *   correct the address itself and answer the same for every request.
 * - The `307` (`locale-entry`) and `410` (`gone`) **must not** be. The first answers from a
 *   preference the address does not state; the second is not a redirect at all, and a retired page
 *   with no replacement belongs at the application's own not-found.
 *
 * A test that only asserts the first half stays green if the code follows everything, which moves
 * readers between locales during what is meant to be an address translation. Both halves are
 * asserted here, on the same harness, from the same table.
 *
 * **The address bar needs no code of its own.** `LocalizedAddressSync` writes only on a locale
 * change and an arrival is not one, so the bar looks like it needs a second change. The Router
 * writes the bar itself: `setBrowserUrl` runs on `BeforeActivateRoutes`, its path is
 * `urlHandlingStrategy.merge(finalUrl, initialUrl)` (the address after `extract`, which is the
 * corrected one) and it reaches the browser through `Location.replaceState`, which funnels
 * through `LocalizedLocationStrategy.prepareExternalUrl`. One fix in `toInternalPath` therefore
 * moves the page and the bar together, and the `address` expectations below are what say so.
 *
 * It is a *replace* rather than a push, which is asserted too. `Location.isCurrentPathEqualTo`
 * compares the Router's path against `LocalizedLocationStrategy.path()`, which is already the
 * corrected address, so the two agree and no history entry is added. Back from an arrival at a
 * retired address leaves the site, instead of returning to the retired address and being corrected
 * again: a trap the reader cannot get out of with the Back button, and one that no assertion
 * about the rendered page would notice.
 */

@Component({
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
class RootHost {}

/**
 * The same three locales as the fixture's own policy, with the default locale's prefix dropped.
 *
 * `createPathPrefixLocalePolicy` and `createDefaultLocalePrefixPolicy` are the same policy kind, so
 * this is a policy option rather than a fourth kind, and the addresses it retires, `/en-us/...`,
 * are ones the plain policy still serves. That is what makes the pair below a difference of one
 * option rather than of two applications.
 */
const OMITTING: LocaleUrlPolicy = createPathPrefixLocalePolicy({
  defaultLocale: 'en-US',
  locales: {
    'en-US': 'en-us',
    'ar-EG': 'ar-eg',
    'en-Arab-XB': 'en-arab-xb',
  },
  aliases: { en: 'en-US', ar: 'ar-EG' },
  localeNeutralRoots: ['assets'],
  xDefaultPath: '/',
  omitDefaultPrefix: true,
});

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

interface Arrival {
  /** What the Router matched, and therefore which page rendered. */
  readonly routerUrl: string;
  /** What the address bar says once the navigation has settled. */
  readonly address: string;
  /** The `data-route-view` of whatever rendered. */
  readonly view: string | null;
  readonly locale: string | undefined;
  /** How many history entries the arrival added. Zero means it corrected in place. */
  readonly historyPushes: number;
}

/**
 * A browser-supplied arrival, driven by the Router's own initial navigation.
 *
 * Both halves of the address are set, and the pair is load-bearing: `MockPlatformLocation` is what
 * the `LocationStrategy` reads, and jsdom's `history` is what Atlas's `url` locale source reads.
 * Setting one and not the other leaves the Router and the committed locale disagreeing, which the
 * three-path fixture measured and recorded.
 */
async function arriveAt(
  address: string,
  policy: LocaleUrlPolicy,
): Promise<Arrival> {
  history.replaceState(null, '', address);

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: MOCK_PLATFORM_LOCATION_CONFIG,
        useValue: { startUrl: `https://atlas.example${address}` },
      },
      provideLocalizedRouter(routes, { origin: 'https://atlas.example' }),
      provideLocalizationTesting(
        {
          configuration,
          catalogSet,
          catalogLoaders,
          recoveryPayload,
          extensions: atlasRuntimeExtensions,
          routeProjection,
        },
        withRouting({ policy, projection: appRouteProjection }),
      ),
    ],
  });

  const localization = TestBed.inject(Localization);
  await localization.initialize();
  const router = TestBed.inject(Router);
  const fixture = TestBed.createComponent(RootHost);

  // Watched from before the navigation, and calling through: what is being read is whether the
  // correction added a history entry, and the answer has to come from the call rather than from a
  // count the mock happens to expose. Zero is what rules out the implementation nobody wants:
  // correcting the address by navigating to it, which leaves the retired address one Back away and
  // corrects it again the moment the reader presses it.
  const platform = TestBed.inject(PlatformLocation);
  const pushState = vi.spyOn(platform, 'pushState');

  const settled = firstValueFrom(
    router.events.pipe(
      filter(
        (event) =>
          event instanceof NavigationEnd ||
          event instanceof NavigationCancel ||
          event instanceof NavigationError,
      ),
    ),
  );
  router.initialNavigation();
  await settled;
  TestBed.tick();

  const rendered: HTMLElement | null =
    fixture.nativeElement.querySelector('[data-route-view]');
  return Object.freeze({
    routerUrl: router.url,
    address: platform.pathname + platform.search + platform.hash,
    view: rendered === null ? null : rendered.getAttribute('data-route-view'),
    locale: localization.snapshot()?.primaryLocale,
    historyPushes: pushState.mock.calls.length,
  });
}

describe('a client-side arrival follows the answer the server would have given', () => {
  it('follows a canonical correction: the retired prefix under omitDefaultPrefix', async () => {
    const arrival = await arriveAt('/en-us/second', OMITTING);

    expect(arrival.view).toBe('second');
    expect(arrival.routerUrl).toBe('/second');
    expect(arrival.address).toBe('/second');
    expect(arrival.historyPushes).toBe(0);
  });

  it('follows a replacement: a retired path spelling', async () => {
    const arrival = await arriveAt('/en-us/legacy', routePolicy);

    expect(arrival.view).toBe('second');
    expect(arrival.routerUrl).toBe('/second');
    expect(arrival.address).toBe('/en-us/second');
    expect(arrival.historyPushes).toBe(0);
  });

  it('carries the query and the fragment through the correction', async () => {
    const arrival = await arriveAt('/en-us/second?page=2#notes', OMITTING);

    expect(arrival.view).toBe('second');
    expect(arrival.routerUrl).toBe('/second?page=2#notes');
    expect(arrival.address).toBe('/second?page=2#notes');
  });

  it('leaves a 410 alone, so the application answers for a page with no replacement', async () => {
    const arrival = await arriveAt('/en-us/removed', routePolicy);

    expect(arrival.view).toBe('not-found');
  });

  it('leaves the 307 alone, so an address states no preference it did not carry', async () => {
    const arrival = await arriveAt('/', routePolicy);

    expect(arrival.view).toBe('home');
    expect(arrival.routerUrl).toBe('/');
  });

  it('does not touch an address the policy still serves', async () => {
    const arrival = await arriveAt('/ar-eg/second', OMITTING);

    expect(arrival.view).toBe('second');
    expect(arrival.routerUrl).toBe('/second');
    expect(arrival.address).toBe('/ar-eg/second');
    expect(arrival.locale).toBe('ar-EG');
  });
});
