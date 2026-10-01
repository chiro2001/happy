/**
 * Types for the Qwen-Omni-Realtime voice provider.
 *
 * This provider is additive: the ElevenLabs path in `../RealtimeVoiceSession`
 * is untouched, and `VoiceSession` (see `../types.ts`) stays the only contract
 * the rest of the app sees.
 */

/** Where the model runs. Only the China mainland region is wired up for now. */
export type QwenRegion = 'cn-beijing' | 'ap-southeast-1';

export interface QwenConfig {
    apiKey: string;
    workspaceId: string;
    region: QwenRegion;
    model: string;
    voice: string;
}

/** Token accounting as reported by `response.done`. */
export interface QwenUsage {
    inputTokens: number;
    outputTokens: number;
    inputAudioTokens: number;
    inputTextTokens: number;
    outputAudioTokens: number;
    outputTextTokens: number;
}

export interface QwenClientCallbacks {
    /** WebSocket is open and the session configuration was accepted. */
    onReady(): void;
    onClosed(reason?: string): void;
    onError(message: string): void;
    /** Transcript of the *user's* audio. Display only — see the note in client.ts. */
    onUserTranscript(text: string): void;
    /** Streaming assistant text, for the transcript view. */
    onAssistantText(delta: string): void;
    /** A chunk of 24 kHz mono s16le PCM to play. */
    onAudioDelta(pcm: Uint8Array): void;
    /** Server VAD signals; used for the speaking indicator and for barge-in. */
    onUserSpeechStart(): void;
    onUserSpeechStop(): void;
    onAssistantSpeechStart(): void;
    onAssistantSpeechStop(): void;
    onUsage(usage: QwenUsage): void;
    /**
     * The whole turn is finished — every tool call has been answered and the
     * model has nothing further to say.
     *
     * Distinct from `onAssistantSpeechStop`, which fires at *every*
     * `response.done`: a tool turn spans several responses, so that callback
     * fires before the work is actually done.
     */
    onTurnComplete?(): void;
    /**
     * Invoked when the model asks to run a tool. Resolve with the string the
     * model should see as the tool result.
     */
    onToolCall(name: string, args: Record<string, unknown>, callId: string): Promise<string>;
}

export const QWEN_DEFAULTS = {
    region: 'cn-beijing' as QwenRegion,
    model: 'qwen3.8-omni-flash-realtime',
    voice: 'Tina',
    /**
     * Chinese speech pauses 400-600 ms at a comma, so the 600 ms default cuts
     * sentences in half. Measured: 600 ms produced two commits for one
     * utterance, 1200 ms produced one. See FINDINGS.md §9.3.
     */
    silenceDurationMs: 1000,
    /**
     * Left at the default. Noise testing (§9.5) showed five kinds of
     * interference — including a full-scale transient — were all rejected, so
     * there is nothing to gain from moving this.
     */
    vadThreshold: 0.5,
    inputSampleRate: 16000,
    outputSampleRate: 24000,
} as const;
