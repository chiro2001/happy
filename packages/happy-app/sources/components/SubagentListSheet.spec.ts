import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { SubagentView } from '@/sync/reducer/reducer';

// The list is the only way to reach an agent whose pointer row has scrolled
// away, so these hold its two jobs: show the tree, and open the agent it names.
// Mocks follow `MessageView.subagent.spec.ts`.
const state = vi.hoisted(() => ({ subagents: {} as Record<string, SubagentView> }));
vi.hoisted(() => {
    vi.stubGlobal('__DEV__', false);
    // Without this React 19 warns that `act` is unsupported and then unmounts
    // the renderer before the assertions run — which reads as "rendered
    // nothing" rather than as a missing flag.
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), ScrollView: host('ScrollView'), Pressable: host('Pressable'),
        ActivityIndicator: host('ActivityIndicator'),
        Platform: { get OS() { return 'ios'; }, select: (value: any) => value.ios ?? value.default },
        StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
        useWindowDimensions: () => ({ width: 390, height: 844 }),
    };
});
vi.mock('react-native-unistyles', async () => {
    const { lightTheme } = await import('@/theme');
    return {
        StyleSheet: { create: (styles: any) => typeof styles === 'function' ? styles(lightTheme) : styles, hairlineWidth: 1 },
        useUnistyles: () => ({ theme: lightTheme }),
    };
});
vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => null,
    Octicons: (props: any) => null,
}));
vi.mock('@/text', () => ({
    t: (key: string, params?: any) => params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock('@/sync/storage', () => ({
    useSessionSubagents: () => state.subagents,
}));
vi.mock('./MobileGlass', async () => {
    const React = await import('react');
    return { MobileGlassSurface: (props: any) => React.createElement('MobileGlassSurface', props, props.children) };
});

import { SubagentListSheet } from './SubagentListSheet';

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

function render(onOpenSubagent: (id: string) => void, onClose: () => void) {
    let tree!: ReturnType<typeof create>;
    act(() => {
        tree = create(
            React.createElement(SubagentListSheet, { sessionId: 's1', onOpenSubagent, onClose }),
        );
    });
    return tree;
}

describe('subagent list', () => {
    it('lists every agent, including the nested ones', () => {
        state.subagents = {
            parent: agent({ id: 'parent', title: '/root/parent', startedAt: 100 }),
            child: agent({ id: 'child', title: '/root/parent/child', parentId: 'parent', startedAt: 200 }),
        };
        const tree = render(() => {}, () => {});
        const text = JSON.stringify(tree.toJSON());

        expect(text).toContain('/root/parent');
        expect(text).toContain('/root/parent/child');
    });

    it('opens the agent a row names, and closes the list behind it', () => {
        state.subagents = { parent: agent({ id: 'parent', title: '/root/parent' }) };
        const opened: string[] = [];
        const closed: string[] = [];
        const tree = render((id) => opened.push(id), () => closed.push('x'));

        const pressables = tree.root.findAllByType('Pressable' as any);
        // The last pressable is the sheet's own dismiss button.
        pressables[0].props.onPress();

        expect(opened).toEqual(['parent']);
        expect(closed).toEqual(['x']);
    });

    it('says so when the session has never spawned an agent', () => {
        state.subagents = {};
        const tree = render(() => {}, () => {});

        expect(JSON.stringify(tree.toJSON())).toContain('message.subagentListEmpty');
    });

    it('reports how many agents are still working', () => {
        state.subagents = {
            done: agent({ id: 'done', status: 'completed', endedAt: 200 }),
            working: agent({ id: 'working', status: 'running' }),
        };
        const tree = render(() => {}, () => {});

        expect(JSON.stringify(tree.toJSON())).toContain('message.subagentListRunning');
    });

    it('does not call a finished session busy', () => {
        state.subagents = { done: agent({ id: 'done', status: 'completed', endedAt: 200 }) };
        const tree = render(() => {}, () => {});
        const text = JSON.stringify(tree.toJSON());

        expect(text).toContain('message.subagentListSettled');
        expect(text).not.toContain('message.subagentListRunning');
    });
});
