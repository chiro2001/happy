import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/sync/typesMessage';

/**
 * These exercise the real hooks — the module-level tier state, the background
 * detection, and the reduced-context bookkeeping — rather than the pure rules
 * they delegate to. The gap that matters is the one between "the tier says
 * background sessions are announced, not transcribed" and "the user then moves
 * to that session", which only shows up when both are run in sequence.
 */

const mocks = {
    state: {
        sessions: {} as Record<string, any>,
        sessionMessages: {} as Record<string, any>,
        settings: { voiceContextMode: 'full' as 'minimal' | 'lite' | 'full' },
        realtimeMode: 'idle' as string,
        getActiveSessions: () => Object.values({}) as any[],
    },
    focusedSessionId: null as string | null,
    context: [] as string[],
    prompts: [] as string[],
};

vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => mocks.state,
        subscribe: () => () => {},
    },
}));

vi.mock('../RealtimeSession', () => ({
    getCurrentRealtimeSessionId: () => mocks.focusedSessionId,
    setCurrentRealtimeSessionId: (id: string) => { mocks.focusedSessionId = id; },
    isVoiceSessionStarted: () => true,
    getVoiceSession: () => ({
        sendContextualUpdate: (update: string) => { mocks.context.push(update); },
        sendTextMessage: (message: string) => { mocks.prompts.push(message); },
    }),
}));

const { voiceHooks } = await import('./voiceHooks');

const A = 'session-a';
const B = 'session-b';

function message(id: string, text: string): Message {
    return { id, kind: 'agent-text', createdAt: Number(id), text } as Message;
}

function addSession(id: string, summary: string, messages: Message[]) {
    mocks.state.sessions[id] = {
        id,
        metadata: { summary: { text: summary }, path: '/home/chiro/project' },
    };
    mocks.state.sessionMessages[id] = { messages };
}

function setTier(mode: 'minimal' | 'lite' | 'full') {
    mocks.state.settings.voiceContextMode = mode;
}

beforeEach(() => {
    voiceHooks.onVoiceStopped();
    mocks.context.length = 0;
    mocks.prompts.length = 0;
    mocks.focusedSessionId = null;
    mocks.state.sessions = {};
    mocks.state.sessionMessages = {};
    mocks.state.getActiveSessions = () => Object.values(mocks.state.sessions);
    mocks.state.realtimeMode = 'idle';
    mocks.state.settings.voiceContextMode = 'full';
    addSession(A, 'Refactor the parser', [message('1', 'A step one'), message('2', 'A step two')]);
    addSession(B, 'Fix the build', [message('3', 'B step one'), message('4', 'B step two')]);
});

describe('voiceHooks context tiers', () => {
    describe('lite', () => {
        beforeEach(() => {
            setTier('lite');
            mocks.focusedSessionId = A;
        });

        it('gives the focused session its transcript on start', () => {
            const prompt = voiceHooks.onVoiceStarted(A);
            expect(prompt).toContain('Available sessions');
            expect(prompt).toContain('A step one');
        });

        it('does not inject a background session\u2019s message bodies', () => {
            voiceHooks.onVoiceStarted(A);
            mocks.context.length = 0;
            voiceHooks.onMessages(B, [message('9', 'B produced a huge diff')]);
            expect(mocks.context.join('\n')).not.toContain('B produced a huge diff');
        });

        it('announces a finished background turn in one line', () => {
            voiceHooks.onVoiceStarted(A);
            voiceHooks.onReady(B);
            const prompt = mocks.prompts.join('\n');
            expect(prompt).toContain(B);
            expect(prompt).toContain('finished');
            // The notice must not drag the transcript in with it.
            expect(prompt).not.toContain('B step one');
        });

        it('silences the per-message stream for a background session', () => {
            voiceHooks.onVoiceStarted(A);
            voiceHooks.onMessages(B, [message('9', 'partial output')]);
            // Nothing is announced until the turn's ready event.
            expect(mocks.prompts).toHaveLength(0);
        });

        /**
         * `applyMessages` reports every message its reducer produced, including
         * ones that merely grew or were re-delivered by a later socket update.
         * Injecting the same text again does not overwrite it — the server
         * appends — so both copies are re-billed on every later turn.
         *
         * A live desktop session showed the same `CodexBash` call injected
         * twice inside one second, and context grew 3.3k → 40k tokens in about
         * ninety seconds.
         */
        it('does not inject the same message text twice', () => {
            voiceHooks.onVoiceStarted(A);
            mocks.context.length = 0;

            const msg = message('42', 'Codex is using CodexBash');
            voiceHooks.onMessages(A, [msg]);
            voiceHooks.onMessages(A, [msg]);

            const injections = mocks.context.filter((c) => c.includes('session-a'));
            expect(injections).toHaveLength(1);
        });

        it('injects again when the message actually changed', () => {
            voiceHooks.onVoiceStarted(A);
            mocks.context.length = 0;

            voiceHooks.onMessages(A, [message('43', 'first half')]);
            voiceHooks.onMessages(A, [message('43', 'first half and second half')]);

            const injections = mocks.context.filter((c) => c.includes('session-a'));
            expect(injections).toHaveLength(2);
        });

        it('forgets what it injected when the voice session restarts', () => {
            voiceHooks.onVoiceStarted(A);
            voiceHooks.onMessages(A, [message('44', 'same text')]);
            voiceHooks.onVoiceStopped();

            // A new session must not inherit the old one's dedup state, or a
            // message replayed into it would be dropped as a duplicate.
            voiceHooks.onVoiceStarted(A);
            mocks.context.length = 0;
            voiceHooks.onMessages(A, [message('44', 'same text')]);

            expect(mocks.context.filter((c) => c.includes('session-a'))).toHaveLength(1);
        });

        it('clips a long tool description to the tier budget', () => {
            voiceHooks.onVoiceStarted(A);
            mocks.context.length = 0;
            const huge = 'x'.repeat(50_000);

            voiceHooks.onMessages(A, [{
                id: '45',
                kind: 'tool-call',
                createdAt: 45,
                tool: { name: 'CodexBash', description: huge, input: {} },
            } as unknown as Message]);

            const sent = mocks.context.join('\n');
            expect(sent).toContain('truncated');
            // lite's cap is 700; allow for the surrounding framing.
            expect(sent.length).toBeLessThan(2000);
        });

        it('upgrades a previously background session once the user moves to it', () => {
            voiceHooks.onVoiceStarted(A);
            voiceHooks.onReady(B);
            expect(mocks.context.join('\n')).not.toContain('B step one');

            mocks.context.length = 0;
            voiceHooks.onSessionFocus(B);
            expect(mocks.context.join('\n')).toContain('B step one');
        });

        it('tells the assistant which session is current when focus moves', () => {
            voiceHooks.onVoiceStarted(A);
            mocks.context.length = 0;

            voiceHooks.onSessionFocus(B);

            const sent = mocks.context.join('\n');
            // The fact the model needs: B is where messages go now. The old
            // wording only announced the event, which left it guessing — and it
            // guessed the session from the start of the call, so a real
            // instruction was delivered to the wrong window.
            expect(sent).toContain('Current session: session-b');
            expect(sent).toContain('Send messages here');
            expect(sent).not.toContain('Current session: session-a');
        });

        it('names the current session in the opening brief', () => {
            const prompt = voiceHooks.onVoiceStarted(A);
            expect(prompt).toContain('Current session: session-a');
        });

        it('routes by name even where the session list is withheld', () => {
            // minimal carries no session directory, so the current-session line
            // is the only thing in its context that names a session. Without it
            // the model has an id to message and no way to know it is the right
            // one, which is how a switch went unnoticed.
            setTier('minimal');
            mocks.focusedSessionId = A;
            const brief = voiceHooks.onVoiceStarted(A);
            expect(brief).not.toContain('Available sessions');
            expect(brief).toContain('Current session: session-a');

            mocks.context.length = 0;
            voiceHooks.onSessionFocus(B);
            expect(mocks.context.join('\n')).toContain('Current session: session-b');
        });

        it('does not repeat the transcript when focus returns to a full session', () => {
            voiceHooks.onVoiceStarted(A);
            mocks.context.length = 0;
            voiceHooks.onSessionFocus(B);
            mocks.context.length = 0;
            voiceHooks.onSessionFocus(B);
            expect(mocks.context.join('\n')).not.toContain('B step one');
        });

        it('still asks the user about a permission request from any session', () => {
            voiceHooks.onVoiceStarted(A);
            voiceHooks.onPermissionRequested(B, 'req-1', 'Bash', { command: 'rm -rf /' });
            const prompt = mocks.prompts.join('\n');
            expect(prompt).toContain('req-1');
            expect(prompt).toContain('Bash');
        });
    });

    describe('full', () => {
        beforeEach(() => {
            mocks.focusedSessionId = A;
        });

        it('injects background message bodies, as before', () => {
            voiceHooks.onVoiceStarted(A);
            mocks.context.length = 0;
            voiceHooks.onMessages(B, [message('9', 'B produced a huge diff')]);
            expect(mocks.context.join('\n')).toContain('B produced a huge diff');
        });

        it('announces a finished background turn with the usual wording', () => {
            voiceHooks.onVoiceStarted(A);
            voiceHooks.onReady(B);
            expect(mocks.prompts.join('\n')).toContain('Report this to the human immediately');
        });
    });

    describe('minimal', () => {
        beforeEach(() => {
            setTier('minimal');
            mocks.focusedSessionId = A;
        });

        it('drops the session directory from the opening prompt', () => {
            const prompt = voiceHooks.onVoiceStarted(A);
            expect(prompt).not.toContain('Available sessions');
        });

        it('keeps the skeleton but not the transcript for the focused session', () => {
            const prompt = voiceHooks.onVoiceStarted(A);
            expect(prompt).toContain(A);
            expect(prompt).toContain('Refactor the parser');
            expect(prompt).not.toContain('A step one');
        });
    });

    describe('announcing finished turns', () => {
        beforeEach(() => {
            setTier('lite');
            mocks.focusedSessionId = A;
            voiceHooks.onVoiceStarted(A);
            mocks.prompts.length = 0;
        });

        it('stays quiet when the user stops the turn themselves', () => {
            // A Stop is the user's own action. Announcing "done working" for it
            // is the assistant talking back about something the user just did.
            voiceHooks.onReady(A, { turnId: 'turn-1', status: 'cancelled' });
            expect(mocks.prompts).toEqual([]);
        });

        it('announces a finished turn once, however often it is reported', () => {
            // The CLI ends a turn twice on the wire — a `turn-end` envelope,
            // then a session-level `ready` meaning "gone idle" — and a stop can
            // add another turn-end for the turn it aborted. A live session heard
            // three identical replies from this; the turn id is what makes the
            // announcement idempotent.
            voiceHooks.onReady(A, { turnId: 'turn-1', status: 'completed' });
            expect(mocks.prompts).toHaveLength(1);

            // Same turn again: a re-delivery, not a second completion.
            voiceHooks.onReady(A, { turnId: 'turn-1', status: 'completed' });
            expect(mocks.prompts).toHaveLength(1);

            // The CLI's idle echo carries no turn id, and belongs to the turn
            // just announced.
            voiceHooks.onReady(A, {});
            expect(mocks.prompts).toHaveLength(1);
        });

        it('still announces the next turn', () => {
            voiceHooks.onReady(A, { turnId: 'turn-1', status: 'completed' });
            voiceHooks.onReady(A, {});
            voiceHooks.onReady(A, { turnId: 'turn-2', status: 'completed' });
            expect(mocks.prompts).toHaveLength(2);
        });

        it('announces an idle event from a producer that sends no turn ids', () => {
            // Older CLIs report completion only as the session-level event.
            // There it is not an echo of anything, and suppressing it would
            // leave the user with no notice at all.
            voiceHooks.onReady(A, {});
            expect(mocks.prompts).toHaveLength(1);
        });

        it('keeps a stopped turn from consuming the next turn\'s announcement', () => {
            voiceHooks.onReady(A, { turnId: 'turn-1', status: 'cancelled' });
            voiceHooks.onReady(A, { turnId: 'turn-2', status: 'completed' });
            voiceHooks.onReady(A, {});
            expect(mocks.prompts).toHaveLength(1);
        });
    });

    describe('reading on demand instead of pushing', () => {
        beforeEach(() => {
            setTier('minimal');
            mocks.focusedSessionId = A;
            voiceHooks.onVoiceStarted(A);
            mocks.context.length = 0;
            mocks.prompts.length = 0;
        });

        it('pushes no agent output at all in the read-on-demand tier', () => {
            // Everything pushed into a realtime session stays there and is
            // re-billed on every later turn, so this tier reads instead.
            voiceHooks.onMessages(A, [message('9', 'the agent produced this')]);
            expect(mocks.context.join('\n')).not.toContain('the agent produced this');
        });

        it('still announces that a turn finished', () => {
            // The one thing that must survive: without it the user gets no
            // signal at all that their agent stopped working.
            voiceHooks.onReady(A, { turnId: 't1', status: 'completed' });
            expect(mocks.prompts).toHaveLength(1);
        });

        it('tells the assistant to read the output rather than implying it has it', () => {
            // The pushed tiers end their notice with "the previous message(s)
            // are the summary of the work done". In a tier that pushed nothing
            // that sentence describes something the assistant cannot see, and
            // it will invent an answer rather than admit that.
            voiceHooks.onReady(A, { turnId: 't1', status: 'completed' });
            const notice = mocks.prompts.join('\n');

            expect(notice).toContain('getSessionHistory');
            expect(notice).not.toContain('previous message(s) are the summary');
        });
    });

    describe('the shape of the injected history', () => {
        // The store hands messages over newest-first — that is the order the
        // chat list renders inverted — so the transcript has to be turned back
        // around on the way into the context. Getting this wrong is quiet and
        // expensive: a model treats the end of a transcript as the most recent
        // news, so a backwards history is summarised from its stale end.
        beforeEach(() => {
            mocks.focusedSessionId = A;
        });

        it('injects history in the order it happened, newest last', () => {
            setTier('full');
            const newest = message('9', 'what just happened');
            const middle = message('5', 'something in between');
            const oldest = message('1', 'the very first thing');
            addSession(A, 'Refactor the parser', [newest, middle, oldest]);

            const prompt = voiceHooks.onVoiceStarted(A);

            expect(prompt.indexOf('the very first thing'))
                .toBeLessThan(prompt.indexOf('something in between'));
            expect(prompt.indexOf('something in between'))
                .toBeLessThan(prompt.indexOf('what just happened'));
        });

        it('keeps the newest messages when the history is capped', () => {
            // The other half of the same rule: which messages survive the cap.
            // Ten is the lite limit, and the ten must be the recent ten.
            setTier('lite');
            const messages = Array.from({ length: 30 }, (_, i) => (
                message(String(30 - i), `message number ${30 - i}`)
            ));
            addSession(A, 'Refactor the parser', messages);

            const prompt = voiceHooks.onVoiceStarted(A);

            expect(prompt).toContain('message number 30');
            expect(prompt).toContain('message number 21');
            expect(prompt).not.toContain('message number 20');
            expect(prompt).not.toContain('message number 1');
        });
    });

    describe('the cost of one injection', () => {
        beforeEach(() => {
            setTier('lite');
            mocks.focusedSessionId = A;
            voiceHooks.onVoiceStarted(A);
            mocks.context.length = 0;
        });

        it('bounds a batch however many messages arrive together', () => {
            // The per-message cap bounds one message; the batch was the hole.
            // A busy session delivers a dozen changed rows in one update, and
            // a batch of them reached ~8,000 characters (~2,500 tokens) — all
            // of which stays in the realtime context and is re-billed on every
            // later turn. Measured: three voice turns billed 61,935 input
            // tokens, with single injections costing 1,000–2,500 each.
            const batch: Message[] = [];
            for (let i = 0; i < 40; i += 1) {
                const text = `step ${i} ` + 'x'.repeat(600);
                batch.push({ id: `m${i}`, kind: 'agent-text', createdAt: i, text } as Message);
            }

            voiceHooks.onMessages(A, batch);

            const injected = mocks.context.join('\n');
            // The tier's budget, plus the header and the omission marker.
            expect(injected.length).toBeLessThan(2600);
            // What is kept is the end of the burst, where the session got to.
            expect(injected).toContain('step 39');
            expect(injected).not.toContain('step 0 ');
            // And the assistant is told it is not seeing all of it, rather than
            // being left to assume the batch was complete.
            expect(injected).toMatch(/\d+ earlier messages? omitted/);
        });

        it('does not re-send a clipped message that merely grew', () => {
            // Text streams in at the end, and every growth arrives as its own
            // update. Once the version already sent was clipped, the visible
            // part cannot change — only the count of characters not shown,
            // which is a number in the truncation marker. Re-sending re-bills
            // the same prefix and appends a near-copy beside it.
            const long = 'y'.repeat(3000);
            voiceHooks.onMessages(A, [{ id: 'm1', kind: 'agent-text', createdAt: 1, text: long } as Message]);
            expect(mocks.context).toHaveLength(1);

            mocks.context.length = 0;
            voiceHooks.onMessages(A, [{ id: 'm1', kind: 'agent-text', createdAt: 1, text: long + 'more text' } as Message]);
            expect(mocks.context).toEqual([]);
        });

        it('still sends a message whose visible part actually changed', () => {
            // The suppression above must not swallow a real edit: a message
            // that was short enough to send whole, then grew past the point of
            // being readable, has new content the assistant has not seen.
            voiceHooks.onMessages(A, [{ id: 'm1', kind: 'agent-text', createdAt: 1, text: 'short' } as Message]);
            expect(mocks.context).toHaveLength(1);

            mocks.context.length = 0;
            voiceHooks.onMessages(A, [{ id: 'm1', kind: 'agent-text', createdAt: 1, text: 'z'.repeat(3000) } as Message]);
            expect(mocks.context).toHaveLength(1);
        });
    });
});
