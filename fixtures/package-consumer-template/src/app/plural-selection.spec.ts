import { describe, expect, it, beforeEach } from 'vitest';

import { TestBed } from '@angular/core/testing';
import { Localization, provideLocalizationSetup } from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { messages, providerId, scopeId } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * Arabic plural selection, executed rather than assumed.
 *
 * No fixture catalog contained a plural, so `selectPattern` and the `Intl.PluralRules` dispatch
 * behind it had never run in any Atlas test. Arabic has six CLDR cardinal categories against
 * English's two, so a source-locale corpus proves nothing here: the target locale is the whole
 * point.
 *
 * CLDR `ar` cardinal rules, and the smallest value that selects each category:
 *   zero  0
 *   one   1
 *   two   2
 *   few   3    (n % 100 in 3..10)
 *   many  11   (n % 100 in 11..99)
 *   other 100
 */

const shellScope = { providerId, scopeId } as const;

function context(): Localization {
  TestBed.configureTestingModule({
    providers: [
      provideLocalizationSetup({
        configuration,
        catalogSet,
        catalogLoaders,
        recoveryPayload,
        extensions: atlasRuntimeExtensions,
      }),
    ],
  });
  return TestBed.inject(Localization);
}

describe('Arabic plural selection', () => {
  let localization: Localization;

  beforeEach(async () => {
    localization = context();
    await localization.initialize();
    await localization.changeLocale('ar-EG');
  });

  it('agrees with Intl.PluralRules on every ar-EG category', () => {
    const rules = new Intl.PluralRules('ar-EG');
    expect(rules.select(0)).toBe('zero');
    expect(rules.select(1)).toBe('one');
    expect(rules.select(2)).toBe('two');
    expect(rules.select(3)).toBe('few');
    expect(rules.select(11)).toBe('many');
    expect(rules.select(100)).toBe('other');
  });

  it('selects a distinct pattern for each of the six categories', () => {
    const rendered = [0, 1, 2, 3, 11, 100].map((count) =>
      localization.text(messages.plural.items, { count }),
    );

    expect(rendered[0]).toBe('لا عناصر');
    expect(rendered[1]).toBe('عنصر واحد');
    expect(rendered[2]).toBe('عنصران');
    expect(rendered[3]).toContain('عناصر');
    expect(rendered[4]).toContain('عنصرًا');
    expect(rendered[5]).toContain('عنصر');

    // Six categories must produce six distinct strings. A catch-all fallthrough would collapse
    // several of these together and still look plausible, which is the failure this guards.
    expect(new Set(rendered).size).toBe(6);
  });

  it('keeps selecting on the boundaries of the few and many rules', () => {
    for (const count of [3, 4, 9, 10]) {
      expect(localization.text(messages.plural.items, { count })).toContain(
        'عناصر',
      );
    }
    for (const count of [11, 12, 98, 99]) {
      expect(localization.text(messages.plural.items, { count })).toContain(
        'عنصرًا',
      );
    }
  });

  it('selects a nested plural inside a select', () => {
    const box = (count: number) =>
      localization.text(messages.plural.nested, { count, kind: 'box' });
    const unit = (count: number) =>
      localization.text(messages.plural.nested, { count, kind: 'other' });

    expect(box(0)).toBe('لا صناديق');
    expect(box(1)).toBe('صندوق واحد');
    expect(box(2)).toBe('صندوقان');
    expect(unit(0)).toBe('لا وحدات');
    expect(unit(1)).toBe('وحدة واحدة');
    expect(unit(2)).toBe('وحدتان');

    // The two arms must not collapse into one another.
    expect(box(3)).not.toBe(unit(3));
  });

  it('falls back to English two-category selection without inventing Arabic categories', async () => {
    await localization.changeLocale('en-US');
    expect(localization.text(messages.plural.items, { count: 1 })).toBe(
      '1 item',
    );
    expect(localization.text(messages.plural.items, { count: 0 })).toBe(
      '0 items',
    );
    expect(localization.text(messages.plural.items, { count: 2 })).toBe(
      '2 items',
    );
  });
});
