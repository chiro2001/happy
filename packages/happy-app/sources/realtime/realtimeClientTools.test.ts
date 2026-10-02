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
        sessionMessages: {} as Record<string, any>,
        settings: { voiceContextMode: 'full' as 'minimal' | 'lite' | 'full' },
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
    mocks.state.sessionMessages = {};
    mocks.state.settings = { voiceContextMode: 'full' };
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

/**
 * The read tools exist so the pushed transcript can be optional: everything
 * pushed into a realtime session stays there and is re-billed on every later
 * turn, while something read on request is paid once. These hold the two
 * properties that make that trade safe — the assistant gets the newest
 * material, and it is told when there is more.
 */
describe('getSessionHistory', () => {
    function agentText(id: string, at: number, text: string) {
        return { kind: 'agent-text', id, localId: null, createdAt: at, text };
    }
    function userText(id: string, at: number, text: string) {
        return { kind: 'user-text', id, localId: null, createdAt: at, text };
    }

    function load(messages: any[], hasMoreOlder = false) {
        mocks.state.sessionMessages[CURRENT] = { messages, hasMoreOlder };
    }

    beforeEach(() => {
        addSession(CURRENT, 'Refactor the parser');
        load([
            agentText('m1', 1, 'first step'),
            userText('m2', 2, 'carry on'),
            agentText('m3', 3, 'second step'),
        ]);
    });

    it('reads the newest messages by default', async () => {
        const result = await realtimeClientTools.getSessionHistory({ count: 1 });

        expect(result).toContain('second step');
        expect(result).not.toContain('first step');
    });

    it('says how much older history is left, and how to reach it', async () => {
        // The assistant cannot ask for what it does not know exists.
        const result = await realtimeClientTools.getSessionHistory({ count: 1 });

        expect(result).toContain('2 older available');
        expect(result).toContain('before=3');
    });

    it('pages backwards through the window', async () => {
        const result = await realtimeClientTools.getSessionHistory({ count: 2, before: 3 });

        expect(result).toContain('first step');
        expect(result).toContain('carry on');
        expect(result).not.toContain('second step');
    });

    it('can skip the user\u2019s own messages', async () => {
        const result = await realtimeClientTools.getSessionHistory({ agentOnly: true });

        expect(result).toContain('first step');
        expect(result).not.toContain('carry on');
    });

    it('falls back to the current session when none is named', async () => {
        const result = await realtimeClientTools.getSessionHistory({});

        expect(result).toContain(CURRENT);
    });

    it('says so when the session has produced nothing yet', async () => {
        load([]);
        const result = await realtimeClientTools.getSessionHistory({});

        expect(result).toContain('no messages match');
    });

    it('admits that older history exists on the machine but is not loaded', async () => {
        // A client keeps a window, not the whole conversation. Without this the
        // assistant concludes the session began where the window does.
        load([agentText('m1', 1, 'only what is loaded')], true);
        const result = await realtimeClientTools.getSessionHistory({});

        expect(result).toContain('Older history exists');
    });

    it('rejects nonsense parameters instead of guessing', async () => {
        const result = await realtimeClientTools.getSessionHistory({ count: -5 });
        expect(result).toContain('error');
    });
});

describe('listSessions', () => {
    it('lists every running session and marks the current one', async () => {
        addSession(CURRENT, 'the one on screen');
        addSession(OTHER, 'the other one');

        const result = await realtimeClientTools.listSessions();

        expect(result).toContain('the one on screen');
        expect(result).toContain('the other one');
        expect(result).toContain(CURRENT);
        expect(result).toContain('(current)');
    });

    it('handles having no sessions at all', async () => {
        mocks.state.sessions = {};
        const result = await realtimeClientTools.listSessions();
        expect(result).toContain('No sessions');
    });
});
