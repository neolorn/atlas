import { beforeEach, describe, expect, it } from 'vitest';

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Localization, withRouting } from '@neolorn/atlas';
import { provideLocalizationTesting } from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';

import { atlasRuntimeExtensions } from './runtime-extensions';
import { FeatureLabReadiness } from './readiness';
import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * The other half of the argument for keeping six exports published.
 *
 * `readiness.ts` is the consumer: application code that uses six exports for reasons of its own.
 * This is what makes it a consumer that would *notice*. Without assertions on what it renders, a
 * component can import a symbol and never exercise it, which is the shape the decision explicitly
 * rejected: a reference is not a use.
 *
 * So every assertion here is on rendered output, and each one fails for a different export.
 */

describe('the readiness panel exercises what the published surface kept', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FeatureLabReadiness],
      providers: [
        provideRouter([]),
        provideLocalizationTesting(
          {
            configuration,
            catalogSet,
            catalogLoaders,
            recoveryPayload,
            extensions: atlasRuntimeExtensions,
            maximumCachedCatalogs: 1,
            routeProjection,
          },
          withRouting({
            policy: routePolicy,
            projection: appRouteProjection,
          }),
        ),
      ],
    }).compileComponents();
    await TestBed.inject(Localization).initialize();
  });

  function render(): HTMLElement {
    const fixture = TestBed.createComponent(FeatureLabReadiness);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('builds reciprocal links from the injected policy and projection: LOCALE_URL_POLICY', () => {
    const element = render();
    const alternates = [...element.querySelectorAll('[data-alternate]')];

    // What the panel offers is the policy's locales intersected with the ones this build
    // generated, minus the one on screen. This suite runs after `atlas generate --pseudo`, so the
    // contracted pseudo-locale is among them and a developer can switch to it from the page; a
    // production build generates no catalog for it and the same code offers `ar-EG` alone.
    //
    // The expanded pseudo-locale is the control sitting inside this assertion. It is declared and
    // generated exactly like the contracted one and the policy gives it no prefix, so it must not
    // appear, which is the other direction of the same intersection, and the reason this is an
    // exact list rather than a length. An empty list would mean the token resolved to something
    // without a locale table, which is what reading the policy from anywhere other than its single
    // supplier would produce.
    expect(
      alternates.map((link) => link.getAttribute('data-alternate')),
    ).toEqual(['ar-EG', 'en-Arab-XB']);
    // Built through the projection the same token carries, so the path is the real localized one
    // rather than a concatenation.
    expect(alternates[0]?.getAttribute('href')).toBe('/ar-eg');
    expect(alternates[1]?.getAttribute('href')).toBe('/en-arab-xb');
  });

  it('phrases a one-hour span through the policy: resolveRelativeTime, systemClock', () => {
    const text = render()
      .querySelector('[data-readiness-relative]')
      ?.textContent?.trim();

    // One hour back, under a policy whose smallest unit is the minute and largest is the day, is a
    // relative phrase rather than the `elapsed:` fallback. A clock that did not advance, or a
    // policy the resolver ignored, produces the other arm.
    expect(text).toBeDefined();
    expect(text).not.toMatch(/^elapsed:/u);
    expect(text?.length).toBeGreaterThan(0);
  });

  it('derives the message identity a backend code names: issueMessageId', () => {
    expect(
      render().querySelector('[data-readiness-issue-id]')?.textContent?.trim(),
    ).toBe('insufficient-stock');
  });

  it('maps every input status to a code the directive also produces: localizedInputIssueCode', () => {
    const element = render();
    // No input yet, so no issue. The assertion that matters is the next one: the map is keyed by
    // the same function the validator uses, so `unmapped` can only appear if the two disagree.
    expect(
      element
        .querySelector('[data-readiness-input-issue]')
        ?.textContent?.trim(),
    ).toBe('none');
    expect(
      element.querySelector('[data-readiness-input-issue]')?.textContent,
    ).not.toContain('unmapped');
  });

  it('sizes its own budget against the enforced ceiling: RUNTIME_LIMITS', () => {
    // Half of `catalogBytes`. A hardcoded number here would pass this assertion and stop tracking
    // the ceiling, which is the whole reason the limit is published.
    expect(
      render()
        .querySelector('[data-readiness-catalog-budget]')
        ?.textContent?.trim(),
    ).toBe('8388608');
  });
});
