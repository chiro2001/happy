import type { SubagentView } from '@/sync/reducer/reducer';

/**
 * One row of the subagent list, with the depth the UI indents by.
 *
 * The list is a tree because agents spawn agents: Codex's `agentPath` is a
 * path (`/root/parent/child`), and the registry resolves the same shape as
 * `parentId` links. A flat list would show a nested run as a crowd of
 * unrelated agents, and the one thing a reader wants to know about a subagent —
 * who asked for it — would be missing.
 */
export type SubagentTreeRow = {
    id: string;
    agent: SubagentView;
    /** 0 for an agent the session spawned directly. */
    depth: number;
};

/**
 * Flatten the registry into display order: depth-first, parents before
 * children, siblings oldest first.
 *
 * Ordering is by `startedAt` rather than by id or name because the list is
 * read as a history — "what has this session been doing" — and a run's own
 * order is the only one that answers that. A child is placed under its parent
 * regardless of when it started, so the indentation always means what it
 * looks like it means.
 *
 * Orphans are shown, not dropped. A registry can hold an agent whose parent
 * thread is not in this session's stream — a client that attached mid-run, a
 * grandchild whose parent's own `start` never arrived — and hiding it would
 * hide work that is really happening.
 */
export function buildSubagentTree(subagents: Record<string, SubagentView>): SubagentTreeRow[] {
    const childrenByParent = new Map<string, SubagentView[]>();
    const roots: SubagentView[] = [];

    for (const agent of Object.values(subagents)) {
        // A parentId that names an agent this client has not seen is treated as
        // top level: the alternative is an agent that exists in the registry
        // and appears nowhere in the list.
        const parent = agent.parentId ? subagents[agent.parentId] : undefined;
        if (!parent) {
            roots.push(agent);
            continue;
        }
        const siblings = childrenByParent.get(parent.id);
        if (siblings) {
            siblings.push(agent);
        } else {
            childrenByParent.set(parent.id, [agent]);
        }
    }

    const byStart = (a: SubagentView, b: SubagentView) => a.startedAt - b.startedAt;
    roots.sort(byStart);
    for (const siblings of childrenByParent.values()) {
        siblings.sort(byStart);
    }

    const rows: SubagentTreeRow[] = [];
    const seen = new Set<string>();
    const visit = (agent: SubagentView, depth: number) => {
        // A cycle cannot be produced by the reducer — a `start` fills a gap and
        // never rewrites an existing parent link — but the cost of being wrong
        // here is an infinite loop inside a render, so it is worth the two
        // lines.
        if (seen.has(agent.id)) return;
        seen.add(agent.id);
        rows.push({ id: agent.id, agent, depth });
        for (const child of childrenByParent.get(agent.id) ?? []) {
            visit(child, depth + 1);
        }
    };
    for (const root of roots) {
        visit(root, 0);
    }

    return rows;
}

/**
 * How many agents are still working.
 *
 * `running` is the registry's initial state as well as its live one, so an
 * agent whose `stop` never arrived counts here. That is deliberate: the badge
 * is a prompt to look, and offering to look at something that turns out to be
 * finished is a much smaller error than saying "all done" while an agent works.
 */
export function countRunningSubagents(subagents: Record<string, SubagentView>): number {
    let running = 0;
    for (const agent of Object.values(subagents)) {
        if (agent.status === 'running') running += 1;
    }
    return running;
}
