import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, beforeEach } from 'vitest';

import {
  Localization,
  LocalizedLabel,
  LocalizedMessage,
  LocalizePipe,
  withRouting,
} from '@neolorn/atlas';
import {
  provideLocalizationTesting,
  renderedText,
} from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';
import { messages } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';
import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * A page under a pseudo-locale, and the string that did not go through Atlas.
 *
 * The catalog under test is the one `atlas generate --pseudo` wrote. It is loaded through the
 * application's own generated `catalogLoaders`, switched to with an ordinary `changeLocale`, and
 * nothing here tells the runtime that a pseudo-locale is involved, because nothing can. That is
 * the design: the transform ran at build time and what the runtime received is a target catalog.
 *
 * **The hardcoded string is the point of the criterion, not decoration.** Pseudo-localization
 * exists to make an unlocalized string visible, and a fixture with nothing hardcoded proves the
 * transform runs but not that it catches anything: every assertion would pass for a page with no
 * way to fail. The paragraph below is a string a developer forgot to put through Atlas, and the
 * check is that it comes through the locale change byte for byte while everything beside it does
 * not.
 */

/** A string a developer forgot to put through Atlas. Deliberate, and the whole point. */
const HARDCODED = 'Saved 3 minutes ago';

const MARKER_START = '⟦';
const MARKER_END = '⟧';

@Component({
  selector: 'pseudo-page',
  imports: [LocalizePipe, LocalizedMessage, LocalizedLabel],
  template: `
    <h1 data-title>{{ messages.appTitle | localize }}</h1>
    <localized-message data-rich [handle]="messages.learnMore" />
    <button data-label [localizedLabel]="messages.control.submit"></button>
    <!-- Not localized. A developer typed this straight into the template. -->
    <p data-hardcoded>Saved 3 minutes ago</p>
  `,
})
class PseudoPage {
  protected readonly messages = messages;
}

/**
 * The rendered-text channels. `data-label` is not among them and is asserted separately, because
 * `localizedLabel` writes `aria-label` rather than text: an element with a localized label has no
 * text content at all. Keeping it in the criterion matters: a message that reaches a page only
 * through an attribute is still a message the page rendered, and it is the one a reader scanning
 * for untransformed text would never notice.
 */
const LOCALIZED = ['data-title', 'data-rich'] as const;

const textOf = (element: HTMLElement, selector: string): string =>
  renderedText(element.querySelector(`[${selector}]`) as Element);

const labelOf = (element: HTMLElement): string =>
  element.querySelector('[data-label]')?.getAttribute('aria-label') ?? '';

describe('a page rendered under a pseudo-locale', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PseudoPage],
      providers: [
        provideRouter([]),
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
    }).compileComponents();
    await TestBed.inject(Localization).initialize();
  });

  it('transforms every message it rendered and leaves the hardcoded string alone', async () => {
    const fixture = TestBed.createComponent(PseudoPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    const before = new Map(
      LOCALIZED.map((selector) => [selector, textOf(element, selector)]),
    );
    const labelBefore = labelOf(element);
    const hardcodedBefore = textOf(element, 'data-hardcoded');
    expect(hardcodedBefore).toBe(HARDCODED);
    expect(labelBefore.length).toBeGreaterThan(0);
    expect(labelBefore).not.toContain(MARKER_START);
    for (const [selector, value] of before) {
      // Non-empty first. Every assertion below passes vacuously for an empty string, and an
      // earlier draft of this spec did exactly that: the localized elements never resolved and
      // "contains no marker" was true of nothing at all.
      expect(
        value.length,
        `${selector} rendered nothing before the switch`,
      ).toBeGreaterThan(0);
      expect(value).not.toContain(MARKER_START);
    }

    await TestBed.inject(Localization).changeLocale('en-Arab-XB');
    await fixture.whenStable();

    for (const selector of LOCALIZED) {
      const after = textOf(element, selector);
      expect(after).toContain(MARKER_START);
      expect(after).toContain(MARKER_END);
      expect(after).not.toBe(before.get(selector));
    }

    // The attribute channel, transformed like the text ones.
    const labelAfter = labelOf(element);
    expect(labelAfter).toContain(MARKER_START);
    expect(labelAfter).toContain(MARKER_END);
    expect(labelAfter).not.toBe(labelBefore);

    // The criterion. Not "the hardcoded string has no markers": byte for byte what it was,
    // beside three neighbours that all changed, which is what makes it visible on the page rather
    // than merely detectable in an assertion.
    expect(textOf(element, 'data-hardcoded')).toBe(hardcodedBefore);
    expect(textOf(element, 'data-hardcoded')).toBe(HARDCODED);
  });

  it('resolves right-to-left from the tag, with no pseudo-locale branch to read', async () => {
    const fixture = TestBed.createComponent(PseudoPage);
    await fixture.whenStable();

    const localization = TestBed.inject(Localization);
    expect(localization.snapshot()?.direction).toBe('ltr');

    await localization.changeLocale('en-Arab-XB');
    await fixture.whenStable();

    // Read from the resolved snapshot and the document rather than from configuration. The
    // failure mode is a check that asserts direction by reading what was declared, which passes
    // for a pseudo-locale that says RTL and mirrors nothing.
    expect(localization.snapshot()?.direction).toBe('rtl');
    expect(document.documentElement.dir).toBe('rtl');

    // And the language stays English, which is what makes the mirrored page readable to the
    // developer looking at it. A pseudo-locale in another language tests something else.
    expect(document.documentElement.lang).toBe('en-Arab-XB');
  });
});
