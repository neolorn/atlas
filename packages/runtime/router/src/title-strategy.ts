import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { TitleStrategy, type RouterStateSnapshot } from '@angular/router';

import { DocumentLocalization } from '@neolorn/atlas';

/**
 * The one writer of `document.title` once a navigation has ended.
 *
 * Angular emits `NavigationEnd` and then calls `titleStrategy.updateTitle(...)` synchronously in the
 * same `tap` (`@angular/router` 22.1.3, `_router-chunk.mjs:3964-3965`). Atlas has written the title
 * long before that (`applyDocument` runs inside the canonical route resolver, before activation)
 * so the last write of every navigation belongs to whatever holds this token. `DefaultTitleStrategy`
 * writes whenever the route tree declares a `title` (`:3403-3407`), which means a consumer following
 * Angular's own documented route-title API silently replaces every localized title with an English
 * one. Nothing throws, nothing warns, and the page looks like Atlas simply failed to translate.
 *
 * **This is installed by the consumer, not by `provideLocalizedRouter`.** `TitleStrategy` is
 * `providedIn: 'root'` with `factory: () => inject(DefaultTitleStrategy)` (`:3382`), and a raw
 * provider entry is the documented way to replace it. Angular ships no `withTitleStrategy()` router
 * feature to claim it through, so taking the token from inside `provideLocalizedRouter` would
 * silently replace a provider an application had set on purpose. `provideLocalizedRouter` warns in
 * development when the line is missing and the routes declare a title: the configuration where
 * omitting it changes what the page says.
 *
 * The fallback is Angular's behaviour exactly, not a narrowed version of it. For a route Atlas has
 * no title for, this writes what `DefaultTitleStrategy` would have written, including its
 * `newTitle || ''` for an empty one (`@angular/platform-browser` 22.1.3,
 * `platform-browser.mjs:134-136`). `Title` is not injected to do it: that service lives in
 * `@angular/platform-browser`, which is not a peer of this package, and all it does is assign
 * `document.title`, which is also how `DocumentLocalization` writes.
 */
@Injectable()
export class LocalizedTitleStrategy extends TitleStrategy {
  private readonly documentRef = inject(DOCUMENT);

  /**
   * Optional for the same reason `RouteLocalization` takes it that way: an application can install
   * the router integration without the document effect. Without it Atlas has no title to defend and
   * this strategy is `DefaultTitleStrategy` with an extra frame.
   */
  private readonly localized = inject(DocumentLocalization, { optional: true });

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const projected = this.localized?.current()?.title;
    // Re-asserted rather than skipped. Atlas wrote this value before activation, and between then
    // and now the only thing that can have moved the title is something outside Atlas, so writing
    // it again is what makes "the localized title survives the navigation" true rather than likely.
    // Assigning the value the document already holds is not a mutation the browser acts on.
    if (projected !== undefined) {
      this.documentRef.title = projected;
      return;
    }
    const declared = this.buildTitle(snapshot);
    if (declared !== undefined) this.documentRef.title = declared || '';
  }
}
