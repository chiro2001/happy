/**
 * Qwen-Omni-Realtime list prices and cost estimation.
 *
 * Rates are CNY per million tokens, taken from the Bailian model catalogue
 * (`bl model list --model qwen3.8-omni-flash-realtime`) on 2026-10-01. They are
 * list prices: the console bill is authoritative, and account-level discounts
 * would not appear here.
 *
 * Note the asymmetry that drives the cost model: audio is 4x the text rate on
 * input and ~2.7x on output, but text dominates the bill in practice because
 * every turn re-sends the tool definitions and the accumulated history.
 */

export const QWEN_PRICE_CNY_PER_MILLION = {
    inputAudio: 6,
    inputText: 1.5,
    outputAudio: 12,
    outputText: 4.5,
} as const;

/** Free-tier grant for this model, per Bailian account. */
export const QWEN_FREE_TIER_TOKENS = 1_000_000;

/** Grace period ends here; the grant does not renew. */
export const QWEN_FREE_TIER_EXPIRES = '2026-12-21';

/** Token counts accumulated across every turn of every session. */
export interface QwenUsageTotals {
    inputAudioTokens: number;
    inputTextTokens: number;
    outputAudioTokens: number;
    outputTextTokens: number;
    /** Number of completed turns; used to show an average. */
    turnCount: number;
    /**
     * Wall-clock time the session was connected, in milliseconds.
     *
     * Paired with `speechMs` this is the headline difference from ElevenLabs:
     * that provider bills connected time, so a ten-minute call with one minute
     * of speech costs ten minutes. Here only speech is committed and billed,
     * and the gap between the two numbers is money not spent.
     */
    connectionMs: number;
    /** Time the server's VAD classified as speech, in milliseconds. */
    speechMs: number;
    /** Epoch ms of the last update, or 0 when never used. */
    updatedAt: number;
}

export const EMPTY_QWEN_USAGE: QwenUsageTotals = {
    inputAudioTokens: 0,
    inputTextTokens: 0,
    outputAudioTokens: 0,
    outputTextTokens: 0,
    turnCount: 0,
    connectionMs: 0,
    speechMs: 0,
    updatedAt: 0,
};

export function totalTokens(totals: QwenUsageTotals): number {
    return (
        totals.inputAudioTokens +
        totals.inputTextTokens +
        totals.outputAudioTokens +
        totals.outputTextTokens
    );
}

/**
 * Estimated spend in CNY.
 *
 * This is what the turn *would* cost at list price. While the free grant
 * covers it the real charge is zero — pair this with `totalTokens` against
 * `QWEN_FREE_TIER_TOKENS` to see which side of that line you are on.
 */
export function estimateCostCny(totals: QwenUsageTotals): number {
    const p = QWEN_PRICE_CNY_PER_MILLION;
    return (
        (totals.inputAudioTokens / 1e6) * p.inputAudio +
        (totals.inputTextTokens / 1e6) * p.inputText +
        (totals.outputAudioTokens / 1e6) * p.outputAudio +
        (totals.outputTextTokens / 1e6) * p.outputText
    );
}

/** Format a CNY amount with enough precision to stay meaningful when tiny. */
export function formatCny(amount: number): string {
    if (amount === 0) return '¥0';
    if (amount < 0.01) return `¥${amount.toFixed(5)}`;
    if (amount < 1) return `¥${amount.toFixed(4)}`;
    return `¥${amount.toFixed(2)}`;
}

/** Compact token counts: 12,345 → "12.3k". */
export function formatTokens(count: number): string {
    if (count < 1000) return String(count);
    if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
    return `${(count / 1_000_000).toFixed(2)}M`;
}

/** Human-readable duration: 45s / 3m12s / 1h05m. */
export function formatDuration(ms: number): string {
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Share of connected time that was silence, as a percentage.
 *
 * Returns null when the session is too short for the ratio to mean anything —
 * a three-second session would report a wild figure.
 */
export function silenceSharePercent(totals: QwenUsageTotals): number | null {
    if (totals.connectionMs < 10_000) return null;
    const silent = totals.connectionMs - totals.speechMs;
    return Math.max(0, Math.min(100, (silent / totals.connectionMs) * 100));
}

/**
 * What the same connected time would have cost on a per-minute provider.
 *
 * ElevenLabs lists ~¥0.57/min for its tier (see FINDINGS.md §5). This is the
 * comparison that makes the per-token model's advantage concrete.
 */
export const ELEVENLABS_CNY_PER_MINUTE = 0.57;

export function elevenLabsEquivalentCny(connectionMs: number): number {
    return (connectionMs / 60_000) * ELEVENLABS_CNY_PER_MINUTE;
}
