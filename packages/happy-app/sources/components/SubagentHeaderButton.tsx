import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

/**
 * The header's index of the session's subagents, when it has any.
 *
 * A session that never spawns an agent renders nothing — the button is a
 * report of something that exists, not a permanent feature of the chrome. What
 * it reports is the count, because that is the one thing the conversation
 * cannot show: it holds a line where each agent was spawned, and lines scroll
 * away.
 */
export const SubagentHeaderButton = React.memo(function SubagentHeaderButton(props: {
    count: number;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    if (props.count <= 0) {
        return null;
    }
    return (
        <Pressable
            onPress={props.onPress}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('message.subagentListTitle')}
            style={({ pressed }) => [styles.button, { backgroundColor: theme.colors.surface }, pressed && styles.pressed]}
        >
            <Ionicons name="git-branch-outline" size={15} color={theme.colors.text} />
            <Text style={[styles.count, { color: theme.colors.text }]}>{props.count}</Text>
            <Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} />
        </Pressable>
    );
});

export const subagentHeaderRowStyles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
});

const styles = StyleSheet.create({
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
    },
    pressed: {
        opacity: 0.7,
    },
    count: {
        fontSize: 13,
        fontVariant: ['tabular-nums'],
    },
});
