# How to read typed input

`@neolorn/atlas/forms` exports `LocalizedInput`, a directive that parses what a visitor typed in the
committed locale and gives the form the value rather than the text. `١٢٣٫٥`, `123.5` and `123,5` are
one amount, and the control returns that amount.

## Before you begin

Install `@angular/forms`, which is an optional peer of the runtime, and compose a localization
runtime.

## Bind the directive

```text
<input [localizedInput]="profile" [(ngModel)]="amount" />
```

`LocalizedInput` is a `ControlValueAccessor` and a `Validator`, so it works with template-driven and
reactive forms the way any other control does. The profile states what kind of value the input
holds: a decimal, a money amount in a currency, a percentage, a measurement, a date.

The control's value is the parsed value. What you read is `money(decimal('19.99'), 'USD')`, not
`"١٩٫٩٩"`, and what your API receives is that value whichever script the visitor typed it in. Nothing
is rounded on the way through.

## Read the outcome

`result()` carries the outcome rather than throwing. A result that did not parse states a code, and
the code is stable, so a validation message can be a message in your catalog keyed on it. What a
visitor reads when they mistype a number is content, and it belongs in the catalog with everything
else they read.

`LocalizedInput` does not validate business rules. Whether an amount is within a limit, whether a
date is in the future, whether a quantity is in stock: those are yours, and they run on the parsed
value.

## Assert what it parses

The money profile requires the currency marker, which is why the visitor types `$19.99` rather than
`19.99`. Parsing happens in the committed locale, so after a switch the field reads Arabic-Indic
digits and refuses the Latin ones.

```ts src/app/forms.spec.ts
import { afterEach, describe, expect, it } from 'vitest';

import {
  Component,
  provideZonelessChangeDetection,
  viewChild,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule, NgModel } from '@angular/forms';
import {
  decimal,
  Localization,
  money,
  withRecoveryMessage,
  type LocalizedMoneyInputProfile,
  type MoneyValue,
} from '@neolorn/atlas';
import { LocalizedInput } from '@neolorn/atlas/forms';
import {
  provideLocalizationTesting,
  resetLocalizationTestEnvironment,
} from '@neolorn/atlas/testing';
import { localizationSetup } from '#i18n';
import { messages } from '#i18n/shell';

afterEach(resetLocalizationTestEnvironment);

@Component({
  selector: 'app-price-field',
  imports: [FormsModule, LocalizedInput],
  template: `
    <input
      [localizedInput]="profile"
      [(ngModel)]="amount"
      [ngModelOptions]="{ standalone: true }"
    />
  `,
})
class PriceField {
  readonly profile: LocalizedMoneyInputProfile = {
    kind: 'money',
    currency: 'USD',
  };
  amount: MoneyValue | null = null;
  readonly control = viewChild.required(NgModel);
  readonly localized = viewChild.required(LocalizedInput);
}

async function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideLocalizationTesting(
        localizationSetup,
        withRecoveryMessage({ message: messages.recoveryMessage }),
      ),
    ],
  });

  const localization = TestBed.inject(Localization);
  await localization.initialize();

  const fixture = TestBed.createComponent(PriceField);
  await fixture.whenStable();
  fixture.detectChanges();

  const field: HTMLInputElement = fixture.nativeElement.querySelector('input');

  // What a visitor does. Assigning `value` on its own changes nothing, because nothing is
  // listening to an assignment.
  async function type(text: string) {
    field.value = text;
    field.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  return {
    fixture,
    localization,
    field,
    type,
    host: fixture.componentInstance,
  };
}

describe('a localized input', () => {
  it('gives the form a value rather than the text that was typed', async () => {
    const { host, type } = await setup();

    await type('$19.99');

    expect(host.amount).toEqual(money(decimal('19.99'), 'USD'));
  });

  it('respells the field when the locale changes, and keeps the amount', async () => {
    const { fixture, localization, field, type, host } = await setup();
    await type('$19.99');

    await localization.changeLocale('ar-EG');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(host.amount).toEqual(money(decimal('19.99'), 'USD'));
    expect(field.value).toContain('١٩');
  });

  it('reads back what it wrote, in the other script', async () => {
    const { fixture, localization, field, type, host } = await setup();
    await type('$19.99');
    await localization.changeLocale('ar-EG');
    await fixture.whenStable();
    fixture.detectChanges();

    // The visitor edits the field they were given, so what is parsed is Arabic-Indic digits and
    // an Arabic decimal separator. The amount that comes back is the one that went in.
    await type(field.value);

    expect(host.amount).toEqual(money(decimal('19.99'), 'USD'));
  });

  it('reports what it could not read, with a code a message can key on', async () => {
    const { field, host, type } = await setup();

    await type('$nineteen');

    expect(host.localized().result()?.status).toBe('invalid');
    expect(host.control().errors?.['localizedInput']).toEqual({
      code: 'atlas.input.invalid',
      status: 'invalid',
    });
    // The form keeps the value it had. A field nobody can read does not empty what was already
    // there, and there is nothing here yet to keep.
    expect(host.amount).toBe(null);
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });
});
```

## Present an issue of your own

`issueMessage` and `presentIssue` turn a code and its data into the sentence a visitor reads, in the
committed locale. Use them for the issues your own code raises, so a form's errors read the way the
rest of the page does.

## Format the same values back

An input that shows a value the visitor is editing formats it with the conventions it will parse.
That is [How to format a value](format-values.md), and the two share one formatting context, so a
value that round-trips through the form comes back spelled the way it went in.

## Related

- [How to format a value](format-values.md)
- [About canonical values](../explanation/about-values.md)
