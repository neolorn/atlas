import { describe, expect, it, beforeEach } from 'vitest';

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import {
  Localization,
  LocalizePipe,
  LocalizedMessage,
  provideLocalizationSetup,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { messages, providerId, scopeId } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * Translator-supplied bidi controls, after the policy in
 * `specs/09-safe-content-and-ux.spec.md` section 7.1.
 *
 * Measured without one: every control reached rendered output through both
 * paths, with no diagnostic at any stage.
 *
 * Two halves, and this file covers the runtime half.
 *
 * Characters that can reorder surrounding text (overrides, embeddings, unbalanced isolates) are
 * refused when the catalog is parsed, so no authored message can carry one and there is nothing to
 * assert here. That refusal is proved in the toolkit, where refusal happens.
 *
 * What survives is what the policy permits, and it must still render: balanced isolates, which are
 * the safe way to wrap a Latin name inside Arabic prose, and directional marks and zero-width
 * characters, which nudge one neighbour and cannot reorder a run.
 *
 * The second half is isolation of *interpolated* values, where the two render paths can disagree.
 * The structured component wraps them in `<bdi>`; the pipe returns a string and cannot, which
 * leaves the same value protected in one place and bare in the other. The formatter isolates the
 * value itself, so both paths carry it.
 */

const RLO = '\u202e';
const LRI = '\u2066';
const RLI = '\u2067';
const PDI = '\u2069';
const FSI = '\u2068';
const RLM = '\u200f';
const ZWSP = '\u200b';
const WJ = '\u2060';

const shellScope = { providerId, scopeId } as const;

@Component({
  selector: 'hostile-host',
  imports: [LocalizePipe, LocalizedMessage],
  template: `
    <p data-pipe-interpolated>
      {{ messages.hostile.interpolated | localize: { reference: reference() } }}
    </p>
    <localized-message
      data-component-interpolated
      [handle]="messages.hostile.rich"
      [inputs]="{ reference: reference() }"
    />
  `,
})
class HostileHost {
  protected readonly messages = messages;
  protected readonly reference = signal('ABC-12345');
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

describe('permitted bidi controls', () => {
  let localization: Localization;

  beforeEach(async () => {
    localization = setup();
    await localization.initialize();
  });

  it('renders a balanced isolate the translator authored', () => {
    // The capability the policy deliberately keeps: without it a translator has no way to wrap a
    // Latin run inside Arabic prose, and refusing every isolate would remove that with nothing in
    // its place.
    const text = localization.text(messages.hostile.authoredIsolate);
    expect(text).toContain(LRI);
    expect(text).toContain(PDI);
  });

  it('renders directional marks and zero-width characters', () => {
    expect(localization.text(messages.hostile.authoredMark)).toContain(RLM);

    const invisible = localization.text(messages.hostile.authoredInvisible);
    expect(invisible).toContain(ZWSP);
    expect(invisible).toContain(WJ);
  });

  it('carries the same permitted characters in ar-EG', async () => {
    await localization.changeLocale('ar-EG');
    expect(localization.text(messages.hostile.authoredMark)).toContain(RLM);
    expect(localization.text(messages.hostile.authoredIsolate)).toContain(LRI);
  });
});

describe('isolation of interpolated values', () => {
  let localization: Localization;

  beforeEach(async () => {
    localization = setup();
    await localization.initialize();
  });

  it('leaves a value alone when no direction conflict is possible', () => {
    // An English reference in an English message cannot reorder anything. Isolating it anyway
    // would put two invisible characters into every interpolation and into every assertion a
    // consumer writes, buying nothing.
    const text = localization.text(messages.hostile.interpolated, {
      reference: 'ABC-12345',
    });
    expect(text).toBe('Order ABC-12345 shipped');
  });

  it('isolates the value in an Arabic message too', async () => {
    await localization.changeLocale('ar-EG');

    const text = localization.text(messages.hostile.interpolated, {
      reference: 'ABC-12345',
    });

    // The reference is still present and readable; what changed is that it can no longer reorder
    // the Arabic around it.
    //
    // RLI, not FSI. The value carries no direction of its own, so it takes the direction of the
    // message it is going into, and that message is Arabic. FSI is reserved for a value that could
    // reorder on its own, one carrying strong right-to-left characters or a bidi control, where
    // there is a real question about which direction it is.
    expect(text).toContain('ABC-12345');
    expect(text).toContain(RLI);
    expect(text).not.toContain(FSI);
    expect(text).toContain(PDI);
  });

  it('protects an interpolated value on both render paths', () => {
    const fixture = TestBed.createComponent(HostileHost);
    fixture.detectChanges();

    // The component path carries isolation as an element, as it always did.
    const bdi = fixture.debugElement.query(
      By.css('[data-component-interpolated] bdi'),
    );
    expect(bdi).not.toBeNull();
    expect(bdi.nativeElement.textContent).toContain('ABC-12345');

    // The pipe path has no element, and now carries it in the string instead. Same guarantee,
    // reached two ways, with nothing asked of the call site.
    const pipe = fixture.debugElement.query(By.css('[data-pipe-interpolated]'));
    expect(pipe.nativeElement.textContent).toContain('ABC-12345');
  });

  it('never leaves an override in rendered output, whatever the value contains', () => {
    // A value arriving from user input or a backend is not covered by the parse-time policy, which
    // governs authored catalogs. Isolation is what contains it at render time.
    const text = localization.text(messages.hostile.interpolated, {
      reference: `ABC${RLO}12345`,
    });

    expect(text).toContain('ABC');
    // The override is still in the value, because Atlas does not silently rewrite consumer data,
    // but it is wrapped, so its effect cannot escape the placeholder.
    const start = text.indexOf(FSI);
    const end = text.indexOf(PDI);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(text.indexOf(RLO));
    expect(start).toBeLessThan(text.indexOf(RLO));
  });
});
