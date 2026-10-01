import { describe, it, expect } from 'vitest';
import { createReducer, reducer } from './reducer';
import { NormalizedMessage } from '../typesRaw';
import { messageSortKey } from '../typesMessage';

/**
 * Subagents are places, not rows.
 *
 * The conversation keeps a one-line pointer where each agent was spawned; the
 * agent's own commands and messages go to its page. These tests hold that
 * boundary, because the failure it prevents is quiet: if routing slips, the
 * child's work silently reappears inline and looks like the main agent did it.
 */

function lifecycle(
    id: string,
    kind: 'start' | 'stop',
    subagentId: string,
    at: number,
    extra: { title?: string; threadId?: string; parentThreadId?: string } = {},
): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: at,
        role: 'agent',
        isSidechain: false,
        subagentId,
        content: [{
            type: 'subagent-lifecycle',
            kind,
            subagentId,
            threadId: extra.threadId ?? null,
            parentThreadId: extra.parentThreadId ?? null,
            title: extra.title ?? null,
            uuid: `${id}-uuid`,
            parentUUID: null,
        }],
    };
}

function agentText(id: string, at: number, text: string, subagentId?: string): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: at,
        role: 'agent',
        isSidechain: false,
        ...(subagentId ? { subagentId } : {}),
        content: [{ type: 'text', text, uuid: `${id}-uuid`, parentUUID: null }],
    };
}

function command(id: string, at: number, subagentId?: string): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: at,
        role: 'agent',
        isSidechain: false,
        ...(subagentId ? { subagentId } : {}),
        content: [{
            type: 'tool-call',
            id: `${id}-call`,
            name: 'CodexBash',
            input: { command: 'echo hi' },
            description: 'Run echo',
            uuid: `${id}-uuid`,
            parentUUID: subagentId ?? null,
        }],
    };
}

describe('subagent routing', () => {
    it('keeps a subagent\u2019s work out of the timeline and puts a pointer there instead', () => {
        const state = createReducer();
        const result = reducer(state, [
            agentText('m1', 100, 'spawning an agent'),
            lifecycle('s1', 'start', 'sub-1', 200, {
                title: '/root/researcher',
                threadId: 'thread-child',
                parentThreadId: 'thread-root',
            }),
            agentText('c1', 300, 'child thinking out loud', 'sub-1'),
            command('c2', 400, 'sub-1'),
            agentText('m2', 500, 'carrying on'),
        ]);

        // Ordered the way the chat orders it. The reducer emits the pointer
        // rows in a batch of their own, and the store sorts by `createdAt`
        // before rendering (`storage.ts`), so sorting here asserts what a
        // reader actually sees rather than an internal emission order.
        const kinds = result.messages
            .slice()
            .sort((a, b) => messageSortKey(a) - messageSortKey(b))
            .map((m) => m.kind);
        // The child's text and command are not here; the pointer is.
        expect(kinds).toEqual(['agent-text', 'subagent-ref', 'agent-text']);
        expect(result.messages.map((m) => m.kind === 'agent-text' ? m.text : null).filter(Boolean))
            .toEqual(['spawning an agent', 'carrying on']);

        const ref = result.messages.find((m) => m.kind === 'subagent-ref');
        expect(ref).toMatchObject({ subagentId: 'sub-1', title: '/root/researcher' });
    });

    it('gives the agent its own transcript, with the thread id needed to fork it', () => {
        const state = createReducer();
        const result = reducer(state, [
            lifecycle('s1', 'start', 'sub-1', 200, {
                title: '/root/researcher',
                threadId: 'thread-child',
                parentThreadId: 'thread-root',
            }),
            agentText('c1', 300, 'child text', 'sub-1'),
            command('c2', 400, 'sub-1'),
        ]);

        const agent = result.subagents?.['sub-1'];
        expect(agent).toBeTruthy();
        expect(agent).toMatchObject({
            id: 'sub-1',
            title: '/root/researcher',
            // Not derivable from the id, and `thread/fork` needs exactly this.
            threadId: 'thread-child',
            parentThreadId: 'thread-root',
            status: 'running',
        });
        expect(agent!.messages.map((m) => m.kind)).toEqual(['agent-text', 'tool-call']);
    });

    it('closes an agent when its stop arrives', () => {
        const state = createReducer();
        const result = reducer(state, [
            lifecycle('s1', 'start', 'sub-1', 200, { title: '/root/x' }),
            lifecycle('s2', 'stop', 'sub-1', 900),
        ]);

        expect(result.subagents?.['sub-1']).toMatchObject({
            status: 'completed',
            endedAt: 900,
        });
    });

    it('announces an agent once, however many boundaries it reports', () => {
        // An agent's boundary is re-reported whenever it is resumed, and a
        // session that is reloaded rebuilds every turn's boundaries from
        // scratch. Each of those is a `start`, and none of them is a second
        // agent — so the conversation keeps one row and the row's *state*
        // (read from the registry) is what changes.
        const state = createReducer();
        const first = reducer(state, [
            lifecycle('s1', 'start', 'sub-1', 200, { title: '/root/x', threadId: 't1' }),
            lifecycle('s2', 'stop', 'sub-1', 300),
        ]);
        expect(first.messages.filter((m) => m.kind === 'subagent-ref')).toHaveLength(1);
        expect(first.subagents?.['sub-1']!.status).toBe('completed');

        const second = reducer(state, [
            lifecycle('s3', 'start', 'sub-1', 400, { title: '/root/x', threadId: 't1' }),
        ]);
        expect(second.messages.filter((m) => m.kind === 'subagent-ref')).toHaveLength(0);
        expect(second.subagents?.['sub-1']).toMatchObject({
            status: 'running',
            endedAt: null,
        });
    });

    it('does not resurrect an agent when its boundary is replayed out of order', () => {
        // The store does not promise the batch arrives in the order it was
        // produced — the first page a client loads is assembled from whatever
        // the server hands back, and a later re-read can hand the same
        // envelopes over again. A `start` that is *older* than the `stop` this
        // client already applied is a replay of an agent's birth, not a
        // resurrection, and treating it as one leaves a finished agent
        // reported as working forever.
        const state = createReducer();
        reducer(state, [
            lifecycle('s1', 'start', 'sub-1', 200, { title: '/root/x', threadId: 't1' }),
            lifecycle('s2', 'stop', 'sub-1', 900),
        ]);
        expect(reducer(state, []).subagents?.['sub-1']!.status).toBe('completed');

        const replay = reducer(state, [
            lifecycle('s1', 'start', 'sub-1', 200, { title: '/root/x', threadId: 't1' }),
        ]);
        expect(replay.subagents?.['sub-1']).toMatchObject({
            status: 'completed',
            endedAt: 900,
        });
    });

    it('does revive an agent whose new start is genuinely later', () => {
        // The other half of the same rule: `sendInput` starts an agent that had
        // stopped, and that start is newer than the stop it follows. The
        // comparison is strict — a boundary that claims the same instant as the
        // stop is a replay of the same transition, not a new one.
        const state = createReducer();
        reducer(state, [
            lifecycle('s1', 'start', 'sub-1', 200, { title: '/root/x', threadId: 't1' }),
            lifecycle('s2', 'stop', 'sub-1', 900),
        ]);

        const resumed = reducer(state, [
            lifecycle('s3', 'start', 'sub-1', 1000, { title: '/root/x', threadId: 't1' }),
        ]);
        expect(resumed.subagents?.['sub-1']).toMatchObject({
            status: 'running',
            endedAt: null,
        });
    });

    it('links a grandchild to its parent, not to the session', () => {
        const state = createReducer();
        // The grandchild's activity is reported on the child's thread, which is
        // the whole reason `parentThreadId` travels.
        const result = reducer(state, [
            lifecycle('s1', 'start', 'sub-parent', 100, {
                title: '/root/parent',
                threadId: 'thread-parent',
                parentThreadId: 'thread-root',
            }),
            lifecycle('s2', 'start', 'sub-child', 200, {
                title: '/root/parent/child',
                threadId: 'thread-child',
                parentThreadId: 'thread-parent',
            }),
        ]);

        expect(result.subagents?.['sub-parent']).toMatchObject({ parentId: null });
        expect(result.subagents?.['sub-child']).toMatchObject({ parentId: 'sub-parent' });
    });

    it('still lists an agent whose messages arrive before its start', () => {
        // A client that attaches mid-run — a resumed session, a reload — can
        // see an agent's output with no lifecycle marker behind it yet. Showing
        // it untitled beats dropping work that is actually happening.
        const state = createReducer();
        const result = reducer(state, [
            agentText('c1', 100, 'early output', 'sub-1'),
        ]);

        expect(result.subagents?.['sub-1']).toMatchObject({
            id: 'sub-1',
            title: null,
            status: 'running',
        });
        expect(result.subagents?.['sub-1']!.messages).toHaveLength(1);
    });

    it('does not invent an agent from a stop alone', () => {
        const state = createReducer();
        const result = reducer(state, [lifecycle('s1', 'stop', 'sub-1', 100)]);

        // No pointer row either: there is nothing to point at.
        expect(result.messages).toHaveLength(0);
    });

    it('keeps a command out of the timeline when its result arrives in a later pass', () => {
        // The shape a real command has: the start and the result are separate
        // envelopes, reduced in separate passes. The row is created by the
        // first and *updated* by the second, so anything that remembers which
        // agent the row belongs to by looking only at the current pass forgets
        // it exactly when the command finishes — and the agent's work reappears
        // inline, attributed to the parent.
        const state = createReducer();

        const startEnvelope = command('c1', 300, 'sub-1');
        const fileResult = reducer(state, [
            lifecycle('s1', 'start', 'sub-1', 200, { title: '/root/researcher' }),
            startEnvelope,
        ]);
        expect(fileResult.messages.map((m) => m.kind)).toEqual(['subagent-ref']);

        const endEnvelope: NormalizedMessage = {
            id: 'c1-result',
            localId: null,
            createdAt: 400,
            role: 'agent',
            isSidechain: false,
            subagentId: 'sub-1',
            content: [{
                type: 'tool-result',
                tool_use_id: 'c1-call',
                content: 'hi',
                is_error: false,
                uuid: 'c1-result-uuid',
                parentUUID: null,
            }],
        };
        const afterResult = reducer(state, [endEnvelope]);

        // The timeline has nothing new in it, and the agent's page has both
        // rows — the command and its result, joined.
        expect(afterResult.messages).toHaveLength(0);
        const agent = afterResult.subagents?.['sub-1'];
        expect(agent!.messages).toHaveLength(1);
        expect(agent!.messages[0].kind).toBe('tool-call');
        expect((agent!.messages[0] as { tool: { result?: unknown } }).tool).toMatchObject({
            state: 'completed',
        });
    });
});
