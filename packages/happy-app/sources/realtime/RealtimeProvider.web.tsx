import React from 'react';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { QwenVoiceSession } from './qwen/QwenVoiceSession';
import { useSetting, useVoiceSessionGeneration } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    // Web SDK (@elevenlabs/react) uses a plain WebSocket — no LiveKit Room to
    // go stale — so this re-key is mostly defensive. Kept symmetric with native.
    const generation = useVoiceSessionGeneration();

    // Same split as the native provider: only the selected backend mounts, so
    // the other one never opens a socket. On desktop this matters more than on
    // a phone — a stray ElevenLabs connection would bill against Happy's quota
    // while the user is talking to Qwen.
    const voiceProvider = useSetting('voiceProvider');
    if (voiceProvider === 'qwen') {
        return (
            <>
                <QwenVoiceSession key={generation} />
                {children}
            </>
        );
    }

    return (
        <>
            <RealtimeVoiceSession key={generation} />
            {children}
        </>
    );
};
