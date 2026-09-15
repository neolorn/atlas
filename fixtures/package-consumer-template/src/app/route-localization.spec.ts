import { vi } from 'vitest';

import { LocationStrategy } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, type Routes } from '@angular/router';
import { Localization, withRouting } from '@neolorn/atlas';
import {
  RouteLocalization,
  provideLocalizedRouter,
  type RouteLocalizationContext,
} from '@neolorn/atlas/router';
import { provideLocalizationTesting } from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';
import {
  providerId as lazyProviderId,
  scopeId as lazyScopeId,
} from '#i18n/lazy';

import { routePolicy, appRouteProjection } from './localization.routes';
import { atlasRuntimeExtensions } from './runtime-extensions';

@Component({
  standalone: true,
  template: `route`,
})
class RouteProbe {}

/**
 * The application's own routes, canonical, and every address this file navigates to.
 *
 * Every address this file reaches is declared, `/en-us/lazy` included. Atlas appends no
 * catch-all, so an application without a not-found page does not silently acquire one, and an
 * address this list omits renders nothing rather than falling into an appended `**` with the
 * resolver on it and leaving the assertions below about the adapter alone. The `**` here is this
 * fixture's, written where a consumer writes it.
 */
const routes: Routes = [
  { path: '', component: RouteProbe },
  { path: 'second', component: RouteProbe },
  { path: 'lazy', component: RouteProbe },
  { path: '**', component: RouteProbe },
];

/**
 * What this application decides, and nothing more.
 *
 * No `requiredScopes`. The generated route table names what each route must have ready and the
 * adapter loads it, so declaring the shell scope here restated a fact Atlas already holds, and
 * while it was declared, this file passed whether or not the derivation worked at all.
 */
const ATLAS_ROUTING_OPTIONS = {
  origin: 'https://atlas.example',
  document: ({ resolution }: RouteLocalizationContext) => ({
    title:
      resolution.locale === 'ar-EG' ? 'مختبر ميزات Atlas' : 'Atlas feature lab',
  }),
} as const;

describe('Atlas Router transaction integration', () => {
  /** The integration as an application configures it, with nothing added for the test's benefit. */
  const configureRouterIntegration = async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideLocalizedRouter(routes, ATLAS_ROUTING_OPTIONS),
        provideLocalizationTesting(
          {
            configuration,
            catalogSet,
            catalogLoaders,
            recoveryPayload,
            extensions: atlasRuntimeExtensions,
            routeProjection,
          },
          withRouting({
            policy: routePolicy,
            projection: appRouteProjection,
          }),
        ),
      ],
    }).compileComponents();
  };

  /**
   * What a failed post-navigation effect puts back, and where the failure has to be driven from now.
   *
   * Not from `navigateByUrl('/ar-eg')`. `LocalizedUrlHandlingStrategy.extract` delocalizes the
   * address before the Router matches it, so no navigation reaches a locale branch and no
   * navigation changes locale. `Localization.changeLocale` does, and it is not a navigation.
   *
   * So the restore is driven across *routes* instead, from a locale that was switched into
   * beforehand. Three of the four dimensions are unchanged by that: route state, URL and document
   * state all genuinely move and genuinely come back. The fourth is weaker and is worth saying
   * plainly: with no navigation able to change locale, "restores the locale" is now "stays in the
   * locale it was in". That is still a claim worth holding. Restore code that reaches for the
   * default locale rather than the outgoing snapshot passes the old test and fails this one, which
   * is why the assertion is `ar-EG` and not the policy's default.
   */
  it('restores locale, route state, URL, and document state after a post-navigation effect failure', async () => {
    let failDocument = false;
    await TestBed.configureTestingModule({
      providers: [
        provideLocalizedRouter(routes, {
          origin: 'https://atlas.example',
          document: ({ resolution }) => {
            // Keyed on the route rather than the locale, because the locale no longer changes
            // across the navigation under test and keying on it would never fire.
            if (failDocument && resolution.routeId === 'route:second') {
              throw new Error('intentional document failure');
            }
            return {
              title:
                resolution.locale === 'ar-EG'
                  ? 'مختبر ميزات Atlas'
                  : 'Atlas feature lab',
            };
          },
        }),
        provideLocalizationTesting(
          {
            configuration,
            catalogSet,
            catalogLoaders,
            recoveryPayload,
            extensions: atlasRuntimeExtensions,
            routeProjection,
          },
          withRouting({
            policy: routePolicy,
            projection: appRouteProjection,
          }),
        ),
      ],
    }).compileComponents();

    const localization = TestBed.inject(Localization);
    const router = TestBed.inject(Router);
    const routeLocalization = TestBed.inject(RouteLocalization);
    await localization.initialize();
    await router.navigateByUrl('/');
    await expect(routeLocalization.settled()).resolves.toMatchObject({
      status: 'committed',
    });
    expect(localization.snapshot()).toMatchObject({
      primaryLocale: 'en-US',
      route: { routeId: 'route:_index', canonicalPath: '/en-us' },
    });
    expect(document.title).toBe('Atlas feature lab');

    // The switch, which is the operation that changes locale. The address bar follows it, so the
    // state this navigation has to be restored to is an Arabic one throughout.
    //
    // The two addresses are read separately, and under shape 3 they differ. `router.url` is the
    // Router's own tree, and it is canonical now in every case: `extract` delocalizes on the way
    // in, so nothing prefixed ever reaches the matcher and nothing prefixed is ever what the
    // Router holds. What the visitor sees is that tree put back through `prepareExternalUrl`,
    // which is the call `Location.replaceState` funnels through and the one `LocalizedAddressSync`
    // makes on a switch. That a single `expect(router.url).toBe('/en-us')` cannot state this is
    // the invariant rather than a casualty of it.
    await localization.changeLocale('ar-EG');
    // The head is re-projected by an effect, which a running application flushes on its own and a
    // zoneless test has to ask for. `lang` and `dir` do not need this, they are written by a
    // commit hook inside the transaction, but the title, description and alternates do.
    TestBed.tick();
    const externalUrl = () =>
      TestBed.inject(LocationStrategy).prepareExternalUrl(router.url);
    expect(router.url).toBe('/');
    expect(externalUrl()).toBe('/ar-eg');
    expect(document.title).toBe('مختبر ميزات Atlas');

    failDocument = true;
    await router.navigateByUrl('/second');
    await expect(routeLocalization.settled()).resolves.toMatchObject({
      status: 'failed',
      diagnostic: { code: 'effect-failed' },
    });
    // Back at the index, in both forms. Without the restore this is `/second`.
    expect(router.url).toBe('/');
    expect(externalUrl()).toBe('/ar-eg');
    // `canonicalPath` is the whole point of the line. `changeLocale` carries the active route
    // record forward when the caller names none, so a switch that does not restate it leaves the
    // record saying `/en-us` while `primaryLocale` says `ar-EG`. The adapter derives the
    // replacement where the spellings live and restates it through the same publisher, so a
    // snapshot never carries a record from a locale it is not in.
    expect(localization.snapshot()).toMatchObject({
      primaryLocale: 'ar-EG',
      route: { routeId: 'route:_index', canonicalPath: '/ar-eg' },
    });
    expect(routeLocalization.context()?.resolution).toMatchObject({
      locale: 'ar-EG',
      routeId: 'route:_index',
    });
    expect(document.documentElement.lang).toBe('ar-EG');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.title).toBe('مختبر ميزات Atlas');
  });

  /**
   * Scope loading on activation, asserted against the thing that performs it.
   *
   * The scope behind the lazy route is not a startup scope, so nothing has loaded it when this
   * navigation begins and nothing here loads it by hand. The generated route table names it and
   * the adapter loads it on activation, or it stays unavailable. `requiredScopes` is deliberately
   * absent from the configuration above: while it was declared, this file passed whether or not
   * any of that worked, which is how the derivation reached a release guarded by nothing.
   */
  it('loads the scopes a route declares no list for', async () => {
    await configureRouterIntegration();
    const localization = TestBed.inject(Localization);
    const router = TestBed.inject(Router);
    await localization.initialize();

    const lazyScope = { providerId: lazyProviderId, scopeId: lazyScopeId };
    expect(localization.scopeReadiness(lazyScope)().status).not.toBe('ready');

    await router.navigateByUrl('/en-us/lazy');

    expect(localization.scopeReadiness(lazyScope)().status).toBe('ready');
  });

  /**
   * An address the projection does not contain is not a localization failure: the
   * locale resolved and only the page is unknown, so the navigation completes and the application
   * answers. Throwing here abandoned it, and no application's not-found page ever rendered.
   */
  it('completes a navigation to an address it cannot name', async () => {
    await configureRouterIntegration();
    const localization = TestBed.inject(Localization);
    const router = TestBed.inject(Router);
    await localization.initialize();
    await router.navigateByUrl('/en-us');

    await expect(
      router.navigateByUrl('/ar-eg/nothing-is-mounted-here'),
    ).resolves.not.toThrow();
    // The locale committed, which is the whole of the decision: the address is unknown, the
    // language is not. What the adapter keeps in `context()` afterwards is a separate question and
    // is deliberately not asserted here.
    expect(localization.snapshot()).toMatchObject({ primaryLocale: 'ar-EG' });
  });

  /**
   * The regression that removing `RouteLocalization.navigate()` would otherwise have introduced.
   *
   * A locale change is not a navigation, so nothing fires `NavigationEnd` and nothing re-runs the
   * document projection as a side effect: the internal address is `/` before the switch and `/`
   * after it, and only the address bar moves. Without the adapter re-projecting on a locale
   * commit, the title keeps the previous language on every switch, on the very control that does
   * the switching, which is the one place a visitor is certain to be looking.
   *
   * `lang` and `dir` are asserted alongside it because they follow a different mechanism, a
   * commit hook inside the locale transaction, and this is what says the two agree.
   */
  it('re-projects the document when the locale changes without a navigation', async () => {
    await configureRouterIntegration();
    const localization = TestBed.inject(Localization);
    const router = TestBed.inject(Router);
    await localization.initialize();
    await router.navigateByUrl('/en-us');
    expect(document.title).toBe('Atlas feature lab');

    await localization.changeLocale('ar-EG');
    // The re-projection runs in an effect, as the address sync's does, so it lands on the next
    // change detection rather than inside `changeLocale`. A zoneless application schedules that
    // itself; a zoneless TestBed has to be told.
    TestBed.tick();

    expect(document.title).toBe('مختبر ميزات Atlas');
    expect(document.documentElement.lang).toBe('ar-EG');
    expect(document.documentElement.dir).toBe('rtl');
  });

  /**
   * The same hazard as the title, in the other direction, and it was live.
   *
   * The adapter claims the interaction coordinator at construction, so from then on every commit's
   * focus, caret and scroll restore is parked and only `NavigationEnd` releases it. That was right
   * while a locale switch was a navigation. It is not one now, so the restore was parked and never
   * released, and then fired on the next real navigation, putting the previous page's scroll
   * position on the page the reader had just opened.
   *
   * Asserted on `scrollTo`, which is the last thing the restore does, because a restore that never
   * runs and a restore that runs onto an unmoved page look identical from the DOM afterwards.
   */
  it('puts the reader back on a locale change no navigation follows', async () => {
    const scrollTo = vi
      .spyOn(window, 'scrollTo')
      .mockImplementation(() => undefined);
    try {
      await configureRouterIntegration();
      const localization = TestBed.inject(Localization);
      const router = TestBed.inject(Router);
      await localization.initialize();
      await router.navigateByUrl('/en-us');
      scrollTo.mockClear();

      await localization.changeLocale('ar-EG');
      TestBed.tick();
      // The restore is scheduled through `requestAnimationFrame` behind a microtask, so it has not
      // run at the end of the flush that released it.
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );

      expect(scrollTo).toHaveBeenCalled();
    } finally {
      scrollTo.mockRestore();
    }
  });
});
