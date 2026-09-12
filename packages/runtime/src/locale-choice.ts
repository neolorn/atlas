/**
 * The one surface a locale switch has, and the markup Atlas does not write.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 7 puts the loop and the markup in the
 * application and the option's language, direction, current state and address on the control it
 * binds. The address goes on a link and nowhere else, because a link is what an address is for
 * and putting one on a button would be markup Atlas invented.
 *
 * A switch is a transaction rather than a navigation, so the link is what a visitor sees before
 * clicking and what a middle-click opens, and under a locale-specific origin policy it is the
 * mechanism: no application state crosses an origin, so there is nothing to transition.
 */

import { Directive, ElementRef, computed, inject, input } from '@angular/core';

import { withBasePath, type LocaleSelectorChoice } from '@neolorn/atlas/core';

import { applicationBaseHref } from './angular';
import { Localization } from './localization';

/**
 * Aria-current's value when this choice is the current locale.
 *
 * `true` rather than `page`, because a locale is not a page and the switcher is usually still on
 * the one you are looking at. The token list is the attribute's own, so an application that puts
 * its switcher in a navigation landmark can say `page` there without the directive growing a second
 * opinion about what a locale switcher is.
 */
export type LocaleChoiceCurrent = 'true' | 'page' | 'location' | 'step';

/**
 * One option of a locale switcher, wired.
 *
 * The application writes the loop and the markup: that is its layout, and a directive that owned
 * the loop would make Atlas own markup. What the application should not have to write is the six
 * attributes a correct option needs, because every one of them is something the runtime knows:
 *
 *     &commat;for (choice of localization.localeChoices(); track choice.locale) {
 *       &lt;button type="button" [localeChoice]="choice"&gt;{{ choice.selfName }}&lt;/button&gt;
 *     }
 *
 * On an anchor it also writes `href`: the address this page has in that locale, which the routing
 * integration derives per navigation from the same resolution the `hreflang` alternates come from.
 * A control the reader can open in a new tab, copy the link of, or see the destination of in the
 * status bar is what a link is for, and none of it is available to a `button`. Which is also why
 * there is an address only where following it would really arrive in that locale: those three uses
 * are all requests to go there *later*, or *elsewhere*, carrying nothing this page knows. Where
 * there is none (no routing, a slug whose spelling has not been declared yet, or a locale this
 * route's address cannot distinguish) nothing is written and the switch still works.
 *
 * Under a `locale-host` policy that address is at another origin, and it is written here like any
 * other. It is the one case where the `href` is not a convenience: the switch itself is a document
 * navigation to it, because a locale that is an origin cannot be reached in place.
 *
 * `lang` is the option's own language, so a screen reader pronounces "Deutsch" in German rather
 * than reading it as English; `dir` is that language's direction, so an Arabic option laid out in
 * a left-to-right page is not reversed; `aria-current` says which one you are in; `aria-busy` says
 * which one is arriving. Written by hand, all four are written once per locale per template, in
 * languages the author may not read.
 *
 * **This is `routerLinkActive`'s shape, deliberately.** An attribute directive with no markup of its
 * own, applied to an element the application wrote, which reads state and writes attributes, and
 * like it, the activation is the element's own: a `button` and an `a[href]` both raise `click` from
 * the keyboard without help, so there is no key handler here and no `tabindex`. A `div` gets
 * neither, which is the correct outcome for a control that is not one.
 */
@Directive({
  selector: '[localeChoice]',
  host: {
    '[attr.lang]': 'choice().language',
    '[attr.dir]': 'choice().direction',
    '[attr.aria-current]': 'choice().current ? currentAs() : null',
    '[attr.aria-busy]': 'choice().pending ? "true" : null',
    '[attr.href]': 'address()',
    '(click)': 'activate($event)',
  },
})
export class LocaleChoice {
  private readonly localization = inject(Localization);
  /**
   * An anchor gets an address; nothing else does.
   *
   * `href` on a `button` or a `div` is not a link, it is an attribute the browser ignores and a
   * reader's tooling may not, so this is decided by what the application actually wrote, once,
   * because an element does not change its tag. `tagName` rather than `instanceof
   * HTMLAnchorElement`, which is not defined while server rendering.
   */
  private readonly anchor =
    inject(ElementRef<HTMLElement>).nativeElement.tagName?.toLowerCase() ===
    'a';

  /**
   * The option this element stands for, one entry from `localeChoices()`.
   *
   * Required, because every attribute the directive writes is read out of it: the language, the
   * direction, whether this is the locale in use, whether it is the one arriving, and the address.
   */
  readonly choice = input.required<LocaleSelectorChoice>({
    alias: 'localeChoice',
  });

  /**
   * Which `aria-current` token to write when this option is the locale in use.
   *
   * Defaults to `true`. Set it to `page` where the switcher sits in a navigation landmark whose
   * surrounding markup already says that its links are pages.
   */
  readonly currentAs = input<LocaleChoiceCurrent>('true', {
    alias: 'localeChoiceCurrent',
  });

  /**
   * The sub-path this application is deployed under, resolved once from Angular's own declaration.
   *
   * Needed because an `href` is an address the browser resolves against the document, not against
   * the application's root, and the snapshot's addresses are application-rooted, which is what
   * the Router speaks and what `routerLink` expects. Composing the mount point here rather than
   * into the snapshot keeps one address with one meaning and puts the adjustment in the one place
   * that knows which attribute it is writing.
   */
  private readonly baseHref = applicationBaseHref();

  /**
   * Where this locale's copy of the current page lives, when the application is routed.
   *
   * Read from the route record on the snapshot rather than carried on the choice, because it is a
   * property of the page and not of the locale: every navigation changes all of them at once, and a
   * choice that carried one would be rebuilt for every locale on every navigation to say the same
   * thing about a different page.
   *
   * Mounted on the way out. A deployment at `https://example.com/app` gets `/app/en-us/second`
   * here from `/en-us/second` on the snapshot, and under a `locale-host` policy the other origin's
   * URL is mounted on its own path: the same composition the head uses, in the one place an
   * address becomes a browser-resolved one. A root-mounted deployment writes what it always wrote.
   */
  protected readonly address = computed(() => {
    if (!this.anchor) return null;
    const address =
      this.localization.snapshot()?.route?.addresses?.[this.choice().locale];
    return address === undefined ? null : withBasePath(address, this.baseHref);
  });

  /**
   * Switch, unless the visitor asked the browser for something else.
   *
   * A modified click on an anchor carrying an address is a request to open that address somewhere
   * else, and answering it with an in-place locale change loses the thing that was asked for. The
   * check is written now rather than when the address arrives, because the alternative is a
   * directive that quietly starts doing the wrong thing on the day an `href` appears.
   *
   * `preventDefault` otherwise: a switch is not a navigation, and letting the anchor follow its own
   * address would reload the document to reach a state the runtime reaches without one.
   *
   * The result is not awaited and not thrown. Every outcome a caller could act on is already a
   * signal (`lastResult` carries the verdict, `recovery` carries the message a person should see)
   * and a directive that rejected in an event handler would put the same information somewhere
   * nothing reads.
   */
  protected activate(event: Event): void {
    const choice = this.choice();
    if (choice.current) {
      event.preventDefault();
      return;
    }
    if (event instanceof MouseEvent) {
      if (event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        const target = event.currentTarget;
        if (target instanceof HTMLAnchorElement && target.hasAttribute('href'))
          return;
      }
    }
    event.preventDefault();
    void this.localization.changeLocale(choice.locale);
  }
}
