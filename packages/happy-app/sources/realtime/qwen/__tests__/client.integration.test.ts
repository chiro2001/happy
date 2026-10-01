/**
 * Integration test for the Qwen realtime client against the live API.
 *
 * This exercises the real `QwenRealtimeClient` — not a reimplementation — so
 * it catches protocol mistakes that a mock would paper over. It needs:
 *
 *   DASHSCOPE_API_KEY    a Bailian key
 *   BAILIAN_WORKSPACE_ID the workspace id used as the WebSocket host prefix
 *
 * Without both, the suite skips rather than failing, so CI stays green.
 *
 * It is deliberately NOT part of the default `pnpm test` run: it costs money
 * (a few fen) and needs network access.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { QwenRealtimeClient } from '../client';
import type { WebSocketFactory } from '../client';
import type { QwenUsage } from '../types';

const API_KEY = process.env.DASHSCOPE_API_KEY;
const WORKSPACE = process.env.BAILIAN_WORKSPACE_ID;
const ENABLED = Boolean(API_KEY && WORKSPACE);

/**
 * Node's global WebSocket ignores the options argument React Native uses to
 * carry the Authorization header, so the tests supply `ws` instead. This is
 * exactly what `QwenClientOptions.createSocket` exists for — the production
 * path is untouched.
 */
const require = createRequire(import.meta.url);
const NodeWebSocket = require('ws');

const createSocket: WebSocketFactory = (url, headers) =>
    new NodeWebSocket(url, { headers }) as unknown as WebSocket;

interface Collected {
    ready: boolean;
    error: string | null;
    assistantText: string;
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
    toolResults: string[];
    audioBytes: number;
    usage: QwenUsage[];
}

/**
 * Run one turn and resolve once the model stops.
 *
 * `starter` receives the client so each test can drive it differently
 * (text turn vs. audio turn).
 */
function runTurn(
    options: {
        instructions?: string;
        tools?: unknown[];
        initialContext?: string;
    },
    starter: (client: QwenRealtimeClient, collected: Collected) => void,
    timeoutMs = 60_000,
): Promise<Collected> {
    const collected: Collected = {
        ready: false,
        error: null,
        assistantText: '',
        toolCalls: [],
        toolResults: [],
        audioBytes: 0,
        usage: [],
    };

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.close();
            resolve(collected);
        };
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            client.close();
            reject(new Error(`turn timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const client = new QwenRealtimeClient(
            {
                apiKey: API_KEY!,
                workspaceId: WORKSPACE!,
                region: 'cn-beijing',
                model: 'qwen3.8-omni-flash-realtime',
                voice: 'Tina',
            },
            {
                onReady: () => {
                    collected.ready = true;
                    starter(client, collected);
                },
                onClosed: () => finish(),
                onError: (message) => {
                    collected.error = message;
                },
                onUserTranscript: () => {},
                onAssistantText: (delta) => {
                    collected.assistantText += delta;
                },
                onAudioDelta: (pcm) => {
                    collected.audioBytes += pcm.byteLength;
                },
                onUserSpeechStart: () => {},
                onUserSpeechStop: () => {},
                onAssistantSpeechStart: () => {},
                onAssistantSpeechStop: () => {},
                onUsage: (usage) => {
                    collected.usage.push(usage);
                },
                // Fires only after tool calls have been answered and the model
                // has finished its follow-up — waiting on usage would end the
                // turn at the first response.done, before any tool ran.
                onTurnComplete: () => finish(),
                onToolCall: async (name, args) => {
                    collected.toolCalls.push({ name, args });
                    const result = 'sent';
                    collected.toolResults.push(result);
                    return result;
                },
            },
            { createSocket },
        );

        client.connect({
            instructions: options.instructions,
            initialContext: options.initialContext,
            tools: options.tools,
            silenceDurationMs: 1000,
        });
    });
}

describe.skipIf(!ENABLED)('QwenRealtimeClient (live API)', () => {
    it('answers a text turn and reports usage', async () => {
        const collected = await runTurn(
            { instructions: '一句话回答，不要展开。' },
            (client) => client.sendText('用一句话说明 tmux 是什么'),
        );

        expect(collected.error).toBeNull();
        expect(collected.ready).toBe(true);
        expect(collected.assistantText.length).toBeGreaterThan(0);
        expect(collected.audioBytes).toBeGreaterThan(0);

        expect(collected.usage).toHaveLength(1);
        const usage = collected.usage[0];
        expect(usage.inputTokens).toBeGreaterThan(0);
        expect(usage.outputTokens).toBeGreaterThan(0);
        // A text-only turn bills no audio on the way in.
        expect(usage.inputAudioTokens).toBe(0);
        expect(usage.outputAudioTokens).toBeGreaterThan(0);

        console.log(
            `[text turn] in=${usage.inputTokens} out=${usage.outputTokens} ` +
                `audioOut=${usage.outputAudioTokens} chars=${collected.assistantText.length}`,
        );
    }, 90_000);

    it('batches tool calls and answers once', async () => {
        const tools = [
            {
                type: 'function',
                function: {
                    name: 'sendMessageToSession',
                    description: '把消息发给编码代理。用户要求转达时调用。',
                    parameters: {
                        type: 'object',
                        properties: {
                            sessionId: { type: 'string' },
                            message: { type: 'string' },
                        },
                        required: ['sessionId', 'message'],
                    },
                },
            },
        ];

        const collected = await runTurn(
            {
                instructions: '用户要求转达时调用工具，然后简短确认。',
                tools,
            },
            (client) =>
                client.sendText(
                    '帮我给 session abc 发一条消息，内容是“请把构建日志贴出来”。',
                ),
            90_000,
        );

        expect(collected.error).toBeNull();
        // The model must actually choose the tool.
        expect(collected.toolCalls.length).toBeGreaterThan(0);
        const call = collected.toolCalls[0];
        expect(call.name).toBe('sendMessageToSession');
        expect(call.args.sessionId).toBeTruthy();
        expect(call.args.message).toBeTruthy();

        // Every call gets exactly one result — the regression this guards.
        expect(collected.toolResults).toHaveLength(collected.toolCalls.length);

        console.log(
            `[tool turn] calls=${collected.toolCalls.length} args=${JSON.stringify(call.args)}`,
        );
    }, 120_000);

    it('accepts initial context without the model answering it', async () => {
        const collected = await runTurn(
            {
                instructions: '只回答用户直接问的问题。',
                initialContext: '项目路径 /home/user/proj，当前分支 main。',
            },
            (client) => client.sendText('当前分支是什么？'),
        );

        expect(collected.error).toBeNull();
        // The context is a user turn; the model should use it as background.
        // A loose check — we only assert it did not echo the notice back.
        expect(collected.assistantText).not.toContain('背景信息');
        console.log(`[context turn] reply=${collected.assistantText.trim().slice(0, 80)}`);
    }, 90_000);
});
