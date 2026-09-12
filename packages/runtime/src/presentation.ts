/**
 * Showing a domain value or a failure code to a reader, including one Atlas has never seen.
 *
 * `specs/08-formatting-parsing-and-domain.spec.md` section 10 keeps machine equality and
 * persistence on the invariant value rather than on the localized label, so what is presented
 * here is a rendering and never the thing itself. An external value outside the known set
 * becomes a typed unknown state with a safe presentation and a diagnostic rather than a blank
 * or a guess, because an application receives values from systems it does not deploy and there
 * is always one it has not heard of yet.
 */

import {
  type ExternalValuePresentation,
  type IssueMessageSource,
  type IssuePresentation,
  type LocalizationDiagnostic,
  type LocalizedIssue,
  type LocalizedNotification,
  type NotificationMessage,
  type MessageHandle,
  type PlainMessageHandle,
} from '@neolorn/atlas/core';
import { issueMessage } from './issue-convention';
import type { Localization } from './localization';

function safeCode(code: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(code);
}

function unknownDiagnostic(): LocalizationDiagnostic {
  return Object.freeze({
    code: 'unknown-presentation-code',
    outcome: 'consumer-domain-outcome',
    message:
      'An unknown external presentation code used the configured generic message.',
  });
}

/**
 * The message for one backend failure code.
 *
 * An explicit binding wins, because it exists precisely for the cases the convention cannot
 * express. Otherwise the code names its own message: `INSUFFICIENT_STOCK` finds
 * `insufficient-stock` in the group, and nothing is written per code.
 *
 * Everything else falls to the unknown branch, which is not a fallback so much as the point of
 * the feature: an application receives codes from a service it does not deploy, and there is
 * always a code it has not heard of yet.
 */
export function presentIssue(
  localization: Localization,
  issue: LocalizedIssue,
  source: IssueMessageSource,
): IssuePresentation {
  if (!safeCode(issue.code)) return unknownIssue(localization, issue, source);
  const binding = source.bindings?.[issue.code];
  if (binding !== undefined) {
    return Object.freeze({
      status: 'known',
      code: issue.code,
      localized: localization.evaluateText(
        binding.message,
        binding.parameters?.(issue) ?? issue.parameters ?? {},
      ),
    });
  }
  const paired = issueMessage(source.messages, issue.code);
  if (paired === undefined) return unknownIssue(localization, issue, source);
  return Object.freeze({
    status: 'known',
    code: issue.code,
    localized: localization.evaluateText(
      paired,
      source.parameters?.(issue) ?? issue.parameters ?? {},
    ),
  });
}

function unknownIssue(
  localization: Localization,
  issue: LocalizedIssue,
  source: IssueMessageSource,
): IssuePresentation {
  return Object.freeze({
    status: 'unknown',
    code: issue.code,
    localized: localization.evaluateText(source.unknown, {}),
    diagnostic: unknownDiagnostic(),
  });
}

/**
 * Turns a code that came from outside into words, without letting the code choose a message.
 *
 * Takes localization, the value to present, the messages it may map to by name, and what to say for
 * a value that maps to none. Returns a known presentation with the localized text, or an unknown
 * one carrying the value, the fallback text and a diagnostic.
 *
 * A status from an API, an error code from a payment provider, an enum from another team's service:
 * the set changes without this application shipping, so an unmapped value is expected rather than a
 * defect. The lookup is guarded, so a value shaped like a property name reaches no message it was
 * not given one for.
 */
export function presentExternalValue<Value extends string>(
  localization: Localization,
  value: Value,
  bindings: Readonly<Record<string, PlainMessageHandle>>,
  unknownMessage: PlainMessageHandle,
): ExternalValuePresentation<Value> {
  const message = safeCode(value) ? bindings[value] : undefined;
  if (message === undefined) {
    return Object.freeze({
      status: 'unknown',
      value,
      localized: localization.evaluateText(unknownMessage, {}),
      diagnostic: unknownDiagnostic(),
    });
  }
  return Object.freeze({
    status: 'known',
    value,
    localized: localization.evaluateText(message, {}),
  });
}

/**
 * Localizes one notification, whether its message is plain text or structured.
 *
 * Takes localization and the notification, and returns it with its content evaluated and its tone
 * settled, defaulting to information. The identity is carried through untouched, so a queue can
 * still match a notification to the thing that raised it.
 *
 * Which of the two kinds of content came back is read off the result, so a toast host renders a
 * string or a set of parts without knowing in advance which its caller supplied.
 */
export function presentNotification(
  localization: Localization,
  notification: NotificationMessage,
): LocalizedNotification {
  const content =
    notification.message.resultKind === 'plain'
      ? localization.evaluateText(
          notification.message as PlainMessageHandle,
          notification.inputs ?? {},
        )
      : localization.parts(
          notification.message as MessageHandle & {
            readonly resultKind: 'structured';
          },
          notification.inputs ?? {},
        );
  return Object.freeze({
    id: notification.id,
    tone: notification.tone ?? 'information',
    content,
  });
}
