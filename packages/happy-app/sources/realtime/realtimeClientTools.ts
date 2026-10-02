import { z } from 'zod';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { trackVoicePermissionResponse } from '@/track';
import { messageSortKey, type Message } from '@/sync/typesMessage';
import { formatMessage, resolveAgentName } from './hooks/contextFormatters';
import { getVoiceConfig } from './voiceConfig';
import {
    getCurrentRealtimeSessionId,
    getVoiceSession,
    isVoiceSessionStarted,
} from './RealtimeSession';
import {
    getVoiceMessageCount,
    incrementVoiceMessageCount,
} from '@/sync/persistence';

/**
 * Resolve a session the assistant named, or the one the user is looking at.
 *
 * Shared by the read tools so they behave like `sendMessageToSession` does:
 * an omitted id means "the current session", because that is the common case
 * and asking the model to recall an opaque id for it is a memory test it has
 * already failed once — by passing a *valid* id from an earlier session.
 * Returns null when neither is available, so the caller can say so.
 */
function resolveReadTarget(sessionId: string | undefined): { id: string; sessions: ReturnType<typeof storage.getState>['sessions'] } | null {
    const sessions = storage.getState().sessions;
    if (sessionId) {
        if (sessions[sessionId]) return { id: sessionId, sessions };
        // A named session that is not ours: fall back rather than fail, but
        // only when the fallback is unambiguous.
        const focused = getCurrentRealtimeSessionId();
        return focused && sessions[focused] ? { id: focused, sessions } : null;
    }
    const focused = getCurrentRealtimeSessionId();
    return focused && sessions[focused] ? { id: focused, sessions } : null;
}

/**
 * The newest messages of a session, as text, for a read tool.
 *
 * Separate from the push path's formatter because the two want opposite
 * things. A push is unsolicited and pays rent for the rest of the session, so
 * it is clipped hard. A read is asked for, answers one question, and is worth
 * more per item — the assistant went looking because it needed detail. So the
 * budget here is larger and spent per item rather than on a batch.
 *
 * Returned newest-last (the order they happened) and oldest-first within the
 * window, because that is how a transcript reads.
 */
function readSessionWindow(
    sessionId: string,
    messages: Message[],
    options: { count: number; before?: number; agentOnly?: boolean },
): string {
    const cap = getVoiceConfig(storage.getState().settings.voiceContextMode).MAX_MESSAGE_CHARS;
    const agentName = resolveAgentName(storage.getState().sessions[sessionId]?.metadata?.flavor);
    const config = { ...getVoiceConfig(storage.getState().settings.voiceContextMode), MAX_MESSAGE_CHARS: cap };

    const ordered = [...messages].sort((a, b) => messageSortKey(a) - messageSortKey(b));
    const window = options.before !== undefined
        ? ordered.filter((m) => messageSortKey(m) < options.before!)
        : ordered;
    const eligible = options.agentOnly
        ? window.filter((m) => m.kind === 'agent-text' || m.kind === 'tool-call')
        : window;

    const selected = eligible.slice(-options.count);
    if (selected.length === 0) {
        return '(no messages match)';
    }

    const lines = selected
        .map((m) => formatMessage(m, config, agentName))
        .filter((text): text is string => Boolean(text));

    // How much more there is, and how to get it. The assistant cannot ask a
    // follow-up question about history it does not know exists.
    const older = eligible.length - selected.length;
    const oldest = messageSortKey(selected[0]);
    const header = older > 0
        ? `${selected.length} message(s) shown, ${older} older available (pass before=${oldest} to read them)`
        : `${selected.length} message(s), the whole history`;

    return `${header}\n\n${lines.join('\n\n')}`;
}

/**
 * Static client tools for the realtime voice interface.
 * These tools allow the voice assistant to interact with Claude Code sessions.
 */
export const realtimeClientTools = {
    /**
     * Read a session's transcript, on demand.
     *
     * The counterpart to the pushed transcript, and the reason the tiers can
     * afford to push less. Everything pushed into a realtime session stays
     * there and is re-billed on every later turn — the model has no cache and
     * the protocol has no way to delete — so a message body pushed "just in
     * case" is rent paid for the rest of the call. A body read on request is
     * paid once, by a question that needed it.
     *
     * Measured on a live desktop session: three voice turns billed 61,935
     * input tokens, most of it pushed context that the user never asked to
     * hear. The same information reachable through this tool costs nothing
     * until someone asks.
     */
    getSessionHistory: async (parameters: unknown) => {
        const schema = z.object({
            sessionId: z.string().min(1).optional(),
            count: z.number().int().min(1).max(50).optional(),
            /** Only the agent's own output, skipping what the user sent. */
            agentOnly: z.boolean().optional(),
            /** Read older than this (a `before` value from a previous call). */
            before: z.number().optional(),
        });
        const parsed = schema.safeParse(parameters);
        if (!parsed.success) {
            console.error('❌ Invalid parameters for getSessionHistory:', parsed.error);
            return 'error (invalid parameters)';
        }

        const target = resolveReadTarget(parsed.data.sessionId);
        if (!target) {
            return 'error (no session to read; ask the user which one)';
        }

        const stored = storage.getState().sessionMessages[target.id];
        const messages = stored?.messages ?? [];
        console.log(
            '📖 getSessionHistory:',
            target.id,
            `count=${parsed.data.count ?? 10}`,
            parsed.data.agentOnly ? 'agent-only' : '',
            `· ${messages.length} loaded`,
        );

        const body = readSessionWindow(target.id, messages, {
            count: parsed.data.count ?? 10,
            ...(parsed.data.before !== undefined ? { before: parsed.data.before } : {}),
            ...(parsed.data.agentOnly ? { agentOnly: true } : {}),
        });

        const summary = target.sessions[target.id]?.metadata?.summary?.text?.trim();
        const header = summary ? `Session ${target.id} ("${summary}"):` : `Session ${target.id}:`;
        // Older pages are not in memory: a client keeps a window, not the whole
        // conversation. Saying so beats letting the assistant conclude the
        // session began where the window does.
        const tail = stored?.hasMoreOlder
            ? '\n(Older history exists on the machine but is not loaded here. Ask the agent to summarise if you need it.)'
            : '';
        return `${header}\n\n${body}${tail}`;
    },

    /**
     * List the sessions this machine is running.
     *
     * The pull-side equivalent of the session directory that the opening brief
     * used to carry. That directory is small, but it is the wrong shape for the
     * tiers that carry no transcript: it costs rent for the whole call to
     * answer a question — "which sessions are there?" — that is usually not
     * asked at all.
     */
    listSessions: async () => {
        const sessions = Object.values(storage.getState().sessions);
        if (sessions.length === 0) {
            return 'No sessions.';
        }
        const focused = getCurrentRealtimeSessionId();
        const lines = sessions.map((session) => {
            const summary = session?.metadata?.summary?.text?.trim() || 'No summary';
            const here = session.id === focused ? ' (current)' : '';
            return `- ${session.id}: "${summary}"${here}`;
        });
        console.log('📖 listSessions:', sessions.length);
        return 'Sessions:\n' + lines.join('\n');
    },

    /**
     * Send a message to a specific Claude Code session
     */
    sendMessageToSession: async (parameters: unknown) => {
        const schema = z.object({
            // Optional on purpose. The common case is "send this to the session
            // I am looking at", and that is a fact the client already has.
            // Requiring the model to recall and reproduce an opaque id for it
            // put a memory test in the middle of the most frequent path — and
            // when it lost that test it passed a *valid* id belonging to an
            // earlier session, which no validation can catch, and the message
            // was delivered to the wrong window.
            sessionId: z.string().min(1).optional(),
            message: z.string().min(1)
        });
        const parsed = schema.safeParse(parameters);

        if (!parsed.success) {
            console.error('❌ Invalid parameters:', parsed.error);
            return "error (invalid parameters)";
        }

        const { message } = parsed.data;
        const sessions = storage.getState().sessions;
        const focused = getCurrentRealtimeSessionId();
        const focusedIsUsable = Boolean(focused && sessions[focused]);

        // Where it goes, and why. Logged unconditionally: this path decides
        // whether an instruction reaches the window the user meant, and the
        // tier that had the most trouble here is also the one that turns
        // general logging off — which is exactly when it needs to be visible.
        let target = parsed.data.sessionId;
        let reason = 'named by the assistant';

        if (!target) {
            if (!focusedIsUsable) {
                console.warn('📤 sendMessageToSession: nothing named and no current session');
                return "error (no current session; ask the user which session to use)";
            }
            target = focused!;
            reason = 'current session (none named)';
        } else if (!sessions[target]) {
            // Not one of ours: invented, or carried over from a stale picture.
            // The instruction was still meant for the session the user is
            // looking at, so send it there rather than lose it.
            if (!focusedIsUsable) {
                console.warn('📤 sendMessageToSession: unknown id and no current session:', target);
                return "error (that session is not available; ask the user which session to use)";
            }
            reason = `unknown id ${target} → current session`;
            target = focused!;
        } else if (target !== focused) {
            // Legitimate — the user may have named another session — but it is
            // also exactly what a stale id looks like, so leave a line that
            // tells the two apart after the fact.
            reason = `targeted explicitly (current session is ${focused ?? 'none'})`;
        }

        const summary = sessions[target]?.metadata?.summary?.text?.trim();
        console.log(
            '📤 sendMessageToSession:',
            target,
            summary ? `("${summary}")` : '',
            `· ${reason}`,
        );

        await sync.sendMessage(target, message, { source: 'voice' });
        incrementVoiceMessageCount();
        const voiceMessageCount = getVoiceMessageCount();
        if (isVoiceSessionStarted()) {
            getVoiceSession()?.sendContextualUpdate([
                '# Runtime counters updated',
                `- voice_message_count: ${voiceMessageCount}`,
            ].join('\n'));
        }
        // Naming the destination costs a couple of tokens and gives the model
        // the one piece of evidence it would need to notice a misdelivery.
        const where = summary ? `"${summary}"` : target;
        return `sent to ${where} [DO NOT say anything else, simply say 'sent']`;
    },

    /**
     * Respond to a permission request from a Claude Code session
     */
    processPermissionRequest: async (parameters: unknown) => {
        const schema = z.object({
            requestId: z.string().min(1),
            decision: z.enum(['allow', 'deny'])
        });
        const parsed = schema.safeParse(parameters);

        if (!parsed.success) {
            console.error('❌ Invalid parameters:', parsed.error);
            return "error (invalid parameters)";
        }

        const { requestId, decision } = parsed.data;

        // Find which session owns this request
        const sessions = storage.getState().sessions;
        let sessionId: string | null = null;
        for (const [id, session] of Object.entries(sessions)) {
            if (session?.agentState?.requests?.[requestId]) {
                sessionId = id;
                break;
            }
        }

        if (!sessionId) {
            console.error('❌ No session found with request:', requestId);
            return "error (permission request not found)";
        }

        console.log('🔍 processPermissionRequest:', decision, 'for session:', sessionId, 'request:', requestId);

        try {
            if (decision === 'allow') {
                await sessionAllow(sessionId, requestId);
                trackVoicePermissionResponse(true);
            } else {
                await sessionDeny(sessionId, requestId);
                trackVoicePermissionResponse(false);
            }
            return "done [DO NOT say anything else, simply say 'done']";
        } catch (error) {
            console.error('❌ Failed to process permission:', error);
            return `error (failed to ${decision} permission)`;
        }
    }
};
