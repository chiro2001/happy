import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { SubagentRefMessage } from '@/sync/typesMessage';

// The pointer row is all the conversation shows for a subagent, so these hold
// its two jobs: say which agent it points at, and open it.
//
// The mocks match `ToolView.test.ts`; the renderer is React Native's, and what
// is asserted here is the component's own decisions rather than the styling.
// JSX is avoided to keep this file a `.ts`, which is what the test include
// pattern picks up.
vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), ScrollView: host('ScrollView'), Pressable: host('Pressable'),
        Platform: { get OS() { return 'ios'; }, select: (value: any) => value.ios ?? value.default },
        StyleSheet: { create: (styles: any) => styles },
    };
});
vi.mock('react-native-unistyles', async () => {
    const { lightTheme } = await import('@/theme');
    return {
        StyleSheet: { create: (styles: any) => typeof styles === 'function' ? styles(lightTheme) : styles },
        useUnistyles: () => ({ theme: lightTheme }),
    };
});
vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => null,
    Octicons: (props: any) => null,
}));
vi.mock('@/text', () => ({
    t: (key: string, params?: any) => params?.path ? `${key}:${params.path}` : key,
}));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/sync/storage', () => ({ useSetting: () => false, useLocalSetting: () => false }));
vi.mock('./layout', () => ({ layout: { maxWidth: 1200 } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('./markdown/MarkdownView', () => ({ MarkdownView: (props: any) => null }));
vi.mock('./tools/ToolView', () => ({ ToolView: (props: any) => null }));
// MessageView reaches for these on paths the pointer row never takes. Left
// unmocked they pull their real module graphs in, which is both slower and the
// source of unrelated transform failures.
vi.mock('./LongPressCopyable', () => ({ LongPressCopyable: (props: any) => props.children }));
vi.mock('./parseLocalCommandMessage', () => ({
    parseLocalCommandMessage: () => null,
    isUserSlashCommandEcho: () => false,
}));

import { MessageView } from './MessageView';

function refMessage(overrides: Partial<SubagentRefMessage> = {}): SubagentRefMessage {
    return {
        kind: 'subagent-ref',
        id: 'm1',
        createdAt: 1000,
        subagentId: 'sub-1',
        title: '/root/researcher',
        ...overrides,
    };
}

function render(message: SubagentRefMessage, onOpenSubagent?: (id: string) => void) {
    // `act` is required, not stylistic: without it React 19 unmounts the
    // renderer before the assertions run, which reads as "rendered nothing".
    let tree!: ReturnType<typeof create>;
    act(() => {
        tree = create(
            React.createElement(MessageView, {
                message,
                metadata: null,
                sessionId: 's1',
                onOpenSubagent,
            }),
        );
    });
    return tree;
}

describe('subagent pointer row', () => {
    it('names the agent so the row says which one it points at', () => {
        const tree = render(refMessage());
        expect(JSON.stringify(tree.toJSON())).toContain('/root/researcher');
    });

    it('opens the agent it points at', () => {
        const opened: string[] = [];
        const tree = render(refMessage(), (id) => opened.push(id));
        const pressable = tree.root.findAllByType('Pressable' as any)[0];
        pressable.props.onPress();
        expect(opened).toEqual(['sub-1']);
    });

    it('does not look tappable where there is nowhere to navigate to', () => {
        // A preview, a share image, the transcript of another agent: no
        // navigator, so no button — rather than one that silently does nothing.
        const tree = render(refMessage());
        expect(tree.root.findAllByType('Pressable' as any)).toHaveLength(0);
    });

    it('falls back to a generic label when the agent has no path yet', () => {
        // An agent whose messages arrived before its `start` is listed but
        // unnamed; showing the row without a name beats hiding work in progress.
        const tree = render(refMessage({ title: null }));
        expect(JSON.stringify(tree.toJSON())).toContain('message.subagentUntitled');
    });
});
