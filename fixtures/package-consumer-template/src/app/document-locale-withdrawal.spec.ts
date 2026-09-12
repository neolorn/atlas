/**
 * What the document effects do when nobody asks, and what stops them.
 *
 * `specs/06-runtime-and-angular.spec.md` section 1 puts the language, the direction and the
 * announcement on without a provider, so the case worth proving is the withdrawal: an
 * application rendering inside a host page that owns the document has to be able to leave the
 * document alone, and every other application has to get the effects without asking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestBed } from '@angular/core/testing';
import {
  Localization,
  provideLocalizationSetup,
  withoutDocumentLocale,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * `withoutDocumentLocale()`, which withdraws the one Atlas default that touches a document Atlas
 * may not own.
 *
 * This sat in progressive coordination's exact position: a public feature provider, a live
 * runtime branch, and no consumer anywhere. It was verified by hand and it worked; a hand
 * verification is a statement about one afternoon.
 *
 * `specs/12-verification.spec.md` section 7 is the rule it was missing: a promise nothing
 * exercises is a promise nobody has tested. A specification claiming Angular tests covered this
 * was the second false coverage claim of its kind.
 *
 * The failure this prevents has two opposite shapes and both need pinning, because a test for
 * either alone passes in the world where the other is broken:
 *
 * - Withdrawn but still applied. A widget mounted inside a host page rewrites that page's `lang`
 *   and `dir` and appends a live region to its body. Nothing throws. The host's own localization
 *   is silently overwritten by a component that was told not to.
 * - Applied but never applied by default. The far more common failure, and the reason the default
 *   is not a flag: a page whose text is Arabic and whose `dir` is `ltr`. Withdrawal that leaves the
 *   document untouched is indistinguishable from a feature that never worked at all, so the
 *   default half is asserted in the same file against the same setup.
 *
 * The announcer is asserted alongside `lang` and `dir` because it is the part most easily left
 * behind. It is a separate commit hook reached by a separate branch, and a withdrawal that
 * remembered the root attributes and forgot the appended region would still be writing into a
 * document it does not own: into the host's accessibility tree, which is worse than the
 * attributes, not better.
 */

const ANNOUNCER = '[data-atlas-announcer]';

/**
 * Sentinel values no locale produces, so "Atlas left it alone" is asserted against something Atlas
 * would have had to overwrite rather than against an empty attribute that was always empty.
 */
const HOST_LANGUAGE = 'fr-CA';
const HOST_DIRECTION = 'ltr';

function setup(withdrawn: boolean) {
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
        ...(withdrawn ? [withoutDocumentLocale()] : []),
      ),
    ],
  });
  return TestBed.inject(Localization);
}

describe('withoutDocumentLocale withdraws every document effect and nothing else', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('lang', HOST_LANGUAGE);
    document.documentElement.setAttribute('dir', HOST_DIRECTION);
    for (const region of document.querySelectorAll(ANNOUNCER)) region.remove();
  });

  afterEach(() => {
    for (const region of document.querySelectorAll(ANNOUNCER)) region.remove();
  });

  it('maintains lang, dir and the announcer by default, across a locale change', async () => {
    const localization = setup(false);
    await localization.initialize();

    expect(document.documentElement.lang).toBe('en-US');
    expect(document.documentElement.dir).toBe('ltr');
    // Present from construction rather than from the first announcement: assistive technology
    // reports changes to a region it is already observing.
    expect(document.querySelector(ANNOUNCER)).not.toBeNull();

    await localization.changeLocale('ar-EG');

    expect(document.documentElement.lang).toBe('ar-EG');
    expect(document.documentElement.dir).toBe('rtl');
    // Announced after the commit rather than with it, and on the following frame, so that a
    // screen reader is not told about a locale whose controls have not been redrawn yet.
    await vi.waitFor(() => {
      expect(document.querySelector(ANNOUNCER)?.textContent ?? '').not.toBe('');
    });
  });

  it('leaves the host document exactly as it found it when withdrawn', async () => {
    const localization = setup(true);
    await localization.initialize();

    expect(document.documentElement.getAttribute('lang')).toBe(HOST_LANGUAGE);
    expect(document.documentElement.getAttribute('dir')).toBe(HOST_DIRECTION);
    expect(document.querySelector(ANNOUNCER)).toBeNull();

    const result = await localization.changeLocale('ar-EG');

    // Withdrawal is about the document and only the document. A widget that stopped localizing
    // when told not to touch the page would be a different and larger bug, and it is the reading
    // of "without document locale" that a hurried implementation reaches for first.
    expect(result.status).toBe('committed');
    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
    expect(localization.snapshot()?.direction).toBe('rtl');

    expect(document.documentElement.getAttribute('lang')).toBe(HOST_LANGUAGE);
    expect(document.documentElement.getAttribute('dir')).toBe(HOST_DIRECTION);
    // Past the frame the announcement would have used, so this is "never appended" rather than
    // "not appended yet".
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(ANNOUNCER)).toBeNull();
  });
});
