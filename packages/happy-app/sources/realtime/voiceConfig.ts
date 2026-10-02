/**
 * How much context the voice assistant is given, and how often.
 *
 * Everything in a realtime session's context is re-billed on every turn, so
 * carrying more than the assistant needs is a recurring cost rather than a
 * one-off. Measured on a live session, a single background-session output of
 * 11,716 tokens stayed in context and was charged again on all 16 remaining
 * turns — 187k tokens for something the user never asked to hear.
 *
 * Three tiers trade context for cost. Numbers are from `measure_context.py`
 * and `tier_model.py` in portable-tmux/tools/qwen-realtime-test.
 */

export type VoiceContextMode = 'minimal' | 'lite' | 'full';

export interface VoiceConfig {
    /**
     * How much of a tool call reaches the context.
     *
     * - `full`   name, clipped description, and for the verbose tiers the
     *            arguments too
     * - `name`   just the tool's name — "Codex is using CodexBash"
     * - `off`    nothing at all
     *
     * This is the single biggest lever left, and the measurement is not close.
     * For a Codex session the tool's description *is* the shell command, so a
     * `full` tool call costs the tier's whole per-message budget — 700
     * characters in lite — and a session running commands produces one every
     * few seconds. Of everything injected into a live desktop session over a
     * half-hour window, tool calls were 47% and the agent's own words were 1%.
     *
     * The split does not match what a voice assistant needs. Its job is to say
     * what a session is doing, and the tool's *name* answers that: running a
     * command, editing files, waiting on a subagent. The command text itself is
     * never read aloud, and when the user does want detail the agent's own
     * summary — or `getSessionHistory` — is a better source than a spliced
     * shell line.
     */
    TOOL_CALL_DETAIL: 'full' | 'name' | 'off';
    /** Never forward permission requests — the assistant loses approval ability. */
    DISABLE_PERMISSION_REQUESTS: boolean;
    /** Skip session online/offline notices. */
    DISABLE_SESSION_STATUS: boolean;
    /** Skip new-message injection entirely. */
    DISABLE_MESSAGES: boolean;
    /** Skip session-focus notices. */
    DISABLE_SESSION_FOCUS: boolean;
    /** Skip "the agent finished" prompts, which trigger a spoken report. */
    DISABLE_READY_EVENTS: boolean;
    /** How many past messages to include when dumping a session. 0 = none. */
    MAX_HISTORY_MESSAGES: number;
    ENABLE_DEBUG_LOGGING: boolean;
    /**
     * Announce background sessions as short "finished" notices instead of
     * injecting their message bodies.
     *
     * This is the single biggest lever. A notice costs ~60 tokens and tells the
     * user which session needs them; the body costs thousands and stays in
     * context for the rest of the session. Detail is still reachable — the
     * assistant can ask that session to summarise itself, and an agent's own
     * summary beats a transcript we spliced together anyway.
     */
    REPORT_ONLY_BACKGROUND: boolean;
    /** Include the list of all active sessions in the opening prompt. */
    INCLUDE_SESSION_DIRECTORY: boolean;
    /**
     * Reconnect with a fresh brief after this many assistant turns, or null to
     * never reconnect.
     *
     * Nothing the server has already seen can be un-seen: context is re-billed
     * every turn, so a long conversation becomes quadratic. Restarting drops
     * the accumulated transcript at the cost of a moment's silence and a new
     * opening brief. Only the cheap tiers do it — in the full tier the whole
     * point is continuity.
     */
    RESET_AFTER_TURNS: number | null;
    /**
     * Longest single message allowed into the context, in characters.
     *
     * The transcript has no natural size limit, and the worst offenders are
     * tool calls: Codex puts the entire shell command in the tool description,
     * so one `CodexBash` can be several thousand characters. Measured on a live
     * desktop session, context grew from 3.3k to 40k tokens in about ninety
     * seconds, and every one of those tokens is re-billed on every later turn.
     *
     * Truncation is not free — the assistant loses the tail of long output —
     * which is why the cap is per tier rather than global. `full` keeps enough
     * to be useful; the cheap tiers keep the shape of what happened and rely on
     * the assistant asking the session for detail it actually needs.
     */
    MAX_MESSAGE_CHARS: number;
    /**
     * Longest combined payload for one new-message injection, in characters.
     *
     * The per-message cap above bounds one message; this bounds the batch, and
     * without it the batch is the hole. A busy session delivers a dozen changed
     * rows in one update, each clipped to the per-message cap, so a single
     * injection could reach ~8,000 characters (~2,500 tokens) — and everything
     * injected stays in the realtime context and is re-billed on every later
     * turn. Measured on a live desktop session: three voice turns billed
     * 61,935 input tokens, growing 8.7k → 40.4k, with individual injections
     * costing 1,000–2,500 tokens each.
     *
     * The newest messages are kept, because a batch is a burst of progress and
     * the end of it is where the session got to. Older ones are dropped with a
     * marker rather than silently, so the assistant knows it is not seeing
     * everything and can ask the agent for detail.
     */
    MAX_INJECTION_CHARS: number;
    /**
     * Whether an agent's own output is pushed into the context as it happens.
     *
     * The single most expensive thing we can do, because everything pushed
     * stays: the realtime API has no cache and no way to delete an item, so a
     * pushed message body is re-billed on every later turn of the call. A body
     * the assistant fetches through `getSessionHistory` instead is paid once,
     * by a question that actually needed it.
     *
     * Turning this off does not remove the assistant's ability to answer
     * questions about a session — it changes when the reading happens, from
     * "always, in advance" to "when asked". What it does give up is
     * unprompted commentary: an assistant that has not read the output cannot
     * volunteer what it says.
     */
    PUSH_AGENT_OUTPUT: boolean;
}

/**
 * Full — the original behaviour.
 *
 * Every message from every session is injected verbatim and stays in context.
 * Best comprehension, highest cost: a three-session session costs ~5x lite
 * over 50 turns.
 */
const FULL: VoiceConfig = {
    TOOL_CALL_DETAIL: 'full',
    DISABLE_PERMISSION_REQUESTS: false,
    DISABLE_SESSION_STATUS: true,
    DISABLE_MESSAGES: false,
    DISABLE_SESSION_FOCUS: false,
    DISABLE_READY_EVENTS: false,
    MAX_HISTORY_MESSAGES: 50,
    ENABLE_DEBUG_LOGGING: true,
    REPORT_ONLY_BACKGROUND: false,
    INCLUDE_SESSION_DIRECTORY: true,
    RESET_AFTER_TURNS: null,
    MAX_MESSAGE_CHARS: 4000,
    MAX_INJECTION_CHARS: 8000,
    PUSH_AGENT_OUTPUT: true,
};

/**
 * Lite — the recommended default.
 *
 * Background sessions report completion instead of injecting bodies; the
 * focused session keeps a short message history. Still ~2.5x cheaper than full
 * over 100 turns, and the assistant keeps every capability.
 */
const LITE: VoiceConfig = {
    ...FULL,
    // Name only. The description is the shell command, and a command is the one
    // part of a tool call that never belongs in a spoken summary; the name is
    // what tells the assistant whether the session is running something,
    // editing something, or waiting on a subagent. Measured on a live desktop
    // session, this is most of what the tier was spending.
    TOOL_CALL_DETAIL: 'name',
    MAX_HISTORY_MESSAGES: 10,
    REPORT_ONLY_BACKGROUND: true,
    INCLUDE_SESSION_DIRECTORY: true,
    RESET_AFTER_TURNS: 20,
    MAX_MESSAGE_CHARS: 700,
    MAX_INJECTION_CHARS: 2000,
    PUSH_AGENT_OUTPUT: true,
};

/**
 * Minimal — cheapest, for long or noisy sessions.
 *
 * No message bodies at all, only a summary plus completion notices. The
 * assistant summarises and sends messages but cannot quote detail; it must ask
 * the agent when the user wants specifics.
 */
const MINIMAL: VoiceConfig = {
    ...LITE,
    // Nothing reaches this tier, so names would be its only claim about what an
    // agent produced — and a name without a result is not worth the rent.
    TOOL_CALL_DETAIL: 'off',
    MAX_HISTORY_MESSAGES: 0,
    INCLUDE_SESSION_DIRECTORY: false,
    ENABLE_DEBUG_LOGGING: false,
    RESET_AFTER_TURNS: 10,
    MAX_MESSAGE_CHARS: 300,
    MAX_INJECTION_CHARS: 900,
    // Minimal reads on demand and pushes nothing. Its whole premise is that a
    // transcript the user has not asked to hear is not worth its rent.
    PUSH_AGENT_OUTPUT: false,
};

export const VOICE_CONFIGS: Record<VoiceContextMode, VoiceConfig> = {
    minimal: MINIMAL,
    lite: LITE,
    full: FULL,
};

/** The tier used when nothing has been chosen. */
export const DEFAULT_VOICE_CONTEXT_MODE: VoiceContextMode = 'full';

export function getVoiceConfig(mode: VoiceContextMode): VoiceConfig {
    return VOICE_CONFIGS[mode] ?? VOICE_CONFIGS[DEFAULT_VOICE_CONTEXT_MODE];
}

//
// Tier policy
//
// The rules the hooks apply, kept as pure functions so they can be tested
// without a store, a socket, or a React tree.
//

/**
 * Whether `sessionId` is a session the user is not currently looking at.
 *
 * Before a voice session has a focused session there is nothing to be
 * background *to*, so nothing counts as background.
 */
export function isBackgroundSession(focusedSessionId: string | null, sessionId: string): boolean {
    return focusedSessionId !== null && focusedSessionId !== sessionId;
}

/**
 * Whether message bodies from this session may enter the assistant's context.
 * The single largest cost decision in the whole feature.
 */
export function shouldInjectMessageBody(config: VoiceConfig, background: boolean): boolean {
    return !(background && config.REPORT_ONLY_BACKGROUND);
}

/**
 * Whether a session may become the assistant's routing target.
 *
 * Focus means "the session the user is looking at", and the only evidence for
 * that is the app's own record of the session on screen. Visibility reports are
 * not that evidence: they also fire for preloads, refreshes and embedded
 * previews, so a background session that merely produced output could claim
 * focus and receive the user's next instruction.
 *
 * A null viewing session means the app has no claim at all — the list is
 * showing, or a detail screen is on top — so nothing is overruled.
 */
export function shouldClaimVoiceFocus(
    viewingSessionId: string | null,
    sessionId: string,
): boolean {
    return viewingSessionId === null || viewingSessionId === sessionId;
}

/** Whether a finished turn in this session is announced rather than read out. */
export function shouldAnnounceCompletion(config: VoiceConfig, background: boolean): boolean {
    return background && config.REPORT_ONLY_BACKGROUND;
}

/**
 * Kept so existing call sites that want the original behaviour still work.
 * Prefer `getVoiceConfig(mode)` in new code.
 */
export const VOICE_CONFIG = FULL;
