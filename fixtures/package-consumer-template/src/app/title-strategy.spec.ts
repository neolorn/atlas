import { describe, expect, it } from 'vitest';

import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router, TitleStrategy } from '@angular/router';
import { Localization, withRouting } from '@neolorn/atlas';
import {
  LocalizedTitleStrategy,
  provideLocalizedRouter,
} from '@neolorn/atlas/router';
import { provideLocalizationTesting } from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';

import { routes } from './app.routes';
import { atlasRuntimeExtensions } from './runtime-extensions';
import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * Who writes `document.title` last, in both of the configurations an application can be in.
 *
 * Angular emits `NavigationEnd` and then calls `titleStrategy.updateTitle(...)` synchronously in
 * the same `tap` (`@angular/router` 22.1.3, `_router-chunk.mjs:3964-3965`). Atlas writes the title
 * during route resolution, before activation, so Angular's strategy always writes afterwards.
 * `DefaultTitleStrategy` writes whenever the route tree declares a title (`:3403-3407`), and
 * `app.routes.ts` declares one, in English, on `second`.
 *
 * So the failure this file is written against is not "Atlas's provider is missing". It is "another
 * string replaced the localized title and nothing said so", and every assertion here reads the
 * document rather than the injector for that reason: a check on
 * `inject(TitleStrategy) instanceof LocalizedTitleStrategy` is green for a strategy that is
 * installed and does the wrong thing. What Atlas *reports* about the token is the other file,
 * `localized-router-diagnostics.spec.ts`.
 */

/** What Atlas projects, per locale. Both differ from the route's declared title. */
const ATLAS_TITLE_EN = 'Atlas feature lab';
const ATLAS_TITLE_AR = 'مختبر ميزات Atlas';
const DECLARED_TITLE = 'Second route, declared in English';

const OPTIONS = {
  document: ({ resolution }: { resolution: { locale: string } }) => ({
    title: resolution.locale === 'ar-EG' ? ATLAS_TITLE_AR : ATLAS_TITLE_EN,
  }),
} as const;

/**
 * The application's providers, with the one line under test present or absent.
 *
 * Absent means absent: no `TitleStrategy` entry at all, which is the configuration a consumer who
 * never read the diagnostic is in. Angular then resolves the token through its own root factory to
 * `DefaultTitleStrategy`, so this is the real omission rather than a substitution standing in for
 * one.
 */
async function bootstrap(
  titleStrategy: 'installed' | 'omitted',
  address = '/second',
): Promise<{
  readonly atNavigationEnd: string;
  readonly afterNavigation: string;
}> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    providers: [
      provideLocalizedRouter(routes, OPTIONS),
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
      ...(titleStrategy === 'installed'
        ? [{ provide: TitleStrategy, useClass: LocalizedTitleStrategy }]
        : []),
    ],
  }).compileComponents();

  const router = TestBed.inject(Router);
  await TestBed.inject(Localization).initialize();

  // One navigation before the one under test, and it is not throat-clearing.
  //
  // `RouteLocalization` subscribes to `router.events` in its constructor, and nothing constructs it
  // until the first navigation's resolver injects it. So on a first navigation a subscriber added
  // here is registered *before* Atlas's and runs before it, and the reading below would be the
  // order this test happened to subscribe in rather than the order the application runs in.
  // Measured: without this line the title reads as empty at `NavigationEnd` in every
  // configuration, which says nothing about who wrote it.
  await router.navigateByUrl('/');

  // Read at two points, because which one is read is the difference between seeing this defect and
  // not. A subscriber to `NavigationEnd` runs *before* `updateTitle`: Angular emits the event and
  // calls the strategy in that order inside one `tap`, so at that instant the title is still the
  // one Atlas wrote, in every configuration.
  let atNavigationEnd = '';
  const subscription = router.events.subscribe((event) => {
    if (event instanceof NavigationEnd) atNavigationEnd = document.title;
  });
  try {
    await router.navigateByUrl(address);
  } finally {
    subscription.unsubscribe();
  }
  return { atNavigationEnd, afterNavigation: document.title };
}

describe('who writes the document title after a navigation', () => {
  it('keeps the projected title when Atlas’s strategy is installed', async () => {
    const { afterNavigation } = await bootstrap('installed');
    expect(afterNavigation).toBe(ATLAS_TITLE_EN);
    expect(afterNavigation).not.toBe(DECLARED_TITLE);
  });

  it('loses the projected title to the declared one when the line is omitted', async () => {
    // The defect, observed rather than inferred. Not "the provider is missing": the page is
    // serving the route's hardcoded string in place of the one Atlas resolved for this locale.
    const { afterNavigation } = await bootstrap('omitted');
    expect(afterNavigation).toBe(DECLARED_TITLE);
  });

  it('shows why the assertion point matters', async () => {
    // The first of the two mutations this pair covers. Both configurations agree at
    // `NavigationEnd` and disagree immediately after it, so an assertion placed in a
    // `NavigationEnd` handler is green for the omitted case: a check that exists and proves
    // nothing.
    const omitted = await bootstrap('omitted');
    expect(omitted.atNavigationEnd).toBe(ATLAS_TITLE_EN);
    expect(omitted.afterNavigation).toBe(DECLARED_TITLE);

    const installed = await bootstrap('installed');
    expect(installed.atNavigationEnd).toBe(ATLAS_TITLE_EN);
    expect(installed.afterNavigation).toBe(ATLAS_TITLE_EN);
  });

  /**
   * The same test, against a prefixed address.
   *
   * Without an address-translating strategy, `navigateByUrl('/ar-eg/second')` consults no
   * `LocationStrategy`, so a prefixed address matches against a locale branch: an entry carrying
   * only the route's target, with the declared `title` nowhere on it. `DefaultTitleStrategy` finds
   * nothing to write, and the localized title survives the omitted configuration *by accident*,
   * which is a false green rather than anything good.
   *
   * `LocalizedUrlHandlingStrategy` delocalizes the address before matching, so both addresses reach
   * the same route, carrying the same declared title, and the two configurations diverge here
   * exactly as they do above. The assertion is therefore the same one, and that sameness is the
   * point: the path a caller took is not a variable.
   */
  it('is exercised by a prefixed address, which reaches the declared title', async () => {
    const omitted = await bootstrap('omitted', '/ar-eg/second');
    expect(omitted.afterNavigation).toBe(DECLARED_TITLE);

    const installed = await bootstrap('installed', '/ar-eg/second');
    expect(installed.afterNavigation).toBe(ATLAS_TITLE_EN);
  });
});
