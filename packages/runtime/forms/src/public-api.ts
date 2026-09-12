/**
 * A localized field, and the state this control does not own.
 *
 * `specs/08-formatting-parsing-and-domain.spec.md` section 8 leaves the control value, the
 * selection, an active composition, the touched, dirty and pending state, issue precedence,
 * asynchronous validation and submission with the form system, and requires every one of them
 * to survive a locale change with only the wording rebuilt, so a half-filled form is not lost
 * when a reader switches language.
 *
 * The parsing itself is `specs/08-formatting-parsing-and-domain.spec.md` section 6, which is why
 * an entry this control cannot read becomes a typed status rather than a corrected value.
 */

import {
  Directive,
  ElementRef,
  Renderer2,
  effect,
  forwardRef,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  NG_VALIDATORS,
  NG_VALUE_ACCESSOR,
  type AbstractControl,
  type ControlValueAccessor,
  type ValidationErrors,
  type Validator,
} from '@angular/forms';
import { remapCaret } from './caret';
import {
  Localization,
  formatLocalizedInput,
  parseLocalizedInput,
  type LocalizedInputProfile,
  type LocalizedInputResult,
  type LocalizedInputStatus,
  type LocalizedInputValue,
} from '@neolorn/atlas';

/**
 * The error code this directive writes when it could not read what a reader typed.
 *
 * One code per refusal, so a form that chooses its wording by code can tell an entry that is not
 * finished from one that is outside the range the profile allows, and an entry the locale cannot
 * express from one a policy refused. The strings are namespaced because a control carries the
 * errors of every validator on it in one object, and a bare word would collide.
 */
export type LocalizedInputIssueCode =
  | 'atlas.input.incomplete'
  | 'atlas.input.invalid'
  | 'atlas.input.ambiguous'
  | 'atlas.input.out-of-range'
  | 'atlas.input.unsupported-capability'
  | 'atlas.input.policy-rejected';

/**
 * The code that goes with a refusal, so a template branches on one string rather than two.
 *
 * Takes any parse status other than `valid`, which is not a refusal and has no code. Returns the
 * code this directive puts under the `localizedInput` key of the control's errors.
 */
export function localizedInputIssueCode(
  status: Exclude<LocalizedInputStatus, 'valid'>,
): LocalizedInputIssueCode {
  return `atlas.input.${status}`;
}

/**
 * A text field whose displayed value is written and read in the committed locale.
 *
 * Stands in for the control value accessor and the validator at once, so the form holds the parsed
 * value while the element holds the locale's spelling of it. A locale change rewrites the text and
 * leaves everything else: the value, the caret, an active composition, and whether the control has
 * been touched.
 *
 * Text the profile cannot read is not corrected and not thrown away. It stays in the field, the
 * element is marked invalid for a screen reader, and the reason is reported through `validate` and
 * through `result`. The value the form holds is the last one that parsed.
 */
@Directive({
  selector: 'input[localizedInput]',
  standalone: true,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => LocalizedInput),
      multi: true,
    },
    {
      provide: NG_VALIDATORS,
      useExisting: forwardRef(() => LocalizedInput),
      multi: true,
    },
  ],
  host: {
    '(input)': 'handleInput()',
    '(blur)': 'handleBlur()',
    '(compositionstart)': 'handleCompositionStart()',
    '(compositionend)': 'handleCompositionEnd()',
  },
})
export class LocalizedInput implements ControlValueAccessor, Validator {
  private readonly element =
    inject<ElementRef<HTMLInputElement>>(ElementRef).nativeElement;
  private readonly renderer = inject(Renderer2);
  private readonly localization = inject(Localization);
  private model: LocalizedInputValue<LocalizedInputProfile> | null = null;
  private composing = false;
  private pendingRender = false;
  private change: (value: LocalizedInputValue<LocalizedInputProfile>) => void =
    () => undefined;
  private touched: () => void = () => undefined;
  private validatorChange: () => void = () => undefined;

  /**
   * What kind of value the field holds, which is also the attribute the directive is selected by.
   *
   * It decides how the value is written and what counts as readable text. Binding a different
   * profile rewrites what is on screen in the new shape without going through the form.
   */
  readonly profile = input.required<LocalizedInputProfile>({
    alias: 'localizedInput',
  });

  /**
   * What came of the last read or write, and `undefined` until one has happened.
   *
   * A template can read this to explain a refusal in its own words rather than mapping the
   * control's error object back to a cause.
   */
  readonly result = signal<
    LocalizedInputResult<LocalizedInputValue<LocalizedInputProfile>> | undefined
  >(undefined);

  constructor() {
    effect(() => {
      this.profile();
      this.localization.snapshot()?.id;
      this.renderModel();
    });
  }

  /**
   * Takes the value the form holds and writes it in the committed locale.
   *
   * Called by the form rather than by an application. A value the locale cannot express leaves the
   * field empty and reports why through `result`, because a number written in a spelling the
   * profile did not ask for would be read back as a different number.
   */
  writeValue(value: LocalizedInputValue<LocalizedInputProfile> | null): void {
    this.model = value;
    this.result.set(undefined);
    this.renderModel();
  }

  /**
   * Takes the callback the form uses to receive a new value. Called by the form.
   *
   * Atlas calls it only when what was typed parses, so a half-finished entry never reaches the
   * model and the form keeps the last value that meant something.
   */
  registerOnChange(
    change: (value: LocalizedInputValue<LocalizedInputProfile>) => void,
  ): void {
    this.change = change;
  }

  /**
   * Takes the callback that marks the control touched. Called by the form.
   *
   * Atlas calls it on blur, after one last read of the field, so the value and the touched state
   * change together rather than one edit apart.
   */
  registerOnTouched(touched: () => void): void {
    this.touched = touched;
  }

  /**
   * Takes the callback that tells the form to revalidate. Called by the form.
   *
   * Atlas calls it whenever a read or a write changes the status, which includes the rewrite a
   * locale change causes, so a field that became unreadable in the new locale is reported without
   * anyone touching it.
   */
  registerOnValidatorChange(change: () => void): void {
    this.validatorChange = change;
  }

  /** Takes whether the form has disabled the control, and puts that on the element. */
  setDisabledState(disabled: boolean): void {
    this.renderer.setProperty(this.element, 'disabled', disabled);
  }

  /**
   * Returns `null` while the last read succeeded or has not happened yet.
   *
   * Otherwise returns a single error under the `localizedInput` key carrying the status and its
   * code. One key, so precedence against whatever else validates the control stays with the form,
   * which is where the spec leaves it. The control argument is unused: what is being judged is the
   * text in the element, which the form does not hold.
   */
  validate(_control: AbstractControl): ValidationErrors | null {
    const result = this.result();
    if (result === undefined || result.status === 'valid') return null;
    return Object.freeze({
      localizedInput: Object.freeze({
        code: localizedInputIssueCode(result.status),
        status: result.status,
      }),
    });
  }

  protected handleInput(): void {
    if (this.composing) return;
    this.parseView();
  }

  protected handleBlur(): void {
    if (!this.composing) this.parseView();
    this.touched();
  }

  protected handleCompositionStart(): void {
    this.composing = true;
  }

  protected handleCompositionEnd(): void {
    this.composing = false;
    this.parseView();
    if (this.pendingRender) this.renderModel();
  }

  private parseView(): void {
    const formatting = this.localization.snapshot()?.formatting;
    if (formatting === undefined) return;
    const result = parseLocalizedInput(
      this.element.value,
      this.profile(),
      formatting,
    ) as LocalizedInputResult<LocalizedInputValue<LocalizedInputProfile>>;
    this.result.set(result);
    this.renderer.setAttribute(
      this.element,
      'aria-invalid',
      result.status === 'valid' ? 'false' : 'true',
    );
    this.validatorChange();
    if (result.status !== 'valid') return;
    this.model = result.value;
    this.change(result.value);
  }

  private renderModel(): void {
    if (this.composing) {
      this.pendingRender = true;
      return;
    }
    this.pendingRender = false;
    const currentResult = this.result();
    if (currentResult !== undefined && currentResult.status !== 'valid') return;
    const formatting = this.localization.snapshot()?.formatting;
    if (formatting === undefined || this.model === null) return;
    const formatted = formatLocalizedInput(
      this.model,
      this.profile(),
      formatting,
    );
    if (!formatted.ok) {
      this.renderer.setProperty(this.element, 'value', '');
      this.renderer.setAttribute(this.element, 'aria-invalid', 'true');
      this.result.set(
        Object.freeze({
          status:
            formatted.diagnostic.code === 'unsupported-formatting-capability'
              ? 'unsupported-capability'
              : 'policy-rejected',
          text: '',
          diagnostic: formatted.diagnostic,
        }),
      );
      this.validatorChange();
      return;
    }
    if (this.element.value === formatted.value.text) return;
    const active = this.element.ownerDocument.activeElement === this.element;
    // The text this selection indexes into, kept because the offsets stop meaning what they mean
    // the moment the value is rewritten.
    const selection = active
      ? Object.freeze({
          start: this.element.selectionStart,
          end: this.element.selectionEnd,
          direction: this.element.selectionDirection,
          value: this.element.value,
        })
      : undefined;
    this.renderer.setProperty(this.element, 'value', formatted.value.text);
    if (
      selection !== undefined &&
      selection.start !== null &&
      selection.end !== null
    ) {
      const { start, end, direction, value: previous } = selection;
      queueMicrotask(() => {
        if (this.element.ownerDocument.activeElement !== this.element) return;
        // Both boundaries go through the same rule independently, rather than one anchor plus the
        // width carried across. A separator appearing inside the selection changes how wide it is,
        // and reusing the old width would move the far edge to preserve a length that no longer
        // describes anything.
        const next = this.element.value;
        this.element.setSelectionRange(
          remapCaret(previous, start, next),
          remapCaret(previous, end, next),
          direction ?? undefined,
        );
      });
    }
  }
}
