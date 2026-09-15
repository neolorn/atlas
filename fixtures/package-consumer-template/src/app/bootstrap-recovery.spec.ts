import { describe, expect, it, afterEach } from 'vitest';

import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  Localization,
  LocalizationRecovery,
  provideLocalizationSetup,
  withLocaleSources,
  withPersistence,
  withRecoveryMessage,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { messages, providerId, scopeId } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * When a catalog failed to load at startup, the user saw nothing at all.
 *
 * `provideAppInitializer(() => localization.initialize())` rejected, Angular aborted bootstrap, and
 * the component tree was never created, including whatever hosts the recovery presentation. So
 * the recovery feature was unreachable on precisely the failure it exists for: a chunk that 404s,
 * a bad deploy, a catalog that will not load.
 *
 * An application that gates first paint on localization readiness, the ordinary way to avoid
 * showing untranslated text, has exactly this failure mode. It is the base case for that
 * design, not an edge case.
 *
 * These tests boot through the supported provider path with a real `bootstrapApplication`. The
 * existing runtime-failure spec builds a context with `createLocalizationContext` instead, which
 * proves recovery works on the object while saying nothing about whether it can ever be seen.
 */

const sourceIdentity = `${providerId}:${scopeId}:en-US` as const;

@Component({
  selector: 'recovery-host',
  imports: [LocalizationRecovery],
  template: `
    <main data-application-shell>
      <localization-recovery data-recovery retryLabel="String override" />
    </main>
  `,
})
class RecoveryHost {}

/** The same surface with nothing supplied, so only the payload can name the control. */
@Component({
  selector: 'payload-recovery-host',
  imports: [LocalizationRecovery],
  template: `
    <main data-application-shell>
      <localization-recovery data-recovery />
    </main>
  `,
})
class PayloadRecoveryHost {}

/** A store that remembers one locale, so the failure is resolved against `ar-EG`. */
const remembering = (locale: string) => () =>
  Object.freeze({
    id: 'remembered',
    read: () => locale,
    write: () => undefined,
  });

const hosts: HTMLElement[] = [];

function mountHost(tag = 'recovery-host'): HTMLElement {
  const host = document.createElement(tag);
  document.body.append(host);
  hosts.push(host);
  return host;
}

function failingLoaders() {
  return {
    ...catalogLoaders,
    [sourceIdentity]: () =>
      Promise.reject(
        new TypeError('Failed to fetch dynamically imported module'),
      ),
  };
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

describe('bootstrap when a catalog cannot load', () => {
  it('still renders, and shows recovery instead of an empty body', async () => {
    const host = mountHost();

    const application = await bootstrapApplication(RecoveryHost, {
      providers: [
        provideLocalizationSetup(
          {
            configuration,
            catalogSet,
            catalogLoaders: failingLoaders(),
            recoveryPayload,
            extensions: atlasRuntimeExtensions,
          },
          withRecoveryMessage({
            message: messages.recovery.unavailable,
            retryLabel: messages.control.retry,
          }),
        ),
      ],
    });

    // The application booted. Before this fix, bootstrapApplication rejected here and the host
    // element stayed empty.
    expect(host.querySelector('[data-application-shell]')).not.toBeNull();

    const recovery = host.querySelector('[data-recovery]');
    expect(recovery).not.toBeNull();
    expect(recovery?.textContent ?? '').toContain(
      'Localization is temporarily unavailable.',
    );

    // An accessible alert, not silent text.
    const alert = host.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('aria-live')).toBe('assertive');

    application.destroy();
  });

  it('publishes no partial runtime behind the recovery surface', async () => {
    mountHost();

    const application = await bootstrapApplication(RecoveryHost, {
      providers: [
        provideLocalizationSetup(
          {
            configuration,
            catalogSet,
            catalogLoaders: failingLoaders(),
            recoveryPayload,
            extensions: atlasRuntimeExtensions,
          },
          withRecoveryMessage({
            message: messages.recovery.unavailable,
            retryLabel: messages.control.retry,
          }),
        ),
      ],
    });

    const localization = application.injector.get(Localization);

    // Booting is not the same as working. The failure is still a failure, and nothing renders
    // half-localized: reading any message throws rather than returning a fallback.
    expect(localization.lifecycle()).toBe('failed');
    expect(localization.snapshot()).toBeUndefined();
    expect(() => localization.text(messages.appTitle)).toThrow();

    application.destroy();
  });

  it('prefers the selected retry label over a string on the element', async () => {
    const host = mountHost();

    const application = await bootstrapApplication(RecoveryHost, {
      providers: [
        provideLocalizationSetup(
          {
            configuration,
            catalogSet,
            catalogLoaders: failingLoaders(),
            recoveryPayload,
            extensions: atlasRuntimeExtensions,
          },
          withRecoveryMessage({
            message: messages.recovery.unavailable,
            retryLabel: messages.control.retry,
          }),
        ),
      ],
    });

    const button = host.querySelector('[data-recovery] button');
    expect(button?.textContent?.trim()).toBe('Retry');
    // The string input is an override for an application with no handle, and a handle outranks it.
    expect(button?.textContent ?? '').not.toContain('String override');

    application.destroy();
  });

  it('renders the retry label in the locale the reader asked for', async () => {
    const host = mountHost('payload-recovery-host');

    const application = await bootstrapApplication(PayloadRecoveryHost, {
      providers: [
        provideLocalizationSetup(
          {
            configuration,
            catalogSet,
            catalogLoaders: failingLoaders(),
            recoveryPayload,
            extensions: atlasRuntimeExtensions,
          },
          withPersistence(remembering('ar-EG')),
          withLocaleSources('stored', 'default'),
          withRecoveryMessage({
            message: messages.recovery.unavailable,
            retryLabel: messages.control.retry,
          }),
        ),
      ],
    });

    // No catalog loaded, so both of these came from the recovery payload rather than from one.
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.getAttribute('lang')).toBe('ar');
    expect(alert?.getAttribute('dir')).toBe('rtl');
    expect(alert?.textContent ?? '').toContain('الترجمة غير متاحة مؤقتًا.');

    const button = host.querySelector('[data-recovery] button');
    expect(button?.textContent?.trim()).toBe('إعادة المحاولة');
    // The control carries its own claim rather than inheriting one, which is what stops an English
    // button inside an Arabic region being read under Arabic pronunciation rules.
    expect(button?.getAttribute('lang')).toBe('ar');
    expect(button?.getAttribute('dir')).toBe('rtl');

    application.destroy();
  });

  it('rejects bootstrap when no recovery presentation is configured', async () => {
    const host = mountHost();

    // Without a recovery message there is nothing to show, and an application whose every message
    // throws is worse than a hard failure. That case keeps failing loudly.
    await expect(
      bootstrapApplication(RecoveryHost, {
        providers: [
          provideLocalizationSetup({
            configuration,
            catalogSet,
            catalogLoaders: failingLoaders(),
            extensions: atlasRuntimeExtensions,
          }),
        ],
      }),
    ).rejects.toBeDefined();

    expect(host.querySelector('[data-application-shell]')).toBeNull();
  });
});
