import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Routing tests for `sendMessageToSession`.
 *
 * This tool decides which window a spoken instruction lands in, and it failed
 * in a way no validation could catch: the model passed a *valid* session id —
 * one belonging to the session it had been introduced to earlier in the call —
 * so the message was delivered, just to the wrong agent. The fix was to stop
 * asking the model to remember an id for the common case at all, which is what
 * the "omitted" cases below pin down.
 */

const mocks = {
    state: {
        sessions: {} as Record<string, any>,
    },
    focused: null as string | null,
    sent: [] as Array<{ sessionId: string; message: string }>,
    contexts: [] as string[],
};

vi.mock('@/sync/storage', () => ({
    storage: { getState: () => mocks.state },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: async (sessionId: string, message: string) => {
            mocks.sent.push({ sessionId, message });
        },
    },
}));

vi.mock('@/sync/ops', () => ({ sessionAllow: vi.fn(), sessionDeny: vi.fn() }));
vi.mock('@/track', () => ({ trackVoicePermissionResponse: vi.fn() }));
vi.mock('@/sync/persistence', () => ({
    getVoiceMessageCount: () => 1,
    incrementVoiceMessageCount: vi.fn(),
}));
vi.mock('./RealtimeSession', () => ({
    getCurrentRealtimeSessionId: () => mocks.focused,
    isVoiceSessionStarted: () => true,
    getVoiceSession: () => ({
        sendContextualUpdate: (update: string) => { mocks.contexts.push(update); },
    }),
}));

const { realtimeClientTools } = await import('./realtimeClientTools');

const CURRENT = 'session-current';
const OTHER = 'session-other';

function addSession(id: string, summary: string) {
    mocks.state.sessions[id] = { id, metadata: { summary: { text: summary } } };
}

beforeEach(() => {
    mocks.state.sessions = {};
    mocks.focused = CURRENT;
    mocks.sent.length = 0;
    mocks.contexts.length = 0;
    addSession(CURRENT, '测试会话');
    addSession(OTHER, 'FPGA 资源统计');
});

describe('sendMessageToSession', () => {
    it('sends to the current session when no id is given', async () => {
        const result = await realtimeClientTools.sendMessageToSession({
            message: '重启一下服务',
        });

        expect(mocks.sent).toEqual([{ sessionId: CURRENT, message: '重启一下服务' }]);
        // The destination is named back to the model, so a misdelivery is at
        // least visible to it.
        expect(result).toContain('测试会话');
    });

    it('follows a session switch without the model having to remember anything', async () => {
        // The user moves to another session mid-call; the next unnamed message
        // goes there because the client — not the model — holds that fact.
        mocks.focused = OTHER;

        await realtimeClientTools.sendMessageToSession({ message: '继续' });

        expect(mocks.sent[0].sessionId).toBe(OTHER);
    });

    it('honours an explicitly named session', async () => {
        await realtimeClientTools.sendMessageToSession({
            sessionId: OTHER,
            message: '把结果贴过来',
        });

        expect(mocks.sent[0].sessionId).toBe(OTHER);
    });

    it('repairs an invented id by using the current session', async () => {
        const result = await realtimeClientTools.sendMessageToSession({
            sessionId: 'does-not-exist',
            message: '跑一下测试',
        });

        expect(mocks.sent[0].sessionId).toBe(CURRENT);
        // The model is not told it succeeded silently; it is told where it went.
        expect(result).toContain('测试会话');
    });

    it('refuses rather than guesses when nothing is named and nothing is focused', async () => {
        mocks.focused = null;

        const result = await realtimeClientTools.sendMessageToSession({ message: '喂' });

        expect(mocks.sent).toHaveLength(0);
        expect(result).toContain('error');
    });

    it('refuses when the named session is unknown and there is no current session', async () => {
        mocks.focused = null;

        const result = await realtimeClientTools.sendMessageToSession({
            sessionId: 'nope',
            message: '喂',
        });

        expect(mocks.sent).toHaveLength(0);
        expect(result).toContain('error');
    });

    it('falls back when the current session has gone away', async () => {
        // A stale focus — the session was archived or deleted while the call ran.
        mocks.focused = 'deleted-session';

        const result = await realtimeClientTools.sendMessageToSession({
            sessionId: OTHER,
            message: '还在吗',
        });

        // An explicitly named, still-valid session is still honoured.
        expect(mocks.sent[0].sessionId).toBe(OTHER);
        expect(result).not.toContain('error');
    });

    it('rejects a call with no message', async () => {
        const result = await realtimeClientTools.sendMessageToSession({ sessionId: CURRENT });

        expect(mocks.sent).toHaveLength(0);
        expect(result).toContain('error');
    });
});
