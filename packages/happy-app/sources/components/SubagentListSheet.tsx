import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSessionSubagents } from '@/sync/storage';
import type { SubagentView } from '@/sync/reducer/reducer';
import { buildSubagentTree, countRunningSubagents } from '@/utils/subagentTree';
import { MobileGlassSurface } from './MobileGlass';

/**
 * Every agent a session has spawned, as a tree.
 *
 * The conversation itself can only ever hold one line per agent, standing
 * where it was spawned — which answers "what is this session doing" but not
 * "what is it doing *right now*". This is the other question: a live index of
 * the agents, nesting included, that opens on top of the conversation, and
 * whose rows go to the same read-only page the inline pointer rows do.
 */
export const SubagentListSheet = React.memo(function SubagentListSheet(props: {
    sessionId: string;
    onOpenSubagent: (subagentId: string) => void;
    /** Injected by the modal infra. */
    onClose?: () => void;
}) {
    const { sessionId, onOpenSubagent, onClose } = props;
    const subagents = useSessionSubagents(sessionId);
    const { theme } = useUnistyles();
    const windowSize = useWindowDimensions();

    const rows = React.useMemo(() => buildSubagentTree(subagents), [subagents]);
    const running = React.useMemo(() => countRunningSubagents(subagents), [subagents]);

    // Wide enough to read a path, never wider than the screen it is on. The
    // sheet is a list of monospace-ish names, so it wants a little more width
    // than the alert-shaped modals but has no reason to stretch on a desktop.
    const width = Math.min(windowSize.width - 32, 420);
    const maxHeight = Math.max(240, windowSize.height - 160);

    const open = React.useCallback((id: string) => {
        onClose?.();
        onOpenSubagent(id);
    }, [onClose, onOpenSubagent]);

    return (
        <MobileGlassSurface style={[styles.sheet, { width, maxHeight }]}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('message.subagentListTitle')}</Text>
                <Text style={styles.subtitle}>
                    {running > 0
                        ? t('message.subagentListRunning', { count: running, total: rows.length })
                        : t('message.subagentListSettled', { count: rows.length })}
                </Text>
            </View>
            {rows.length === 0 ? (
                <Text style={styles.empty}>{t('message.subagentListEmpty')}</Text>
            ) : (
                <ScrollView contentContainerStyle={styles.listContent}>
                    {rows.map((row) => (
                        <SubagentRow
                            key={row.id}
                            agent={row.agent}
                            depth={row.depth}
                            onPress={() => open(row.id)}
                        />
                    ))}
                </ScrollView>
            )}
            <Pressable
                onPress={onClose}
                style={({ pressed }) => [styles.closeButton, pressed && styles.rowPressed]}
                accessibilityRole="button"
            >
                <Text style={styles.closeText}>{t('common.ok')}</Text>
            </Pressable>
        </MobileGlassSurface>
    );
});

function SubagentRow(props: { agent: SubagentView; depth: number; onPress: () => void }) {
    const { agent, depth } = props;
    const { theme } = useUnistyles();
    const running = agent.status === 'running';
    // One line per row, and the path is the informative part — the status
    // lives in the leading dot. The border is what makes a child read as a
    // child without spending horizontal room on a tree glyph at every level.
    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.row,
                depth > 0 && styles.rowNested,
                { paddingLeft: 16 + depth * 16 },
                pressed && styles.rowPressed,
            ]}
            accessibilityRole="button"
        >
            <View style={[
                styles.statusDot,
                { backgroundColor: statusColor(agent.status, theme) },
            ]} />
            <Text style={styles.rowText} numberOfLines={1}>
                {agent.title ?? t('message.subagentUntitled')}
            </Text>
            <Text style={styles.rowMeta}>{describeDuration(agent)}</Text>
            <Ionicons name="chevron-forward" size={15} color={theme.colors.textSecondary} />
        </Pressable>
    );
}

function statusColor(status: SubagentView['status'], theme: ReturnType<typeof useUnistyles>['theme']): string {
    switch (status) {
        case 'failed': return theme.colors.textDestructive;
        case 'completed': return theme.colors.textSecondary;
        case 'interrupted': return theme.colors.textSecondary;
        default: return theme.colors.button.primary.background;
    }
}

/**
 * The agent's lifetime, as one short token.
 *
 * Same rule as the agent's own page: a running agent shows nothing rather than
 * a clock, because a number that only settles at the end is not worth a
 * re-render a second on a list nobody is staring at.
 */
function describeDuration(agent: SubagentView): string {
    if (agent.endedAt === null) return '';
    const seconds = Math.max(0, Math.round((agent.endedAt - agent.startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const styles = StyleSheet.create((theme) => ({
    sheet: {
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        alignSelf: 'center',
    },
    header: {
        paddingHorizontal: 20,
        paddingTop: 18,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        fontWeight: '600' as const,
        color: theme.colors.text,
    },
    subtitle: {
        marginTop: 4,
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    listContent: {
        paddingVertical: 4,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 11,
        paddingRight: 16,
    },
    // A child is marked by a rule in the gutter its indentation opens up, so
    // nesting survives both a narrow phone and a path so long it is truncated.
    rowNested: {
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.divider,
    },
    rowPressed: {
        opacity: 0.7,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    rowText: {
        flex: 1,
        minWidth: 0,
        fontSize: 14,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        color: theme.colors.text,
    },
    rowMeta: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    empty: {
        paddingHorizontal: 20,
        paddingVertical: 24,
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    closeButton: {
        paddingVertical: 13,
        alignItems: 'center',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    closeText: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default(),
    },
}));
