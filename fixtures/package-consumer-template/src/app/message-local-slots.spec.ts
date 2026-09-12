import { describe, expect, it, beforeEach } from 'vitest';

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  Localization,
  LocalizedMessage,
  provideLocalizationSetup,
  type LocalizedSlotPart,
  type TrustedSlotBinding,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { messages } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * The two bindings that render a slot which is neither a link nor an action.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 3 sends every other slot to a template or a text
 * binding, and section 4 says a message-local slot is implemented in trusted consumer code. Both
 * kinds were in the contract and neither was exercised anywhere: no test, no fixture, no page. A
 * kind nothing renders is a kind nothing notices the loss of.
 *
 * `extension.badge` is the message, because a registered rich slot kind is the shape a consumer
 * actually reaches for: a design-system badge, with the tone the catalog chose and the wording the
 * translator wrote inside it.
 *
 * The template binding renders the slot's own children, so the translator keeps what is inside the
 * badge. The text binding substitutes consumer text for them, which is the escape for a slot whose
 * content the application supplies.
 */

@Component({
  selector: 'badge-host',
  imports: [LocalizedMessage],
  template: `
    <ng-template #badge let-part>
      <span data-badge [attr.data-tone]="tone(part)">{{ inner(part) }}</span>
    </ng-template>

    <localized-message
      data-templated
      [handle]="messages.extension.badge"
      [slots]="{ badge: { kind: 'template', template: badge } }"
    />

    <localized-message
      data-projected
      [handle]="messages.extension.badge"
      [slots]="{ badge: { kind: 'text', projection: 'BADGE' } }"
    />
  `,
})
class BadgeHost {
  protected readonly messages = messages;

  /** `noPropertyAccessFromIndexSignature` is on here, so an option is read by key. */
  protected tone(part: LocalizedSlotPart): string {
    return part.options['tone'] ?? 'info';
  }

  protected inner(part: LocalizedSlotPart): string {
    return part.children
      .map((child) => (child.kind === 'slot' ? '' : child.value))
      .join('');
  }
}

/**
 * The same message with nothing bound.
 *
 * `[slots]="{}"` does not compile against `Readonly<Record<"badge", TrustedSlotBinding>>`, which is
 * the guard that matters and the one `negative-templates.negative.ts` proves. The cast is how a
 * JavaScript caller reaches the runtime branch, and the refusal behind it is what stands when the
 * type check is not there.
 */
@Component({
  selector: 'unbound-badge-host',
  imports: [LocalizedMessage],
  template: `
    <localized-message [handle]="messages.extension.badge" [slots]="none" />
  `,
})
class UnboundBadgeHost {
  protected readonly messages = messages;
  protected readonly none = {} as Readonly<Record<'badge', TrustedSlotBinding>>;
}

function setup(): Localization {
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

describe('a message-local slot rendered by a template binding', () => {
  let localization: Localization;

  beforeEach(async () => {
    localization = setup();
    await localization.initialize();
  });

  it('renders the consumer markup around the translator content', async () => {
    const fixture = TestBed.createComponent(BadgeHost);
    await fixture.whenStable();
    fixture.detectChanges();

    const badge = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('[data-templated] [data-badge]');
    expect(badge?.getAttribute('data-tone')).toBe('info');
    expect(badge?.textContent?.trim()).toBe('New');
  });

  it('moves with the locale', async () => {
    const fixture = TestBed.createComponent(BadgeHost);
    await fixture.whenStable();
    fixture.detectChanges();

    await localization.changeLocale('ar-EG');
    await fixture.whenStable();
    fixture.detectChanges();

    const badge = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('[data-templated] [data-badge]');
    expect(badge?.textContent?.trim()).toBe('جديد');
  });
});

describe('a message-local slot rendered by a text binding', () => {
  beforeEach(async () => {
    await setup().initialize();
  });

  it('substitutes the consumer text for the slot content', async () => {
    const fixture = TestBed.createComponent(BadgeHost);
    await fixture.whenStable();
    fixture.detectChanges();

    const projected = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('[data-projected]');
    expect(projected?.textContent?.trim()).toBe('BADGE');
    // The children the translator wrote are replaced rather than wrapped, which is the whole
    // difference between this binding and the template one.
    expect(projected?.textContent).not.toContain('New');
  });
});

describe('a message-local slot with no binding', () => {
  beforeEach(async () => {
    await setup().initialize();
  });

  it('refuses the message rather than rendering it without the slot', async () => {
    // The whole sequence, because the refusal is raised by the component's own host binding and
    // the first change detection that reaches it is Angular's rather than this test's.
    await expect(
      (async () => {
        const fixture = TestBed.createComponent(UnboundBadgeHost);
        await fixture.whenStable();
        fixture.detectChanges();
      })(),
    ).rejects.toThrowError(
      /Trusted binding for semantic slot badge is missing or incompatible/u,
    );
  });
});
