import { z } from 'zod';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { trackVoicePermissionResponse } from '@/track';
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
 * Static client tools for the realtime voice interface.
 * These tools allow the voice assistant to interact with Claude Code sessions.
 */
export const realtimeClientTools = {
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
