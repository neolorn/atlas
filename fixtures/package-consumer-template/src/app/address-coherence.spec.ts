import { describe, expect, it } from 'vitest';

import { Location, PlatformLocation } from '@angular/common';
import { MOCK_PLATFORM_LOCATION_CONFIG } from '@angular/common/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  Router,
  RouterOutlet,
} from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import { Localization, withRouting } from '@neolorn/atlas';
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
 * The address bar spells the current route in the committed locale, at every point a reader can
 * stop at.
 *
 * That is one sentence and it is deliberately not a list of occasions. Moving the address bar
 * *when the locale changes* is true and is not enough: a locale change is not the only way the two
 * come apart, and an answer shaped like a trigger only covers the triggers someone thought of.
 *
 * **The one nobody thought of.** A `popstate` onto a history entry whose canonical route is the one
 * already active is skipped by the Router (`NavigationSkipped`, `IgnoredSameUrlNavigation`) and
 * a skipped navigation never reaches `setBrowserUrl`. The entry it returned to was written before a
 * locale change, in the previous language, so it stays on screen while the page renders in the
 * current one: an English page at an Arabic address.
 *
 * The two groups below are the two halves of that claim. The first is the sequence a reader
 * produces with the Router alone, asserted step by step: it was already correct and it has to
 * stay correct, because a check that fires on more occasions is also a check that can write on more
 * occasions. The second is the one that was wrong, and it needs an application to push its own
 * history entry, which is what a modal, a wizard step or a filter kept in history does.
 */

@Component({
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
class RootHost {}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 20));

interface Application {
  readonly router: Router;
  readonly platform: PlatformLocation;
  readonly location: Location;
  readonly localization: Localization;
  /** Every skip the Router reported, so a test can say which mechanism it exercised. */
  readonly skipped: readonly string[];
}

async function arriveAt(startUrl: string): Promise<Application> {
  history.replaceState(null, '', new URL(startUrl).pathname);

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: MOCK_PLATFORM_LOCATION_CONFIG, useValue: { startUrl } },
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
        withRouting({ policy: routePolicy, projection: appRouteProjection }),
      ),
    ],
  });

  const localization = TestBed.inject(Localization);
  await localization.initialize();
  const router = TestBed.inject(Router);
  TestBed.createComponent(RootHost);

  const skipped: string[] = [];
  router.events
    .pipe(filter((event) => event instanceof NavigationSkipped))
    .subscribe((event) =>
      skipped.push(String((event as NavigationSkipped).code)),
    );

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

  return {
    router,
    platform: TestBed.inject(PlatformLocation),
    location: TestBed.inject(Location),
    localization,
    skipped,
  };
}

/** What a reader would see: the address bar, and the route and language behind it. */
const showing = (application: Application): string =>
  `${application.platform.pathname} ${application.router.url} ${String(
    application.localization.snapshot()?.primaryLocale,
  )}`;

const ARABIC_SECOND = 'https://atlas.example/ar-eg/second';

describe('the address bar through a reader’s own history', () => {
  it('spells the route and the locale at every step of a switch and a walk back', async () => {
    const application = await arriveAt(ARABIC_SECOND);
    const trace: string[] = [showing(application)];
    const step = async (act: () => unknown): Promise<void> => {
      await act();
      TestBed.tick();
      await settle();
      trace.push(showing(application));
    };

    await step(() => application.router.navigateByUrl('/'));
    await step(() => application.router.navigateByUrl('/second'));
    await step(() => application.localization.changeLocale('en-US'));
    await step(() => application.location.back());
    await step(() => application.location.back());
    await step(() => application.location.forward());

    // Asserted as one list rather than six times, because what is being pinned is the sequence.
    // Every entry the walk returns to was written in Arabic and comes back re-spelled, which is
    // the ordinary Back path doing its job: `setBrowserUrl` runs with `replaceUrl` on a popstate.
    expect(trace).toEqual([
      '/ar-eg/second /second ar-EG',
      '/ar-eg / ar-EG',
      '/ar-eg/second /second ar-EG',
      '/en-us/second /second en-US',
      '/en-us / en-US',
      '/en-us/second /second en-US',
      '/en-us / en-US',
    ]);
    // Nothing was skipped, which is why this sequence was always right. The Router cannot produce
    // the skip on its own: a locale switch replaces its history entry rather than pushing one, so
    // no two adjacent entries ever carry the same canonical route.
    expect(application.skipped).toEqual([]);
  });

  it('re-spells an entry the application pushed itself, which the Router skips', async () => {
    const application = await arriveAt(ARABIC_SECOND);

    // The second entry on one canonical route: the shape the Router will not make and an
    // application makes whenever it keeps a modal, a step or a filter in history.
    application.location.go('/second');
    await settle();
    expect(showing(application)).toBe('/ar-eg/second /second ar-EG');

    await application.localization.changeLocale('en-US');
    TestBed.tick();
    await settle();
    expect(showing(application)).toBe('/en-us/second /second en-US');

    application.location.back();
    await settle();
    TestBed.tick();
    await settle();

    // The Router skipped this navigation, so nothing in Angular wrote the address: the entry that
    // came back says `/ar-eg/second` and the page is English. Without the check on the skip, this
    // is what the reader is left looking at.
    expect(application.skipped).toEqual([
      String(0), // NavigationSkippedCode.IgnoredSameUrlNavigation
    ]);
    expect(showing(application)).toBe('/en-us/second /second en-US');
  });
});
