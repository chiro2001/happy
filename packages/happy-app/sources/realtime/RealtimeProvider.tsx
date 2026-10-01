import React from 'react';
import { ElevenLabsProvider } from '@elevenlabs/react-native';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { QwenVoiceSession } from './qwen/QwenVoiceSession';
import { useSetting, useVoiceSessionGeneration } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    // Force ElevenLabsProvider to remount between sessions. The native SDK uses
    // LiveKit, whose Room instance can't be reused after disconnect — second
    // startSession silently fails. Children sit OUTSIDE the provider so the app
    // tree isn't torn down on remount.
    const generation = useVoiceSessionGeneration();
    const voiceProvider = useSetting('voiceProvider');

    // Only one voice session registers itself: whichever provider is selected.
    // The Qwen path needs no wrapper — it owns its own WebSocket — so mounting
    // ElevenLabsProvider for it would just initialize LiveKit for nothing.
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
            <ElevenLabsProvider key={generation}>
                <RealtimeVoiceSession />
            </ElevenLabsProvider>
            {children}
        </>
    );
};
