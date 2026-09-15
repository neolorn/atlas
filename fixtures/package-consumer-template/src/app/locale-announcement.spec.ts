/**
 * What the live region says, and what it says when the application says it instead.
 *
 * Section 11 of `specs/09-safe-content-and-ux.spec.md` makes the announcement unconditional and
 * makes `withLocaleAnnouncement` a replacement of the wording alone. A replacement that supplies no
 * wording is still a replacement, and is how an application that announces the change through a
 * region of its own keeps the change from being announced twice.
 *
 * `document-locale-withdrawal.spec.ts` covers the region's existence and its withdrawal. This file
 * is about what goes into it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestBed } from '@angular/core/testing';
import {
  Localization,
  provideLocalizationSetup,
  withLocaleAnnouncement,
  type LocalizationSnapshot,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';

import { atlasRuntimeExtensions } from './runtime-extensions';

const ANNOUNCER = '[data-atlas-announcer]';

const announced = () =>
  document.querySelector(ANNOUNCER)?.textContent ?? undefined;

/**
 * Past the frame the announcement waits for, so an empty region is one nothing was written to
 * rather than one nothing has been written to yet.
 */
const pastTheFrame = () => new Promise((resolve) => setTimeout(resolve, 32));

function setup(
  format?: (snapshot: LocalizationSnapshot) => string | undefined,
): Localization {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideLocalizationSetup(
        {
          configuration,
          catalogSet,
          catalogLoaders,
          recoveryPayload,
          extensions: atlasRuntimeExtensions,
        },
        ...(format === undefined ? [] : [withLocaleAnnouncement(format)]),
      ),
    ],
  });
  return TestBed.inject(Localization);
}

describe('what a locale change is announced as', () => {
  beforeEach(() => {
    for (const region of document.querySelectorAll(ANNOUNCER)) region.remove();
  });

  afterEach(() => {
    for (const region of document.querySelectorAll(ANNOUNCER)) region.remove();
  });

  it('is the arriving language’s own name, written in that language', async () => {
    const localization = setup();
    await localization.initialize();

    await localization.changeLocale('ar-EG');

    await vi.waitFor(() => {
      expect(announced() ?? '').not.toBe('');
    });
    // The name rather than the tag, and in Arabic letters rather than in the language being left.
    // Announcing "ar-EG", or announcing "Arabic" in English, is what this rules out.
    expect(announced()).not.toBe('ar-EG');
    expect(announced()).toMatch(/\p{Script=Arabic}/u);
  });

  it('is the application’s sentence where it supplies one', async () => {
    const localization = setup((snapshot) => `now ${snapshot.primaryLocale}`);
    await localization.initialize();

    await localization.changeLocale('ar-EG');

    await vi.waitFor(() => {
      expect(announced()).toBe('now ar-EG');
    });
  });
});

describe('an application that announces the change itself', () => {
  beforeEach(() => {
    for (const region of document.querySelectorAll(ANNOUNCER)) region.remove();
  });

  afterEach(() => {
    for (const region of document.querySelectorAll(ANNOUNCER)) region.remove();
  });

  it('supplies no wording, and the change is not announced twice', async () => {
    const localization = setup(() => undefined);
    await localization.initialize();

    const result = await localization.changeLocale('ar-EG');
    await pastTheFrame();

    // The change still happened, and the region is still there. Supplying no wording is not a
    // refusal of the change and not a withdrawal of the document effects.
    expect(result.status).toBe('committed');
    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
    expect(document.querySelector(ANNOUNCER)).not.toBeNull();
    expect(announced()).toBe('');
  });

  it('is announced again as soon as it supplies wording', async () => {
    // A change that says nothing must not leave the hook believing the page is still in the locale
    // it was in, or the next change compares against the wrong one and says nothing either.
    const localization = setup((snapshot) =>
      snapshot.primaryLocale === 'ar-EG' ? undefined : 'back in English',
    );
    await localization.initialize();

    await localization.changeLocale('ar-EG');
    await pastTheFrame();
    expect(announced()).toBe('');

    await localization.changeLocale('en-US');

    await vi.waitFor(() => {
      expect(announced()).toBe('back in English');
    });
  });
});
