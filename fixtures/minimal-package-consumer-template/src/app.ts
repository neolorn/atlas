import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import {
  LocaleChoice,
  LocalizedMessage,
  LocalizePipe,
  injectLocalization,
} from '@neolorn/atlas';
import { messages } from '#i18n/shell';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [LocaleChoice, LocalizedMessage, LocalizePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main data-minimal-atlas [attr.lang]="locale()" [attr.dir]="direction()">
      <h1 data-title>{{ title() }}</h1>
      <p data-welcome>{{ welcome() }}</p>
      <p data-pipe>{{ messages.title | localize }}</p>
      <localized-message data-rich [handle]="messages.guide" />
      <p data-inherited>{{ inherited() }}</p>
      <output data-locale>{{ locale() }}</output>
      <!--
        The smallest switcher there is, and it still names no locale. The loop is four lines of the
        application's own markup; the option's language, direction, current state and label come
        from the choice.
      -->
      @for (choice of localeChoices(); track choice.locale) {
        <button
          type="button"
          [attr.data-switch-locale]="choice.locale"
          [localeChoice]="choice"
        >
          {{ choice.selfName }}
        </button>
      }
    </main>
  `,
})
export class App {
  private readonly localization = injectLocalization();

  protected readonly messages = messages;
  protected readonly title = this.localization.textSignal(messages.title);
  protected readonly welcome = this.localization.textSignal(messages.welcome, {
    name: 'Atlas',
  });
  /**
   * The one message `ar-EG` does not carry.
   *
   * `ar` does, and `ar-EG` inherits from `ar`, so in Arabic this renders the Arabic sentence rather
   * than the English one. Nothing here says that: the component asks for a message, and which
   * catalog answers is the runtime walking the chain the build resolved.
   */
  protected readonly inherited = this.localization.textSignal(
    messages.inherited,
  );
  protected readonly localeChoices = this.localization.localeChoices;
  protected readonly locale = computed(
    () => this.localization.snapshot()?.primaryLocale ?? 'uninitialized',
  );
  protected readonly direction = computed(
    () => this.localization.snapshot()?.direction ?? 'ltr',
  );

  /**
   * Kept for the spec, which drives the switch from the component rather than the DOM.
   *
   * Not a locale union any more: a parameter typed `'en-US' | 'ar-EG'` is the same hardcoded locale
   * set as a template literal, one layer down, and it stops compiling the day a third locale is
   * configured.
   */
  async selectLocale(locale: string): Promise<void> {
    await this.localization.changeLocale(locale);
  }
}
