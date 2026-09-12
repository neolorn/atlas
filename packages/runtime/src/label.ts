import {
  Directive,
  ElementRef,
  Renderer2,
  computed,
  effect,
  inject,
  input,
} from '@angular/core';

import {
  type MessageHandle,
  type MessageInputArguments,
  type MessageInputs,
} from '@neolorn/atlas/core';
import { Localization } from './localization';

/**
 * The attributes that carry text a person reads.
 *
 * A closed list, because the directive writes a localized string into whatever it is pointed at.
 * `href`, `src`, `formaction`, and every `on*` attribute are places where a string stops being
 * text and becomes a navigation or a program, and an application should not be able to route
 * translated content into one of them by changing a single word in a template.
 *
 * Adding to this list is a deliberate act. Every entry has to be an attribute whose value is
 * presented, never fetched, executed, or resolved.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 9 is where the set is required to be closed,
 * and why an attribute outside it is refused rather than written.
 */
export const LABEL_ATTRIBUTES = Object.freeze([
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'alt',
  'placeholder',
  'title',
] as const);

/**
 * Any one of the seven attributes a localized label may be written into.
 *
 * What `localizedLabelAttribute` accepts, so naming an attribute outside the set is a compile error
 * rather than something discovered at render time. Every entry is presented to a reader and none of
 * them is fetched, executed or resolved.
 */
export type LabelAttribute = (typeof LABEL_ATTRIBUTES)[number];

function isLabelAttribute(value: string): value is LabelAttribute {
  return (LABEL_ATTRIBUTES as readonly string[]).includes(value);
}

/**
 * A message in attribute position.
 *
 * `aria-label`, `title`, `placeholder` and `alt` are read aloud or shown, and a pipe can already
 * write one: `[attr.alt]="messages.x | localize"` compiles and renders. What this directive adds is
 * the closed set. `LABEL_ATTRIBUTES` is seven names, every one presented to a reader and none of
 * them fetched, executed, or resolved, and an attribute outside the seven is a type error.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 9 requires that set, and says why: routing
 * translated content into one of the other positions MUST NOT be a one-word template change. With a
 * pipe, `[attr.aria-label]` becomes `[attr.href]` by changing one word, it compiles, and the value
 * is a string a translator supplied. Angular sanitizes `[attr.href]` already, so what is left is
 * how small that edit is and who wrote the string, which is not the application itself.
 *
 *     <div class="hero__actions" [localizedLabel]="messages.hero.actionsAriaLabel"></div>
 *     <input [localizedLabel]="messages.search.hint" localizedLabelAttribute="placeholder" />
 *
 * The attribute is written imperatively rather than through a host binding on every supported
 * name, so an element that already carries a static `alt` or `title` keeps it. A host binding
 * would claim that slot and clear it.
 *
 * Generic in the handle, so `localizedLabelInputs` means what that particular message declares. The
 * same reason `LocalizedMessage` is: a message needing `{ name }` should not accept `{ nmae }`
 * and fail in the browser, in whichever locale happened to be active.
 */
@Directive({
  selector: '[localizedLabel]',
})
export class LocalizedLabel<
  Handle extends MessageHandle & { readonly resultKind: 'plain' } =
    MessageHandle & { readonly resultKind: 'plain' },
> {
  private readonly localization = inject(Localization);
  private readonly element = inject(ElementRef<Element>);
  private readonly renderer = inject(Renderer2);
  private written: string | undefined;

  /**
   * The message to write, which is also the attribute the directive is selected by.
   *
   * Aliased rather than named for the selector, so a member read from the class reads as what it
   * is and a template keeps the prefix that tells one directive from another.
   */
  readonly handle = input.required<Handle>({ alias: 'localizedLabel' });

  /** What the message declares, typed to this handle. */
  readonly inputs = input<MessageInputs<Handle>>(
    // A message with no inputs is bound as nothing at all, so the default has to exist. The
    // template binding is where the contract is enforced, and there this is a real type.
    Object.freeze({}) as MessageInputs<Handle>,
    { alias: 'localizedLabelInputs' },
  );

  /** Which of the four attributes to write. The default is the one that is read aloud. */
  readonly attribute = input<LabelAttribute>('aria-label', {
    alias: 'localizedLabelAttribute',
  });

  private readonly text = computed(
    () =>
      this.localization.evaluateText(
        this.handle(),
        ...([this.inputs()] as MessageInputArguments<Handle>),
      ).value,
  );

  constructor() {
    effect(() => {
      const attribute = this.attribute();
      if (!isLabelAttribute(attribute)) {
        // Reachable only from JavaScript that bypasses the template's type checking. Refusing to
        // write is the safe answer: the alternative is a localized string in an attribute this
        // directive was built not to touch.
        return;
      }
      const value = this.text();
      if (this.written !== undefined && this.written !== attribute) {
        this.renderer.removeAttribute(this.element.nativeElement, this.written);
      }
      this.renderer.setAttribute(this.element.nativeElement, attribute, value);
      this.written = attribute;
    });
  }
}
