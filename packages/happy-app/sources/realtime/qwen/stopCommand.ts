/**
 * Detecting "stop talking" utterances.
 *
 * Kept in a plain `.ts` module, separate from the session component, so it can
 * be unit-tested without pulling React Native into the test environment.
 *
 * Why this exists at all: the server treats every utterance as a turn to answer.
 * Measured on-device, saying 停止 produced a fresh 7.1-second spoken reply, and
 * saying 停下 produced another 1.7 seconds after that. Each attempt to silence
 * the assistant made it talk more — which is what "it takes ages to react when
 * I say stop" turned out to be. The server was reacting promptly; it just
 * answered the word instead of obeying it.
 */

const STOP_PHRASES = [
    '停止',
    '停下',
    '停一下',
    '别说了',
    '不要说了',
    '别说',
    '安静',
    '闭嘴',
    '停',
    'stop',
    'stopit',
    'bequiet',
    'shutup',
];

/**
 * Whether a transcript is a bare stop command.
 *
 * Deliberately strict: only short, self-contained utterances count. "停一下，
 * 我看看这个" is a normal sentence that happens to contain 停, and replying to
 * it is correct — the cost of a false positive (ignoring a real request) is
 * worse than a false negative (one extra reply).
 */
export function isStopCommand(text: string): boolean {
    const normalized = text
        .trim()
        .toLowerCase()
        .replace(/[\s。，、！？,.!?~～]/g, '');
    if (!normalized || normalized.length > 6) return false;
    return STOP_PHRASES.includes(normalized);
}
