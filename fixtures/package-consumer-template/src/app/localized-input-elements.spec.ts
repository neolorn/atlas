import { describe, expect, it } from 'vitest';

import { Component } from '@angular/core';
import { By } from '@angular/platform-browser';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import {
  Localization,
  decimal,
  provideLocalizationSetup,
  type LocalizedInputProfile,
} from '@neolorn/atlas';
import { LocalizedInput } from '@neolorn/atlas/forms';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * What a localized field may be written with, and when a write to one may arrive.
 *
 * Section 8 of `specs/08-formatting-parsing-and-domain.spec.md` states both. What kind of value a
 * field holds is independent of the element it is written with, so the directive covers the text
 * elements the form system binds a value accessor to rather than one of them. And a write that
 * lands before the field has been given its profile is held rather than failed on, because an
 * application's own field component stands between the form and this one and the order of the two
 * bindings is the framework's.
 *
 * `localized-input-profiles.spec.ts` covers what each profile kind does with a value. This file is
 * about the two things that are true of every kind.
 */

const AMOUNT: LocalizedInputProfile = {
  kind: 'decimal',
  maximumFractionDigits: 2,
};

@Component({
  imports: [LocalizedInput, ReactiveFormsModule],
  template: `<textarea
    data-amount-area
    [formControl]="control"
    [localizedInput]="profile"
  ></textarea>`,
})
class AreaHost {
  protected readonly profile = AMOUNT;
  readonly control = new FormControl<unknown>(decimal('1234.5'), {
    nonNullable: true,
  });
}

@Component({
  imports: [LocalizedInput],
  template: `<input data-unbound [localizedInput]="profile" />`,
})
class UnboundHost {
  protected readonly profile = AMOUNT;
}

async function configure(): Promise<Localization> {
  TestBed.resetTestingModule();
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
  const localization = TestBed.inject(Localization);
  await localization.initialize();
  return localization;
}

describe('a localized field written as a textarea', () => {
  it('renders, re-parses and re-renders exactly as the one-line field does', async () => {
    const localization = await configure();
    const fixture = TestBed.createComponent(AreaHost);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const area = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-amount-area]',
    ) as HTMLTextAreaElement;
    const englishText = area.value;
    expect(englishText).not.toBe('');

    area.value = englishText;
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.control.errors).toBeNull();
    expect(fixture.componentInstance.control.value).toEqual(decimal('1234.5'));

    await localization.changeLocale('ar-EG');
    await fixture.whenStable();
    fixture.detectChanges();

    // The same fixed point the one-line field is held to: what Arabic renders parses back, and
    // rendering that parse in English returns the original text character for character.
    const arabicText = area.value;
    expect(arabicText).not.toBe(englishText);
    area.value = arabicText;
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.control.errors).toBeNull();

    await localization.changeLocale('en-US');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(area.value).toBe(englishText);
  });
});

describe('a write that arrives before the profile binding does', () => {
  it('is held, and rendered once the binding lands', async () => {
    await configure();
    // The creation pass runs the directive's constructor; the update pass sets its inputs. Between
    // the two the field exists and has no profile, which is the window an application's own field
    // component forwards the form's write in.
    const fixture = TestBed.createComponent(UnboundHost);
    const field = fixture.debugElement
      .query(By.directive(LocalizedInput))
      .injector.get(LocalizedInput);

    expect(() => {
      field.writeValue(decimal('1234.5') as never);
    }).not.toThrow();

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-unbound]',
    ) as HTMLInputElement;
    // Held rather than dropped. A write that is swallowed leaves a field a reader has to fill in
    // again, and nothing reports it. What the separators are is the locale's business and
    // `localized-input-profiles.spec.ts` covers it; what is asserted here is that the value the
    // form wrote is the value on screen.
    expect(input.value).not.toBe('');
    expect(input.value.replace(/[^0-9.]/gu, '')).toBe('1234.5');
  });
});
