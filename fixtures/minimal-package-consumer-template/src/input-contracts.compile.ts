import { type Localization } from '@neolorn/atlas';
import { messages } from '#i18n/shell';

declare const localization: Localization;

const noInputMessage: string = localization.text(messages.title);
const inferredInputMessage: string = localization.text(messages.welcome, {
  name: 'Atlas',
});
const structuredMessage = localization.parts(messages.guide);

// @ts-expect-error The generated welcome handle requires its inferred name input.
localization.text(messages.welcome);
// @ts-expect-error Generated message inputs reject undeclared fields.
localization.text(messages.welcome, { name: 'Atlas', extra: true });
// @ts-expect-error Generated message inputs preserve their declared value types.
localization.text(messages.welcome, { name: 42 });

void noInputMessage;
void inferredInputMessage;
void structuredMessage;
