import { TestBed } from '@angular/core/testing';
import {
  Localization,
  LocalizationRecovery,
  createLocalizationContext,
} from '@neolorn/atlas';
import { LocalizationTestingController } from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { messages, providerId, scopeId } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';

const scope = { providerId, scopeId } as const;

describe('Atlas runtime failure and recovery contracts', () => {
  it('publishes independent recovery text and retries initialization explicitly', async () => {
    const sourceIdentity = `${providerId}:${scopeId}:en-US` as const;
    const sourceLoader = catalogLoaders[sourceIdentity];
    if (sourceLoader === undefined)
      throw new Error('Source test loader is absent.');
    let fail = true;

    const localization = createLocalizationContext({
      setup: {
        configuration,
        catalogSet,
        catalogLoaders: {
          ...catalogLoaders,
          [sourceIdentity]: () => {
            if (fail) return Promise.reject(new Error('intentional'));
            return sourceLoader();
          },
        },
        recoveryPayload,
        extensions: atlasRuntimeExtensions,
      },
      bootstrapScopes: [scope],
      recoveryMessage: messages.recovery.unavailable,
    });
    await expect(localization.initialize()).rejects.toBeDefined();
    expect(localization.lifecycle()).toBe('failed');
    expect(localization.snapshot()).toBeUndefined();
    expect(localization.recovery()?.value).toBe(
      'Localization is temporarily unavailable.',
    );

    await TestBed.configureTestingModule({
      imports: [LocalizationRecovery],
      providers: [{ provide: Localization, useValue: localization }],
    }).compileComponents();
    const fixture = TestBed.createComponent(LocalizationRecovery);
    fixture.componentRef.setInput('retryLabel', 'Retry');
    fixture.detectChanges();
    const recoveryRegion = fixture.nativeElement.querySelector(
      '[role="alert"]',
    ) as HTMLElement | null;
    const retryButton = fixture.nativeElement.querySelector(
      'button',
    ) as HTMLButtonElement | null;
    expect(recoveryRegion).not.toBeNull();
    expect(recoveryRegion?.getAttribute('aria-live')).toBe('assertive');
    expect(recoveryRegion?.getAttribute('lang')).toBe('en');
    expect(recoveryRegion?.getAttribute('dir')).toBe('ltr');
    expect(recoveryRegion?.textContent).toContain(
      'Localization is temporarily unavailable.',
    );
    expect(retryButton?.type).toBe('button');
    expect(retryButton?.textContent?.trim()).toBe('Retry');

    fail = false;
    await expect(localization.retry()).resolves.toMatchObject({
      primaryLocale: 'en-US',
    });
    expect(localization.lifecycle()).toBe('ready');
    expect(localization.recovery()).toBeUndefined();
    fixture.destroy();
    TestBed.resetTestingModule();
    localization.dispose();
  });

  it('keeps strict fallback failure distinct from a valid committed locale', async () => {
    const localization = createLocalizationContext({
      setup: {
        configuration,
        catalogSet,
        catalogLoaders,
        recoveryPayload,
        extensions: atlasRuntimeExtensions,
        fallbackPolicy: 'strict',
      },
      bootstrapScopes: [scope],
      recoveryMessage: messages.recovery.unavailable,
    });
    await localization.initialize();
    await expect(localization.changeLocale('ar-EG')).resolves.toMatchObject({
      status: 'committed',
    });
    expect(() => localization.text(messages.sourceOnly)).toThrow(
      /Strict localization rejects/u,
    );
    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
    localization.dispose();
  });

  it('cancels a pending transition without changing the committed snapshot', async () => {
    const controller = new LocalizationTestingController(catalogLoaders);
    const localization = createLocalizationContext({
      setup: {
        configuration,
        catalogSet,
        catalogLoaders: controller.catalogLoaders,
        extensions: atlasRuntimeExtensions,
      },
      bootstrapScopes: [scope],
    });
    await localization.initialize();
    const delayed = controller.deferNext(scope, 'ar-EG');
    const transition = localization.changeLocale('ar-EG');
    await delayed.started;

    localization.cancelTransition();
    await expect(transition).resolves.toMatchObject({ status: 'cancelled' });
    delayed.release();

    expect(localization.snapshot()?.primaryLocale).toBe('en-US');
    expect(localization.lifecycle()).toBe('ready');
    localization.dispose();
  });
});
