import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOCUMENT } from '@angular/common';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, type Routes } from '@angular/router';
import {
  LocaleChoice,
  Localization,
  createHostLocalePolicy,
  withRouting,
  type LocaleSelectorChoice,
  type LocaleUrlPolicy,
} from '@neolorn/atlas';
import { provideLocalizedRouter } from '@neolorn/atlas/router';
import { provideLocalizationTesting } from '@neolorn/atlas/testing';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { configuration } from '#i18n';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';

import { routePolicy, appRouteProjection } from './localization.routes';
import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * A locale that is an origin, and the switch that cannot happen in place.
 *
 * Under `createHostLocalePolicy` the locale is carried by the domain. Nothing an application holds
 * crosses a domain (not a cookie scoped to one host, not storage, not a signal, not the running
 * instance) so a switch is a move rather than a transition. Running the transition anyway commits
 * the locale, and the adapter then fails to rebuild the address because the target is on another
 * origin, leaving the reader on an English page with Arabic committed. Withholding an `href` from
 * the switcher, on the reasoning that another origin is not somewhere the adapter can navigate to,
 * does not prevent the switch: it removes the one thing that would make it work.
 *
 * Nuxt i18n's `differentDomains` strategy is the one comparable implementation, and it does the
 * same thing for the same stated reason: its switcher is a plain anchor to the other domain, and
 * its documentation warns that the framework's own link component is wrong for this case. A
 * cross-origin locale switch is a link, and the runtime's job is to know the address.
 *
 * **Both halves are asserted here, and the path-prefix case is why.** A claim that fired for every
 * policy would pass every assertion about the host case and break every application that is not
 * one, so the same switch is made under this fixture's own path-prefix policy and has to come out
 * the other way: committed in place, no navigation, the locale actually changed.
 */

@Component({
  standalone: true,
  template: `route`,
})
class RouteProbe {}

@Component({
  standalone: true,
  imports: [LocaleChoice],
  template: `<a [localeChoice]="choice()">switch</a>`,
})
class ChoiceHost {
  readonly choice = signal<LocaleSelectorChoice>({
    locale: 'ar-EG',
    language: 'ar',
    selfName: 'العربية',
    direction: 'rtl',
    current: false,
    pending: false,
  });
}

const routes: Routes = [
  { path: '', component: RouteProbe },
  { path: 'second', component: RouteProbe },
  { path: '**', component: RouteProbe },
];

const HOST: LocaleUrlPolicy = createHostLocalePolicy({
  defaultLocale: 'en-US',
  origins: {
    'en-US': 'https://atlas.example',
    'ar-EG': 'https://ar.atlas.example',
    'en-Arab-XB': 'https://xb.atlas.example',
  },
});

/**
 * `location.assign`, made observable without giving Atlas a seam it does not need.
 *
 * jsdom's `Location` is unforgeable: its properties are own and non-configurable, so a spy cannot
 * be installed on the real one and the call is otherwise invisible. Jsdom logs "Not implemented"
 * and does nothing. Proxies stand in front of the real objects and delegate everything except the
 * one property under test, so Angular keeps the document it actually needs and this file still
 * sees the call. Bound because jsdom's methods brand-check their receiver.
 *
 * The alternative was asserting only the address `changeLocale` reports, which would leave the one
 * line that actually moves the reader unasserted, and a switch that reports the right address and
 * does not go there is exactly the failure this whole item is about.
 */
function documentWithSpy(assign: (url: string) => void): Document {
  const passThrough =
    <Target extends object>(
      target: Target,
      overrides: Record<string, unknown>,
    ) =>
    (_t: Target, property: string | symbol): unknown => {
      if (typeof property === 'string' && property in overrides)
        return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    };

  const view = document.defaultView;
  if (view === null) throw new Error('This suite needs a window.');
  // Over an empty target, and that is required rather than tidy. A proxy may not report a
  // different value for a non-configurable own data property of its target, and jsdom's
  // `location.assign` is exactly one: proxying the real `Location` throws on the first read of
  // it. An empty target owns nothing, so the trap is free to answer, and the real location is
  // still what every other property is read from.
  const location = new Proxy({} as Location, {
    get: passThrough(view.location, { assign }),
  });
  const proxiedWindow = new Proxy(view, {
    get: passThrough(view, { location }),
  });
  return new Proxy(document, {
    get: passThrough(document, { defaultView: proxiedWindow }),
  }) as Document;
}

let assigned: string[] = [];

async function configure(policy: LocaleUrlPolicy): Promise<Router> {
  assigned = [];
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    providers: [
      {
        provide: DOCUMENT,
        useFactory: () =>
          documentWithSpy((url) => {
            assigned.push(url);
          }),
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
  }).compileComponents();
  const router = TestBed.inject(Router);
  await router.navigateByUrl('/second');
  return router;
}

const addresses = (): Readonly<Record<string, string>> =>
  TestBed.inject(Localization).snapshot()?.route?.addresses ?? {};

describe('switching locale under a policy whose locales are origins', () => {
  beforeEach(() => {
    for (const node of document.querySelectorAll('link[rel="alternate"]')) {
      node.remove();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes the other origin as the address of this page', async () => {
    await configure(HOST);

    const record = addresses();
    const here = record['en-US'];
    const there = record['ar-EG'];

    // Asserted as a relation rather than as three literals. What makes this a locale switch and
    // not a link somewhere else is that it is *the same page* at another origin: the origins come
    // from the policy and the path is the one this page already has.
    expect(new URL(here ?? '').origin).toBe('https://atlas.example');
    expect(new URL(there ?? '').origin).toBe('https://ar.atlas.example');
    expect(new URL(there ?? '').pathname).toBe(new URL(here ?? '').pathname);
  });

  it('writes that address as the switcher href', async () => {
    await configure(HOST);
    const fixture = TestBed.createComponent(ChoiceHost);
    fixture.detectChanges();

    // The whole reason the address is published. Without an `href` the option is a control the
    // reader cannot open in a new tab, copy, or see the destination of, and under this policy it
    // is also the address the switch itself goes to, so an option without one was a button that
    // could not do the only thing it was for.
    const anchor: HTMLAnchorElement =
      fixture.nativeElement.querySelector('a[href]');
    expect(anchor.getAttribute('href')).toBe(addresses()['ar-EG']);
  });

  it('moves the document instead of committing the locale', async () => {
    await configure(HOST);
    const localization = TestBed.inject(Localization);
    const target = addresses()['ar-EG'];

    const result = await localization.changeLocale('ar-EG');

    expect(result.status).toBe('redirected');
    expect(result).toMatchObject({ targetLocale: 'ar-EG', address: target });
    // The move actually started, at the address that was reported.
    expect(assigned).toEqual([target]);
    // And nothing was committed here. A transition that ran would leave this application claiming
    // Arabic at the English origin, which is the state the reader was left in before this.
    expect(localization.snapshot()?.primaryLocale).toBe('en-US');
  });

  it('leaves the locale this origin already serves to the ordinary transition', async () => {
    await configure(HOST);
    const localization = TestBed.inject(Localization);

    // `en-US` is this build's own origin, so there is nowhere to go. The claim has to answer for
    // the policy *and* for the locale, and a claim that only read the policy would strand the one
    // locale that works.
    const result = await localization.changeLocale('en-US');

    expect(result.status).not.toBe('redirected');
    expect(assigned).toEqual([]);
  });

  it('does not claim a switch under a policy that keeps its locales in one origin', async () => {
    await configure(routePolicy);
    const localization = TestBed.inject(Localization);

    const result = await localization.changeLocale('ar-EG');

    // The control, and the reason this file is not just the host case. A claim that fired for
    // every policy would satisfy every assertion above and break every application that puts its
    // locales in the path.
    expect(result.status).toBe('committed');
    expect(assigned).toEqual([]);
    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
  });
});
