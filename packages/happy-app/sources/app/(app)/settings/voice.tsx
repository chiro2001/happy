import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { UsageBar } from '@/components/usage/UsageBar';
import { useSettingMutable, useEntitlement, useLocalSetting, useLocalSettingMutable, useSetting } from '@/sync/storage';
import { useAuth } from '@/auth/AuthContext';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { fetchVoiceUsage, type VoiceUsageResponse } from '@/sync/apiVoice';
import { t } from '@/text';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { trackPaywallButtonClicked } from '@/track';
import { getVoiceExperimentStatus, getVoiceUpsellVariantLabel } from '@/realtime/voiceExperiment';
import {
    getQwenVoiceUsage,
    getVoiceLocalCounters,
    resetQwenVoiceUsage,
    resetVoiceLocalCounters,
} from '@/sync/persistence';
import {
    estimateCostCny,
    formatCny,
    formatDuration,
    formatTokens,
    elevenLabsEquivalentCny,
    silenceSharePercent,
    totalTokens,
    QWEN_FREE_TIER_TOKENS,
} from '@/realtime/qwen/pricing';

function formatVoiceTime(totalSeconds: number): string {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}m ${secs}s`;
}

export default React.memo(function VoiceSettingsScreen() {
    const router = useRouter();
    const auth = useAuth();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [voiceCustomAgentId, setVoiceCustomAgentId] = useSettingMutable('voiceCustomAgentId');
    const [voiceBypassToken, setVoiceBypassToken] = useSettingMutable('voiceBypassToken');
    const [voiceProvider, setVoiceProvider] = useSettingMutable('voiceProvider');
    const [qwenModel, setQwenModel] = useSettingMutable('qwenModel');
    // Device-local: the API key must not ride the account settings sync, and
    // half-duplex depends on the device's echo cancellation, not the account.
    const [qwenApiKey, setQwenApiKey] = useLocalSettingMutable('qwenApiKey');
    const [qwenWorkspaceId, setQwenWorkspaceId] = useLocalSettingMutable('qwenWorkspaceId');
    const [qwenHalfDuplex, setQwenHalfDuplex] = useLocalSettingMutable('qwenHalfDuplex');
    // Read once per mount: sessions run outside this screen, and coming back
    // here is the natural moment to see what they cost.
    const [qwenUsage, setQwenUsage] = React.useState(() => getQwenVoiceUsage());
    const [voiceUpsellOverride, setVoiceUpsellOverride] = useLocalSettingMutable('voiceUpsellOverride');
    const experiments = useSetting('experiments');
    const devModeEnabled = __DEV__ || useLocalSetting('devModeEnabled');

    const hasPro = useEntitlement('pro');

    const [usage, setUsage] = React.useState<VoiceUsageResponse | null>(null);
    const [usageLoading, setUsageLoading] = React.useState(true);
    const [voiceLocalCounters, setVoiceLocalCounters] = React.useState(() => getVoiceLocalCounters());

    React.useEffect(() => {
        if (!auth.credentials) return;
        fetchVoiceUsage(auth.credentials)
            .then(setUsage)
            .catch(() => {})
            .finally(() => setUsageLoading(false));
    }, [auth.credentials]);

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    const handleSupportUs = React.useCallback(async () => {
        trackPaywallButtonClicked('voluntary_support');
        await sync.presentPaywall('voluntary_support');
    }, []);

    const handleCustomAgentId = React.useCallback(async () => {
        const value = await Modal.prompt(
            t('settingsVoice.customAgentId'),
            t('settingsVoice.customAgentIdDescription'),
            {
                defaultValue: voiceCustomAgentId ?? '',
                placeholder: t('settingsVoice.customAgentIdPlaceholder'),
            }
        );
        if (value !== null) {
            const trimmed = value.trim() || null;
            setVoiceCustomAgentId(trimmed);
            // Auto-toggle bypass when setting/clearing agent ID
            setVoiceBypassToken(trimmed !== null);
        }
    }, [voiceCustomAgentId, setVoiceCustomAgentId, setVoiceBypassToken]);

    const handleQwenApiKey = React.useCallback(async () => {
        const value = await Modal.prompt(
            'DashScope API Key',
            '用于 Qwen-Omni-Realtime，仅保存在本机。可在百炼控制台创建。',
            {
                defaultValue: qwenApiKey ?? '',
                placeholder: 'sk-...',
            }
        );
        if (value !== null) {
            setQwenApiKey(value.trim() || null);
        }
    }, [qwenApiKey, setQwenApiKey]);

    const handleQwenWorkspaceId = React.useCallback(async () => {
        const value = await Modal.prompt(
            '业务空间 ID',
            '百炼业务空间 ID，用作 WebSocket 地址前缀（形如 ws-xxxxxxxx）。',
            {
                defaultValue: qwenWorkspaceId ?? '',
                placeholder: 'ws-...',
            }
        );
        if (value !== null) {
            setQwenWorkspaceId(value.trim() || null);
        }
    }, [qwenWorkspaceId, setQwenWorkspaceId]);

    const handleQwenModel = React.useCallback(async () => {
        const value = await Modal.prompt(
            '实时模型',
            '默认 qwen3.8-omni-flash-realtime；另有 qwen-audio-3.0-realtime-flash。',
            {
                defaultValue: qwenModel,
                placeholder: 'qwen3.8-omni-flash-realtime',
            }
        );
        if (value !== null) {
            setQwenModel(value.trim() || 'qwen3.8-omni-flash-realtime');
        }
    }, [qwenModel, setQwenModel]);

    const handleVoiceExperimentOverride = React.useCallback(() => {
        Modal.alert(
            'Voice Experiment Override',
            'Select a local override for the voice-upsell experiment.',
            [
                { text: 'No Override', onPress: () => setVoiceUpsellOverride(null) },
                { text: 'Control', onPress: () => setVoiceUpsellOverride('control') },
                { text: 'Soft Paywall', onPress: () => setVoiceUpsellOverride('show-paywall-before-first-voice-chat') },
                { text: 'Onboarding + Upsell', onPress: () => setVoiceUpsellOverride('voice-onboarding-and-upsell') },
            ],
        );
    }, [setVoiceUpsellOverride]);

    const handleResetVoiceCounters = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            'Reset Voice Counters',
            'Clear local voice counters used for onboarding and soft-paywall behavior on this device?',
            {
                confirmText: 'Reset',
                destructive: true,
            },
        );
        if (!confirmed) {
            return;
        }

        resetVoiceLocalCounters();
        setVoiceLocalCounters(getVoiceLocalCounters());
    }, []);

    const voiceExperimentStatus = React.useMemo(() => {
        return getVoiceExperimentStatus({
            voiceBypassToken,
            voiceCustomAgentId,
            voiceUpsellOverride,
            voiceUpsellOverrideEnabled: devModeEnabled,
        });
    }, [devModeEnabled, voiceBypassToken, voiceCustomAgentId, voiceUpsellOverride]);

    const developerExperimentSubtitle = React.useMemo(() => {
        const upsellVariant = getVoiceUpsellVariantLabel(voiceExperimentStatus.upsellVariant);
        const gatingMode = voiceExperimentStatus.gatingMode === 'direct-byo-agent'
            ? 'direct BYO agent bypass'
            : 'Happy server gate';

        return [
            `voice-upsell: ${upsellVariant}`,
            `source: ${voiceExperimentStatus.upsellVariantSource}`,
            `gate: ${gatingMode}`,
            `experiments setting: ${experiments ? 'on' : 'off'}`,
        ].join('\n');
    }, [experiments, voiceExperimentStatus]);

    const developerOverrideLabel = React.useMemo(() => {
        if (!voiceUpsellOverride) {
            return 'No Override';
        }
        return getVoiceUpsellVariantLabel(voiceUpsellOverride);
    }, [voiceUpsellOverride]);

    const developerCountersSubtitle = React.useMemo(() => {
        return [
            `soft paywall shown: ${voiceLocalCounters.softPaywallShownCount}`,
            `onboarding prompt loads: ${voiceLocalCounters.onboardingPromptLoadCount}`,
            `voice messages: ${voiceLocalCounters.voiceMessageCount}`,
        ].join('\n');
    }, [voiceLocalCounters]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Voice Usage.
                ElevenLabs quota lives on Happy's server, so it is meaningless
                when the user has switched to Qwen — and it costs a network call
                to fetch. The Qwen equivalent appears in its own group below. */}
            {voiceProvider !== 'qwen' && usageLoading ? (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    <ActivityIndicator />
                </View>
            ) : voiceProvider === 'qwen' ? (
                /* Qwen usage takes the same slot the ElevenLabs quota occupied,
                   so switching backends swaps the panel in place instead of
                   moving it around the screen. */
                qwenUsage.turnCount + qwenUsage.connectionMs > 0 && (() => {
                    const used = totalTokens(qwenUsage);
                    const cost = estimateCostCny(qwenUsage);
                    const freeRemaining = Math.max(0, QWEN_FREE_TIER_TOKENS - used);
                    const silentPct = silenceSharePercent(qwenUsage);
                    const equivalent = elevenLabsEquivalentCny(qwenUsage.connectionMs);
                    return (
                        <ItemGroup
                            title="用量"
                            footer={
                                `按刊例价估算，控制台账单为准。免费额度 `
                                + `${formatTokens(QWEN_FREE_TIER_TOKENS)} token，12-21 到期。`
                                + `静音不计费，所以连接时长远大于计费时长是正常的。`
                            }
                        >
                            <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                                <UsageBar
                                    label="免费额度"
                                    value={used}
                                    maxValue={QWEN_FREE_TIER_TOKENS}
                                    color={freeRemaining > 0 ? '#007AFF' : '#FF3B30'}
                                />
                                <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                                    {formatTokens(used)} / {formatTokens(QWEN_FREE_TIER_TOKENS)} token
                                    {freeRemaining > 0
                                        ? ` · 剩余 ${formatTokens(freeRemaining)}`
                                        : ' · 已超出免费额度'}
                                </Text>
                                <UsageBar
                                    label="有效语音 / 连接时长"
                                    value={qwenUsage.speechMs}
                                    maxValue={Math.max(qwenUsage.connectionMs, 1)}
                                    color="#34C759"
                                />
                                <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                                    {formatDuration(qwenUsage.speechMs)} / {formatDuration(qwenUsage.connectionMs)}
                                    {silentPct === null ? '' : ` · 静音 ${silentPct.toFixed(0)}% 未计费`}
                                </Text>
                            </View>
                            <Item
                                title="预估费用"
                                subtitle={
                                    freeRemaining > 0
                                        ? `免费额度内 · 名义 ${formatCny(cost)}`
                                        : `约 ${formatCny(cost)}`
                                }
                                icon={<Ionicons name="pricetag-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                            <Item
                                title="与 ElevenLabs 对比"
                                subtitle={
                                    `同样连接时长在其上约 ${formatCny(equivalent)}`
                                    + (cost > 0
                                        ? ` · 约为其 1/${Math.max(1, Math.round(equivalent / Math.max(cost, 0.0001)))}`
                                        : '')
                                }
                                icon={<Ionicons name="git-compare-outline" size={29} color="#007AFF" />}
                                showChevron={false}
                            />
                            <Item
                                title="累计轮次"
                                subtitle={
                                    `${qwenUsage.turnCount} 轮 · 输入 `
                                    + `${formatTokens(qwenUsage.inputAudioTokens + qwenUsage.inputTextTokens)}`
                                    + ` / 输出 ${formatTokens(qwenUsage.outputAudioTokens + qwenUsage.outputTextTokens)}`
                                }
                                icon={<Ionicons name="analytics-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                            <Item
                                title="重置统计"
                                subtitle="只清除本地计数，不影响服务端账单"
                                icon={<Ionicons name="refresh-outline" size={29} color="#FF3B30" />}
                                onPress={() => {
                                    resetQwenVoiceUsage();
                                    setQwenUsage(getQwenVoiceUsage());
                                }}
                            />
                        </ItemGroup>
                    );
                })()
            ) : usage ? (
                <ItemGroup
                    title={t('settingsVoice.usageTitle')}
                    footer={t('settingsVoice.usageFooter')}
                >
                    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                        <UsageBar
                            label={t('settingsVoice.usageLabel')}
                            value={usage.usedSeconds}
                            maxValue={usage.limitSeconds}
                            color={usage.usedSeconds >= usage.limitSeconds ? '#FF3B30' : '#007AFF'}
                        />
                        <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                            {formatVoiceTime(usage.usedSeconds)} / {formatVoiceTime(usage.limitSeconds)}
                        </Text>
                        <UsageBar
                            label={t('settingsVoice.conversationsLabel')}
                            value={usage.conversationCount}
                            maxValue={usage.conversationLimit}
                            color={usage.conversationCount >= usage.conversationLimit ? '#FF3B30' : '#007AFF'}
                        />
                        <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                            {usage.conversationCount} / {usage.conversationLimit}
                        </Text>
                    </View>
                </ItemGroup>
            ) : null}

            {/* Support / Upgrade */}
            {voiceProvider !== 'qwen' && !hasPro && (
                <ItemGroup>
                    <Item
                        title={t('settingsVoice.supportTitle')}
                        subtitle={t('settingsVoice.supportSubtitle')}
                        icon={<Ionicons name="heart-outline" size={29} color="#FF2D55" />}
                        onPress={handleSupportUs}
                    />
                </ItemGroup>
            )}

            {/* Developer panel is entirely about the ElevenLabs rollout. */}
            {devModeEnabled && voiceProvider !== 'qwen' && (
                <ItemGroup
                    title="Developer"
                    footer="Developer-only diagnostics and local override controls for the current voice rollout. The paid voice gate runs through Happy server unless Direct Connection and a custom ElevenLabs agent are both enabled."
                >
                    <Item
                        title="Voice Experiment Override"
                        subtitle="Simple local override for the voice-upsell flag"
                        detail={developerOverrideLabel}
                        icon={<Ionicons name="options-outline" size={29} color="#007AFF" />}
                        onPress={handleVoiceExperimentOverride}
                    />
                    <Item
                        title="Voice Experiment Status"
                        subtitle={developerExperimentSubtitle}
                        subtitleLines={0}
                        icon={<Ionicons name="flask-outline" size={29} color="#5856D6" />}
                        showChevron={false}
                        copy={developerExperimentSubtitle}
                    />
                    <Item
                        title="Reset Voice Counters"
                        subtitle={developerCountersSubtitle}
                        subtitleLines={0}
                        icon={<Ionicons name="refresh-outline" size={29} color="#FF9500" />}
                        onPress={handleResetVoiceCounters}
                    />
                </ItemGroup>
            )}

            {/* Language Settings */}
            <ItemGroup
                title={t('settingsVoice.languageTitle')}
                footer={t('settingsVoice.languageDescription')}
            >
                <Item
                    title={t('settingsVoice.preferredLanguage')}
                    subtitle={t('settingsVoice.preferredLanguageSubtitle')}
                    icon={<Ionicons name="language-outline" size={29} color="#007AFF" />}
                    detail={getLanguageDisplayName(currentLanguage)}
                    onPress={() => router.push('/settings/voice/language')}
                />
            </ItemGroup>

            {/* Voice backend — additive: ElevenLabs stays the default */}
            <ItemGroup
                title="语音后端"
                footer={
                    '选择实时语音使用哪家服务。ElevenLabs 走 Happy 的服务器并受其额度限制；'
                    + 'Qwen 直连阿里云百炼，使用你自己的 API Key，费用约为前者的 1/19，'
                    + '且静音不计费。'
                }
            >
                <Item
                    title="当前后端"
                    subtitle={
                        voiceProvider === 'qwen'
                            ? 'Qwen-Omni-Realtime（阿里云百炼）'
                            : 'ElevenLabs（Happy 默认）'
                    }
                    icon={<Ionicons name="swap-horizontal-outline" size={29} color="#5856D6" />}
                    onPress={() => {
                        Modal.alert('选择语音后端', '随时可切回，设置会被保留。', [
                            {
                                text: 'ElevenLabs（默认）',
                                onPress: () => setVoiceProvider('elevenlabs'),
                            },
                            {
                                text: 'Qwen-Omni-Realtime',
                                onPress: () => setVoiceProvider('qwen'),
                            },
                            { text: '取消', style: 'cancel' },
                        ]);
                    }}
                />
                {voiceProvider === 'qwen' && (
                    <>
                        <Item
                            title="DashScope API Key"
                            subtitle={qwenApiKey ? '已配置' : '未配置'}
                            icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                            onPress={handleQwenApiKey}
                        />
                        <Item
                            title="业务空间 ID"
                            subtitle={qwenWorkspaceId ?? '未配置'}
                            icon={<Ionicons name="business-outline" size={29} color="#007AFF" />}
                            onPress={handleQwenWorkspaceId}
                        />
                        <Item
                            title="实时模型"
                            subtitle={qwenModel}
                            icon={<Ionicons name="hardware-chip-outline" size={29} color="#34C759" />}
                            onPress={handleQwenModel}
                        />
                        <Item
                            title="说话时静音麦克风"
                            subtitle={
                                qwenHalfDuplex
                                    ? '已开启 · 无法用语音打断'
                                    : '已关闭 · 支持语音打断（依赖系统回声消除）'
                            }
                            icon={<Ionicons name="mic-off-outline" size={29} color="#FF3B30" />}
                            rightElement={
                                <Switch
                                    value={qwenHalfDuplex}
                                    onValueChange={setQwenHalfDuplex}
                                />
                            }
                        />
                    </>
                )}
            </ItemGroup>

            {/* Bring Your Own Agent — ElevenLabs-only: it configures which
                ElvenLabs agent to talk to. */}
            {voiceProvider !== 'qwen' && (
            <ItemGroup
                title={t('settingsVoice.byoTitle')}
                footer={t('settingsVoice.byoDescription')}
            >
                <Item
                    title={t('settingsVoice.customAgentId')}
                    subtitle={voiceCustomAgentId ?? t('settingsVoice.customAgentIdNotSet')}
                    icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                    onPress={handleCustomAgentId}
                />
                <Item
                    title={t('settingsVoice.bypassToken')}
                    subtitle={t('settingsVoice.bypassTokenSubtitle')}
                    icon={<Ionicons name="flash-outline" size={29} color="#FF3B30" />}
                    rightElement={
                        <Switch
                            value={voiceBypassToken}
                            onValueChange={setVoiceBypassToken}
                        />
                    }
                />
            </ItemGroup>
            )}

            {/* Prompt Guide — shown when custom agent is configured */}
            {voiceProvider !== 'qwen' && voiceCustomAgentId && (
                <ItemGroup
                    title={t('settingsVoice.promptGuideTitle')}
                    footer={t('settingsVoice.promptGuideDescription')}
                >
                    <Item
                        title={t('settingsVoice.customAgentId')}
                        subtitle={voiceCustomAgentId}
                        copy={voiceCustomAgentId}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
});
