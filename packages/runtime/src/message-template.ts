/**
 * The two template surfaces for a message: the structured presenter and the plain-text pipe.
 *
 * `specs/06-runtime-and-angular.spec.md` section 3 requires the pipe to be impure, because it
 * reads the ambient snapshot rather than only its arguments and would otherwise keep the first
 * locale it saw. The presenter takes a handle with its typed inputs and trusted slot bindings and
 * loads nothing, so a template cannot become a place where a catalog request starts.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 3 is why a message whose slot has no binding of
 * the right kind is refused instead of rendered: a link needs an application-owned destination
 * and an action an application-owned handler, and rendering the text without them would leave a
 * catalog deciding where a reader goes.
 */

import { NgTemplateOutlet } from '@angular/common';
import { type TrustedSlotBinding } from './angular-contracts';
import {
  ChangeDetectionStrategy,
  Component,
  Pipe,
  computed,
  inject,
  input,
} from '@angular/core';

import {
  LocalizationError,
  type LocalizedPart,
  type MessageHandle,
  type MessageInputArguments,
  type MessageInputs,
  type MessageSlots,
} from '@neolorn/atlas/core';
import { Localization } from './localization';

function requireBindings(
  parts: readonly LocalizedPart[],
  bindings: Readonly<Record<string, TrustedSlotBinding>>,
): void {
  for (const part of parts) {
    if (part.kind !== 'slot') continue;
    const binding = bindings[part.name];
    if (
      (part.slotKind === 'link' && binding?.kind !== 'link') ||
      (part.slotKind === 'action' && binding?.kind !== 'action') ||
      (!['emphasis', 'strong', 'code', 'link', 'action'].includes(
        part.slotKind,
      ) &&
        binding?.kind !== 'template' &&
        binding?.kind !== 'text')
    ) {
      throw new LocalizationError({
        code: 'invalid-rich-message',
        outcome: 'operational-failure',
        message: `Trusted binding for semantic slot ${part.name} is missing or incompatible.`,
        supplyingLocale: part.supplyingLocale,
      });
    }
    requireBindings(part.children, bindings);
  }
}

/**
 * A structured message rendered in a template, with its own contract intact.
 *
 * The component is generic in the handle so `inputs` and `slots` mean what that particular message
 * declares. They were `Readonly<Record<string, unknown>>`: a message needing `{ name }` accepted
 * `{ nmae }`, or `{}`, or nothing, and every one of those compiled.
 *
 * Where that matters most is a library boundary. A shared component library renders messages
 * passed in by the application and owns no wording of its own, so the contract crossing that
 * boundary is the only thing standing between a shared component and a message it cannot
 * actually render. Erasing it there erases it everywhere the component is used.
 */
@Component({
  selector: 'localized-message',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.lang]': 'localized().language',
    '[attr.dir]': 'localized().direction',
  },
  template: `
    <ng-container
      *ngTemplateOutlet="renderParts; context: { $implicit: localized().value }"
    />

    <ng-template #renderParts let-parts>
      @for (part of parts; track $index) {
        @switch (part.kind) {
          @case ('text') {
            <ng-container>{{ part.value }}</ng-container>
          }
          @case ('value') {
            <!--
              contentDirection, not direction. direction is the direction of the locale that
              supplied the value, which for an interpolated value is always the message's own, so
              binding it here told the browser what it already knew and left an Arabic name in an
              English message marked left-to-right. contentDirection carries u:dir when the author
              wrote one, and auto when Atlas defers, which is what bdi does by default.
              MessageFormat 2's u:id is on the part and deliberately not bound to the DOM: an id
              attribute must be unique in a document, and a message rendered twice would produce
              two of them.
            -->
            <bdi
              [attr.lang]="part.language"
              [attr.dir]="part.contentDirection"
              >{{ part.value }}</bdi
            >
          }
          @case ('slot') {
            @switch (part.slotKind) {
              @case ('strong') {
                <strong [attr.lang]="part.language" [attr.dir]="part.direction">
                  <ng-container
                    *ngTemplateOutlet="
                      renderParts;
                      context: { $implicit: part.children }
                    "
                  />
                </strong>
              }
              @case ('emphasis') {
                <em [attr.lang]="part.language" [attr.dir]="part.direction">
                  <ng-container
                    *ngTemplateOutlet="
                      renderParts;
                      context: { $implicit: part.children }
                    "
                  />
                </em>
              }
              @case ('code') {
                <code [attr.lang]="part.language" [attr.dir]="part.direction">
                  <ng-container
                    *ngTemplateOutlet="
                      renderParts;
                      context: { $implicit: part.children }
                    "
                  />
                </code>
              }
              @case ('link') {
                @if (binding(part.name); as trusted) {
                  @if (trusted.kind === 'link') {
                    <a
                      [href]="trusted.destination.href"
                      [attr.target]="
                        trusted.destination.kind === 'external'
                          ? trusted.destination.target
                          : null
                      "
                      [attr.rel]="
                        trusted.destination.kind === 'external'
                          ? trusted.destination.rel
                          : null
                      "
                      [attr.lang]="part.language"
                      [attr.dir]="part.direction"
                    >
                      <ng-container
                        *ngTemplateOutlet="
                          renderParts;
                          context: { $implicit: part.children }
                        "
                      />
                    </a>
                  }
                }
              }
              @case ('action') {
                @if (binding(part.name); as trusted) {
                  @if (trusted.kind === 'action') {
                    <button
                      type="button"
                      [disabled]="trusted.disabled ?? false"
                      [attr.lang]="part.language"
                      [attr.dir]="part.direction"
                      (click)="trusted.activate()"
                    >
                      <ng-container
                        *ngTemplateOutlet="
                          renderParts;
                          context: { $implicit: part.children }
                        "
                      />
                    </button>
                  }
                }
              }
              @default {
                @if (binding(part.name); as trusted) {
                  @if (trusted.kind === 'template') {
                    <ng-container
                      *ngTemplateOutlet="
                        trusted.template;
                        context: { $implicit: part, part }
                      "
                    />
                  } @else if (trusted.kind === 'text') {
                    {{ trusted.projection }}
                  }
                }
              }
            }
          }
        }
      }
    </ng-template>
  `,
})
export class LocalizedMessage<
  Handle extends MessageHandle & { readonly resultKind: 'structured' } =
    MessageHandle & { readonly resultKind: 'structured' },
> {
  private readonly localization = inject(Localization);

  /** The message to render, which is what fixes the types of `inputs` and `slots`. */
  readonly handle = input.required<Handle>();
  /**
   * The values the message declares, by name.
   *
   * Optional only for a message that declares none. For any other, leaving it out is a compile
   * error rather than an empty placeholder at render time.
   */
  readonly inputs = input<MessageInputs<Handle>>(
    // A message with no inputs is bound as nothing at all, so the default has to exist. The
    // template binding is where the contract is enforced, and there this is a real type.
    Object.freeze({}) as MessageInputs<Handle>,
  );
  /**
   * What each slot the message places renders as, by name.
   *
   * A slot with no binding, or with one of the wrong kind, renders nothing: the words inside it are
   * dropped rather than shown unstyled, because a link that silently became text is a link the
   * reader cannot follow and cannot see is missing.
   */
  readonly slots = input<
    Readonly<Record<MessageSlots<Handle>, TrustedSlotBinding>>
  >(
    Object.freeze({}) as Readonly<
      Record<MessageSlots<Handle>, TrustedSlotBinding>
    >,
  );

  protected readonly localized = computed(() => {
    const result = this.localization.parts(
      this.handle(),
      ...([this.inputs()] as MessageInputArguments<Handle>),
    );
    requireBindings(
      result.value,
      this.slots() as Readonly<Record<string, TrustedSlotBinding>>,
    );
    return result;
  });

  protected binding(name: string): TrustedSlotBinding | undefined {
    return (this.slots() as Readonly<Record<string, TrustedSlotBinding>>)[name];
  }
}

/**
 * Writes a plain message into a template: `{{ messages.greeting | localize }}`.
 *
 * Takes a handle whose result is plain text, plus that message's declared inputs, and returns the
 * string in the committed locale. A structured message, one with emphasis or a link in it, is not
 * accepted here; `LocalizedMessage` renders those.
 *
 * Impure, because the text changes when the locale does and not when the arguments do. The last
 * result is kept and returned again while the handle, the inputs and the committed snapshot are all
 * unchanged, so an impure pipe in a list does not re-evaluate a message per rendering pass.
 */
@Pipe({
  name: 'localize',
  standalone: true,
  pure: false,
})
export class LocalizePipe {
  private readonly localization = inject(Localization);
  private priorHandle?: MessageHandle;
  private priorInputs?: unknown;
  private priorSnapshotId: number | undefined;
  private priorValue = '';

  /**
   * The inputs are the message's own, not `unknown`.
   *
   * `inputs?: unknown` accepted anything: a misspelled key, a missing required value, a number
   * where a date belongs. The evaluator rejected it at runtime, in the browser, in whichever
   * locale happened to be active, which is the wrong place to learn that a template does not
   * match its message.
   */
  transform<Handle extends MessageHandle & { readonly resultKind: 'plain' }>(
    handle: Handle,
    ...inputs: MessageInputArguments<Handle>
  ): string {
    const inputValues = inputs[0];
    const snapshotId = this.localization.snapshot()?.id;
    if (
      handle === this.priorHandle &&
      inputValues === this.priorInputs &&
      snapshotId === this.priorSnapshotId
    ) {
      return this.priorValue;
    }
    this.priorHandle = handle;
    this.priorInputs = inputValues;
    this.priorSnapshotId = snapshotId;
    this.priorValue = this.localization.evaluateText(handle, ...inputs).value;
    return this.priorValue;
  }
}
