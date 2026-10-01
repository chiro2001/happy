import { describe, expect, it } from 'vitest';
import {
    DEFAULT_VOICE_CONTEXT_MODE,
    getVoiceConfig,
    isBackgroundSession,
    shouldAnnounceCompletion,
    shouldInjectMessageBody,
    VOICE_CONFIGS,
    type VoiceContextMode,
} from './voiceConfig';
import {
    formatCompletionNotice,
    formatNewMessages,
    formatSessionFull,
} from './hooks/contextFormatters';
import {
    getVoiceSystemPromptBase,
    VOICE_SYSTEM_PROMPT_BASE,
    VOICE_SYSTEM_PROMPT_LITE,
    VOICE_SYSTEM_PROMPT_MINIMAL,
} from './voiceSystemPrompt';
import type { Message } from '@/sync/typesMessage';
import type { Session } from '@/sync/storageTypes';

/**
 * The tiers exist to cut what the assistant carries, so the tests here are
 * mostly about *what reaches the prompt*: which sessions get their message
 * bodies, how much history, and how big the fixed parts are. A tier that is
 * merely "different" is not useful; a tier that is cheaper and still correct is.
 */

/** Same estimate the Python cost model uses: ~4 chars/token ASCII, ~1.5 CJK. */
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

function message(id: string, kind: 'agent-text' | 'user-text', text: string): Message {
    return {
        id,
        kind,
        createdAt: Number(id.replace(/\D/g, '')) || 0,
        text,
    } as Message;
}

function session(id: string, summary: string): Session {
    return {
        id,
        metadata: { summary: { text: summary }, path: '/home/chiro/project' },
    } as unknown as Session;
}

const SESSION_ID = 's-current';
const OTHER_ID = 's-background';

describe('voice context tiers', () => {
    it('defaults to the pre-tier behaviour so an update changes nothing', () => {
        expect(DEFAULT_VOICE_CONTEXT_MODE).toBe('full');
        expect(getVoiceConfig(DEFAULT_VOICE_CONTEXT_MODE).REPORT_ONLY_BACKGROUND).toBe(false);
        expect(getVoiceConfig(DEFAULT_VOICE_CONTEXT_MODE).MAX_HISTORY_MESSAGES).toBe(50);
        expect(getVoiceConfig(DEFAULT_VOICE_CONTEXT_MODE).RESET_AFTER_TURNS).toBeNull();
    });

    it('falls back to the default for unknown or missing modes', () => {
        expect(getVoiceConfig(undefined as unknown as VoiceContextMode))
            .toBe(VOICE_CONFIGS.full);
        expect(getVoiceConfig('nonsense' as VoiceContextMode)).toBe(VOICE_CONFIGS.full);
    });

    it('keeps permission approvals in every tier', () => {
        for (const mode of ['minimal', 'lite', 'full'] as const) {
            expect(getVoiceConfig(mode).DISABLE_PERMISSION_REQUESTS).toBe(false);
        }
    });

    describe('background sessions', () => {
        it('recognises a session the user is not looking at', () => {
            expect(isBackgroundSession(null, OTHER_ID)).toBe(false);
            expect(isBackgroundSession(SESSION_ID, SESSION_ID)).toBe(false);
            expect(isBackgroundSession(SESSION_ID, OTHER_ID)).toBe(true);
        });

        it('transcribes the background session only in the full tier', () => {
            expect(shouldInjectMessageBody(VOICE_CONFIGS.full, true)).toBe(true);
            expect(shouldInjectMessageBody(VOICE_CONFIGS.lite, true)).toBe(false);
            expect(shouldInjectMessageBody(VOICE_CONFIGS.minimal, true)).toBe(false);
        });

        it('always transcribes the focused session', () => {
            for (const mode of ['minimal', 'lite', 'full'] as const) {
                expect(shouldInjectMessageBody(getVoiceConfig(mode), false)).toBe(true);
            }
        });

        it('announces a finished background turn exactly where it is not transcribed', () => {
            for (const mode of ['minimal', 'lite', 'full'] as const) {
                const config = getVoiceConfig(mode);
                expect(shouldAnnounceCompletion(config, true))
                    .toBe(!shouldInjectMessageBody(config, true));
            }
        });

        it('costs roughly two orders of magnitude less than the body it replaces', () => {
            const messages = Array.from({ length: 6 }, (_, i) =>
                message(`m${i}`, 'agent-text', 'Edited src/foo.ts and ran the test suite. '.repeat(40)));
            const body = formatNewMessages(OTHER_ID, messages, VOICE_CONFIGS.full)!;
            const notice = formatCompletionNotice(OTHER_ID, 'Refactor done');
            expect(estimateTokens(notice)).toBeLessThan(80);
            expect(estimateTokens(body) / estimateTokens(notice)).toBeGreaterThan(20);
        });
    });

    describe('history dumped with a session', () => {
        const messages = Array.from({ length: 80 }, (_, i) =>
            message(`m${i}`, 'agent-text', `step ${i}`));

        it('caps at the tier limit', () => {
            const full = formatSessionFull(session(SESSION_ID, 'Work'), messages, VOICE_CONFIGS.full)!;
            const lite = formatSessionFull(session(SESSION_ID, 'Work'), messages, VOICE_CONFIGS.lite)!;
            expect(full).toContain('<text>step 0</text>');
            expect(full).toContain('<text>step 49</text>');
            expect(full).not.toContain('<text>step 50</text>');
            expect(lite).toContain('<text>step 0</text>');
            expect(lite).toContain('<text>step 9</text>');
            expect(lite).not.toContain('<text>step 10</text>');
        });

        it('omits the history section entirely in the minimal tier', () => {
            const minimal = formatSessionFull(session(SESSION_ID, 'Work'), messages, VOICE_CONFIGS.minimal)!;
            expect(minimal).not.toContain('Our interaction history');
            expect(minimal).not.toContain('<text>step 0</text>');
            // The skeleton is still there — the assistant knows which session it
            // is talking about and can ask it for detail.
            expect(minimal).toContain(SESSION_ID);
            expect(minimal).toContain('Work');
        });
    });

    describe('fixed per-turn cost', () => {
        it('shrinks the system prompt with the tier', () => {
            const minimal = estimateTokens(getVoiceSystemPromptBase('minimal'));
            const lite = estimateTokens(getVoiceSystemPromptBase('lite'));
            const full = estimateTokens(getVoiceSystemPromptBase('full'));
            expect(minimal).toBeLessThan(lite);
            expect(lite).toBeLessThan(full);
            expect(full).toBe(estimateTokens(VOICE_SYSTEM_PROMPT_BASE));
            expect(lite).toBe(estimateTokens(VOICE_SYSTEM_PROMPT_LITE));
            expect(minimal).toBe(estimateTokens(VOICE_SYSTEM_PROMPT_MINIMAL));
        });

        it('keeps the rules that cost money to lose', () => {
            for (const prompt of [VOICE_SYSTEM_PROMPT_MINIMAL, VOICE_SYSTEM_PROMPT_LITE, VOICE_SYSTEM_PROMPT_BASE]) {
                expect(prompt).toContain('skip_turn');
                expect(prompt).toContain('sendMessageToSession');
                expect(prompt).toContain('processPermissionRequest');
            }
            // Only the cheap tiers need to be told they cannot see output.
            expect(VOICE_SYSTEM_PROMPT_MINIMAL).toContain('not shown what an agent produced');
        });

        it('resets long conversations only where the tier says so', () => {
            expect(VOICE_CONFIGS.full.RESET_AFTER_TURNS).toBeNull();
            expect(VOICE_CONFIGS.lite.RESET_AFTER_TURNS).toBe(20);
            expect(VOICE_CONFIGS.minimal.RESET_AFTER_TURNS).toBe(10);
        });
    });
});
