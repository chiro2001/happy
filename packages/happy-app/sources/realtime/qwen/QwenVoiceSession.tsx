/**
 * Qwen-Omni-Realtime as a second voice provider, alongside ElevenLabs.
 *
 * Additive by design: nothing in the ElevenLabs path changes. This component
 * implements the same `VoiceSession` contract, registers itself the same way,
 * and is only mounted when the user picks this provider in settings. Switching
 * back is a setting change, not a code change.
 */

import React, { useEffect, useRef } from 'react';
import { storage } from '@/sync/storage';
import { addQwenVoiceUsage } from '@/sync/persistence';
import { realtimeClientTools } from '../realtimeClientTools';
import { registerVoiceSession } from '../RealtimeSession';
import { QwenRealtimeClient } from './client';
import { QwenAudioCapture, QwenAudioPlayer } from './audio';
import { QWEN_DEFAULTS } from './types';
import { isStopCommand } from './stopCommand';
import type { QwenConfig, QwenUsage } from './types';
import type { VoiceSession, VoiceSessionConfig } from '../types';

/**
 * Tools the model may call. The names must match `realtimeClientTools` keys —
 * note that Happy's own in-app documentation says `messageClaudeCode`, which is
 * wrong; the real key is `sendMessageToSession`.
 */
const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'sendMessageToSession',
            description:
                '把用户的指令发送给正在运行的编码代理（Codex）。' +
                '当用户要求转达、询问或指示代理做事时调用。',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: '目标会话 id' },
                    message: { type: 'string', description: '要发送的文本' },
                },
                required: ['sessionId', 'message'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'processPermissionRequest',
            description: '批准或拒绝编码代理发出的工具使用授权请求。',
            parameters: {
                type: 'object',
                properties: {
                    requestId: { type: 'string', description: '授权请求 id' },
                    decision: {
                        type: 'string',
                        enum: ['allow', 'deny'],
                        description: '允许或拒绝',
                    },
                },
                required: ['requestId', 'decision'],
            },
        },
    },
];

/** Turn the shared session config into provider-specific options. */
function toSessionOptions(config: VoiceSessionConfig) {
    // The client-side stop-word suppressor handles the common case, but telling
    // the model directly covers phrasings it does not enumerate and avoids
    // generating tokens only to throw them away.
    const stopInstruction =
        '\n\n【重要】当用户要求你停止说话（例如说“停止”“停下”“别说了”）时，'
        + '必须立刻保持安静，不要回复任何内容，也不要确认收到。';
    const instructions = config.systemPrompt
        ? config.systemPrompt + stopInstruction
        : stopInstruction.trim();

    return {
        instructions,
        initialContext: config.initialContext,
        tools: TOOL_DEFINITIONS,
        voice: QWEN_DEFAULTS.voice,
        silenceDurationMs: QWEN_DEFAULTS.silenceDurationMs,
        vadThreshold: QWEN_DEFAULTS.vadThreshold,
        vadType: 'server_vad' as const,
    };
}
class QwenVoiceSessionImpl implements VoiceSession {
    private client: QwenRealtimeClient | null = null;
    private capture = new QwenAudioCapture();
    private player = new QwenAudioPlayer();
    private conversationId: string | null = null;
    /** Set from settings at session start; see the settings doc comment. */
    private halfDuplex = false;
    /**
     * Timing for the "silence is free" comparison.
     *
     * `connectedAt` opens when the socket is ready and closes on teardown;
     * `speechMs` accumulates only the spans the server's VAD labelled as
     * speech. The difference is time that would have been billed by a
     * per-minute provider and is not billed here.
     */
    private connectedAt: number | null = null;
    private speechStartedAt: number | null = null;
    private speechMs = 0;
    private timingsFlushed = false;
    /**
     * Latency marks for the current turn, in epoch ms.
     *
     * The end-to-end delay a user actually feels is the sum of several
     * server-side stages, and without timestamps there is no way to tell which
     * one is slow:
     *
     *   speechStopAt  — the VAD decided the user stopped talking
     *   transcriptAt  — the ASR finished; the model has its input
     *   usageAt       — the whole turn (LLM + speech synthesis) is done
     */
    private speechStopAt: number | null = null;
    private transcriptAt: number | null = null;
    /**
     * Assistant text accumulated for the current turn.
     *
     * Deltas arrive several times per second; logging each one turned a
     * twelve-turn conversation into ~130 unreadable lines. They are buffered
     * and emitted once when the turn completes. Set `qwenLogDeltas` in settings
     * to see the raw stream when debugging timing.
     */
    private assistantBuffer = '';
    private logDeltas = false;
    /**
     * Drop incoming audio while a cancelled response drains.
     *
     * `player.flush()` clears what is already queued, but the server keeps
     * sending deltas for a moment after `response.cancel` — without this flag
     * they are re-queued and the assistant audibly carries on, which is exactly
     * the "I said stop and nothing happened" symptom.
     */
    private suppressPlayback = false;
    /** Failsafe so a cancel that never yields a new response cannot mute the
     *  assistant for the rest of the session. */
    private suppressTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * Set when the user says a bare stop word, cleared when that turn ends.
     *
     * A stop command should produce silence, not an acknowledgement. Cancelling
     * alone is not enough: if the response has not started yet the cancel is a
     * no-op and the server happily generates a reply to "停止", which then gets
     * spoken. This flag kills that reply wherever it appears — at
     * `response.created`, and again on every audio delta.
     */
    private muteNextResponse = false;
    /** Failsafe for `muteNextResponse`; separate from `suppressTimer` so the
     *  two mechanisms cannot cancel each other's timers. */
    private muteTimer: ReturnType<typeof setTimeout> | null = null;

    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        const settings = storage.getState().settings;
        // Credential + per-device tuning come from local settings; the account
        // settings blob is uploaded to the server (see sync/localSettings.ts).
        const local = storage.getState().localSettings;
        const qwenConfig: QwenConfig = {
            apiKey: local.qwenApiKey ?? '',
            workspaceId: local.qwenWorkspaceId ?? '',
            region: (settings.qwenRegion as QwenConfig['region']) ?? QWEN_DEFAULTS.region,
            model: settings.qwenModel ?? QWEN_DEFAULTS.model,
            voice: settings.qwenVoice ?? QWEN_DEFAULTS.voice,
        };

        if (!qwenConfig.apiKey || !qwenConfig.workspaceId) {
            throw new Error('缺少 DashScope API Key 或业务空间 ID');
        }

        const granted = await QwenAudioCapture.requestPermission();
        if (!granted) {
            throw new Error('麦克风权限未授予');
        }
        QwenAudioCapture.configureSession();

        storage.getState().setRealtimeStatus('connecting');
        this.halfDuplex = local.qwenHalfDuplex;
        this.logDeltas = local.qwenLogDeltas;

        const client = new QwenRealtimeClient(qwenConfig, {
            onReady: () => {
                storage.getState().setRealtimeStatus('connected');
                storage.getState().setRealtimeMode('idle');
                this.connectedAt = Date.now();
                this.capture.start({
                    onChunk: (pcm) => {
                        // The recorder is patched to capture through
                        // VOICE_COMMUNICATION, so Android's echo canceller
                        // removes the assistant's voice from the mic feed and
                        // the mic can stay live — which is what makes voice
                        // barge-in possible. `halfDuplex` is the escape hatch
                        // for devices with weak AEC: it mutes the mic during
                        // playback, trading barge-in for a guaranteed
                        // no-self-echo guarantee.
                        if (this.halfDuplex && this.player.isPlaying()) return;
                        this.client?.appendAudio(pcm);
                    },
                });
            },
            onClosed: () => {
                this.flushTimings();
                this.teardownAudio();
                storage.getState().setRealtimeStatus('disconnected');
                storage.getState().setRealtimeMode('idle', true);
                storage.getState().clearRealtimeModeDebounce();
                storage.getState().incrementVoiceSessionGeneration();
            },
            onError: (message) => {
                console.warn('[Qwen voice]', message);
                storage.getState().setRealtimeStatus('disconnected');
            },
            onUserTranscript: (text) => {
                this.transcriptAt = Date.now();
                const asr = this.speechStopAt ? this.transcriptAt - this.speechStopAt : null;
                console.log(
                    '[Qwen voice] user:',
                    text,
                    asr !== null ? `| ASR +${asr}ms` : '',
                );

                // A bare "stop" means go quiet, not "acknowledge me".
                if (isStopCommand(text)) {
                    this.muteNextResponse = true;
                    this.client?.cancelResponse();
                    this.player.flush();
                    console.log('[Qwen voice] stop command: reply suppressed');
                    // Belt and braces: if the turn never completes (nothing was
                    // generated at all), `onTurnComplete` never fires and the
                    // assistant would stay mute for good.
                    if (this.muteTimer) clearTimeout(this.muteTimer);
                    this.muteTimer = setTimeout(() => {
                        this.muteNextResponse = false;
                        this.muteTimer = null;
                    }, 8000);
                }
            },
            onAssistantText: (delta) => {
                this.assistantBuffer += delta;
                if (this.logDeltas) {
                    console.log('[Qwen voice] assistant delta:', delta);
                }
            },
            onAudioDelta: (pcm) => {
                // Two independent reasons to stay silent: the user cut in, or
                // the user asked for silence and the server replied anyway.
                if (this.suppressPlayback || this.muteNextResponse) return;
                this.player.enqueue(pcm);
            },
            onUserSpeechStart: () => {
                // Barge-in, in the order the server expects it:
                //   1. tell the server to stop generating
                //   2. stop trusting arriving deltas
                //   3. drop what is still queued locally
                // Doing only step 3 was the original bug: the server never
                // learned about the interruption, finished its whole reply, and
                // the late deltas refilled the player.
                const wasSpeaking = this.client?.isResponseActive ?? false;
                this.client?.cancelResponse();
                if (wasSpeaking) {
                    this.suppressPlayback = true;
                    // Normally `response.created` for the next turn clears
                    // this. If the server never starts one (the utterance was
                    // too short to commit), the assistant would stay mute.
                    if (this.suppressTimer) clearTimeout(this.suppressTimer);
                    this.suppressTimer = setTimeout(() => {
                        this.suppressPlayback = false;
                        this.suppressTimer = null;
                    }, 4000);
                }
                this.player.flush();
                // The interrupted reply still deserves a line in the log.
                this.flushAssistantText();
                console.log(
                    '[Qwen voice] barge-in:',
                    wasSpeaking ? 'cancelled active response' : 'no active response',
                );
                this.speechStartedAt = Date.now();
                // A new turn begins; clear the previous turn's marks so a
                // stale timestamp cannot be read as this turn's latency.
                this.speechStopAt = null;
                this.transcriptAt = null;
                storage.getState().setRealtimeMode('user-speaking', true);
            },
            onUserSpeechStop: () => {
                this.closeSpeechInterval();
                this.speechStopAt = Date.now();
                storage.getState().setRealtimeMode('idle');
            },
            onAssistantSpeechStart: () => {
                if (this.muteNextResponse) {
                    // The reply to a stop word — kill it before it speaks, and
                    // keep the flag set so its audio deltas stay dropped.
                    this.client?.cancelResponse();
                    this.player.flush();
                    return;
                }
                // A fresh response is starting; playback is meaningful again.
                this.suppressPlayback = false;
                if (this.suppressTimer) {
                    clearTimeout(this.suppressTimer);
                    this.suppressTimer = null;
                }
                storage.getState().setRealtimeMode('agent-speaking');
            },
            onAssistantSpeechStop: () => {
                storage.getState().setRealtimeMode('idle');
            },
            onTurnComplete: () => {
                this.flushAssistantText();
                // The suppressed turn is over; later replies are normal again.
                this.muteNextResponse = false;
            },
            onUsage: (usage: QwenUsage) => {
                // Persisted so the settings screen can show a running total;
                // the console bill is still the authority on what was charged.
                const totals = addQwenVoiceUsage({
                    inputAudioTokens: usage.inputAudioTokens,
                    inputTextTokens: usage.inputTextTokens,
                    outputAudioTokens: usage.outputAudioTokens,
                    outputTextTokens: usage.outputTextTokens,
                    turnCount: 1,
                    // Timing is recorded once per session in flushTimings();
                    // passing zeros here keeps the two accounting paths from
                    // double-counting.
                    connectionMs: 0,
                    speechMs: 0,
                });
                console.log(
                    '[Qwen voice] usage',
                    `in=${usage.inputTokens}(a${usage.inputAudioTokens})`,
                    `out=${usage.outputTokens}(a${usage.outputAudioTokens})`,
                    `| turn ${totals.turnCount}`,
                    this.latencySummary(),
                );
            },
            onToolCall: async (name, args) => {
                const tool = (realtimeClientTools as Record<string, unknown>)[name];
                if (typeof tool !== 'function') {
                    return `error (unknown tool: ${name})`;
                }
                return (tool as (a: unknown) => Promise<string>)(args);
            },
        });

        this.client = client;
        this.conversationId = `qwen-${Date.now()}`;
        this.connectedAt = null;
        this.speechStartedAt = null;
        this.speechMs = 0;
        this.timingsFlushed = false;
        client.connect(toSessionOptions(config));
        return this.conversationId;
    }

    async endSession(): Promise<void> {
        if (this.suppressTimer) {
            clearTimeout(this.suppressTimer);
            this.suppressTimer = null;
        }
        if (this.muteTimer) {
            clearTimeout(this.muteTimer);
            this.muteTimer = null;
        }
        this.suppressPlayback = false;
        this.muteNextResponse = false;
        this.flushAssistantText();
        this.flushTimings();
        this.teardownAudio();
        this.client?.close();
        this.client = null;
        this.conversationId = null;
        storage.getState().setRealtimeStatus('disconnected');
        storage.getState().setRealtimeMode('idle', true);
    }

    sendTextMessage(message: string): void {
        this.client?.sendText(message);
    }

    sendContextualUpdate(update: string): void {
        // Context is injected as a user turn the model is told not to answer.
        // Qwen has no separate "contextual update" channel.
        this.client?.sendText(update, { respond: false });
    }

    cancelResponse(): void {
        this.player.flush();
        this.client?.cancelResponse();
    }

    private teardownAudio(): void {
        this.capture.stop();
        this.player.stop();
    }

    /** Close an open speech span, if any. Safe to call repeatedly. */
    private closeSpeechInterval(): void {
        if (this.speechStartedAt !== null) {
            this.speechMs += Date.now() - this.speechStartedAt;
            this.speechStartedAt = null;
        }
    }

    /**
     * One-line latency breakdown for the turn that just finished.
     *
     * `ASR` is the server finalising the transcription after the VAD closed the
     * turn; `LLM+TTS` is everything after that until the turn completes. The
     * first is fixed pipeline cost, the second scales with the model's
     * reasoning effort — which is why running at `max` is visible here.
     */
    private latencySummary(): string {
        const now = Date.now();
        const stop = this.speechStopAt;
        const transcript = this.transcriptAt;
        if (stop === null) return '| latency n/a';
        const asr = transcript !== null ? transcript - stop : null;
        const total = now - stop;
        const parts = [
            asr !== null ? `ASR ${asr}ms` : 'ASR n/a',
            asr !== null ? `LLM+TTS ${total - asr}ms` : `total ${total}ms`,
        ];
        return `| ${parts.join(' · ')} · total ${total}ms`;
    }

    /** Emit the buffered reply as one line, then start a fresh buffer. */
    private flushAssistantText(): void {
        const text = this.assistantBuffer.trim();
        this.assistantBuffer = '';
        if (text) {
            console.log('[Qwen voice] assistant:', text);
        }
    }

    /**
     * Record connected and speech time exactly once per session.
     *
     * Called from both `endSession` and the socket's `onClosed`, since either
     * can be first depending on whether the user stopped it or the network did.
     */
    private flushTimings(): void {
        if (this.timingsFlushed || this.connectedAt === null) return;
        this.timingsFlushed = true;
        this.closeSpeechInterval();

        const connectionMs = Math.max(0, Date.now() - this.connectedAt);
        this.connectedAt = null;
        if (connectionMs < 1000) return;   // Ignore aborted starts.

        addQwenVoiceUsage({
            inputAudioTokens: 0,
            inputTextTokens: 0,
            outputAudioTokens: 0,
            outputTextTokens: 0,
            turnCount: 0,
            connectionMs,
            speechMs: Math.min(this.speechMs, connectionMs),
        });
    }
}

export const QwenVoiceSession: React.FC = () => {
    const registered = useRef(false);

    useEffect(() => {
        if (registered.current) return;
        try {
            registerVoiceSession(new QwenVoiceSessionImpl());
            registered.current = true;
        } catch (error) {
            console.error('Failed to register Qwen voice session:', error);
        }
    }, []);

    // No visible output; this exists to own the session lifetime.
    return null;
};
