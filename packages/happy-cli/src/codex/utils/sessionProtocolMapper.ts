import { createHash, randomUUID } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import type { ReasoningOutput } from './reasoningProcessor';
import type { DiffToolCall, DiffToolResult } from './diffProcessor';
import {
    createEnvelope,
    stripLeadingTaskNotificationWrappers,
    type CreateEnvelopeOptions,
    type SessionEnvelope,
    type SessionUsage,
} from '@slopus/happy-wire';
import type { Thread, ThreadItem, ThreadTurn } from '../codexAppServerTypes';
import { stripHappySystemBlocks } from '../codexPrompt';

export type CodexTurnState = {
    currentTurnId: string | null;
    startedSubagents?: Set<string>;
    activeSubagents?: Set<string>;
    providerSubagentToSessionSubagent?: Map<string, string>;
    subagentTitles?: Map<string, string>;
    collabReceiverThreadIdsByCall?: Map<string, string[]>;
    collabToolByCall?: Map<string, string>;
};

type CodexMapperResult = {
    currentTurnId: string | null;
    startedSubagents: Set<string>;
    activeSubagents: Set<string>;
    providerSubagentToSessionSubagent: Map<string, string>;
    subagentTitles: Map<string, string>;
    collabReceiverThreadIdsByCall: Map<string, string[]>;
    collabToolByCall: Map<string, string>;
    envelopes: SessionEnvelope[];
};

type LegacyToolLikeMessage = {
    type: 'tool-call' | 'tool-call-result';
    callId: string;
    name?: string;
    input?: unknown;
    output?: {
        content?: string;
        status?: 'completed' | 'canceled';
    };
};

type TurnEndStatus = 'completed' | 'failed' | 'cancelled';

function getStartedSubagents(state: CodexTurnState): Set<string> {
    return state.startedSubagents ?? new Set<string>();
}

function getActiveSubagents(state: CodexTurnState): Set<string> {
    return state.activeSubagents ?? new Set<string>();
}

function getProviderSubagentToSessionSubagent(state: CodexTurnState): Map<string, string> {
    return state.providerSubagentToSessionSubagent ?? new Map<string, string>();
}

function getSubagentTitles(state: CodexTurnState): Map<string, string> {
    return state.subagentTitles ?? new Map<string, string>();
}

function getCollabReceiverThreadIdsByCall(state: CodexTurnState): Map<string, string[]> {
    return state.collabReceiverThreadIdsByCall ?? new Map<string, string[]>();
}

function getCollabToolByCall(state: CodexTurnState): Map<string, string> {
    return state.collabToolByCall ?? new Map<string, string>();
}

function deterministicSessionSubagentId(providerSubagent: string): string {
    const digest = createHash('sha256')
        .update(`codex-subagent:${providerSubagent}`)
        .digest('hex');
    return `c${digest.slice(0, 23)}`;
}

function ensureSessionSubagent(
    providerSubagent: string,
    providerSubagentToSessionSubagent: Map<string, string>,
): string {
    const existing = providerSubagentToSessionSubagent.get(providerSubagent);
    if (existing) {
        return existing;
    }

    const created = deterministicSessionSubagentId(providerSubagent);
    providerSubagentToSessionSubagent.set(providerSubagent, created);
    return created;
}

function maybeEmitSubagentStart(
    subagent: string | undefined,
    opts: CreateEnvelopeOptions,
    startedSubagents: Set<string>,
    activeSubagents: Set<string>,
    subagentTitles: Map<string, string>,
    envelopes: SessionEnvelope[],
    /**
     * Where this agent came from, when the caller knows. `threadId` is the
     * agent's own thread — the handle `thread/read` and `thread/fork` need, and
     * not recoverable from the derived `subagent` id; `parentThreadId` is the
     * thread it was reported on.
     *
     * Optional because only the activity events carry this authoritatively, and
     * they arrive first in practice (measured: activity at +2640ms, the child's
     * first command at +3748ms). A `start` that arrives without it is still
     * correct, just less informative, and a later activity for the same agent
     * carries the same `start` guard so nothing is re-emitted.
     */
    origin?: { threadId?: string; parentThreadId?: string },
): void {
    if (!subagent) {
        return;
    }

    // An agent that is already running has nothing new to announce — activity
    // repeats for every command it runs. Only a genuine transition (first
    // sighting, or a resumed agent that had stopped) produces a boundary.
    if (activeSubagents.has(subagent)) {
        return;
    }

    const title = subagentTitles.get(subagent);
    envelopes.push(createEnvelope('agent', {
        t: 'start',
        ...(title ? { title } : {}),
        ...(origin?.threadId ? { threadId: origin.threadId } : {}),
        ...(origin?.parentThreadId ? { parentThreadId: origin.parentThreadId } : {}),
    }, { ...opts, subagent }));
    startedSubagents.add(subagent);
    activeSubagents.add(subagent);
}

function maybeEmitSubagentStop(
    subagent: string | undefined,
    opts: CreateEnvelopeOptions,
    activeSubagents: Set<string>,
    envelopes: SessionEnvelope[],
): void {
    if (!subagent || !activeSubagents.has(subagent)) {
        return;
    }

    envelopes.push(createEnvelope('agent', { t: 'stop' }, { ...opts, subagent }));
    activeSubagents.delete(subagent);
}

function emitSubagentStops(
    opts: CreateEnvelopeOptions,
    startedSubagents: Set<string>,
    activeSubagents: Set<string>,
): SessionEnvelope[] {
    const envelopes: SessionEnvelope[] = [];
    for (const subagent of activeSubagents) {
        envelopes.push(createEnvelope('agent', { t: 'stop' }, { ...opts, subagent }));
    }
    activeSubagents.clear();
    return envelopes;
}

function buildEnvelopeOptions(currentTurnId: string | null, subagent?: string): CreateEnvelopeOptions {
    return {
        ...(currentTurnId ? { turn: currentTurnId } : {}),
        ...(subagent ? { subagent } : {}),
    };
}

function pickTokenCount(message: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = message[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            return Math.trunc(value);
        }
    }
    return undefined;
}

function pickTokenUsageSource(message: Record<string, unknown>): Record<string, unknown> {
    if (message.last && typeof message.last === 'object' && !Array.isArray(message.last)) {
        return message.last as Record<string, unknown>;
    }
    return message.total && typeof message.total === 'object' && !Array.isArray(message.total)
        ? message.total as Record<string, unknown>
        : message;
}

function pickTokenUsage(message: Record<string, unknown>): SessionUsage | undefined {
    const source = pickTokenUsageSource(message);
    const input = pickTokenCount(source, ['input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens']);
    const output = pickTokenCount(source, ['output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens']);
    const cacheCreation = pickTokenCount(source, [
        'cache_creation_input_tokens',
        'cacheCreationInputTokens',
        'cacheCreation',
        'cache_write_input_tokens',
        'cacheWriteInputTokens',
    ]);
    const cacheRead = pickTokenCount(source, [
        'cache_read_input_tokens',
        'cacheReadInputTokens',
        'cacheRead',
        'cached_input_tokens',
        'cachedInputTokens',
    ]);
    const total = pickTokenCount(source, ['total_tokens', 'totalTokens', 'tokensUsed', 'usedTokens']);
    const contextWindow = pickTokenCount(message, [
        'context_window',
        'contextWindow',
        'model_context_window',
        'modelContextWindow',
    ]);

    if (
        input === undefined
        && output === undefined
        && cacheCreation === undefined
        && cacheRead === undefined
        && total === undefined
    ) {
        return undefined;
    }

    const outputTokens = output ?? 0;
    const cacheCreationTokens = cacheCreation ?? 0;
    const cacheReadTokens = cacheRead ?? 0;
    const inputTokensIncludeCache = input !== undefined
        && total !== undefined
        && total === input + outputTokens;
    const fallbackInputTokens = input
        ?? Math.max(0, (total ?? 0) - outputTokens - cacheCreationTokens - cacheReadTokens);
    const inputTokens = inputTokensIncludeCache && input !== undefined
        ? Math.max(0, input - cacheCreationTokens - cacheReadTokens)
        : fallbackInputTokens;
    const serviceTier = typeof message.service_tier === 'string'
        ? message.service_tier
        : (typeof message.serviceTier === 'string' ? message.serviceTier : undefined);

    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheCreation !== undefined ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
        ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheReadTokens } : {}),
        ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
        ...(serviceTier ? { service_tier: serviceTier } : {}),
    };
}

function pickProviderSubagent(message: Record<string, unknown>): string | undefined {
    const candidates = [
        message.subagent,
        message.parent_call_id,
        message.parentCallId,
        message.agent_thread_id,
        message.agentThreadId,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate;
        }
    }
    return undefined;
}

function resolveSessionSubagent(
    message: Record<string, unknown>,
    providerSubagentToSessionSubagent: Map<string, string>,
): string | undefined {
    const providerSubagent = pickProviderSubagent(message);
    if (!providerSubagent) {
        return undefined;
    }

    return ensureSessionSubagent(providerSubagent, providerSubagentToSessionSubagent);
}

function pickCallId(message: Record<string, unknown>): string {
    const callId = message.call_id ?? message.callId;
    if (typeof callId === 'string' && callId.length > 0) {
        return callId;
    }
    return randomUUID();
}

/**
 * How much of a command's output travels to the app.
 *
 * The ceiling is not a display preference, it is the transport: messages reach
 * clients as socket.io frames, and the server advertises `maxPayload: 1000000`.
 * A single oversized envelope therefore does not degrade into "a long message"
 * — it fails to send at all, taking the tool result *and* everything queued
 * behind it with it. Some of the commands this session has run (profiler dumps,
 * `find` over a tree) comfortably exceed that.
 *
 * 64 KB is ~1500 lines of terminal text, which is past what the detail screen
 * can show at once and well inside the frame budget once encryption and base64
 * are accounted for. The tail is kept rather than the head: when a command
 * fails, the reason is at the end.
 */
const MAX_COMMAND_RESULT_CHARS = 64 * 1024;

/**
 * The `result`/`isError` pair for a finished command, or nothing when the
 * command produced no output — an omitted field and an empty string render
 * identically, and omitting it keeps the frame small for the common case of a
 * command whose only effect was a side effect.
 */
function formatCommandResult(message: Record<string, unknown>): { result?: string; isError?: boolean } {
    const raw = message.output;
    const exitCode = message.exit_code;
    const isError = typeof exitCode === 'number' && exitCode !== 0;

    if (typeof raw !== 'string' || raw.length === 0) {
        return isError ? { isError } : {};
    }

    const text = raw.length > MAX_COMMAND_RESULT_CHARS
        ? `[…${raw.length - MAX_COMMAND_RESULT_CHARS} characters omitted…]\n`
            + raw.slice(raw.length - MAX_COMMAND_RESULT_CHARS)
        : raw;

    return { result: text, ...(isError ? { isError } : {}) };
}

function pickString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined;
}

function pickStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function shortText(value: string, max = 80): string {
    return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function collabToolTitle(tool: string | undefined, prompt: string | undefined): string {
    if (prompt) {
        return shortText(prompt);
    }

    switch (tool) {
        case 'spawnAgent':
            return 'Spawn Codex subagent';
        case 'sendInput':
            return 'Send input to Codex subagent';
        case 'resumeAgent':
            return 'Resume Codex subagent';
        case 'wait':
            return 'Wait for Codex subagent';
        case 'closeAgent':
            return 'Close Codex subagent';
        default:
            return 'Codex subagent';
    }
}

function collabToolDescription(tool: string | undefined, prompt: string | undefined): string {
    const title = collabToolTitle(tool, prompt);
    if (!prompt) {
        return title;
    }
    switch (tool) {
        case 'spawnAgent':
            return `Spawn Codex subagent: ${shortText(prompt, 120)}`;
        case 'sendInput':
            return `Send input to Codex subagent: ${shortText(prompt, 120)}`;
        default:
            return title;
    }
}

function pickCollabReceiverThreadIds(message: Record<string, unknown>): string[] {
    return pickStringArray(message.receiver_thread_ids ?? message.receiverThreadIds);
}

function pickCollabAgentStateThreadIds(message: Record<string, unknown>): string[] {
    const raw = message.agents_states ?? message.agentsStates;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return [];
    }
    return Object.keys(raw).filter((key) => key.length > 0);
}

function resolveCollabProviderIds(
    call: string,
    message: Record<string, unknown>,
    collabReceiverThreadIdsByCall: Map<string, string[]>,
): string[] {
    const receiverThreadIds = pickCollabReceiverThreadIds(message);
    if (receiverThreadIds.length > 0) {
        collabReceiverThreadIdsByCall.set(call, receiverThreadIds);
        return receiverThreadIds;
    }

    const remembered = collabReceiverThreadIdsByCall.get(call);
    if (remembered && remembered.length > 0) {
        return remembered;
    }

    const stateThreadIds = pickCollabAgentStateThreadIds(message);
    if (stateThreadIds.length > 0) {
        collabReceiverThreadIdsByCall.set(call, stateThreadIds);
        return stateThreadIds;
    }

    // No target named. Return nothing rather than the tool-call id.
    //
    // The fallback used to be `[call]`, which invented an id from the *tool
    // call* and registered it as a subagent. That produced a second,
    // incompatible identity for the same agent: `subAgentActivity` derives its
    // id from the child thread, so the two never matched, and the tool card's
    // `sessionSubagent` pointed at an id no message would ever carry.
    //
    // It fires more often than it looks: a `wait` on an agent that was spawned
    // elsewhere in the turn arrives with `receiverThreadIds: []` and
    // `agentsStates: {}` (measured). Naming nobody is the honest answer — the
    // authoritative registration comes from `subAgentActivity`, which always
    // carries the child thread.
    return [];
}

function resolveCollabTool(
    call: string,
    message: Record<string, unknown>,
    collabToolByCall: Map<string, string>,
): string | undefined {
    const tool = pickString(message.tool);
    if (tool) {
        collabToolByCall.set(call, tool);
        return tool;
    }
    return collabToolByCall.get(call);
}

function isCollabCallInProgress(message: Record<string, unknown>): boolean {
    const status = pickString(message.status);
    return status === 'inProgress';
}

function collabAgentStates(
    message: Record<string, unknown>,
    sessionSubagentsByProviderId: Record<string, string>,
): Array<{ sessionSubagent: string; status?: string; message?: string | null }> {
    const raw = message.agents_states ?? message.agentsStates;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return [];
    }

    const states: Array<{ sessionSubagent: string; status?: string; message?: string | null }> = [];
    for (const [providerId, state] of Object.entries(raw as Record<string, unknown>)) {
        const sessionSubagent = sessionSubagentsByProviderId[providerId];
        if (!sessionSubagent || !state || typeof state !== 'object' || Array.isArray(state)) {
            continue;
        }
        const record = state as Record<string, unknown>;
        states.push({
            sessionSubagent,
            ...(typeof record.status === 'string' ? { status: record.status } : {}),
            ...(typeof record.message === 'string' || record.message === null ? { message: record.message } : {}),
        });
    }
    return states;
}

function emitCollabAgentStateMessages(
    envelopes: SessionEnvelope[],
    message: Record<string, unknown>,
    sessionSubagentsByProviderId: Record<string, string>,
    opts: CreateEnvelopeOptions,
): void {
    const raw = message.agents_states ?? message.agentsStates;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return;
    }

    for (const [providerId, state] of Object.entries(raw as Record<string, unknown>)) {
        const sessionSubagent = sessionSubagentsByProviderId[providerId];
        if (!sessionSubagent || !state || typeof state !== 'object' || Array.isArray(state)) {
            continue;
        }
        const status = pickString((state as Record<string, unknown>).status);
        const statusMessage = pickString((state as Record<string, unknown>).message);
        if (!statusMessage) {
            continue;
        }
        const prefix = status ? `Codex subagent ${status}` : 'Codex subagent';
        envelopes.push(createEnvelope('agent', {
            t: 'service',
            text: `${prefix}: ${statusMessage}`,
        }, { ...opts, subagent: sessionSubagent }));
    }
}

function subagentActivityServiceText(kind: unknown, agentPath: string | undefined): string | undefined {
    if (kind === 'started') {
        return agentPath ? `Codex subagent started: ${agentPath}` : 'Codex subagent started';
    }
    if (kind === 'interrupted') {
        return 'Codex subagent interrupted';
    }
    return undefined;
}

function maybeEmitSubagentActivityService(
    envelopes: SessionEnvelope[],
    kind: unknown,
    agentPath: string | undefined,
    opts: CreateEnvelopeOptions,
    sessionSubagent: string,
): void {
    const text = subagentActivityServiceText(kind, agentPath);
    if (!text) {
        return;
    }
    envelopes.push(createEnvelope('agent', { t: 'service', text }, { ...opts, subagent: sessionSubagent }));
}

function registerCodexSubagents(
    providerIds: string[],
    title: string | undefined,
    providerSubagentToSessionSubagent: Map<string, string>,
    subagentTitles: Map<string, string>,
): { primarySubagent?: string; sessionSubagents: Record<string, string> } {
    const sessionSubagents: Record<string, string> = {};
    let primarySubagent: string | undefined;

    for (const providerId of providerIds) {
        const sessionSubagent = ensureSessionSubagent(providerId, providerSubagentToSessionSubagent);
        sessionSubagents[providerId] = sessionSubagent;
        if (!primarySubagent) {
            primarySubagent = sessionSubagent;
        }
        if (title) {
            subagentTitles.set(sessionSubagent, title);
        }
    }

    return { primarySubagent, sessionSubagents };
}

function collabArgs(
    message: Record<string, unknown>,
    primarySubagent: string | undefined,
    sessionSubagents: Record<string, string>,
): Record<string, unknown> {
    const sessionSubagentValues = Object.values(sessionSubagents);
    return {
        tool: pickString(message.tool) ?? 'unknown',
        status: pickString(message.status) ?? 'unknown',
        prompt: pickString(message.prompt) ?? null,
        model: pickString(message.model) ?? null,
        reasoningEffort: pickString(message.reasoning_effort ?? message.reasoningEffort) ?? null,
        agentStates: collabAgentStates(message, sessionSubagents),
        ...(primarySubagent ? { sessionSubagent: primarySubagent } : {}),
        ...(sessionSubagentValues.length > 0 ? { sessionSubagents: sessionSubagentValues } : {}),
    };
}

/**
 * One collab interaction, as the timeline's tool card.
 *
 * Shared by the `collabAgentToolCall` items Codex does emit and the ones it
 * does not: `sendInput` reaches the client as a bare activity marker, so the
 * card is built here from the same fields the real item carries, and the two
 * spellings of the same interaction render identically.
 */
function emitCollabToolCallEnvelopes(
    envelopes: SessionEnvelope[],
    details: {
        tool: string;
        status: string;
        sessionSubagent: string;
        prompt?: string | null;
    },
    callId: string,
    opts: CreateEnvelopeOptions,
    times: { startedAt: number; completedAt?: number },
): void {
    const prompt = details.prompt ?? undefined;
    const title = collabToolTitle(details.tool, prompt);
    envelopes.push(createEnvelope('agent', {
        t: 'tool-call-start',
        call: callId,
        name: 'CodexSubagent',
        title,
        description: collabToolDescription(details.tool, prompt),
        args: {
            tool: details.tool,
            status: details.status,
            prompt: details.prompt ?? null,
            agentStates: {},
            sessionSubagent: details.sessionSubagent,
            sessionSubagents: [details.sessionSubagent],
        },
    }, {
        ...opts,
        id: `${callId}:start`,
        time: times.startedAt,
    }));
    envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call: callId }, {
        ...opts,
        id: `${callId}:end`,
        time: times.completedAt ?? times.startedAt,
    }));
}

/**
 * A subagent activity item, turned into what the conversation shows.
 *
 * Shared by the live stream and the backfill read because the two see the same
 * items and must agree about them — the earlier split is how they came to
 * disagree, with a live client rendering an agent's finish as a second spawn.
 *
 * The three kinds mean three different things:
 *
 * - `started`   the agent exists and is running → announce it
 * - `interacted` the parent sent it input → running again, and that interaction
 *                is itself worth a row, which nothing else produces
 * - `completed`/`interrupted`/`failed` → it stopped
 */
function subagentActivityEnvelopes(
    envelopes: SessionEnvelope[],
    details: {
        kind: string | undefined;
        sessionSubagent: string;
        agentPath: string | undefined;
        origin: { threadId?: string; parentThreadId?: string };
        opts: CreateEnvelopeOptions;
        startedAt: number;
        itemId: string | undefined;
    },
    startedSubagents: Set<string>,
    activeSubagents: Set<string>,
    subagentTitles: Map<string, string>,
): void {
    const { kind, sessionSubagent, agentPath, origin, opts, startedAt, itemId } = details;
    if (kind === 'completed' || kind === 'interrupted' || kind === 'failed') {
        maybeEmitSubagentStop(sessionSubagent, opts, activeSubagents, envelopes);
    } else {
        maybeEmitSubagentStart(
            sessionSubagent,
            opts,
            startedSubagents,
            activeSubagents,
            subagentTitles,
            envelopes,
            origin,
        );
    }
    maybeEmitSubagentActivityService(envelopes, kind, agentPath, opts, sessionSubagent);
    if (kind === 'interacted') {
        // The app-server reports a parent's `sendInput` to a child as nothing
        // but this marker — unlike `wait` and `spawnAgent` it never becomes a
        // `collabAgentToolCall` item — so without synthesizing the card here
        // the interaction exists in the protocol and nowhere on screen.
        const callId = `subagent-interacted:${itemId ?? sessionSubagent}`;
        emitCollabToolCallEnvelopes(
            envelopes,
            { tool: 'sendInput', status: 'completed', sessionSubagent },
            callId,
            opts,
            { startedAt },
        );
    }
}

function summarizeCommand(command: unknown): string | null {
    if (typeof command === 'string' && command.trim().length > 0) {
        return command;
    }
    if (Array.isArray(command)) {
        const cmd = command.map(v => String(v)).join(' ').trim();
        return cmd.length > 0 ? cmd : null;
    }
    return null;
}

function commandToTitle(command: string | null): string {
    if (!command) {
        return 'Run command';
    }
    const short = command.length > 80 ? `${command.slice(0, 77)}...` : command;
    return `Run \`${short}\``;
}

export function turnTimestampMs(turn: ThreadTurn): number {
    const seconds = turn.startedAt ?? turn.completedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

export function completedTimestampMs(turn: ThreadTurn): number {
    const seconds = turn.completedAt ?? turn.startedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

function textFromInputItems(items: unknown): string | null {
    if (!Array.isArray(items)) {
        return null;
    }
    const text = items
        .filter((item): item is { type: 'text'; text: string } => (
            Boolean(item)
            && typeof item === 'object'
            && (item as { type?: unknown }).type === 'text'
            && typeof (item as { text?: unknown }).text === 'string'
        ))
        .map((item) => item.text)
        .join('\n')
        .trim();
    return text.length > 0 ? text : null;
}

function visibleCodexMessageText(text: string): string | null {
    // Imported/background-agent completions can appear in Codex thread images
    // as synthetic text items even though their output is already represented
    // by structured subagent envelopes. Keep only any real text after them.
    // Also strip Happy's own injected scaffolding (option-chips system prompt +
    // change-title instruction), which is baked into the Codex turn text and
    // would otherwise leak into the chat when a thread is reconstructed from a
    // fork / duplicate / side-chat backfill.
    const visibleText = stripLeadingTaskNotificationWrappers(stripHappySystemBlocks(text));
    return visibleText.trim().length > 0 ? visibleText : null;
}

function reasoningText(item: ThreadItem): string | null {
    const summary = (item as { summary?: unknown }).summary;
    const content = (item as { content?: unknown }).content;
    const parts = [
        ...(Array.isArray(summary) ? summary : []),
        ...(Array.isArray(content) ? content : []),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const text = parts.join('\n').trim();
    return text.length > 0 ? text : null;
}

export function turnStatus(turn: ThreadTurn): TurnEndStatus {
    const status = typeof turn.status === 'string' ? turn.status : null;
    if (status === 'failed') {
        return 'failed';
    }
    if (status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted') {
        return 'cancelled';
    }
    return 'completed';
}

export function isCodexTurnInProgress(turn: ThreadTurn): boolean {
    const status = typeof turn.status === 'string' ? turn.status : null;
    return status === 'inProgress' || status === 'running' || status === 'active' || status === 'pending';
}

function emitHistoricalToolCall(
    envelopes: SessionEnvelope[],
    turn: ThreadTurn,
    item: ThreadItem,
    name: string,
    title: string,
    args: Record<string, unknown>,
    output: string | null,
    timestamps?: {
        startedAt: number;
        completedAt: number;
    },
): void {
    const time = timestamps?.startedAt ?? turnTimestampMs(turn);
    const opts = { turn: turn.id, time, codexItemId: item.id } satisfies CreateEnvelopeOptions;
    envelopes.push(createEnvelope('agent', {
        t: 'tool-call-start',
        call: item.id,
        name,
        title,
        description: title,
        args,
    }, {
        ...opts,
        id: `${item.id}:start`,
    }));

    if (output && output.trim().length > 0) {
        envelopes.push(createEnvelope('agent', {
            t: 'text',
            text: output,
            thinking: true,
        }, {
            ...opts,
            id: `${item.id}:output`,
        }));
    }

    envelopes.push(createEnvelope('agent', {
        t: 'tool-call-end',
        call: item.id,
    }, {
        ...opts,
        id: `${item.id}:end`,
        time: timestamps?.completedAt ?? completedTimestampMs(turn),
    }));
}

export function mapCodexThreadItemToSessionEnvelopes(
    turn: ThreadTurn,
    item: ThreadItem,
    timestamps?: {
        startedAt: number;
        completedAt: number;
    },
    state?: CodexTurnState,
): SessionEnvelope[] {
    const startedAt = timestamps?.startedAt ?? turnTimestampMs(turn);
    const completedAt = timestamps?.completedAt ?? completedTimestampMs(turn);
    const mappingState = state ?? { currentTurnId: turn.id };
    const startedSubagents = getStartedSubagents(mappingState);
    const activeSubagents = getActiveSubagents(mappingState);
    const providerSubagentToSessionSubagent = getProviderSubagentToSessionSubagent(mappingState);
    const subagentTitles = getSubagentTitles(mappingState);
    const collabReceiverThreadIdsByCall = getCollabReceiverThreadIdsByCall(mappingState);
    const collabToolByCall = getCollabToolByCall(mappingState);

    switch (item.type) {
        case 'userMessage': {
            const text = textFromInputItems(item.content);
            const visibleText = text ? visibleCodexMessageText(text) : null;
            return visibleText
                ? [createEnvelope('user', { t: 'text', text: visibleText }, {
                    id: item.id,
                    time: startedAt,
                    codexItemId: item.id,
                })]
                : [];
        }
        case 'agentMessage': {
            const text = typeof item.text === 'string' ? item.text.trim() : '';
            const visibleText = visibleCodexMessageText(text);
            if (!visibleText) {
                return [];
            }

            const subagent = resolveSessionSubagent(item as Record<string, unknown>, providerSubagentToSessionSubagent);
            const opts = {
                id: item.id,
                turn: turn.id,
                time: completedAt,
                codexItemId: item.id,
                ...(subagent ? { subagent } : {}),
            } satisfies CreateEnvelopeOptions;
            const envelopes: SessionEnvelope[] = [];
            maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
            envelopes.push(createEnvelope('agent', { t: 'text', text: visibleText }, opts));
            return envelopes;
        }
        case 'reasoning': {
            const text = reasoningText(item);
            if (!text) {
                return [];
            }

            const subagent = resolveSessionSubagent(item as Record<string, unknown>, providerSubagentToSessionSubagent);
            const opts = {
                id: item.id,
                turn: turn.id,
                time: startedAt,
                codexItemId: item.id,
                ...(subagent ? { subagent } : {}),
            } satisfies CreateEnvelopeOptions;
            const envelopes: SessionEnvelope[] = [];
            maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
            envelopes.push(createEnvelope('agent', { t: 'text', text, thinking: true }, opts));
            return envelopes;
        }
        case 'commandExecution': {
            const envelopes: SessionEnvelope[] = [];
            const command = typeof item.command === 'string' ? item.command : '';
            emitHistoricalToolCall(
                envelopes,
                turn,
                item,
                'CodexBash',
                commandToTitle(command),
                { command, cwd: item.cwd },
                typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : null,
                { startedAt, completedAt },
            );
            return envelopes;
        }
        case 'fileChange': {
            const envelopes: SessionEnvelope[] = [];
            emitHistoricalToolCall(
                envelopes,
                turn,
                item,
                'CodexPatch',
                'Apply patch',
                { changes: item.changes, status: item.status },
                null,
                { startedAt, completedAt },
            );
            return envelopes;
        }
        case 'mcpToolCall': {
            const envelopes: SessionEnvelope[] = [];
            const title = `${item.server}.${item.tool}`;
            const output = item.error !== undefined && item.error !== null
                ? String(item.error)
                : (item.result !== undefined && item.result !== null ? String(item.result) : null);
            emitHistoricalToolCall(
                envelopes,
                turn,
                item,
                'McpTool',
                title,
                {
                    server: item.server,
                    tool: item.tool,
                    arguments: item.arguments,
                },
                output,
                { startedAt, completedAt },
            );
            return envelopes;
        }
        case 'collabAgentToolCall': {
            const itemRecord = item as Record<string, unknown>;
            const tool = resolveCollabTool(item.id, itemRecord, collabToolByCall);
            const prompt = pickString(itemRecord.prompt);
            const title = collabToolTitle(tool, prompt);
            const providerIds = resolveCollabProviderIds(item.id, itemRecord, collabReceiverThreadIdsByCall);
            const { primarySubagent, sessionSubagents } = registerCodexSubagents(
                providerIds,
                title,
                providerSubagentToSessionSubagent,
                subagentTitles,
            );
            const startOpts = {
                turn: turn.id,
                time: startedAt,
                codexItemId: item.id,
            } satisfies CreateEnvelopeOptions;
            const endOpts = {
                turn: turn.id,
                time: completedAt,
                codexItemId: item.id,
            } satisfies CreateEnvelopeOptions;
            const envelopes: SessionEnvelope[] = [
                createEnvelope('agent', {
                    t: 'tool-call-start',
                    call: item.id,
                    name: 'CodexSubagent',
                    title,
                    description: collabToolDescription(tool, prompt),
                    args: collabArgs(itemRecord, primarySubagent, sessionSubagents),
                }, {
                    ...startOpts,
                    id: `${item.id}:start`,
                }),
            ];

            for (const sessionSubagent of Object.values(sessionSubagents)) {
                maybeEmitSubagentStart(
                    sessionSubagent,
                    startOpts,
                    startedSubagents,
                    activeSubagents,
                    subagentTitles,
                    envelopes,
                );
            }

            if (!isCollabCallInProgress(itemRecord)) {
                emitCollabAgentStateMessages(envelopes, itemRecord, sessionSubagents, endOpts);
                envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call: item.id }, {
                    ...endOpts,
                    id: `${item.id}:end`,
                }));
                if (tool === 'closeAgent') {
                    for (const sessionSubagent of Object.values(sessionSubagents)) {
                        maybeEmitSubagentStop(sessionSubagent, endOpts, activeSubagents, envelopes);
                    }
                }
                collabReceiverThreadIdsByCall.delete(item.id);
                collabToolByCall.delete(item.id);
            }
            return envelopes;
        }
        case 'subAgentActivity': {
            const itemRecord = item as Record<string, unknown>;
            const providerSubagent = pickString(itemRecord.agentThreadId ?? itemRecord.agent_thread_id);
            if (!providerSubagent) {
                return [];
            }
            const sessionSubagent = ensureSessionSubagent(providerSubagent, providerSubagentToSessionSubagent);
            const agentPath = pickString(itemRecord.agentPath ?? itemRecord.agent_path);
            if (agentPath) {
                subagentTitles.set(sessionSubagent, agentPath);
            }
            // Backfill reads one thread at a time, so it has the child's id but
            // not which thread the activity was reported on — the item does not
            // carry it. The client falls back to the parent implied by
            // `agentPath`, which is a path and therefore says the same thing.
            const origin = { threadId: providerSubagent };
            const opts = {
                turn: turn.id,
                time: startedAt,
                codexItemId: item.id,
            } satisfies CreateEnvelopeOptions;
            const envelopes: SessionEnvelope[] = [];
            subagentActivityEnvelopes(
                envelopes,
                {
                    kind: pickString(itemRecord.kind),
                    sessionSubagent,
                    agentPath,
                    origin,
                    opts,
                    startedAt,
                    itemId: typeof item.id === 'string' ? item.id : undefined,
                },
                startedSubagents,
                activeSubagents,
                subagentTitles,
            );
            return envelopes;
        }
        default:
            return [];
    }
}

export function mapCodexThreadToSessionEnvelopes(thread: Pick<Thread, 'turns'>): SessionEnvelope[] {
    const envelopes: SessionEnvelope[] = [];
    const providerSubagentToSessionSubagent = new Map<string, string>();
    const subagentTitles = new Map<string, string>();
    const collabReceiverThreadIdsByCall = new Map<string, string[]>();
    const collabToolByCall = new Map<string, string>();

    for (const turn of thread.turns ?? []) {
        const startedAt = turnTimestampMs(turn);
        const completedAt = completedTimestampMs(turn);
        const state: CodexTurnState = {
            currentTurnId: turn.id,
            startedSubagents: new Set<string>(),
            activeSubagents: new Set<string>(),
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
        };
        envelopes.push(createEnvelope('agent', { t: 'turn-start' }, {
            id: `${turn.id}:start`,
            turn: turn.id,
            time: startedAt,
        }));

        const timestamps = { startedAt, completedAt };
        for (const item of turn.items ?? []) {
            envelopes.push(...mapCodexThreadItemToSessionEnvelopes(turn, item, timestamps, state));
        }

        if (!isCodexTurnInProgress(turn)) {
            envelopes.push(...emitSubagentStops(
                { turn: turn.id, time: completedAt },
                getStartedSubagents(state),
                getActiveSubagents(state),
            ));
            envelopes.push(createEnvelope('agent', { t: 'turn-end', status: turnStatus(turn) }, {
                id: `${turn.id}:end`,
                turn: turn.id,
                time: completedAt,
            }));
        }
    }

    return envelopes;
}

function patchDescription(changes: unknown): string {
    if (!changes || typeof changes !== 'object') {
        return 'Applying patch';
    }
    const fileCount = Object.keys(changes as Record<string, unknown>).length;
    if (fileCount === 1) {
        return 'Applying patch to 1 file';
    }
    return `Applying patch to ${fileCount} files`;
}

function pickTurnEndStatus(message: Record<string, unknown>, type: unknown): TurnEndStatus {
    const rawStatus = message.status;
    if (rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'cancelled') {
        return rawStatus;
    }
    if (rawStatus === 'canceled') {
        return 'cancelled';
    }

    // Abort events are treated as cancelled unless they explicitly look like failures.
    if (type === 'turn_aborted') {
        const reason = message.reason;
        const error = message.error;
        if ((typeof reason === 'string' && /(fail|error)/i.test(reason))
            || (typeof error === 'string' && error.length > 0)
            || (error !== undefined && error !== null && typeof error === 'object')) {
            return 'failed';
        }
        return 'cancelled';
    }

    if (message.error !== undefined && message.error !== null) {
        return 'failed';
    }

    return 'completed';
}

export function mapCodexMcpMessageToSessionEnvelopes(message: Record<string, unknown>, state: CodexTurnState): CodexMapperResult {
    const result = mapCodexMcpMessageToSessionEnvelopesInner(message, state);
    ensureCodexEnvelopeTurn(result);
    return result;
}

function ensureCodexEnvelopeTurn(result: Pick<CodexMapperResult, 'currentTurnId' | 'envelopes'>): void {
    // Automatic continuations may deliver content without a task_started event.
    // Keep usage-only service envelopes turn-less for older client compatibility.
    const requiresTurn = (envelope: SessionEnvelope) => envelope.role === 'agent'
        && !envelope.turn
        && !(envelope.ev.t === 'service' && !envelope.ev.text.trim() && envelope.usage);
    if (!result.envelopes.some(requiresTurn)) return;

    const turn = result.currentTurnId ?? createId();
    result.envelopes = result.envelopes.map((envelope) => requiresTurn(envelope)
        ? { ...envelope, turn }
        : envelope);
    if (!result.currentTurnId) {
        result.envelopes.unshift(createEnvelope('agent', { t: 'turn-start' }, { turn }));
    }
    result.currentTurnId = turn;
}

function mapCodexMcpMessageToSessionEnvelopesInner(message: Record<string, unknown>, state: CodexTurnState): CodexMapperResult {
    const type = message.type;
    const startedSubagents = getStartedSubagents(state);
    const activeSubagents = getActiveSubagents(state);
    const providerSubagentToSessionSubagent = getProviderSubagentToSessionSubagent(state);
    const subagentTitles = getSubagentTitles(state);
    const collabReceiverThreadIdsByCall = getCollabReceiverThreadIdsByCall(state);
    const collabToolByCall = getCollabToolByCall(state);

    // `turn/started` and `turn/completed` are reported for every thread Codex
    // runs, including the ones subagents run on. A child's turn boundary is not
    // the session's: treating it as one ends the parent's answer while it is
    // still working, and the registry it clears makes the child's next activity
    // re-announce an agent that was already introduced — which the timeline
    // shows as a second, identical "spawned" row where the agent's *finish*
    // should have been.
    const childThreadId = pickString(message.subagent);
    if (childThreadId && (type === 'task_started' || type === 'task_complete' || type === 'turn_aborted')) {
        const sessionSubagent = ensureSessionSubagent(childThreadId, providerSubagentToSessionSubagent);
        const opts = {
            ...(state.currentTurnId ? { turn: state.currentTurnId } : {}),
            subagent: sessionSubagent,
        } satisfies CreateEnvelopeOptions;
        const envelopes: SessionEnvelope[] = [];
        if (type === 'task_started') {
            maybeEmitSubagentStart(
                sessionSubagent,
                opts,
                startedSubagents,
                activeSubagents,
                subagentTitles,
                envelopes,
                { threadId: childThreadId },
            );
        }
        if (type === 'task_complete' || type === 'turn_aborted') {
            maybeEmitSubagentStop(sessionSubagent, opts, activeSubagents, envelopes);
        }
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    if (type === 'task_started') {
        const turnId = createId();
        const turnStart = createEnvelope('agent', { t: 'turn-start' }, { turn: turnId });
        startedSubagents.clear();
        activeSubagents.clear();
        collabReceiverThreadIdsByCall.clear();
        collabToolByCall.clear();
        return {
            currentTurnId: turnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes: [turnStart],
        };
    }

    if (type === 'task_complete' || type === 'turn_aborted') {
        if (!state.currentTurnId) {
            return {
                currentTurnId: null,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                subagentTitles,
                collabReceiverThreadIdsByCall,
                collabToolByCall,
                envelopes: [],
            };
        }

        const lifecycleOpts = { turn: state.currentTurnId } satisfies CreateEnvelopeOptions;
        collabReceiverThreadIdsByCall.clear();
        collabToolByCall.clear();
        return {
            currentTurnId: null,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes: [
                // A turn ending normally does not end the agents it spawned:
                // they run on their own threads and report their own finish.
                // An abort does — the children are killed with the turn — which
                // is why only that path closes them here.
                ...(type === 'turn_aborted'
                    ? emitSubagentStops(lifecycleOpts, startedSubagents, activeSubagents)
                    : []),
                createEnvelope('agent', {
                    t: 'turn-end',
                    status: pickTurnEndStatus(message, type),
                }, lifecycleOpts),
            ],
        };
    }

    if (type === 'token_count') {
        const usage = pickTokenUsage(message);
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes: usage
                // Deliberately NO turn id: app versions without the
                // usage-only-service filter render any agent service envelope
                // that has a turn as a chat row — one blank bubble per
                // token_count event. Turn-less agent envelopes are dropped by
                // those versions, while versions with the filter read the
                // usage either way.
                ? [createEnvelope('agent', { t: 'service', text: '' }, { usage })]
                : [],
        };
    }

    if (type === 'collab_agent_begin' || type === 'collab_agent_end') {
        const call = pickCallId(message);
        const tool = resolveCollabTool(call, message, collabToolByCall);
        const prompt = pickString(message.prompt);
        const title = collabToolTitle(tool, prompt);
        const providerIds = resolveCollabProviderIds(call, message, collabReceiverThreadIdsByCall);
        const { primarySubagent, sessionSubagents } = registerCodexSubagents(
            providerIds,
            title,
            providerSubagentToSessionSubagent,
            subagentTitles,
        );
        const turnOpts = buildEnvelopeOptions(state.currentTurnId);
        const envelopes: SessionEnvelope[] = [];

        if (type === 'collab_agent_begin') {
            envelopes.push(createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: 'CodexSubagent',
                title,
                description: collabToolDescription(tool, prompt),
                args: collabArgs(message, primarySubagent, sessionSubagents),
            }, turnOpts));

            for (const sessionSubagent of Object.values(sessionSubagents)) {
                maybeEmitSubagentStart(
                    sessionSubagent,
                    turnOpts,
                    startedSubagents,
                    activeSubagents,
                    subagentTitles,
                    envelopes,
                );
            }
        } else {
            emitCollabAgentStateMessages(envelopes, message, sessionSubagents, turnOpts);
            envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call }, turnOpts));
            if (tool === 'closeAgent') {
                for (const sessionSubagent of Object.values(sessionSubagents)) {
                    maybeEmitSubagentStop(sessionSubagent, turnOpts, activeSubagents, envelopes);
                }
            }
            collabReceiverThreadIdsByCall.delete(call);
            collabToolByCall.delete(call);
        }

        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    if (type === 'subagent_activity') {
        const providerSubagent = pickString(message.agent_thread_id ?? message.agentThreadId);
        if (!providerSubagent) {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                subagentTitles,
                collabReceiverThreadIdsByCall,
                collabToolByCall,
                envelopes: [],
            };
        }

        const sessionSubagent = ensureSessionSubagent(providerSubagent, providerSubagentToSessionSubagent);
        const agentPath = pickString(message.agent_path ?? message.agentPath);
        if (agentPath) {
            subagentTitles.set(sessionSubagent, agentPath);
        }
        // `providerSubagent` is the child's own thread; `parent_thread_id` is
        // whichever thread this activity was reported on, which for a
        // grandchild is its parent rather than the session root.
        const origin = {
            threadId: providerSubagent,
            parentThreadId: pickString(message.parent_thread_id ?? message.parentThreadId),
        };
        const turnOpts = buildEnvelopeOptions(state.currentTurnId);
        const envelopes: SessionEnvelope[] = [];
        subagentActivityEnvelopes(
            envelopes,
            {
                kind: pickString(message.kind),
                sessionSubagent,
                agentPath,
                origin,
                opts: turnOpts,
                startedAt: typeof message.time === 'number' ? message.time : Date.now(),
                itemId: pickString(message.item_id ?? message.itemId),
            },
            startedSubagents,
            activeSubagents,
            subagentTitles,
        );

        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    const subagent = resolveSessionSubagent(message, providerSubagentToSessionSubagent);
    const opts = buildEnvelopeOptions(state.currentTurnId, subagent);

    if (type === 'agent_message') {
        if (typeof message.message !== 'string') {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                subagentTitles,
                collabReceiverThreadIdsByCall,
                collabToolByCall,
                envelopes: [],
            };
        }

        const visibleText = visibleCodexMessageText(message.message);
        if (!visibleText) {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                subagentTitles,
                collabReceiverThreadIdsByCall,
                collabToolByCall,
                envelopes: [],
            };
        }

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'text', text: visibleText }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    if (type === 'agent_reasoning' || type === 'agent_reasoning_delta') {
        const text = typeof message.text === 'string'
            ? message.text
            : (typeof message.delta === 'string' ? message.delta : null);

        if (!text) {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                subagentTitles,
                collabReceiverThreadIdsByCall,
                collabToolByCall,
                envelopes: [],
            };
        }

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'text', text, thinking: true }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    // exec_approval_request is intentionally NOT mapped here — the permission
    // handler already renders the approval UI via agent state.  Mapping it to
    // tool-call-start too would create a duplicate tool call card.
    if (type === 'exec_command_begin') {
        const call = pickCallId(message);
        const { call_id: _callIdSnake, callId: _callIdCamel, type: _type, ...args } = message;

        const command = summarizeCommand((args as Record<string, unknown>).command);
        const description = typeof (args as Record<string, unknown>).description === 'string'
            ? ((args as Record<string, string>).description)
            : (command ?? 'Execute command');

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        envelopes.push(
            createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: 'CodexBash',
                title: commandToTitle(command),
                description,
                args: args as Record<string, unknown>,
            }, opts)
        );
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    if (type === 'exec_command_end') {
        const call = pickCallId(message);
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        // Carry the command's output through to the app. It used to be dropped
        // here, and the drop was invisible: the envelope still closed the tool
        // call, so the card stopped spinning and the app rendered its
        // "completed with no output" state for a command that had printed
        // plenty. The app has read `result` off this event all along; nothing
        // wrote it, and the wire schema stripped it even if something had.
        envelopes.push(createEnvelope('agent', {
            t: 'tool-call-end',
            call,
            ...formatCommandResult(message),
        }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    if (type === 'patch_apply_begin') {
        const call = pickCallId(message);
        const autoApproved = (message as { auto_approved?: unknown }).auto_approved;
        const changes = (message as { changes?: unknown }).changes;

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        envelopes.push(
            createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: 'CodexPatch',
                title: 'Apply patch',
                description: patchDescription(changes),
                args: {
                    auto_approved: autoApproved,
                    changes,
                },
            }, opts)
        );
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    if (type === 'patch_apply_end') {
        const call = pickCallId(message);
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    return {
        currentTurnId: state.currentTurnId,
        startedSubagents,
        activeSubagents,
        providerSubagentToSessionSubagent,
        subagentTitles,
        collabReceiverThreadIdsByCall,
        collabToolByCall,
        envelopes: [],
    };
}

export function mapCodexProcessorMessageToSessionEnvelopes(
    message: ReasoningOutput | DiffToolCall | DiffToolResult,
    state: CodexTurnState,
): Pick<CodexMapperResult, 'currentTurnId' | 'envelopes'> {
    const result = {
        currentTurnId: state.currentTurnId,
        envelopes: mapCodexProcessorMessageToSessionEnvelopesInner(message, state),
    };
    ensureCodexEnvelopeTurn(result);
    return result;
}

function mapCodexProcessorMessageToSessionEnvelopesInner(
    message: ReasoningOutput | DiffToolCall | DiffToolResult,
    state: CodexTurnState,
): SessionEnvelope[] {
    const toolLikeMessage = message as LegacyToolLikeMessage;
    const opts = buildEnvelopeOptions(state.currentTurnId);

    if (message.type === 'reasoning') {
        return [createEnvelope('agent', {
            t: 'text',
            text: message.message,
            thinking: true,
        }, opts)];
    }

    if (message.type === 'tool-call') {
        const title = typeof (toolLikeMessage.input as { title?: unknown } | undefined)?.title === 'string'
            ? (toolLikeMessage.input as { title: string }).title
            : `${toolLikeMessage.name || 'Tool'} call`;

        return [createEnvelope('agent', {
            t: 'tool-call-start',
            call: toolLikeMessage.callId,
            name: toolLikeMessage.name || 'unknown',
            title,
            description: title,
            args: (toolLikeMessage.input && typeof toolLikeMessage.input === 'object'
                ? toolLikeMessage.input
                : {}) as Record<string, unknown>,
        }, opts)];
    }

    if (message.type === 'tool-call-result') {
        const envelopes: SessionEnvelope[] = [];
        const content = toolLikeMessage.output?.content;
        if (typeof content === 'string' && content.trim().length > 0) {
            envelopes.push(createEnvelope('agent', {
                t: 'text',
                text: content,
                thinking: true,
            }, opts));
        }
        envelopes.push(createEnvelope('agent', {
            t: 'tool-call-end',
            call: toolLikeMessage.callId,
        }, opts));
        return envelopes;
    }

    return [];
}
