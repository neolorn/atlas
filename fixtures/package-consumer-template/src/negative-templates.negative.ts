import { Component } from '@angular/core';
import { LocalizePipe, LocalizedMessage } from '@neolorn/atlas';
import { messages } from '#i18n/shell';

/**
 * Templates that must not compile.
 *
 * Nothing here is ever built into the application. `verify-package-consumer` type-checks this file
 * on its own and fails the gate unless every case below is reported, which is the only way to
 * prove a *negative*: a test that asserts an error cannot be written in the language the error is
 * written in.
 *
 * The whole fixture tree contained three `@ts-expect-error` lines, all on the direct API and
 * none in a template, so the contract that `LocalizePipe` and `LocalizedMessage` are supposed to
 * carry into templates was never checked anywhere. Why that matters: both erased their inputs
 * to `Readonly<Record<string, unknown>>` and `unknown`, so a
 * misspelled key, a missing required value, or a number where a string belongs all compiled and
 * failed in the browser instead.
 *
 * Each case carries the exact text the verifier looks for. Add a case here and add its expected
 * text there, or the case proves nothing.
 */

// EXPECT: '"nmae"' does not exist in type '{ readonly name: string; }'
@Component({
  selector: 'negative-pipe-unknown-input',
  imports: [LocalizePipe],
  template: `{{ messages.welcome | localize: { nmae: 'Atlas' } }}`,
})
export class NegativePipeUnknownInput {
  protected readonly messages = messages;
}

// EXPECT: Type 'number' is not assignable to type 'string'
@Component({
  selector: 'negative-pipe-wrong-input-type',
  imports: [LocalizePipe],
  template: `{{ messages.welcome | localize: { name: 42 } }}`,
})
export class NegativePipeWrongInputType {
  protected readonly messages = messages;
}

// EXPECT: Expected 2 arguments, but got 1
@Component({
  selector: 'negative-pipe-missing-inputs',
  imports: [LocalizePipe],
  template: `{{ messages.welcome | localize }}`,
})
export class NegativePipeMissingInputs {
  protected readonly messages = messages;
}

// EXPECT: '"refernce"' does not exist in type
@Component({
  selector: 'negative-component-unknown-input',
  imports: [LocalizedMessage],
  template: `
    <localized-message
      [handle]="messages.hostile.rich"
      [inputs]="{ refernce: 'ABC-12345' }"
    />
  `,
})
export class NegativeComponentUnknownInput {
  protected readonly messages = messages;
}

// EXPECT: Type '{ nested: true; }' is not assignable to type 'string'
@Component({
  selector: 'negative-component-wrong-input-type',
  imports: [LocalizedMessage],
  template: `
    <localized-message
      [handle]="messages.hostile.rich"
      [inputs]="{ reference: { nested: true } }"
    />
  `,
})
export class NegativeComponentWrongInputType {
  protected readonly messages = messages;
}

// EXPECT: Type '"structured"' is not assignable to type '"plain"'
@Component({
  selector: 'negative-pipe-structured-handle',
  imports: [LocalizePipe],
  template: `{{ messages.extension.badge | localize }}`,
})
export class NegativePipeStructuredHandle {
  protected readonly messages = messages;
}

// EXPECT: does not exist in type 'Readonly<Record<"badge", TrustedSlotBinding>>'
@Component({
  selector: 'negative-component-unknown-slot',
  imports: [LocalizedMessage],
  template: `
    <localized-message
      [handle]="messages.extension.badge"
      [slots]="{ nope: { kind: 'text', projection: 'x' } }"
    />
  `,
})
export class NegativeComponentUnknownSlot {
  protected readonly messages = messages;
}

// EXPECT: Type '"plain"' is not assignable to type '"structured"'
@Component({
  selector: 'negative-component-plain-handle',
  imports: [LocalizedMessage],
  template: `<localized-message [handle]="messages.welcome" />`,
})
export class NegativeComponentPlainHandle {
  protected readonly messages = messages;
}
