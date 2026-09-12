import { TestBed } from '@angular/core/testing';
import { Localization } from '@neolorn/atlas';
import { configuration } from '#i18n';
import { recoveryPayload } from '#i18n/recovery-payload';
import { messages } from '#i18n/shell';

import { App } from './app';
import { appConfig } from './app.config';

describe('Atlas minimal built-package consumer', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: appConfig.providers,
    }).compileComponents();
    await TestBed.inject(Localization).initialize();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders generated plain, inferred-input, pipe, rich, recovery, and locale-role contracts zonelessly', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    expect(messages.title.identity).toContain(':shell:title');
    expect(element.querySelector('[data-title]')?.textContent).toContain(
      'Atlas minimal consumer',
    );
    expect(element.querySelector('[data-welcome]')?.textContent).toContain(
      'Welcome, Atlas!',
    );
    expect(element.querySelector('[data-pipe]')?.textContent).toContain(
      'Atlas minimal consumer',
    );
    expect(element.querySelector('[data-rich]')?.textContent).toContain(
      'Read the guide.',
    );
    expect(element.querySelector('[data-rich] strong')?.textContent).toBe(
      'guide',
    );
    expect(element.querySelector('[data-inherited]')?.textContent).toContain(
      'This sentence is written in the source locale.',
    );
    expect(element.querySelector('[data-minimal-atlas]')).toMatchObject({
      lang: configuration.defaultLocale,
      dir: 'ltr',
    });
    // One per configured locale, and there are three of them now.
    expect(recoveryPayload).toHaveLength(3);

    // The switcher, and the whole of what this fixture had to write by hand to have one. There is
    // no locale in its template and no label for a locale in its catalogs: the endonyms below are
    // the runtime's, and the option's own language and direction come with them.
    const choices = [
      ...element.querySelectorAll('[data-switch-locale]'),
    ] as HTMLElement[];
    expect(choices.map((choice) => choice.dataset['switchLocale'])).toEqual([
      'en-US',
      'ar',
      'ar-EG',
    ]);
    expect(choices.map((choice) => choice.textContent?.trim())).toEqual([
      'American English',
      'العربية',
      'العربية (مصر)',
    ]);
    expect(
      choices.map((choice) => [
        choice.getAttribute('lang'),
        choice.getAttribute('dir'),
        choice.getAttribute('aria-current'),
      ]),
    ).toEqual([
      ['en', 'ltr', 'true'],
      ['ar', 'rtl', null],
      ['ar', 'rtl', null],
    ]);

    await fixture.componentInstance.selectLocale('ar-EG');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(element.querySelector('[data-title]')?.textContent).toContain(
      'مستهلك Atlas المصغر',
    );
    // The Latin name is wrapped in an isolate inside Arabic prose, so it cannot reorder the
    // sentence around it. A right-to-left isolate rather than a first-strong one: the value
    // carries no direction of its own, so it takes the message's, and the message is Arabic.
    //
    // Written as escapes. The characters are invisible on screen, so a literal one here is
    // invisible to a reader sweeping the file for this expectation.
    expect(element.querySelector('[data-welcome]')?.textContent).toContain(
      'مرحبًا، \u2067Atlas\u2069!',
    );
    expect(element.querySelector('[data-pipe]')?.textContent).toContain(
      'مستهلك Atlas المصغر',
    );
    expect(element.querySelector('[data-rich]')?.textContent).toContain(
      'اقرأ الدليل.',
    );
    expect(element.querySelector('[data-minimal-atlas]')).toMatchObject({
      lang: 'ar-EG',
      dir: 'rtl',
    });

    // The parent-locale chain, in a built application, through the runtime that a browser runs.
    //
    // `inherited` is in `en-US` and in `ar`, and not in `ar-EG`. `ar-EG` inherits from `ar`, so the
    // Arabic sentence is what renders here. Before the chain existed this read the English one, and
    // it is the only assertion in this fixture that can tell the difference: everything else above
    // is carried by `ar-EG` itself, which is what makes those four the control.
    expect(element.querySelector('[data-inherited]')?.textContent).toContain(
      'هذه الجملة مكتوبة بالعربية العامة.',
    );
    expect(
      element.querySelector('[data-inherited]')?.textContent,
    ).not.toContain('source locale');

    // And `ar` still renders its own, which is what says the child was preferred above rather than
    // the parent being read for everything.
    await fixture.componentInstance.selectLocale('ar');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(element.querySelector('[data-title]')?.textContent).toContain(
      'مستهلك Atlas المصغر بالعربية',
    );
    expect(element.querySelector('[data-inherited]')?.textContent).toContain(
      'هذه الجملة مكتوبة بالعربية العامة.',
    );
  });
});
