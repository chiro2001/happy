import { describe, expect, it } from 'vitest';
import { toolsForMode } from './tools';

/**
 * Which tools a tier is given.
 *
 * This is a cost decision as much as a capability one, and it is easy to undo
 * by accident: the tool definitions are re-sent and re-billed on every turn of
 * a call, and the realtime API has no cache. Measured against a real tokenizer,
 * the four-tool set costs ~723 tokens per turn and the two-tool set ~502, so
 * the pair that only the minimal tier needs is ~221 tokens of rent everywhere
 * else.
 */

function names(mode: 'minimal' | 'lite' | 'full' | undefined): string[] {
    return (toolsForMode(mode) as Array<{ function: { name: string } }>)
        .map((tool) => tool.function.name)
        .sort();
}

describe('tool sets per tier', () => {
    it('gives the read tools to the tier that carries no transcript', () => {
        // Minimal pushes nothing, so these are the only way it can learn what an
        // agent produced.
        expect(names('minimal')).toEqual([
            'getSessionHistory',
            'listSessions',
            'processPermissionRequest',
            'sendMessageToSession',
        ]);
    });

    it('leaves them out of the tiers that already receive the output', () => {
        // lite and full are pushed the agent's messages, and a pushed message
        // stays in the context — so for them the read tools buy nothing and
        // cost ~221 tokens on every turn.
        for (const mode of ['lite', 'full'] as const) {
            expect(names(mode)).toEqual([
                'processPermissionRequest',
                'sendMessageToSession',
            ]);
        }
    });

    it('falls back to the pushed tiers when no mode is known', () => {
        // Undefined means the setting has not loaded yet; the cheap assumption
        // is the one the tiers that push use, not the extra definitions.
        expect(names(undefined)).toEqual(names('lite'));
    });
});
