import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    vi.stubGlobal('__DEV__', false);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), Pressable: host('Pressable'),
        Platform: { get OS() { return 'ios'; }, select: (value: any) => value.ios ?? value.default },
        StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
    };
});
vi.mock('react-native-unistyles', async () => {
    const { lightTheme } = await import('@/theme');
    return {
        StyleSheet: { create: (styles: any) => typeof styles === 'function' ? styles(lightTheme) : styles, hairlineWidth: 1 },
        useUnistyles: () => ({ theme: lightTheme }),
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: (props: any) => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { SubagentHeaderButton } from './SubagentHeaderButton';

function render(count: number, onPress: () => void) {
    let tree!: ReturnType<typeof create>;
    act(() => {
        tree = create(React.createElement(SubagentHeaderButton, { count, onPress }));
    });
    return tree;
}

describe('subagent header button', () => {
    it('reports how many agents the session has', () => {
        const tree = render(3, () => {});
        expect(JSON.stringify(tree.toJSON())).toContain('3');
    });

    it('opens the list', () => {
        const presses: number[] = [];
        const tree = render(1, () => presses.push(1));
        tree.root.findAllByType('Pressable' as any)[0].props.onPress();
        expect(presses).toEqual([1]);
    });

    it('renders nothing at all for a session that never spawned an agent', () => {
        // Chrome that is always there has to be paid for on every screen; this
        // one is a report that something exists.
        const tree = render(0, () => {});
        expect(tree.toJSON()).toBeNull();
    });
});
