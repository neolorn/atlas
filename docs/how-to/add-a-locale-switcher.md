# How to add a locale switcher

Render one option per configured locale, with the attributes a correct option carries, and change
the application's locale when a visitor picks one.

## Before you begin

You need at least two locales in `atlas.config.json`, which is
[How to add a locale](add-a-locale.md).

## Render the options

`localeChoices()` returns one choice per configured locale. `localeChoice` wires one:

```ts excerpt src/app/app.ts
    <nav>
      @for (choice of localization.localeChoices(); track choice.locale) {
        <a [localeChoice]="choice">{{ choice.selfName }}</a>
      }
    </nav>
```

You write the loop and the markup. The directive writes what a template would otherwise repeat once
per locale: `lang` and `dir`, so the option is pronounced and laid out in its own language rather
than the page's; `aria-current` for the one you are in; `aria-busy` for the one arriving; and, on an
`<a>`, an `href` holding this page's address in that locale.

`choice.selfName` is the language's name in its own language, so the option is readable to a visitor
who cannot read the current page.

A `<button>` works the same way and gets no `href`. Prefer the anchor: it can be opened in a new tab,
copied, and seen in the status bar.

## Announce the change

A screen reader is told the page changed language whether or not you ask. Atlas announces the
arriving locale's own name, in that locale, into a live region it owns.

`withLocaleAnnouncement` replaces that wording and nothing else. Take it when the language's name is
not what you want said. It takes a function from the snapshot that has just committed to the
sentence to announce, so the wording is yours and can be in the language just arrived at.

If your application already announces the change through a live region of its own, return nothing.
The change is then announced once, by you, and Atlas's region stays in the document saying nothing.

Nothing removes the region. `withoutDocumentLocale()` removes it, along with everything else Atlas
writes to the document, and is the statement that the document is not Atlas's to touch.

## Remember the choice

`withPersistence(cookieStore())` stores what a visitor picked, so the next visit opens in the
language the last one ended in. `localStorageStore` is browser-only. `profileStore` is an interface
for the case where the choice belongs in your own account record. Which store to use under server
rendering is [About how a locale is resolved](../explanation/about-locale-resolution.md).

## Let a reader clear it

`forgetRememberedLocale()` drops the choice from every store you configured and leaves the page in
the language it is already in. It resolves with a report naming every store the removal did not
reach: one that implements no removal, and one whose removal failed. Check it, because the next
visit reads from whichever store still holds a value.

Forgetting does not move the reader, and `changeLocale` records a choice, so a control that offers
to stop remembering the language is the two together:

```text
await localization.forgetRememberedLocale();
await localization.changeLocale(configuration.defaultLocale, { remember: false });
```

Move to the default, or to whatever the visitor's client asks for. `remember: false` is what keeps
that move from storing a fresh choice in place of the one just dropped.

## Assert that the switch is atomic

`changeLocale(locale)` prepares everything the arriving locale needs and commits only when all of it
is ready. Hold the arriving catalog open to assert the state a switch passes through:

```ts src/app/switching.spec.ts
import { afterEach, describe, expect, it } from 'vitest';

import { MOCK_PLATFORM_LOCATION_CONFIG } from '@angular/common/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Localization, withRecoveryMessage, withRouting } from '@neolorn/atlas';
import { provideLocalizedRouter } from '@neolorn/atlas/router';
import {
  LocalizationTestingController,
  provideLocalizationTesting,
  resetLocalizationTestEnvironment,
} from '@neolorn/atlas/testing';
import { localizationSetup } from '#i18n';
import { messages, providerId, scopeId } from '#i18n/shell';

import { routes } from './app.routes';
import { appRouteProjection, routePolicy } from './localization.routes';

const shell = { providerId, scopeId } as const;

// Atlas reads the address bar for the locale, so a test that navigates and does not put it back
// decides what the next test is looking at.
afterEach(resetLocalizationTestEnvironment);

async function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: MOCK_PLATFORM_LOCATION_CONFIG,
        useValue: { startUrl: 'http://localhost:4200/' },
      },
      provideZonelessChangeDetection(),
      provideLocalizedRouter(routes),
      provideLocalizationTesting(
        localizationSetup,
        withRouting({ policy: routePolicy, projection: appRouteProjection }),
        withRecoveryMessage({ message: messages.recoveryMessage }),
      ),
    ],
  });

  const localization = TestBed.inject(Localization);
  await localization.initialize();

  return {
    localization,
    catalogs: TestBed.inject(LocalizationTestingController),
  };
}

describe('a locale change', () => {
  it('commits nothing until the arriving locale is ready', async () => {
    const { localization, catalogs } = await setup();

    const arriving = catalogs.deferNext(shell, 'ar-EG');
    const switching = localization.changeLocale('ar-EG');
    await arriving.started;

    // The catalog is on its way and nothing has moved.
    expect(localization.snapshot()?.primaryLocale).toBe('en-US');

    arriving.release();
    await switching;

    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
  });
});
```

When the switch commits, everything moves together: the messages, the document's `lang` and `dir`,
the address if your URLs carry the locale, and anything registered as a participant.

## Related

- [About how a locale switch is a transaction](../explanation/about-locale-switching.md)
- [How to extend Atlas](extend-atlas.md), for bringing your own work into the switch
- [How to test localized output](test-localized-output.md)
