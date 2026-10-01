import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import { normalizeRawMessage } from '@/sync/typesRaw';

/**
 * One Stop, one announcement.
 *
 * This is the path the bug actually took, end to end: the CLI's session
 * envelopes, normalized and reduced the way the app receives them, and then
 * the voice layer's announcement.
 *
 * A live desktop session showed what went wrong when the user stopped a
 * running turn with the voice assistant connected: three identical replies.
 * The wire produced three completion signals for what the user experienced as
 * one action —
 *
 *   1. a `turn-end` for the turn that happened to finish as the interrupt
 *      landed,
 *   2. a `turn-end` for the follow-up turn the interrupt aborted,
 *   3. the CLI's session-level `ready` event ("gone idle again"), which is
 *      emitted after every turn and names no turn of its own.
 *
 * Each of the first two is a real turn ending, and only the second is the
 * user's Stop; the third is not a turn at all. So the expected result is one
 * announcement, for the turn that actually finished.
 */

const mocks = {
    state: {
        sessions: {} as Record<string, any>,
        sessionMessages: {} as Record<string, any>,
        settings: { voiceContextMode: 'lite' as 'minimal' | 'lite' | 'full' },
        realtimeMode: 'idle' as string,
        getActiveSessions: () => [] as any[],
    },
    prompts: [] as string[],
    focusedSessionId: null as string | null,
};

vi.mock('@/sync/storage', () => ({
    storage: { getState: () => mocks.state, subscribe: () => () => {} },
}));
vi.mock('../RealtimeSession', () => ({
    getCurrentRealtimeSessionId: () => mocks.focusedSessionId,
    setCurrentRealtimeSessionId: (id: string) => { mocks.focusedSessionId = id; },
    isVoiceSessionStarted: () => true,
    getVoiceSession: () => ({
        sendContextualUpdate: () => {},
        sendTextMessage: (message: string) => { mocks.prompts.push(message); },
    }),
}));

const { voiceHooks } = await import('./voiceHooks');

const SESSION = 'session-a';
const FOCUSED = 'session-focused';

/** A session envelope as the CLI's mapper emits it. */
function envelope(id: string, ev: Record<string, unknown>, turn?: string) {
    return {
        id,
        time: 1000 + Number(id.replace(/\D/g, '') || 0),
        role: 'agent' as const,
        ...(turn ? { turn } : {}),
        ev,
    };
}

/** Push envelopes through the app the way `applyMessages` does, and return what
 *  the voice layer would be told about them. */
function applyToVoice(envelopes: Array<Record<string, unknown>>): void {
    const state = createReducer();
    const readyTurns = [];
    for (const raw of envelopes) {
        const normalized = normalizeRawMessage(
            String(raw.id),
            null,
            1000,
            { role: 'session', content: { type: 'session', data: raw } } as any,
        );
        if (!normalized) continue;
        const result = reducer(state, [normalized]);
        readyTurns.push(...(result.readyTurns ?? []));
    }
    for (const turn of readyTurns) {
        voiceHooks.onReady(SESSION, turn);
    }
}

beforeEach(() => {
    voiceHooks.onVoiceStopped();
    mocks.prompts.length = 0;
    mocks.state.sessions = {
        [FOCUSED]: { id: FOCUSED, metadata: { summary: { text: 'the watched session' }, path: '/tmp' } },
        [SESSION]: { id: SESSION, metadata: { summary: { text: 'the working session' }, path: '/tmp' } },
    };
    mocks.state.sessionMessages = {};
    mocks.state.settings.voiceContextMode = 'lite';
    mocks.state.realtimeMode = 'idle';
    mocks.focusedSessionId = FOCUSED;
    voiceHooks.onVoiceStarted(FOCUSED);
    mocks.prompts.length = 0;
});

describe('one Stop, one announcement', () => {
    it('announces only the turn that actually finished', () => {
        applyToVoice([
            // The turn that happened to finish as the interrupt landed.
            envelope('turn-end-1', { t: 'turn-end', status: 'completed' }, 'turn-1'),
            // The follow-up turn, aborted by the same Stop.
            envelope('turn-end-2', { t: 'turn-end', status: 'cancelled' }, 'turn-2'),
            // The CLI's "gone idle again", which is not a turn.
            { id: 'ready-1', time: 2000, role: 'agent', ev: { t: 'ready' } } as any,
        ]);

        expect(mocks.prompts).toHaveLength(1);
        expect(mocks.prompts[0]).toContain(SESSION);
    });

    it('announces an ordinary turn once, not twice', () => {
        // The same doubling, without any Stop involved: every turn ends with a
        // `turn-end` and then the CLI's idle event.
        applyToVoice([
            envelope('turn-end-1', { t: 'turn-end', status: 'completed' }, 'turn-1'),
            { id: 'ready-1', time: 2000, role: 'agent', ev: { t: 'ready' } } as any,
        ]);

        expect(mocks.prompts).toHaveLength(1);
    });

    it('still announces the next turn after a stop', () => {
        applyToVoice([
            envelope('turn-end-1', { t: 'turn-end', status: 'cancelled' }, 'turn-1'),
            { id: 'ready-1', time: 2000, role: 'agent', ev: { t: 'ready' } } as any,
        ]);
        expect(mocks.prompts).toHaveLength(0);

        applyToVoice([
            envelope('turn-end-2', { t: 'turn-end', status: 'completed' }, 'turn-2'),
            { id: 'ready-2', time: 3000, role: 'agent', ev: { t: 'ready' } } as any,
        ]);
        expect(mocks.prompts).toHaveLength(1);
    });
});
