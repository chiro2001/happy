import { describe, it, expect } from 'vitest';
import { buildSubagentTree, countRunningSubagents } from './subagentTree';
import type { SubagentView } from '@/sync/reducer/reducer';

function agent(overrides: Partial<SubagentView> & { id: string }): SubagentView {
    return {
        threadId: null,
        parentThreadId: null,
        parentId: null,
        title: null,
        status: 'running',
        startedAt: 0,
        endedAt: null,
        messages: [],
        ...overrides,
    };
}

describe('subagent tree', () => {
    it('nests a grandchild under its parent, not under the session', () => {
        const tree = buildSubagentTree({
            parent: agent({ id: 'parent', title: '/root/parent', startedAt: 100 }),
            child: agent({ id: 'child', title: '/root/parent/child', parentId: 'parent', startedAt: 200 }),
            grandchild: agent({ id: 'grandchild', title: '/root/parent/child/gc', parentId: 'child', startedAt: 300 }),
        });

        expect(tree.map((row) => [row.agent.id, row.depth])).toEqual([
            ['parent', 0],
            ['child', 1],
            ['grandchild', 2],
        ]);
    });

    it('orders siblings by when they started, so the list reads as a history', () => {
        const tree = buildSubagentTree({
            second: agent({ id: 'second', startedAt: 200 }),
            first: agent({ id: 'first', startedAt: 100 }),
        });

        expect(tree.map((row) => row.agent.id)).toEqual(['first', 'second']);
    });

    it('shows an agent whose parent is missing rather than dropping its work', () => {
        // A client that attached mid-run can hold a grandchild whose parent's
        // own `start` was never in its stream. Hiding it would hide work that
        // is really happening.
        const tree = buildSubagentTree({
            orphan: agent({ id: 'orphan', parentId: 'absent', title: '/root/absent/orphan' }),
        });

        expect(tree).toHaveLength(1);
        expect(tree[0]).toMatchObject({ id: 'orphan', depth: 0 });
    });

    it('visits every agent exactly once', () => {
        const tree = buildSubagentTree({
            a: agent({ id: 'a', startedAt: 1 }),
            b: agent({ id: 'b', parentId: 'a', startedAt: 2 }),
            c: agent({ id: 'c', parentId: 'a', startedAt: 3 }),
            d: agent({ id: 'd', parentId: 'b', startedAt: 4 }),
        });

        expect(tree.map((row) => row.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('counts only the agents still working', () => {
        expect(countRunningSubagents({
            done: agent({ id: 'done', status: 'completed' }),
            failed: agent({ id: 'failed', status: 'failed' }),
            interrupted: agent({ id: 'interrupted', status: 'interrupted' }),
            working: agent({ id: 'working', status: 'running' }),
        })).toBe(1);
    });
});
