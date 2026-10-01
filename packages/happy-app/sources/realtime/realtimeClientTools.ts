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
            sessionId: z.string().min(1),
            message: z.string().min(1)
        });
        const parsed = schema.safeParse(parameters);

        if (!parsed.success) {
            console.error('❌ Invalid parameters:', parsed.error);
            return "error (invalid parameters)";
        }

        const { message } = parsed.data;
        let { sessionId } = parsed.data;

        // A session id that is not one of ours means the model invented it or
        // is working from a stale picture of the session list. Falling back to
        // the focused session is the right repair: the user's instruction was
        // meant for the session they are looking at. The alternative — refusing
        // — loses the instruction, and the previous behaviour of sending to
        // whatever id came back is how a message ended up in the wrong window.
        if (!storage.getState().sessions[sessionId]) {
            const focused = getCurrentRealtimeSessionId();
            console.warn(
                '📤 sendMessageToSession: unknown session',
                sessionId,
                focused ? `→ falling back to focused ${focused}` : '→ no focused session',
            );
            if (!focused || !storage.getState().sessions[focused]) {
                return "error (that session is not available; ask the user which session to use)";
            }
            sessionId = focused;
        }

        console.log('📤 Sending message to session:', sessionId);
        await sync.sendMessage(sessionId, message, { source: 'voice' });
        incrementVoiceMessageCount();
        const voiceMessageCount = getVoiceMessageCount();
        if (isVoiceSessionStarted()) {
            getVoiceSession()?.sendContextualUpdate([
                '# Runtime counters updated',
                `- voice_message_count: ${voiceMessageCount}`,
            ].join('\n'));
        }
        return "sent [DO NOT say anything else, simply say 'sent']";
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
