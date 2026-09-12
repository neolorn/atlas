import { Component } from '@angular/core';
import { injectLocalization } from '@neolorn/atlas';
import { messages as lazyMessages } from '#i18n/lazy';

/**
 * The only place this application uses the `lazy` scope.
 *
 * It is reached through `loadComponent`, so the file is not in the first render's bundle and
 * neither are its messages: Atlas sees the boundary, finds every use of the scope behind it, and
 * marks the scope non-startup. No list anywhere says so.
 *
 * That is also what makes the progressive and coordinated scope tests mean something. A scope
 * already loaded at bootstrap cannot demonstrate what happens while one is still arriving.
 */
@Component({
  selector: 'atlas-feature-lazy-route',
  standalone: true,
  template: `<p data-route-view="lazy">{{ label() }}</p>`,
})
export class FeatureLabLazyRoute {
  private readonly localization = injectLocalization();
  protected readonly label = this.localization.textSignal(lazyMessages.status);
}
