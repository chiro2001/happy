import type { VoiceContextMode } from '../voiceConfig';

/**
 * Tools the model may call. The names must match `realtimeClientTools` keys —
 * note that Happy's own in-app documentation says `messageClaudeCode`, which is
 * wrong; the real key is `sendMessageToSession`.
 *
 * These definitions are re-sent and re-billed on every turn of a call, and the
 * realtime API has no cache, so their length is a recurring cost rather than a
 * one-off. Measured against a real tokenizer, this pair is ~440 tokens per
 * turn — 20% of a lite turn. That is why the read tools are not here: see the
 * minimal set below.
 */
const TOOL_DEFINITIONS = [
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
 * The minimal tier's set: the two above, plus the two read tools.
 *
 * That tier carries no transcript at all, so reading on demand is not a
 * convenience there — it is the only way to learn what an agent produced. The
 * tiers that push already hold that information, which is why the read tools
 * are here and not in the set above: for them the definitions would be rent on
 * a capability they have. Measured, the pair costs ~221 tokens on every turn.
 *
 * Everything is described in as few tokens as the model still acts on, because
 * this tier's whole premise is a small budget. Names and parameter shapes must
 * stay identical to the versions above: they are dispatched by name in
 * `onToolCall`.
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
 * Which tool set a tier is given.
 *
 * The two read tools are the minimal tier's alone. They exist to replace the
 * pushed transcript, and only that tier carries none — the others already hold
 * the information, so for them the definitions would be rent on a capability
 * they have. Measured against a real tokenizer, the pair costs ~221 tokens on
 * every turn.
 */
export function toolsForMode(mode: VoiceContextMode | undefined): unknown[] {
    return mode === 'minimal' ? TOOL_DEFINITIONS_MINIMAL : TOOL_DEFINITIONS;
}
