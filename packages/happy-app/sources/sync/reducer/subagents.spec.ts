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
});
