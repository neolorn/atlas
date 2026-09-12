import { afterEach, describe, expect, it, vi } from 'vitest';

import { Location } from '@angular/common';
import { MOCK_PLATFORM_LOCATION_CONFIG } from '@angular/common/testing';
import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  Router,
  RouterOutlet,
  withRouterConfig,
  type Routes,
} from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import { Localization, withRouting } from '@neolorn/atlas';
import {
  RouteLocalization,
  provideLocalizedRouter,
} from '@neolorn/atlas/router';
import { provideLocalizationTesting } from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';
import { messages, providerId, scopeId } from '#i18n/shell';

import { routes as applicationRoutes } from './app.routes';
import { atlasRuntimeExtensions } from './runtime-extensions';
import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * When the locale commit happens relative to the view that shows it.
 *
 * The Router adapter committed the locale transaction on `NavigationEnd`, after the router had
 * already constructed and rendered the destination component. So arriving in Arabic built the page
 * against the English snapshot, painted it in English, and corrected it a moment later when the
 * transaction landed. An application that offers a locale control on every page, the ordinary
 * placement, shows that to every user on every switch.
 *
 * The commit now happens in the route resolver, which the router runs after guards and before
 * activation. Scopes are preloaded first, so the transaction resolves in microtasks and the
 * browser never gets a chance to paint between the commit and the view that belongs to it.
 *
 * None of these cases drives that through `navigateByUrl('/ar-eg')`, and none can.
 * `LocalizedUrlHandlingStrategy.extract` delocalizes a programmatic address before the Router
 * matches it, so `/ar-eg` is a navigation to `/` in the locale that is committed now: the locale
 * named in the argument is ignored rather than applied. That is the design: **changing locale is
 * its own operation, not a navigation**, and `Localization.changeLocale` is the only thing that
 * performs it. The address bar follows, written by `LocalizedAddressSync`.
 *
 * So the ordering under test is driven the way an application drives it. What that costs is worth
 * naming: a locale switch constructs nothing, so the construction-time reading below is taken on
 * the navigation that follows a switch, and the paint-time readings on the switch itself. The last
 * case pins the contract that makes the rest of the file read the way it does.
 */

const constructedWith: string[] = [];

/**
 * Both ways of reading a message, side by side, because the difference between them is the
 * difference between F1's symptom returning and not.
 *
 * `text()` evaluates once, when the component is constructed, and never again: it is the
 * snapshot read. `textSignal()` is the live one. On a page that offers a locale control, a
 * `text()` binding is still showing the outgoing language after the switch commits, and no
 * amount of correct ordering inside Atlas changes that. The tests below read both, so which
 * one moves is stated rather than assumed.
 */
@Component({
  standalone: true,
  template: `{{ heading }}|{{ liveHeading() }}`,
})
class LocaleRecordingRoute {
  private readonly localization = inject(Localization);
  protected readonly heading = this.localization.text(messages.route.home);
  protected readonly liveHeading = this.localization.textSignal(
    messages.route.home,
  );

  constructor() {
    // What the destination page was built against. This is the value that decides which language
    // the first frame of the new page is painted in.
    constructedWith.push(this.localization.snapshot()?.primaryLocale ?? 'none');
  }
}

@Component({
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
class RootHost {}

// The application's own routes, canonical. Atlas no longer wraps them in locale parents, it
// derives the locale branches from the route projection and supplies them separately, so this is
// exactly what a consumer writes.
const routes: Routes = [
  { path: '', component: LocaleRecordingRoute },
  { path: 'second', component: LocaleRecordingRoute },
  { path: '**', component: LocaleRecordingRoute },
];

async function setup(): Promise<{
  readonly router: Router;
  readonly localization: Localization;
}> {
  constructedWith.length = 0;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideLocalizedRouter(routes, {
        requiredScopes: [{ providerId, scopeId }],
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
  });
  const localization = TestBed.inject(Localization);
  await localization.initialize();
  return { router: TestBed.inject(Router), localization };
}

describe('switching locale, and navigating after one', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a page navigated to after a switch against the switched locale', async () => {
    const { router, localization } = await setup();
    TestBed.createComponent(RootHost);

    await router.navigateByUrl('/');
    TestBed.tick();
    expect(constructedWith.at(-1)).toBe('en-US');

    await localization.changeLocale('ar-EG');
    TestBed.tick();

    // A switch constructs nothing: the route did not change, so the component that is on screen
    // stays on screen and re-renders from the signal. The reading only becomes available again on
    // the next navigation, and this is it.
    await router.navigateByUrl('/second');
    TestBed.tick();

    // The whole point of committing in the resolver. Commit after activation instead and this is
    // 'en-US': the destination page is constructed, and painted, from the outgoing snapshot.
    expect(constructedWith.at(-1)).toBe('ar-EG');
    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');

    // And nothing was built against the outgoing locale after the switch, which is the claim the
    // reading above makes only for the last construction.
    const afterSwitch = constructedWith.slice(1);
    expect(afterSwitch).not.toContain('en-US');
  });

  it('has committed by the time the switch resolves', async () => {
    const { router, localization } = await setup();
    TestBed.createComponent(RootHost);
    await router.navigateByUrl('/');
    TestBed.tick();

    await localization.changeLocale('ar-EG');

    // No settled() in between. A caller that awaits the switch has every right to read the locale
    // it switched to.
    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
  });

  it('renders the switched language without a further navigation', async () => {
    const { router, localization } = await setup();
    const fixture = TestBed.createComponent(RootHost);
    await router.navigateByUrl('/');
    TestBed.tick();
    expect(fixture.nativeElement.textContent).toBe('Home route|Home route');

    await localization.changeLocale('ar-EG');
    TestBed.tick();

    // One change-detection pass after the switch resolves, no navigation and no reconstruction,
    // and the live binding is already in the new language.
    //
    // Asserted as the whole string rather than as a `toContain`, because the half that did *not*
    // move is the more useful half of this reading. `heading` is a `text()` call evaluated in the
    // constructor: it is a snapshot, it is still English, and Atlas cannot make it otherwise. An
    // application whose visible strings are bound that way has F1's symptom back, the page
    // showing the outgoing language after the commit landed, from its own code rather than from
    // the adapter's ordering. Which binding an application reaches for is the part of this that
    // is not Atlas's to decide, so the test states the consequence instead of hiding it.
    expect(fixture.nativeElement.textContent).toBe(
      'Home route|الصفحة الرئيسية',
    );
  });

  it('ignores a locale named in a programmatic address, and says so', async () => {
    // The contract the header describes, asserted rather than only described.
    //
    // `navigateByUrl('/ar-eg')` is a navigation to `/`, answered in the locale that is committed
    // now. It is not a switch and it is not a no-op: the address is delocalized on the way into
    // the matcher, so the canonical route runs with everything declared on it, which is 4.18's
    // whole point. What it does not do is change the language.
    //
    // **And the second half of the name is asserted, because it was not.** This case was written
    // as "and says so" while asserting only the ignoring. A test name is a claim like any other,
    // and one that names a behaviour it does not read is the same defect as a comment that cites
    // a check nobody wrote.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { router, localization } = await setup();
    const fixture = TestBed.createComponent(RootHost);
    await router.navigateByUrl('/');
    TestBed.tick();

    await router.navigateByUrl('/ar-eg');
    TestBed.tick();

    expect(localization.snapshot()?.primaryLocale).toBe('en-US');
    expect(constructedWith.at(-1)).toBe('en-US');
    expect(fixture.nativeElement.textContent).toContain('Home route');

    // Three things, because a caller who wrote a locale into an address and got a different one
    // needs all three to act: what they wrote, what to write instead, and the operation that does
    // what they were trying to do. Read as substrings rather than as the whole message, so that
    // rewording the sentence is not a test failure and dropping any of the three is.
    const delocalized = warn.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
      .filter((message) => message.includes('names a locale in the address'));
    expect(delocalized).toHaveLength(1);
    expect(delocalized[0]).toContain('"/ar-eg"');
    expect(delocalized[0]).toContain('"/"');
    expect(delocalized[0]).toContain('Localization.changeLocale()');
  });

  it('says nothing when the address it was given is already canonical', async () => {
    // The other direction, and the reason it is here: a diagnostic asserted only where it fires is
    // green for a strategy that warns on every navigation. Same bootstrap, same navigation count,
    // one character of difference in the address.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { router } = await setup();
    TestBed.createComponent(RootHost);
    await router.navigateByUrl('/');
    TestBed.tick();

    await router.navigateByUrl('/second');
    TestBed.tick();

    expect(
      warn.mock.calls
        .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
        .filter((message) => message.includes('names a locale in the address')),
    ).toEqual([]);
  });
});

describe('a Router configuration the adapter cannot make coherent', () => {
  it('refuses an eager URL update instead of quietly misbehaving', async () => {
    // Committing before activation keeps the view and its language in step. An eager URL update
    // moves the address bar at the start of navigation instead, so the new locale's URL sits over
    // the old locale's page for the whole of guards and resolution: the same incoherence
    // somewhere the adapter cannot reach. Refused outright rather than left to fixture convention,
    // which is to say to luck.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideLocalizedRouter(
          routes,
          { requiredScopes: [{ providerId, scopeId }] },
          // Passed as a router feature, which is also the shape 5.1a warns about: Angular provides
          // ROUTER_CONFIGURATION non-multi, so this replaces Atlas's own configuration entirely.
          // That is the mechanism the refusal below has to survive.
          withRouterConfig({ urlUpdateStrategy: 'eager' }),
        ),
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
    });

    // Settled first, so the assertion is about the adapter's refusal and not about a context
    // being torn down mid-initialization.
    await TestBed.inject(Localization).initialize();

    expect(() => TestBed.inject(RouteLocalization)).toThrow(/deferred/u);
  });
});

/**
 * The order of the things one locale commit does, read off the document rather than described.
 *
 * Five things happen on a switch: the document's `lang` and `dir` are written, the address bar is
 * brought into line, the head is re-projected for the new locale, the interaction that was captured
 * is put back, and the change is announced. Three were commit hooks, ordered by one array in
 * `provideLocalization()`. Two, the address bar and the head, were Angular effects belonging to
 * the routing adapter, so their turn came when their services happened to be constructed. An order
 * that emerges from construction is an order nothing states, nothing can change deliberately, and
 * no test can read; it is also an order that a later `inject()` in an unrelated constructor can
 * reverse without anything going red.
 *
 * All five are now positions in the one array, and this is the reading of it.
 *
 * **The vantage point is the address write itself.** `Location.onUrlChange` fires synchronously
 * inside `replaceState`, which makes it the one point in the sequence that is not batched: what the
 * document already says at that instant ran before it, and what it does not yet say runs after.
 * `MutationObserver` was tried first and is the wrong instrument here: its callbacks are
 * delivered at one microtask checkpoint, so the order they arrive in is the order the records were
 * queued to be delivered, not the order the writes happened.
 *
 * **What this can and cannot see.** Two of the four readings below are load-bearing and go red if
 * the array is reordered: the address bar carrying the new locale at all (the two routed steps run
 * after publication, not inside the transaction. Run inside it they read the outgoing snapshot,
 * spell the outgoing locale, and the address sync then finds nothing to correct, so nothing is
 * written at all), and the canonical still carrying the outgoing address (the head is projected
 * after the address bar, so the page never advertises a URL the browser is not at).
 *
 * The other two are true but are held by something other than this array, and saying so is the
 * point of writing them down. `lang` is already the new locale because the document hook writes it
 * in `apply`, inside the transaction, and every `apply` precedes every `committed`: moving that
 * hook's position in the array does not move the write, and a case below drives exactly that.
 * `announced` is still empty because the announcement defers itself a microtask and a frame on
 * purpose, so it lands last wherever it sits in the array. Its position is a statement of intent
 * that this vantage point cannot check, and the settled reading at the end is what checks that it
 * lands at all.
 */
describe('the order of the things one locale commit does', () => {
  it('moves the address bar after the document language and before the head', async () => {
    history.replaceState(null, '', '/ar-eg/second');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MOCK_PLATFORM_LOCATION_CONFIG,
          useValue: { startUrl: 'https://atlas.example/ar-eg/second' },
        },
        // The application's own routes and a configured origin, because the head is half of what
        // is being ordered and a canonical URL needs both.
        provideLocalizedRouter(applicationRoutes, {
          origin: 'https://atlas.example',
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
          withRouting({ policy: routePolicy, projection: appRouteProjection }),
        ),
      ],
    });

    const localization = TestBed.inject(Localization);
    await localization.initialize();
    const router = TestBed.inject(Router);
    TestBed.createComponent(RootHost);

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

    const canonical = (): string | null =>
      document.querySelector('link[rel="canonical"]')?.getAttribute('href') ??
      null;
    const announced = (): string | null =>
      document.querySelector('[data-atlas-announcer]')?.textContent ?? null;

    const atTheAddressWrite: unknown[] = [];
    const stopWatching = TestBed.inject(Location).onUrlChange((url) => {
      atTheAddressWrite.push({
        url,
        lang: document.documentElement.lang,
        canonical: canonical(),
        announced: announced(),
      });
    });

    await localization.changeLocale('en-US');
    TestBed.tick();
    stopWatching();

    // One entry, and the whole state of the document at the instant it was written. Asserted as
    // one object rather than four readings, because the claim is about a sequence and a sequence
    // is only readable if the things before and the things after are next to each other.
    expect(atTheAddressWrite).toEqual([
      {
        url: '/en-us/second',
        lang: 'en-US',
        canonical: 'https://atlas.example/ar-eg/second',
        announced: '',
      },
    ]);

    // And the rest of the list, once it has run. Without this the two "not yet" readings above
    // would be satisfied by a head that never projects and an announcement that is never made.
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(canonical()).toBe('https://atlas.example/en-us/second');
    expect(announced()).toBe('American English');
  });
});
