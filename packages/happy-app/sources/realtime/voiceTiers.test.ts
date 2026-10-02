import { describe, expect, it } from 'vitest';
import {
    DEFAULT_VOICE_CONTEXT_MODE,
    getVoiceConfig,
    isBackgroundSession,
    shouldAnnounceCompletion,
    shouldClaimVoiceFocus,
    shouldInjectMessageBody,
    VOICE_CONFIGS,
    type VoiceContextMode,
} from './voiceConfig';
import {
    formatCompletionNotice,
    formatNewMessages,
    formatReadyEvent,
    formatSessionFull,
    resolveAgentName,
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

function session(id: string, summary: string, flavor?: string): Session {
    return {
        id,
        metadata: { summary: { text: summary }, path: '/home/chiro/project', flavor },
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

        /**
         * The assistant's routing target is the session the user is looking
         * at, and nothing else may claim it. A captured session showed the
         * focus oscillating between two sessions every few seconds, each hop
         * 4-11 ms behind an arriving message: a background session was
         * capturing the target simply by producing output, so the user's next
         * instruction was delivered into a window they were not reading.
         */
        it('lets only the session on screen claim voice focus', () => {
            expect(shouldClaimVoiceFocus(SESSION_ID, OTHER_ID)).toBe(false);
            expect(shouldClaimVoiceFocus(SESSION_ID, SESSION_ID)).toBe(true);
        });

        it('does not overrule anything when no session is on screen', () => {
            // The list is showing, or a detail screen is on top; the app has no
            // claim, so a report about a session is the best evidence there is.
            expect(shouldClaimVoiceFocus(null, OTHER_ID)).toBe(true);
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

        it('caps at the tier limit, keeping the newest', () => {
            // Two things this has to get right, and an earlier version of this
            // test asserted the wrong one for both.
            //
            // The store hands messages over newest-first (the chat list renders
            // them inverted), so the cap has to keep the *recent* end: the
            // reason to carry history at all is to know what just happened.
            // And the transcript has to be written in the order it happened,
            // because a model reads the end of a transcript as the latest news
            // — handed a backwards one, it summarised the stale end of the
            // session, which is the bug this caught live.
            const newestFirst = [...messages].reverse();

            const full = formatSessionFull(session(SESSION_ID, 'Work'), newestFirst, VOICE_CONFIGS.full)!;
            const lite = formatSessionFull(session(SESSION_ID, 'Work'), newestFirst, VOICE_CONFIGS.lite)!;

            // full keeps the newest 50: steps 30..79.
            expect(full).toContain('<text>step 79</text>');
            expect(full).toContain('<text>step 30</text>');
            expect(full).not.toContain('<text>step 29</text>');
            expect(full.indexOf('<text>step 30</text>')).toBeLessThan(full.indexOf('<text>step 79</text>'));

            // lite keeps the newest 10: steps 70..79.
            expect(lite).toContain('<text>step 79</text>');
            expect(lite).toContain('<text>step 70</text>');
            expect(lite).not.toContain('<text>step 69</text>');
            expect(lite.indexOf('<text>step 70</text>')).toBeLessThan(lite.indexOf('<text>step 79</text>'));
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

    describe('what a tool call costs', () => {
        // For a Codex session the tool's description is the shell command, so
        // including it costs the tier's whole per-message budget per call, and
        // a session running commands produces one every few seconds. Measured
        // over a half-hour live window: tool calls were 47% of everything
        // injected, and the agent's own words were 1%.
        const bashCall = (id: string, command: string): Message => ({
            id,
            kind: 'tool-call',
            localId: null,
            createdAt: Number(id.replace(/\D/g, '')) || 0,
            tool: {
                name: 'CodexBash',
                description: command,
                input: { cmd: command },
                state: 'completed',
                createdAt: 0,
                startedAt: 0,
                completedAt: 0,
            },
            children: [],
        } satisfies Message);

        const command = '/usr/bin/zsh -lc "timeout 900 ssh a3-21 \'python3 ~/tmp/n16.py 19210 1,8,16 240\' 2>&1 | tail -60"';

        it('sends only the name in the lite tier', () => {
            const out = formatNewMessages(SESSION_ID, [bashCall('m1', command)], VOICE_CONFIGS.lite)!;

            expect(out).toContain('CodexBash');
            expect(out).not.toContain('timeout 900');
            expect(out).not.toContain('a3-21');
        });

        it('still sends the command in the full tier', () => {
            const out = formatNewMessages(SESSION_ID, [bashCall('m1', command)], VOICE_CONFIGS.full)!;

            expect(out).toContain('CodexBash');
            expect(out).toContain('a3-21');
        });

        it('sends nothing in the minimal tier', () => {
            const out = formatNewMessages(SESSION_ID, [bashCall('m1', command)], VOICE_CONFIGS.minimal);
            expect(out).toBeNull();
        });

        it('keeps a tool call that has no description', () => {
            // The earlier version nested the whole branch under "if there is a
            // description", which silently dropped every such call — so a tier
            // set to name-only would have reported nothing at all for the tools
            // that carry no description.
            const bare = {
                id: 'm2',
                kind: 'tool-call',
                localId: null,
                createdAt: 2,
                tool: {
                    name: 'CodexSubagent',
                    description: null,
                    input: {},
                    state: 'completed',
                    createdAt: 0,
                    startedAt: 0,
                    completedAt: 0,
                },
                children: [],
            } satisfies Message;

            const out = formatNewMessages(SESSION_ID, [bare], VOICE_CONFIGS.lite)!;
            expect(out).toContain('CodexSubagent');
        });

        it('cuts the injected size by roughly the length of the command', () => {
            const batch = Array.from({ length: 5 }, (_, i) => bashCall(`m${i}`, command));
            const full = formatNewMessages(SESSION_ID, batch, VOICE_CONFIGS.full)!.length;
            const lite = formatNewMessages(SESSION_ID, batch, VOICE_CONFIGS.lite)!.length;

            // The command is ~120 characters here; with a realistic one it is
            // the entire per-message budget.
            expect(lite).toBeLessThan(full / 3);
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

    /**
     * The transcript named Claude Code outright for every session. A captured
     * Codex session showed the assistant replying "Claude Code is using
     * CodexBash" — it was reporting the wrong agent for work it had just been
     * told about, which is the kind of error that silently discredits every
     * other thing it says.
     */
    describe('names the actual harness', () => {
        it('maps flavors, including the older Codex identifiers', () => {
            expect(resolveAgentName('codex')).toBe('Codex');
            expect(resolveAgentName('gpt')).toBe('Codex');
            expect(resolveAgentName('openai')).toBe('Codex');
            expect(resolveAgentName('claude')).toBe('Claude Code');
            expect(resolveAgentName('agy')).toBe('Antigravity');
            // Sessions older than multi-harness support were all Claude.
            expect(resolveAgentName(null)).toBe('Claude Code');
            expect(resolveAgentName(undefined)).toBe('Claude Code');
            // An unknown flavor is still better than the wrong product name.
            expect(resolveAgentName('something-new')).toBe('something-new');
        });

        it('uses the harness name in message lines', () => {
            const messages = [message('m1', 'agent-text', 'Patched the parser.')];
            const codex = formatNewMessages(SESSION_ID, messages, VOICE_CONFIGS.full, 'Codex')!;
            expect(codex).toContain('Codex:');
            expect(codex).not.toContain('Claude Code');
        });

        it('uses the harness name in the ready event', () => {
            expect(formatReadyEvent(SESSION_ID, 'Codex')).toContain('Codex done working');
            expect(formatReadyEvent(SESSION_ID)).toContain('Claude Code done working');
        });

        it('uses the harness name in completion notices', () => {
            const notice = formatCompletionNotice(OTHER_ID, 'Refactor done', 'Codex');
            expect(notice).toContain('Codex finished working');
        });

        it('reads the harness off the session when dumping its context', () => {
            const codex = formatSessionFull(
                session(SESSION_ID, 'Do the thing', 'codex'),
                [message('m1', 'agent-text', 'Done.')],
                VOICE_CONFIGS.full,
            )!;
            expect(codex).toContain('# Coding agent: Codex');
            expect(codex).toContain('Codex: \n<text>Done.</text>');
            expect(codex).not.toContain('Claude Code');

            const claude = formatSessionFull(
                session(SESSION_ID, 'Do the thing', 'claude'),
                [message('m1', 'agent-text', 'Done.')],
                VOICE_CONFIGS.minimal,
            )!;
            expect(claude).toContain('# Coding agent: Claude Code');
        });
    });
});
