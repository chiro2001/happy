import * as React from 'react';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Text, View, ActivityIndicator, ScrollView } from 'react-native';
import { useSession, useSessionSubagents } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { MessageView } from '@/components/MessageView';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * One subagent's page: its transcript, read-only.
 *
 * Read-only is the point, not a limitation. A subagent has no composer, no
 * permissions to grant and nothing to stop — it is driven entirely by its
 * parent through Codex's collab tools, so a control here would either do
 * nothing or fight the parent for control of the same thread. What the page
 * can usefully offer is the ability to *look*: at what the agent was asked,
 * what it ran, and what it said back.
 *
 * The transcript is the reducer's `subagents[id]`, so it updates live while the
 * agent works and is complete for one that has finished. It survives a reload
 * because it is rebuilt from the session's own messages rather than held in
 * this screen.
 */
const stylesheet = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        paddingVertical: 8,
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 8,
        gap: 4,
    },
    title: {
        fontSize: 15,
        fontFamily: 'monospace',
        color: theme.colors.text,
    },
    meta: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    empty: {
        paddingHorizontal: 16,
        paddingVertical: 24,
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

export default React.memo(() => {
    const { id: sessionId, subagentId } = useLocalSearchParams<{ id: string; subagentId: string }>();
    const router = useRouter();
    const session = useSession(sessionId!);
    const subagents = useSessionSubagents(sessionId!);
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const subagent = subagentId ? subagents[subagentId] : undefined;

    // A subagent only exists as long as the messages that reference it, so a
    // stale link — a bookmark, a back-navigation after the session was
    // reset — has nowhere to land. The registry is rebuilt from those messages,
    // so its absence is the signal that there is nothing here.
    const known = !sessionId || subagent !== undefined;
    React.useEffect(() => {
        if (!known) router.back();
    }, [known, router]);

    React.useEffect(() => {
        if (sessionId) sync.onSessionVisible(sessionId);
    }, [sessionId]);

    const headerTitle = React.useCallback(
        () => subagent?.title ?? t('message.subagentUntitled'),
        [subagent?.title],
    );

    if (!session || !subagent) {
        return (
            <>
                <Stack.Screen options={{ headerTitle }} />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ headerTitle }} />
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                <View style={styles.header}>
                    {subagent.title && <Text style={styles.title}>{subagent.title}</Text>}
                    <Text style={styles.meta}>{describeStatus(subagent)}</Text>
                </View>
                {subagent.messages.length === 0 ? (
                    <Text style={styles.empty}>{t('message.subagentEmpty')}</Text>
                ) : (
                    subagent.messages.map((message) => (
                        <MessageView
                            key={message.id}
                            message={message}
                            metadata={session.metadata}
                            sessionId={session.id}
                        />
                    ))
                )}
            </ScrollView>
        </>
    );
});

/**
 * What the header says under the agent's name.
 *
 * Deliberately not a live timer: the duration is only meaningful once the
 * agent has stopped, and a ticking clock on a page nobody is watching costs a
 * re-render a second for no information.
 */
function describeStatus(subagent: { status: string; startedAt: number; endedAt: number | null }): string {
    const seconds = Math.max(0, Math.round(((subagent.endedAt ?? Date.now()) - subagent.startedAt) / 1000));
    const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

    // Spelled out rather than looked up by a built key: `t` narrows its return
    // type from the literal key, and a template string erases that.
    switch (subagent.status) {
        case 'completed': return `${t('message.subagentStatus.completed')} · ${duration}`;
        case 'failed': return `${t('message.subagentStatus.failed')} · ${duration}`;
        case 'interrupted': return `${t('message.subagentStatus.interrupted')} · ${duration}`;
        default: return `${t('message.subagentStatus.running')} · ${duration}`;
    }
}
