import { getCurrentRealtimeSessionId, getVoiceSession, isVoiceSessionStarted, setCurrentRealtimeSessionId } from '../RealtimeSession';
import {
    formatMessage,
    formatCompletionNotice,
    formatCurrentSession,
    formatNewMessages,
    formatPermissionRequest,
    formatReadyEvent,
    formatSessionFocus,
    formatSessionFull,
    formatSessionOffline,
    formatSessionOnline,
    resolveAgentName,
} from './contextFormatters';
import { storage } from '@/sync/storage';
import type { ReadyTurn } from '@/sync/reducer/reducer';
import { Message } from '@/sync/typesMessage';
import {
    DEFAULT_VOICE_CONTEXT_MODE,
    getVoiceConfig,
    isBackgroundSession as isBackground,
    shouldAnnounceCompletion,
    shouldInjectMessageBody,
    VOICE_CONFIG,
    type VoiceConfig,
    type VoiceContextMode,
} from '../voiceConfig';

/**
 * Centralized voice assistant hooks for multi-session context updates.
 *
 * Two update channels:
 * - sendContext()  → silent background injection (sendContextualUpdate), always immediate
 * - sendPrompt()  → triggers agent response (sendTextMessage), queued while anyone is speaking
 *
 * Prompt queue flushes automatically when realtimeMode transitions to 'idle'.
 */

interface SessionMetadata {
    summary?: { text?: string };
    path?: string;
    machineId?: string;
    /** Which coding agent runs in the session: claude, codex, agy, ... */
    flavor?: string | null;
    [key: string]: any;
}

let shownSessions = new Set<string>();

/**
 * Sessions whose context was injected in reduced form because they were in the
 * background at the time.
 *
 * The reduction is not permanent: when the user moves to such a session, its
 * transcript is worth paying for, because that is the one they are now talking
 * about. Tracking which sessions got the cheap version is what lets focus
 * upgrade them instead of leaving them permanently blind.
 */
let reducedSessions = new Set<string>();

/**
 * The exact text already handed to the server for each message.
 *
 * `applyMessages` reports every message its reducer produced, which includes a
 * message that merely grew — so a streaming reply, or any message that is
 * re-delivered by a later socket update, arrives here again with the same
 * content. Injecting it a second time does not overwrite the first: the server
 * appends, and both copies are then re-billed on every later turn.
 *
 * A live desktop session showed this directly — the same `CodexBash` call,
 * character for character, injected twice inside the same second — and the
 * session's context grew from 3.3k to 40k tokens in about ninety seconds.
 */
let injectedMessageText = new Map<string, string>();

/**
 * Turns already announced, per session, so one turn is announced once.
 *
 * The CLI closes a turn with a `turn-end` envelope, and every envelope id is
 * fresh, so re-delivery cannot be caught by message id alone. The turn id can.
 */
const announcedTurns = new Map<string, Set<string>>();

/**
 * Sessions whose CLI closes a turn with a `turn-end` envelope.
 *
 * The CLI ends a turn twice on the wire: a `turn-end` envelope (which is what
 * announces it) and a session-level `ready` event meaning "the CLI is idle
 * again". The second names no turn, so it cannot be matched to the first by id
 * — but it does not need to be: for a CLI that sends turn-ends at all, the idle
 * event is always the echo of one, and never a completion of its own. Seen once
 * per session rather than per turn, which is also what makes it survive the
 * turns a stop adds.
 *
 * A CLI that sends no turn-ends leaves this unset, and there the idle event is
 * the only completion signal there is — so it still announces.
 */
const reportsTurnEnds = new Set<string>();

/**
 * How many finished turns a session remembers for announcement purposes.
 *
 * Only the newest few can still be in flight, and a long-running session would
 * otherwise grow this without bound.
 */
const ANNOUNCED_TURN_MEMORY = 50;

/**
 * The tier in force for the running voice session.
 *
 * Module state rather than a prop because every one of these hooks is called
 * from the sync engine, which has no access to React context. `onVoiceStarted`
 * refreshes it from settings, so changing the tier takes effect on the next
 * voice session without touching the running one.
 */
let currentConfig: VoiceConfig = VOICE_CONFIG;

/** Switch tiers. Called once per voice session, from `onVoiceStarted`. */
export function setVoiceConfig(mode: VoiceContextMode | undefined) {
    currentConfig = getVoiceConfig(mode ?? DEFAULT_VOICE_CONTEXT_MODE);
}

/** The tier currently in force; exported for tests and diagnostics. */
export function getActiveVoiceConfig(): VoiceConfig {
    return currentConfig;
}

/**
 * A session other than the one the user is looking at. In the reporting tiers
 * these are announced rather than transcribed — see `REPORT_ONLY_BACKGROUND`.
 */
function isBackgroundSession(sessionId: string): boolean {
    return isBackground(getCurrentRealtimeSessionId(), sessionId);
}

/**
 * The harness name for a session, for the lines that name the agent outright.
 *
 * Resolved from session metadata at the moment of use rather than cached: the
 * flavor is only present once the session's metadata has synced, and a session
 * that arrives before its metadata would otherwise be mislabelled forever.
 */
function agentNameFor(sessionId: string): string {
    return resolveAgentName(storage.getState().sessions[sessionId]?.metadata?.flavor);
}

/**
 * Say which session is current, in a line the assistant can act on.
 *
 * The prompt already describes the rule — "the last focused session is where
 * requests usually go" — but never which session that is, so the model has to
 * infer it. In practice it inferred wrong: after the user switched sessions
 * mid-call it kept messaging the session it had been introduced to first, which
 * meant a real instruction landed in the wrong window. Stating the current
 * session outright removes the guess.
 *
 * Sent on every focus change rather than only at the start, because a fact that
 * was true when the call began is not a fact the model should have to
 * invalidate on its own.
 */
function sendCurrentSession(sessionId: string) {
    const summary = storage.getState().sessions[sessionId]?.metadata?.summary?.text;
    // Logged unconditionally, unlike the other hooks. This is the one update
    // whose loss breaks message routing, and the tier with the tightest budget
    // is the one that switches general logging off — which made an earlier
    // round of diagnosis impossible: the behaviour could not be observed
    // without editing the code.
    console.log(
        '🎤 Voice: current session →',
        sessionId,
        summary ? `("${summary}")` : '',
    );
    sendContext(formatCurrentSession(sessionId, summary));
}

// Prompt queue — batched text messages that trigger agent responses
let pendingPrompts: string[] = [];

// Subscribe to realtimeMode changes to flush when idle
let unsubscribeMode: (() => void) | null = null;
let lastRealtimeMode: string | null = null;

function ensureModeSubscription() {
    if (unsubscribeMode) return;
    lastRealtimeMode = storage.getState().realtimeMode;
    unsubscribeMode = storage.subscribe((state) => {
        const mode = state.realtimeMode;
        if (mode !== lastRealtimeMode) {
            lastRealtimeMode = mode;
            if (mode === 'idle') {
                flushPendingPrompts();
            }
        }
    });
}

function flushPendingPrompts() {
    if (pendingPrompts.length === 0) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) {
        pendingPrompts = [];
        return;
    }
    const batched = pendingPrompts.join('\n\n');
    pendingPrompts = [];
    voice.sendTextMessage(batched);
}

/**
 * Send silent background context — always immediate, never queued.
 */
function sendContext(update: string | null | undefined) {
    if (currentConfig.ENABLE_DEBUG_LOGGING) {
        console.log('🎤 Voice: sendContext:', update);
    }
    if (!update) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) return;
    voice.sendContextualUpdate(update);
}

/**
 * Send a prompt that triggers an agent response.
 * Queued while anyone (user or agent) is speaking, flushed on idle.
 */
function sendPrompt(update: string | null | undefined) {
    if (currentConfig.ENABLE_DEBUG_LOGGING) {
        console.log('🎤 Voice: sendPrompt:', update);
    }
    if (!update) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) return;

    const mode = storage.getState().realtimeMode;
    if (mode === 'idle') {
        voice.sendTextMessage(update);
    } else {
        pendingPrompts.push(update);
    }
}

/**
 * Inject full context for a session if not already shown.
 * Shared code path for both voice start and session focus.
 * Returns the formatted string (for initial prompt building) or null if already shown.
 */
function injectSessionContext(sessionId: string, background = false): string | null {
    if (shownSessions.has(sessionId)) return null;
    shownSessions.add(sessionId);
    const session = storage.getState().sessions[sessionId];
    if (!session) return null;
    const messages = storage.getState().sessionMessages[sessionId]?.messages ?? [];
    // A background session gets the skeleton (id, path, summary) and no
    // transcript: messages from a session the user is not looking at are the
    // single most expensive thing we can put in context, and the assistant can
    // ask that session to summarise itself when the user wants detail.
    const config = !shouldInjectMessageBody(currentConfig, background)
        ? { ...currentConfig, MAX_HISTORY_MESSAGES: 0 }
        : currentConfig;
    if (!shouldInjectMessageBody(currentConfig, background)) {
        reducedSessions.add(sessionId);
    }
    return formatSessionFull(session, messages, config);
}

/**
 * Build a one-line directory of all active sessions (id + summary).
 */
function formatSessionDirectory(): string {
    const activeSessions = storage.getState().getActiveSessions();
    if (activeSessions.length === 0) return 'No active sessions.';
    const lines = activeSessions.map(s => {
        const summary = s.metadata?.summary?.text ?? 'No summary';
        return `- ${s.id}: "${summary}"`;
    });
    return 'Available sessions:\n' + lines.join('\n');
}

export const voiceHooks = {

    /**
     * Called when a session comes online/connects
     */
    onSessionOnline(sessionId: string, metadata?: SessionMetadata) {
        if (currentConfig.DISABLE_SESSION_STATUS) return;

        const ctx = injectSessionContext(sessionId, isBackgroundSession(sessionId));
        if (ctx) sendContext(ctx);
        sendContext(formatSessionOnline(sessionId, metadata));
    },

    /**
     * Called when a session goes offline/disconnects
     */
    onSessionOffline(sessionId: string, metadata?: SessionMetadata) {
        if (currentConfig.DISABLE_SESSION_STATUS) return;

        const ctx = injectSessionContext(sessionId, isBackgroundSession(sessionId));
        if (ctx) sendContext(ctx);
        sendContext(formatSessionOffline(sessionId, metadata));
    },

    /**
     * Called when user navigates to/views a session
     */
    onSessionFocus(sessionId: string, metadata?: SessionMetadata) {
        if (currentConfig.DISABLE_SESSION_FOCUS) return;
        if (getCurrentRealtimeSessionId() === sessionId) return;
        setCurrentRealtimeSessionId(sessionId);
        // Stated separately from the event below, and unconditionally: the
        // minimal tier carries no session directory, so without this line
        // nothing in its context names a session and a switch goes unnoticed.
        sendCurrentSession(sessionId);
        // This session may so far have been only announced. Now that it is the
        // one the user is looking at, hand the assistant its transcript — for
        // this session the detail is the point, so it is worth its cost.
        if (reducedSessions.has(sessionId)) {
            shownSessions.delete(sessionId);
            reducedSessions.delete(sessionId);
        }
        // Focus moved to this session, so from here on it is the foreground one
        // and gets the full treatment even in the reporting tiers.
        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatSessionFocus(sessionId, metadata));
    },

    /**
     * Called when Claude requests permission for a tool use
     */
    onPermissionRequested(sessionId: string, requestId: string, toolName: string, toolArgs: any) {
        if (currentConfig.DISABLE_PERMISSION_REQUESTS) return;

        const background = isBackgroundSession(sessionId);
        const ctx = injectSessionContext(sessionId, background);
        if (ctx) sendContext(ctx);
        // Permission requests are always a prompt: the agent is blocked until
        // someone answers, so this must reach the user even in minimal mode.
        sendPrompt(formatPermissionRequest(
            sessionId,
            requestId,
            toolName,
            toolArgs,
            agentNameFor(sessionId),
        ));
    },

    /**
     * Called when agent sends a message/response
     */
    onMessages(sessionId: string, messages: Message[]) {
        if (currentConfig.DISABLE_MESSAGES) return;

        const background = isBackgroundSession(sessionId);
        if (!shouldInjectMessageBody(currentConfig, background)) {
            // Deliberately silent. A turn produces several messages (tool calls,
            // partial text, the final answer); announcing each one would make
            // the assistant talk over itself. The turn's `ready` event is the
            // single point where we know the work is done — that is where the
            // completion notice is sent (see onReady).
            return;
        }

        const ctx = injectSessionContext(sessionId, background);
        if (ctx) sendContext(ctx);

        // Only what has not been sent before, and only the parts that have
        // changed since. See `injectedMessageText`.
        const agentName = agentNameFor(sessionId);
        const cap = currentConfig.MAX_MESSAGE_CHARS;
        const fresh: Message[] = [];
        let suppressed = 0;
        for (const message of messages) {
            const text = formatMessage(message, currentConfig, agentName);
            if (!text) continue;
            const previous = injectedMessageText.get(message.id);
            if (previous === text) {
                suppressed += 1;
                continue;
            }
            // Text that streams in grows at the end, and each growth arrives as
            // a new update. Once the previous version was already clipped, the
            // part the assistant can see cannot change — only the amount it is
            // not shown, which is a number in the truncation marker. Re-sending
            // it re-bills the same prefix and appends a near-copy beside it,
            // because the realtime context only ever grows.
            if (previous && previous.length > cap && text.startsWith(previous.slice(0, cap))) {
                suppressed += 1;
                continue;
            }
            injectedMessageText.set(message.id, text);
            fresh.push(message);
        }
        if (suppressed > 0) {
            // Worth a line: this is the difference between a transcript that
            // grows with the agent's output and one that grows with the number
            // of updates to it, and the two look identical in the server's
            // usage numbers.
            console.log(
                `🎤 Voice: suppressed ${suppressed} re-injection(s) of already-sent messages`,
            );
        }
        if (fresh.length === 0) return;

        sendContext(formatNewMessages(sessionId, fresh, currentConfig, agentName));
    },

    /**
     * Called when voice session starts.
     * Builds initial prompt with session directory + full current session context.
     */
    onVoiceStarted(sessionId: string): string {
        // Pick up the tier chosen in settings. Doing it here (rather than in the
        // mic handler) keeps every entry point — including future ones — on the
        // same setting, and takes effect on the next session, never mid-call.
        setVoiceConfig(storage.getState().settings.voiceContextMode);

        if (currentConfig.ENABLE_DEBUG_LOGGING) {
            console.log('🎤 Voice session started for:', sessionId);
        }
        shownSessions.clear();
        reducedSessions.clear();
        injectedMessageText.clear();
        pendingPrompts = [];
        ensureModeSubscription();

        let prompt = '';

        // Session directory — all active sessions with titles. Skipped in the
        // minimal tier, where a fresh session should cost a brief and nothing
        // else; the assistant can still reach sessions by id.
        if (currentConfig.INCLUDE_SESSION_DIRECTORY) {
            prompt += formatSessionDirectory() + '\n\n';
        }

        // Full context for the current session
        const ctx = injectSessionContext(sessionId, false);
        if (ctx) {
            prompt += 'CURRENT SESSION:\n\n' + ctx;
        }

        // Stated in the brief as well as on every change, so the answer exists
        // from the first turn rather than only after the user switches. This is
        // also what minimal relies on: it carries no session directory, so
        // without this line nothing in its context names a session at all.
        prompt += '\n\n' + formatCurrentSession(
            sessionId,
            storage.getState().sessions[sessionId]?.metadata?.summary?.text,
        );

        return prompt;
    },

    /**
     * Called when Claude Code finishes processing (ready event)
     *
     * `turn` is what the client knows about the turn that ended: its id and
     * whether it completed, failed or was cancelled. Two things follow from
     * it, and both were bugs before it existed:
     *
     *  - A turn the user stopped is not news. Announcing "done working" for a
     *    Stop is the assistant talking back about the user's own action.
     *  - One turn, one announcement. The CLI marks the end of a turn twice —
     *    a `turn-end` envelope for the protocol, and a session-level `ready`
     *    event meaning "the CLI is idle again" — and both used to be announced.
     *    A turn that ended twice on the wire (a completed turn followed by an
     *    aborted one, as a Stop produces) therefore produced three identical
     *    replies. The turn id makes the announcement idempotent, and the idle
     *    echo is recognised because it names no turn at all.
     */
    onReady(sessionId: string, turn: ReadyTurn = {}) {
        if (currentConfig.DISABLE_READY_EVENTS) return;

        const turnId = turn.turnId;
        if (turnId) reportsTurnEnds.add(sessionId);

        // The user pressed Stop. Nothing finished, so nothing is announced.
        if (turn.status === 'cancelled') return;

        if (turnId) {
            const announced = announcedTurns.get(sessionId) ?? new Set<string>();
            if (announced.has(turnId)) return;
            announced.add(turnId);
            // Bounded: a long session would otherwise remember every turn it
            // ever ran. The newest few are all that can still be re-delivered.
            if (announced.size > ANNOUNCED_TURN_MEMORY) {
                announced.delete(announced.values().next().value!);
            }
            announcedTurns.set(sessionId, announced);
        } else if (reportsTurnEnds.has(sessionId)) {
            // No turn id: the session-level "gone idle" event, from a CLI whose
            // turns are already announced by their own ends.
            return;
        }

        const background = isBackgroundSession(sessionId);
        if (shouldAnnounceCompletion(currentConfig, background)) {
            // One cheap notice per finished turn instead of the whole
            // transcript: ~60 tokens against thousands, and it still carries
            // the part the user acts on — which session needs attention.
            const ctx = injectSessionContext(sessionId, true);
            if (ctx) sendContext(ctx);
            const session = storage.getState().sessions[sessionId];
            sendPrompt(formatCompletionNotice(
                sessionId,
                session?.metadata?.summary?.text,
                agentNameFor(sessionId),
            ));
            return;
        }

        const ctx = injectSessionContext(sessionId, false);
        if (ctx) sendContext(ctx);
        sendPrompt(formatReadyEvent(sessionId, agentNameFor(sessionId)));
    },

    /**
     * Called when voice session stops
     */
    onVoiceStopped() {
        if (currentConfig.ENABLE_DEBUG_LOGGING) {
            console.log('🎤 Voice session stopped');
        }
        // Back to the default tier between sessions so a stopped session leaves
        // no tier behind for other code paths to observe.
        currentConfig = VOICE_CONFIG;
        shownSessions.clear();
        reducedSessions.clear();
        injectedMessageText.clear();
        announcedTurns.clear();
        reportsTurnEnds.clear();
        pendingPrompts = [];
    }
};
