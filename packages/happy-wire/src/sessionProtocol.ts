/**
 * UNDER REVIEW - NEEDS MORE CAREFUL DESIGN
 *
 * This session protocol is currently emitted by multiple CLI runtimes and
 * normalized by the app, but the format is still evolving. Treat this as a
 * compatibility contract for current producers/consumers, not as a final
 * cross-agent standard.
 *
 * Before investing more here, look at how pi.dev standardizes their agent
 * protocol — we may want to align with or build on that approach instead of
 * rolling our own envelope format.
 *
 * Types are kept here for reference but are frozen. Do not add new consumers.
 */

import { createId, isCuid } from '@paralleldrive/cuid2';
import * as z from 'zod';

export const sessionRoleSchema = z.enum(['user', 'agent']);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

export const sessionTextEventSchema = z.object({
  t: z.literal('text'),
  text: z.string(),
  thinking: z.boolean().optional(),
});

export const sessionUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative(),
    context_window: z.number().int().positive().optional(),
    service_tier: z.string().optional(),
  })
  .passthrough();
export type SessionUsage = z.infer<typeof sessionUsageSchema>;

export const sessionServiceMessageEventSchema = z.object({
  t: z.literal('service'),
  text: z.string(),
});

export const sessionToolCallStartEventSchema = z.object({
  t: z.literal('tool-call-start'),
  call: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  args: z.record(z.string(), z.unknown()),
});

export const sessionToolCallEndEventSchema = z.object({
  t: z.literal('tool-call-end'),
  call: z.string(),
  /**
   * The tool's output, as text.
   *
   * Optional, and its absence is meaningful: a tool that ran and produced
   * nothing omits this, while a tool that has not finished has no
   * `tool-call-end` at all. The app renders the missing case as "no output",
   * so a producer that has output must send it here or the user sees the tool
   * report silence — which is what happened for every Codex command until this
   * field was carried through (the app has read it for as long as it has parsed
   * envelopes; nothing ever wrote it, and this schema stripped it anyway).
   *
   * Kept as a string rather than a `{stdout, stderr}` pair because the wire
   * carries what the agent reported, and agents differ in whether they separate
   * the two. The app's `getTerminalToolResult` still understands a structured
   * object for producers that have one, so this is the narrow case, not a
   * constraint on the rest.
   *
   * Bounded by the producer, not here: socket.io caps a frame at 1 MB, so an
   * unbounded command output would break the sync channel rather than merely
   * being large.
   */
  result: z.string().optional(),
  /** True when the tool failed, so the app can style the result as an error. */
  isError: z.boolean().optional(),
});

export const sessionFileEventSchema = z.object({
  t: z.literal('file'),
  ref: z.string(),
  name: z.string(),
  size: z.number(),
  mimeType: z.string().optional(),
  image: z
    .object({
      width: z.number(),
      height: z.number(),
      thumbhash: z.string(),
    })
    .optional(),
});

export const sessionTurnStartEventSchema = z.object({
  t: z.literal('turn-start'),
});

export const sessionStartEventSchema = z.object({
  t: z.literal('start'),
  title: z.string().optional(),
  /**
   * The agent's own thread id — the handle `thread/read` and `thread/fork`
   * need. The envelope's `subagent` is a derived, storable id; this is the
   * provider's, and it is not recoverable from the derived one.
   */
  threadId: z.string().optional(),
  /**
   * The thread this agent was reported on: its parent, or the session's own
   * thread when it was spawned by the main agent.
   *
   * Carried because nesting is real — a subagent can spawn its own subagents
   * (measured four levels deep on this machine) — and nothing else in the
   * stream says who spawned whom. Without it the client can list the agents but
   * cannot draw the tree, so a nested run flattens.
   */
  parentThreadId: z.string().optional(),
});

export const sessionTurnEndStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
export type SessionTurnEndStatus = z.infer<typeof sessionTurnEndStatusSchema>;

export const sessionTurnEndEventSchema = z.object({
  t: z.literal('turn-end'),
  status: sessionTurnEndStatusSchema,
});

export const sessionStopEventSchema = z.object({
  t: z.literal('stop'),
});

export const sessionEventSchema = z.discriminatedUnion('t', [
  sessionTextEventSchema,
  sessionServiceMessageEventSchema,
  sessionToolCallStartEventSchema,
  sessionToolCallEndEventSchema,
  sessionFileEventSchema,
  sessionTurnStartEventSchema,
  sessionStartEventSchema,
  sessionTurnEndEventSchema,
  sessionStopEventSchema,
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionEnvelopeSchema = z
  .object({
    id: z.string(),
    time: z.number(),
    role: sessionRoleSchema,
    turn: z.string().optional(),
    subagent: z
      .string()
      .refine((value) => isCuid(value), {
        message: 'subagent must be a cuid2 value',
      })
      .optional(),
    // Underlying agent-protocol message id (e.g. Claude's `uuid` in the
    // session JSONL). Set on text-bearing envelopes so the app can let
    // users pick a precise rewind point for session fork / duplicate.
    claudeUuid: z.string().min(1).optional(),
    // Codex app-server item id for this envelope. Used as the precise
    // rollback point for Codex thread duplicate/fork-from-message.
    codexItemId: z.string().min(1).optional(),
    // Optional model usage carried by the source agent message. Consumers use
    // this to update session context meters without rendering a separate row.
    usage: sessionUsageSchema.optional(),
    ev: sessionEventSchema,
  })
  .superRefine((envelope, ctx) => {
    if (envelope.ev.t === 'service' && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'service events must use role "agent"',
        path: ['role'],
      });
    }
    if ((envelope.ev.t === 'start' || envelope.ev.t === 'stop') && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${envelope.ev.t} events must use role "agent"`,
        path: ['role'],
      });
    }
  });

export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

export type CreateEnvelopeOptions = {
  id?: string;
  time?: number;
  turn?: string;
  subagent?: string;
  claudeUuid?: string;
  codexItemId?: string;
  usage?: SessionUsage;
};

export function createEnvelope(role: SessionRole, ev: SessionEvent, opts: CreateEnvelopeOptions = {}): SessionEnvelope {
  return sessionEnvelopeSchema.parse({
    id: opts.id ?? createId(),
    time: opts.time ?? Date.now(),
    role,
    ...(opts.turn ? { turn: opts.turn } : {}),
    ...(opts.subagent ? { subagent: opts.subagent } : {}),
    ...(opts.claudeUuid ? { claudeUuid: opts.claudeUuid } : {}),
    ...(opts.codexItemId ? { codexItemId: opts.codexItemId } : {}),
    ...(opts.usage ? { usage: opts.usage } : {}),
    ev,
  });
}
