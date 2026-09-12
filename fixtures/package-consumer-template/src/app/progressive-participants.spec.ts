import { describe, expect, it, vi } from 'vitest';

import { inject, provideEnvironmentInitializer } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  Localization,
  languagePresentation,
  provideLocalizationSetup,
  type LocalizationParticipant,
  type LocalizationParticipantContext,
  type LocalizationParticipantRegistration,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * Progressive participants, which is Atlas's answer to the region that must not hold up the page.
 *
 * Nothing else guards this invariant: with `startIndependentParticipants` handed an empty list,
 * the rest of the consumer suite passes, because this application registers exactly one participant
 * and it is `required`. Progressive coordination otherwise has a public option, a runtime path, and
 * no consumer.
 *
 * The failure this prevents is not a crash. A region registered as progressive simply never
 * localizes: the page commits, everything else is in the new locale, and one panel silently keeps
 * the old one forever. Nothing throws, so nothing without a test notices.
 *
 * Both halves are needed and neither is sufficient. That the region *starts* would still hold if
 * Atlas awaited it like a required participant, which is the opposite bug and the one that makes
 * progressive coordination pointless. That it *finishes* would hold in that world too. What pins
 * the behaviour is the pair: the primary commit lands with the region still in flight, and the
 * region completes afterwards on its own.
 */

/**
 * A participant whose `prepare` can be held open, so "the primary UI did not wait" is asserted
 * against a region that provably had not finished rather than against a race that usually resolves
 * the convenient way.
 */
class IndependentRegion {
  private release: (() => void) | undefined;
  private gate: Promise<void> = Promise.resolve();

  /** `prepare:<locale>` and `commit:<locale>`, in the order they actually happened. */
  readonly events: string[] = [];

  close(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  open(): void {
    this.release?.();
    this.release = undefined;
    this.gate = Promise.resolve();
  }

  readonly participant: LocalizationParticipant = Object.freeze({
    id: 'independent-region',
    prepare: async (context: LocalizationParticipantContext) => {
      this.events.push(`prepare:${context.targetLocale}`);
      await this.gate;
      return Object.freeze({
        status: 'ready' as const,
        representation: Object.freeze({
          kind: 'locale-bound' as const,
          supplyingLocale: context.targetLocale,
          direction: languagePresentation(context.targetLocale).direction,
        }),
      });
    },
    commit: (context: LocalizationParticipantContext) => {
      this.events.push(`commit:${context.targetLocale}`);
    },
  });
}

function setup(region: IndependentRegion) {
  let registration: LocalizationParticipantRegistration | undefined;
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
      // From a provider, which is where an application registers a participant and is the reason
      // this reaches the path it does. Registering imperatively after `TestBed.inject` looks
      // equivalent and is not: by then Atlas's app initializer has already started, so the
      // registration arrives late and is picked up by the catch-up path instead of by the
      // dispatch that runs at the end of initialization. Both paths work; only one of them is
      // this invariant, and the other is the one a test reaches by accident.
      provideEnvironmentInitializer(() => {
        registration = inject(Localization).registerParticipant(
          region.participant,
          { coordination: 'progressive' },
        );
      }),
    ],
  });
  const localization = TestBed.inject(Localization);
  return {
    localization,
    registration: registration as LocalizationParticipantRegistration,
  };
}

describe('a progressive participant does not hold up the primary UI', () => {
  it('commits the page while the independent region is still preparing', async () => {
    const region = new IndependentRegion();
    region.close();
    const { localization } = setup(region);

    await localization.initialize();

    // The page is usable. The region is not done, and is provably not done, because its gate is
    // still shut.
    expect(localization.lifecycle()).toBe('ready');
    expect(region.events).not.toContain('commit:en-US');

    // It did start, though. A region that is never dispatched is the failure this whole file
    // exists for, and it looks identical to a region that is merely slow.
    await vi.waitFor(() => {
      expect(region.events).toContain('prepare:en-US');
    });
    expect(region.events).not.toContain('commit:en-US');

    region.open();
  });

  it('finishes the independent region after the page has already committed', async () => {
    const region = new IndependentRegion();
    region.close();
    const { localization, registration } = setup(region);

    await localization.initialize();
    expect(localization.lifecycle()).toBe('ready');

    region.open();

    await vi.waitFor(() => {
      expect(region.events).toEqual(['prepare:en-US', 'commit:en-US']);
    });
    expect(registration.state().current?.report.status).toBe('ready');
    expect(registration.state().current?.targetLocale).toBe('en-US');
    expect(registration.state().coordination).toBe('progressive');
  });

  it('runs the region independently on a locale change too, without holding the change', async () => {
    const region = new IndependentRegion();
    const { localization, registration } = setup(region);

    await localization.initialize();
    await vi.waitFor(() => {
      expect(region.events).toContain('commit:en-US');
    });

    // A locale change is where progressive coordination earns its keep: the visitor clicked, and
    // the page must turn over now rather than when the slowest panel is ready.
    region.close();
    const result = await localization.changeLocale('ar-EG');

    expect(result.status).toBe('committed');
    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
    expect(region.events).not.toContain('commit:ar-EG');

    region.open();
    await vi.waitFor(() => {
      expect(region.events).toContain('commit:ar-EG');
    });
    expect(registration.state().current?.targetLocale).toBe('ar-EG');
  });
});
