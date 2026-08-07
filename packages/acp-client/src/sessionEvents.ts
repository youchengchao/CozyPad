import type { SessionNotification } from '@agentclientprotocol/sdk';

/**
 * The `update` payload carried by a `session/update` notification.
 *
 * ACP declares this union *inline* on {@link SessionNotification}, so there is
 * no name to import — every consumer would otherwise have to spell
 * `SessionNotification['update']`. Naming it is the point of this module.
 *
 * The variants are ACP's own, verbatim. Under
 * `@agentclientprotocol/sdk@1.3.0` that is: `user_message_chunk`,
 * `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
 * `tool_call_update`, `plan`, `plan_update`, `plan_removed`,
 * `available_commands_update`, `current_mode_update`, `config_option_update`,
 * `session_info_update` and `usage_update`.
 *
 * Five of those did not exist in `@zed-industries/agent-client-protocol@0.4.5`
 * and were therefore **dropped on the floor** by the old dependency —
 * `usage_update` most consequentially, since docs/ACP-MIGRATION.md wanted live
 * token and cost in the chat footer and concluded it would have to ride
 * `_meta`. It does not: ACP models it.
 *
 * The union is derived from the SDK rather than restated, so the next variant
 * the protocol adds arrives here by upgrading one dependency.
 */
export type AcpSessionUpdate = SessionNotification['update'];

/** The `sessionUpdate` discriminator of {@link AcpSessionUpdate}. */
export type AcpSessionUpdateKind = AcpSessionUpdate['sessionUpdate'];

/** Narrows {@link AcpSessionUpdate} to a single variant. */
export type AcpSessionUpdateOf<K extends AcpSessionUpdateKind> = Extract<
  AcpSessionUpdate,
  { sessionUpdate: K }
>;

/**
 * A `session/update` notification, flattened for consumption.
 *
 * This is deliberately *not* a translation layer: `kind` holds the ACP
 * discriminator string unchanged and `update` is the untouched ACP payload.
 * The only thing added is that the discriminator is hoisted to the top level,
 * so a consumer can `switch (event.kind)` and have `event.update` narrow with
 * it — while still having `sessionId` in hand.
 */
export type AcpSessionEvent = {
  [K in AcpSessionUpdateKind]: {
    readonly sessionId: string;
    readonly kind: K;
    readonly update: AcpSessionUpdateOf<K>;
    /** ACP's extension point, passed through untouched. */
    readonly _meta?: Record<string, unknown> | null;
  };
}[AcpSessionUpdateKind];

/**
 * Flattens a validated `session/update` notification into an
 * {@link AcpSessionEvent}.
 *
 * The notification has already been through the protocol library's zod schema
 * by the time it reaches here, so this does no validation of its own.
 */
export function normalizeSessionNotification(
  notification: SessionNotification,
): AcpSessionEvent {
  // `kind` and `update` are read from the same value, but TypeScript cannot
  // see that they stay correlated across the property split, so the mapped
  // union has to be asserted rather than inferred.
  return {
    sessionId: notification.sessionId,
    kind: notification.update.sessionUpdate,
    update: notification.update,
    _meta: notification._meta,
  } as AcpSessionEvent;
}
