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
import { addQwenVoiceUsage, getVoiceMessageCount } from '@/sync/persistence';
import { realtimeClientTools } from '../realtimeClientTools';
import { registerVoiceSession } from '../RealtimeSession';
import { QwenRealtimeClient } from './client';
import { QwenAudioCapture, QwenAudioPlayer } from './audio';
import { QWEN_DEFAULTS } from './types';
import { isStopCommand } from './stopCommand';
import type { QwenConfig, QwenUsage } from './types';
import type { VoiceSession, VoiceSessionConfig } from '../types';
import { getVoiceConfig, type VoiceContextMode } from '../voiceConfig';
import { voiceHooks } from '../hooks/voiceHooks';
import { buildVoiceSystemPrompt } from '../voiceSystemPrompt';

/**
 * Tools the model may call. The names must match `realtimeClientTools` keys —
 * note that Happy's own in-app documentation says `messageClaudeCode`, which is
 * wrong; the real key is `sendMessageToSession`.
 */
const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            // Kept terse on purpose: tool definitions are re-sent and re-billed
            // on every turn, so their wording is a recurring cost, not a
            // one-off. The two read tools below add ~110 tokens to the fixed
            // overhead and exist to make the pushed transcript optional.
            name: 'getSessionHistory',
            description:
                '读取某个会话最近的对话内容。当你需要知道代理实际做了什么、' +
                '或用户之前说过什么时调用；上下文里没给的部分用它取。' +
                '省略 sessionId 表示当前会话。',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: '会话 id；默认当前会话' },
                    count: { type: 'number', description: '读取条数，默认 10，最多 50' },
                    agentOnly: { type: 'boolean', description: '只读代理的输出，跳过用户消息' },
                    before: { type: 'number', description: '读更早的：填上次结果里的 before 值' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'listSessions',
            description: '列出当前正在运行的会话。用户提到别的会话而你不知道 id 时调用。',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sendMessageToSession',
            description:
                '把用户的指令发送给正在运行的编码代理。' +
                '当用户要求转达、询问或指示代理做事时调用。' +
                '除非用户明确点名了别的会话，否则不要填 sessionId —— ' +
                '省略表示发到当前会话，比凭记忆填 id 可靠。',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: {
                        type: 'string',
                        description: '目标会话 id。用户明确点名其他会话时才填；默认省略。',
                    },
                    message: { type: 'string', description: '要发送的文本' },
                },
                // sessionId is deliberately not required: see the description.
                required: ['message'],
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

/**
 * The same two tools, described in as few tokens as the model still
 * understands — for the minimal tier, where the tool block is a large share of
 * a deliberately small budget. Names and parameter shapes must stay identical:
 * they are dispatched by name in `onToolCall`.
 */
const TOOL_DEFINITIONS_MINIMAL = [
    {
        type: 'function',
        function: {
            // The minimal tier carries no transcript at all, so this is not a
            // convenience there — it is the only way to learn what an agent
            // produced. Described in as few words as the model still acts on.
            name: 'getSessionHistory',
            description: '读取会话最近的对话内容；上下文里没有的细节用它取。省略 sessionId 表示当前会话。',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string' },
                    count: { type: 'number' },
                    agentOnly: { type: 'boolean' },
                    before: { type: 'number' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'listSessions',
            description: '列出正在运行的会话。',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sendMessageToSession',
            description: '把用户指令发给编码代理；省略 sessionId 表示当前会话',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string' },
                    message: { type: 'string' },
                },
                required: ['message'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'processPermissionRequest',
            description: '批准或拒绝授权请求',
            parameters: {
                type: 'object',
                properties: {
                    requestId: { type: 'string' },
                    decision: { type: 'string', enum: ['allow', 'deny'] },
                },
                required: ['requestId', 'decision'],
            },
        },
    },
];

/**
 * Rough token weight of a string, matching the estimator in
 * tools/qwen-realtime-test/measure_context.py: ~4 chars per token for ASCII and
 * ~1.5 for CJK. Good to about ±10%, which is enough to tell which component is
 * paying for a surprise.
 */
function estimateTokens(text: string): number {
    let cjk = 0;
    let ascii = 0;
    let other = 0;
    for (const char of text) {
        const code = char.codePointAt(0)!;
        if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
        else if (code < 128) ascii += 1;
        else other += 1;
    }
    return Math.round(cjk / 1.5 + ascii / 4 + other / 3);
}

function toolsForMode(mode: VoiceContextMode | undefined) {
    return mode === 'minimal' ? TOOL_DEFINITIONS_MINIMAL : TOOL_DEFINITIONS;
}

/** Turn the shared session config into provider-specific options. */
function toSessionOptions(config: VoiceSessionConfig, tools: unknown[]) {
    // The client-side stop-word suppressor handles the common case, but telling
    // the model directly covers phrasings it does not enumerate and avoids
    // generating tokens only to throw them away.
    const stopInstruction =
        '\n\n【重要】当用户要求你停止说话（例如说“停止”“停下”“别说了”）时，'
        + '必须立刻保持安静，不要回复任何内容，也不要确认收到。';

    // The context states which session is current, but a rule is cheaper to
    // follow than an inference. Without it the model treated "current session"
    // as roughly whichever session it had been talking about, and a switch
    // mid-call went unnoticed until the user noticed for it.
    const routingInstruction =
        '\n\n【会话路由】上下文里的「Current session」就是用户此刻正在看的会话，'
        + '也是没有点名其他会话时消息的默认去处。'
        + '当它发生变化时，以最新的那条为准，不要沿用之前的会话；'
        + '之前的会话此后的产出都只是后台更新。'
        + '用户说「这个会话」「当前会话」时，一律指这一条。';

    const instructions = config.systemPrompt
        ? config.systemPrompt + stopInstruction + routingInstruction
        : (stopInstruction + routingInstruction).trim();

    return {
        instructions,
        // The brief is already inside `instructions`: `buildVoiceSystemPrompt`
        // embeds it under "# Conversation history so far". Passing it again
        // here would send the same text a second time as the opening user turn,
        // and this is the largest single injection in the session — it is
        // re-billed on every turn for as long as the connection lasts. Only
        // send it separately when there is no system prompt to carry it.
        initialContext: config.systemPrompt ? undefined : config.initialContext,
        tools,
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
    /** Credentials + model, resolved once per session and reused on reconnect. */
    private qwenConfig: QwenConfig | null = null;
    /** The config we were started with; the basis for a fresh brief later. */
    private lastConfig: VoiceSessionConfig | null = null;
    /** Tool block for the current tier, chosen in `startSession`. */
    private tools: unknown[] = TOOL_DEFINITIONS;
    /** Assistant turns completed in the current connection. */
    private turnCount = 0;
    /**
     * Bumped on every connect. Sockets from a previous connection keep firing
     * their callbacks after a reconnect, and without this guard the old
     * socket's `onClosed` would tear down the *new* recorder.
     */
    private connectionSeq = 0;
    /** True while a reconnect is in flight, so callbacks can stand down. */
    private reconnecting = false;

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
        // A second start (user stops and starts again, or the provider swaps)
        // must not leave the previous socket running: bump the sequence first
        // so its callbacks cannot disturb the new session, then close it.
        this.connectionSeq += 1;
        this.client?.close();
        this.client = null;
        this.teardownAudio();
        this.halfDuplex = local.qwenHalfDuplex;
        this.logDeltas = local.qwenLogDeltas;
        this.lastConfig = config;
        this.qwenConfig = qwenConfig;
        // Tools follow the context tier: the minimal tier trades tool
        // descriptions for budget, so it gets the compressed block.
        this.tools = toolsForMode(settings.voiceContextMode);
        this.turnCount = 0;

        this.logSessionComposition(config);
        this.connectOnce(config);
        return this.conversationId;
    }

    /**
     * Log what the opening turn actually costs, broken down.
     *
     * Worth its line because the fixed part is invisible otherwise: a tier can
     * look correct in the source and still bill more than expected, and the
     * only way to tell which component is responsible is to see them side by
     * side against the first `usage` line for the session.
     */
    private logSessionComposition(config: VoiceSessionConfig): void {
        const mode = storage.getState().settings.voiceContextMode;
        const tools = JSON.stringify(this.tools);
        const prompt = config.systemPrompt ?? '';
        const brief = config.systemPrompt ? '' : (config.initialContext ?? '');
        const parts = [
            `prompt=${estimateTokens(prompt)}`,
            `tools=${estimateTokens(tools)}`,
            `brief=${estimateTokens(brief)}`,
        ];
        const total = estimateTokens(prompt) + estimateTokens(tools) + estimateTokens(brief);
        console.log(
            `[Qwen voice] session start · tier=${mode} ·`,
            parts.join(' '),
            `| est. fixed ≈ ${total} tok`,
        );
    }

    /**
     * Open one connection. Called by `startSession` and again on a context
     * reset; everything that must not straddle a reconnect is reset here.
     */
    private connectOnce(config: VoiceSessionConfig): void {
        const qwenConfig = this.qwenConfig;
        if (!qwenConfig) return;
        const seq = ++this.connectionSeq;
        const isCurrent = () => this.connectionSeq === seq;

        const client = new QwenRealtimeClient(qwenConfig, {
            onReady: () => {
                if (!isCurrent()) return;
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
                // A socket superseded by a reconnect must not report a
                // disconnect: the UI would tear down a session that is in fact
                // still running.
                if (!isCurrent()) return;
                this.flushTimings();
                this.teardownAudio();
                storage.getState().setRealtimeStatus('disconnected');
                storage.getState().setRealtimeMode('idle', true);
                storage.getState().clearRealtimeModeDebounce();
                storage.getState().incrementVoiceSessionGeneration();
            },
            onError: (message) => {
                if (!isCurrent()) return;
                console.warn('[Qwen voice]', message);
                // Deliberately does not touch the connection status.
                //
                // The server's `error` events are scoped to one operation, not
                // to the socket: "Conversation has none active response" is what
                // a cancel with nothing in flight returns, and the session
                // carries on afterwards. Reporting it as a disconnect hid the
                // voice status bar — which renders on `status !== 'disconnected'`
                // — while the microphone and the socket kept running, so the
                // only way to stop the call was to know it was still there.
                //
                // A connection that really died reports through onClosed, which
                // is the single place that owns the status transition.
            },
            onUserTranscript: (text) => {
                if (!isCurrent()) return;
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
                if (!isCurrent()) return;
                this.flushAssistantText();
                // The suppressed turn is over; later replies are normal again.
                this.muteNextResponse = false;
                // Consume the speech mark. A turn triggered by a prompt rather
                // than by the user speaking has no speech to measure from, and
                // leaving the previous turn's mark in place made those turns
                // report the whole idle gap as "LLM+TTS" — 65s and 71s in one
                // captured session, neither of which was real.
                this.speechStopAt = null;
                this.maybeResetContext();
            },
            onUsage: (usage: QwenUsage) => {
                if (!isCurrent()) return;
                this.turnCount += 1;
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
                if (!isCurrent()) return `error (stale connection)`;
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
        client.connect(toSessionOptions(config, this.tools));
    }

    /**
     * Reconnect with a fresh brief once the tier's turn budget is spent.
     *
     * The server keeps everything it has already been told and re-bills it on
     * every turn, so a long conversation grows quadratically. Dropping the
     * transcript is the only way to actually stop paying for it: sending a
     * summary instead would itself stay in context for good.
     *
     * The user hears a short pause and nothing else — the recorder and player
     * are restarted on the new socket and the UI status never leaves
     * `connected`.
     */
    private maybeResetContext(): void {
        const limit = getVoiceConfig(storage.getState().settings.voiceContextMode).RESET_AFTER_TURNS;
        if (limit === null || this.reconnecting || this.turnCount < limit) return;
        const config = this.lastConfig;
        if (!config || !this.client) return;

        this.reconnecting = true;
        console.log(
            `[Qwen voice] context reset after ${this.turnCount} turns - reconnecting with a fresh brief`,
        );
        try {
            // Rebuild the brief from live state. This also re-reads the tier, so
            // a setting changed mid-session is honoured from here on.
            const initialContext = voiceHooks.onVoiceStarted(config.sessionId);
            const settings = storage.getState().settings;
            const systemPrompt = buildVoiceSystemPrompt({
                initialContext,
                onboardingPromptLoadCount: 0,
                voiceMessageCount: getVoiceMessageCount(),
                includePaidVoiceOnboarding: false,
                contextMode: settings.voiceContextMode,
            });
            this.tools = toolsForMode(settings.voiceContextMode);

            this.flushAssistantText();
            this.flushTimings();
            this.teardownAudio();
            // Retire the socket, then let `connectOnce` take the next sequence.
            // In between, nothing this socket reports can reach the UI.
            this.connectionSeq += 1;
            this.client.close();
            this.client = null;

            this.turnCount = 0;
            this.suppressPlayback = false;
            this.muteNextResponse = false;
            this.lastConfig = { ...config, initialContext, systemPrompt };
            this.logSessionComposition(this.lastConfig);
            this.connectOnce(this.lastConfig);
        } catch (error) {
            console.warn('[Qwen voice] context reset failed:', error);
            storage.getState().setRealtimeStatus('disconnected');
        } finally {
            this.reconnecting = false;
        }
    }

    async endSession(): Promise<void> {
        // Retire the current socket before tearing anything down: callbacks
        // arriving after this point belong to a session that no longer exists.
        this.connectionSeq += 1;
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
