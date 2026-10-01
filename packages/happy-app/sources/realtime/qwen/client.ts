/**
 * Protocol client for Qwen-Omni-Realtime over WebSocket.
 *
 * Deliberately free of React and of React Native: everything here is plain
 * TypeScript so it can be unit-tested and reasoned about, and so the same code
 * would work on the web build. Audio I/O lives in `./audio`.
 *
 * The event names mirror OpenAI's Realtime API, which this endpoint follows.
 * Two behaviours were learned the hard way (see tools/qwen-realtime-web/PITFALLS.md):
 *
 *  1. Tool calls must be answered as a batch. A single response can carry
 *     several `function_call_arguments.done` events; replying after each one
 *     and firing `response.create` per reply makes the server reject the extra
 *     calls ("Conversation already has an active response") and the model
 *     re-issues them, which loops. Instead, collect them and answer once, at
 *     `response.done`, with a single `response.create`.
 *  2. `response.cancel` is only valid while a response is in flight. Sending it
 *     while idle returns "Cannot cancel response before response.created".
 *     `cancelResponse()` checks local state first.
 */

import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import type { QwenClientCallbacks, QwenConfig, QwenUsage } from './types';
import { QWEN_DEFAULTS } from './types';

/** Cap on tool-call round trips inside one user turn, to break feedback loops. */
const MAX_TOOL_ROUNDS = 5;

interface PendingToolCall {
    callId: string;
    name: string;
    args: Record<string, unknown>;
}

export interface QwenSessionOptions {
    /** System prompt. Replaces `instructions`. */
    instructions?: string;
    /** Extra context handed to the model up front (session history, etc.). */
    initialContext?: string;
    /** Tool definitions in OpenAI function-calling shape. */
    tools?: unknown[];
    voice?: string;
    silenceDurationMs?: number;
    vadThreshold?: number;
    /** `server_vad` (default) or `semantic_vad`, which also filters backchannels. */
    vadType?: 'server_vad' | 'semantic_vad';
    /**
     * Ask for a transcript of the user's own audio. Note this runs a *separate*
     * ASR model whose accuracy measured well below the end-to-end model's —
     * display only, never drive logic from it.
     */
    transcription?: boolean;
}

/**
 * Creates the socket. Injected so the client can be exercised outside React
 * Native: RN's `WebSocket` accepts a third argument carrying headers, which is
 * what lets us authenticate straight to DashScope, but Node's global
 * `WebSocket` silently ignores it. Tests pass a `ws`-backed factory instead.
 */
export type WebSocketFactory = (
    url: string,
    headers: Record<string, string>,
) => WebSocket;

/**
 * Default factory: React Native's WebSocket with an options bag.
 *
 * The RN typings do not describe the third argument, so the constructor is
 * widened here rather than sprinkled with casts at the call site.
 */
const reactNativeWebSocketFactory: WebSocketFactory = (url, headers) => {
    const WS = WebSocket as unknown as {
        new (
            url: string,
            protocols?: string | string[] | null,
            options?: unknown,
        ): WebSocket;
    };
    return new WS(url, null, { headers });
};

export interface QwenClientOptions {
    /** Override the socket implementation. Defaults to React Native's. */
    createSocket?: WebSocketFactory;
}

export class QwenRealtimeClient {
    private ws: WebSocket | null = null;
    private config: QwenConfig;
    private callbacks: QwenClientCallbacks;
    private createSocket: WebSocketFactory;
    private closed = false;

    private sessionReady = false;
    private responseActive = false;
    private pendingToolCalls: PendingToolCall[] = [];
    private toolRounds = 0;

    constructor(
        config: QwenConfig,
        callbacks: QwenClientCallbacks,
        options: QwenClientOptions = {},
    ) {
        this.config = config;
        this.callbacks = callbacks;
        this.createSocket = options.createSocket ?? reactNativeWebSocketFactory;
    }

    static buildUrl(config: QwenConfig): string {
        const { workspaceId, region, model } = config;
        return (
            `wss://${workspaceId}.${region}.maas.aliyuncs.com/api-ws/v1/realtime` +
            `?model=${encodeURIComponent(model)}`
        );
    }

    /**
     * Open the socket and configure the session.
     *
     * React Native's WebSocket takes headers as a third argument, which is what
     * lets us authenticate straight to DashScope without a proxy. (Browsers
     * cannot do this — that is why the web test page needed one.)
     */
    connect(options: QwenSessionOptions = {}): void {
        const url = QwenRealtimeClient.buildUrl(this.config);
        this.ws = this.createSocket(url, {
            Authorization: `Bearer ${this.config.apiKey}`,
        });

        this.ws.onopen = () => {
            // `session.created` follows; configuration is sent from onmessage so
            // the server has definitely accepted the connection first.
        };

        this.ws.onmessage = (event: WebSocketMessageEvent) => {
            let msg: Record<string, unknown>;
            try {
                msg = JSON.parse(String(event.data));
            } catch {
                return;
            }
            this.handleEvent(msg, options);
        };

        this.ws.onerror = () => {
            if (!this.closed) {
                this.callbacks.onError('voice connection error');
            }
        };

        this.ws.onclose = () => {
            this.sessionReady = false;
            this.responseActive = false;
            if (!this.closed) {
                this.callbacks.onClosed();
            }
        };
    }

    get isReady(): boolean {
        return this.sessionReady && this.ws?.readyState === 1;
    }

    get isResponseActive(): boolean {
        return this.responseActive;
    }

    /** Append one chunk of 16 kHz mono s16le PCM. */
    appendAudio(pcm: Uint8Array): void {
        if (!this.isReady) return;
        this.send({
            type: 'input_audio_buffer.append',
            audio: encodeBase64(pcm),
        });
    }

    /**
     * Send a text turn. Used by `sendTextMessage` and by contextual updates,
     * which are ordinary user messages the model is told not to answer.
     */
    sendText(text: string, opts: { respond?: boolean } = {}): void {
        if (!this.isReady) return;
        this.send({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text }],
            },
        });
        if (opts.respond !== false) {
            this.resetTurnState();
            this.send({ type: 'response.create' });
        }
    }

    /**
     * Ask the server to stop the in-flight response. Safe to call at any time:
     * when idle it only clears local state, because the server rejects a cancel
     * that arrives before `response.created`.
     */
    cancelResponse(): void {
        if (!this.isReady) return;
        if (!this.responseActive) {
            this.callbacks.onAssistantSpeechStop();
            return;
        }
        this.send({ type: 'response.cancel' });
    }

    close(): void {
        this.closed = true;
        this.sessionReady = false;
        this.responseActive = false;
        this.pendingToolCalls = [];
        try {
            this.ws?.close();
        } catch {
            // Already closed; nothing to do.
        }
        this.ws = null;
    }

    // ── internals ──────────────────────────────────────────────────────────

    private send(payload: Record<string, unknown>): void {
        try {
            this.ws?.send(JSON.stringify(payload));
        } catch (error) {
            this.callbacks.onError(`send failed: ${String(error)}`);
        }
    }

    private resetTurnState(): void {
        this.toolRounds = 0;
        this.pendingToolCalls = [];
    }

    private buildSession(options: QwenSessionOptions): Record<string, unknown> {
        const session: Record<string, unknown> = {
            modalities: ['text', 'audio'],
            voice: options.voice ?? this.config.voice ?? QWEN_DEFAULTS.voice,
            input_audio_format: 'pcm',
            output_audio_format: 'pcm',
            turn_detection: {
                type: options.vadType ?? 'server_vad',
                threshold: options.vadThreshold ?? QWEN_DEFAULTS.vadThreshold,
                silence_duration_ms:
                    options.silenceDurationMs ?? QWEN_DEFAULTS.silenceDurationMs,
            },
        };

        if (options.instructions) {
            session.instructions = options.instructions;
        }
        if (options.tools?.length) {
            session.tools = options.tools;
        }
        if (options.transcription) {
            session.input_audio_transcription = { model: 'qwen3-asr-flash-realtime' };
        }
        return session;
    }

    private handleEvent(
        msg: Record<string, unknown>,
        options: QwenSessionOptions,
    ): void {
        const type = String(msg.type ?? '');

        switch (type) {
            case 'session.created':
                this.send({ type: 'session.update', session: this.buildSession(options) });
                return;

            case 'session.updated': {
                this.sessionReady = true;
                this.callbacks.onReady();
                // Context goes in as the first user turn so the model has it
                // before the user says anything.
                if (options.initialContext) {
                    this.sendText(
                        `背景信息（不要直接回答这一段）：\n${options.initialContext}`,
                        { respond: false },
                    );
                }
                return;
            }

            case 'input_audio_buffer.speech_started':
                this.resetTurnState();
                this.callbacks.onUserSpeechStart();
                return;

            case 'input_audio_buffer.speech_stopped':
                this.callbacks.onUserSpeechStop();
                return;

            case 'response.created':
                this.responseActive = true;
                // Announced so the UI can show "agent speaking" and so the
                // barge-in suppressor knows a fresh response has begun.
                this.callbacks.onAssistantSpeechStart();
                return;

            case 'response.audio.delta':
                this.callbacks.onAudioDelta(decodeBase64(String(msg.delta ?? '')));
                return;

            case 'response.audio_transcript.delta':
            case 'response.text.delta':
                this.callbacks.onAssistantText(String(msg.delta ?? ''));
                return;

            case 'conversation.item.input_audio_transcription.completed':
                this.callbacks.onUserTranscript(String(msg.transcript ?? ''));
                return;

            case 'response.function_call_arguments.done': {
                // Collect only — answering here is what caused the loop.
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(String(msg.arguments ?? '{}'));
                } catch {
                    // Leave args empty; the tool handler will report the problem.
                }
                this.pendingToolCalls.push({
                    callId: String(msg.call_id ?? ''),
                    name: String(msg.name ?? ''),
                    args,
                });
                return;
            }

            case 'response.done':
                void this.onResponseDone(msg);
                return;

            case 'error':
                this.callbacks.onError(this.describeError(msg));
                return;

            default:
                return;
        }
    }

    private async onResponseDone(msg: Record<string, unknown>): Promise<void> {
        this.responseActive = false;
        this.callbacks.onAssistantSpeechStop();

        const response = (msg.response ?? {}) as Record<string, unknown>;
        const usage = this.parseUsage(response.usage);
        if (usage) {
            this.callbacks.onUsage(usage);
        }

        if (this.pendingToolCalls.length === 0) {
            this.callbacks.onTurnComplete?.();
            return;
        }

        this.toolRounds += 1;
        if (this.toolRounds > MAX_TOOL_ROUNDS) {
            this.callbacks.onError(
                `连续 ${MAX_TOOL_ROUNDS} 轮工具调用，已停止继续以免死循环`,
            );
            this.pendingToolCalls = [];
            this.callbacks.onTurnComplete?.();
            return;
        }

        const batch = this.pendingToolCalls;
        this.pendingToolCalls = [];

        // Run the handlers first: the model needs every result before it can
        // continue, and a slow handler must not interleave with a new response.
        const results = await Promise.all(
            batch.map(async (call) => {
                try {
                    const output = await this.callbacks.onToolCall(
                        call.name,
                        call.args,
                        call.callId,
                    );
                    return { callId: call.callId, output };
                } catch (error) {
                    return { callId: call.callId, output: `error: ${String(error)}` };
                }
            }),
        );

        if (!this.isReady) return;

        for (const result of results) {
            this.send({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: result.callId,
                    output: result.output,
                },
            });
        }
        // Exactly one continuation for the whole batch.
        this.send({ type: 'response.create' });
    }

    private parseUsage(raw: unknown): QwenUsage | null {
        if (!raw || typeof raw !== 'object') return null;
        const u = raw as Record<string, unknown>;
        // The API spells these `input_tokens_details`; accept the singular form
        // too so a rename does not silently zero out the audio line.
        const inDetails = (u.input_tokens_details ?? u.input_token_details ?? {}) as Record<string, number>;
        const outDetails = (u.output_tokens_details ?? u.output_token_details ?? {}) as Record<string, number>;

        const inputAudio = inDetails.audio_tokens ?? 0;
        const outputAudio = outDetails.audio_tokens ?? 0;
        const inputTotal = Number(u.input_tokens ?? 0);
        const outputTotal = Number(u.output_tokens ?? 0);

        return {
            inputTokens: inputTotal,
            outputTokens: outputTotal,
            inputAudioTokens: inputAudio,
            inputTextTokens: Math.max(inputTotal - inputAudio, 0),
            outputAudioTokens: outputAudio,
            outputTextTokens: Math.max(outputTotal - outputAudio, 0),
        };
    }

    private describeError(msg: Record<string, unknown>): string {
        const err = (msg.error ?? {}) as Record<string, unknown>;
        const message = err.message ?? err.code ?? JSON.stringify(err);
        return String(message);
    }
}
