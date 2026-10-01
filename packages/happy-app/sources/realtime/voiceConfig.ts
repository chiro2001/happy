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
    /** Drop tool-call information entirely. */
    DISABLE_TOOL_CALLS: boolean;
    /** Send tool names and descriptions but not their arguments. */
    LIMITED_TOOL_CALLS: boolean;
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
}

/**
 * Full — the original behaviour.
 *
 * Every message from every session is injected verbatim and stays in context.
 * Best comprehension, highest cost: a three-session session costs ~5x lite
 * over 50 turns.
 */
const FULL: VoiceConfig = {
    DISABLE_TOOL_CALLS: false,
    LIMITED_TOOL_CALLS: true,
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
    MAX_HISTORY_MESSAGES: 10,
    REPORT_ONLY_BACKGROUND: true,
    INCLUDE_SESSION_DIRECTORY: true,
    RESET_AFTER_TURNS: 20,
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
    DISABLE_TOOL_CALLS: true,
    MAX_HISTORY_MESSAGES: 0,
    INCLUDE_SESSION_DIRECTORY: false,
    ENABLE_DEBUG_LOGGING: false,
    RESET_AFTER_TURNS: 10,
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
