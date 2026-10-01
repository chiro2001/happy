import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta } from './messageMeta';
import type { Session } from './storageTypes';
import type { Settings } from './settings';

/**
 * A message's permission mode is an instruction to change modes, not a hint:
 * the CLI's Codex runner resolves `message.meta.permissionMode` and logs
 * "Permission mode updated from user message to: …", while sending nothing logs
 * "using current". So the difference between sending a value and omitting it is
 * the difference between changing the session and leaving it alone.
 *
 * That makes any fallback to a code default dangerous. A session started from
 * the CLI records no permission mode — checked against eighteen live sessions,
 * whose metadata carries `dangerouslySkipPermissions` and nothing else — so a
 * freshly opened client has an empty mirror and would substitute `auto` for
 * every message. A session launched with `--permission-mode yolo` was then
 * quietly turned back into one that stops and asks.
 */

const CLI = '1.2.5';

function codexSession(overrides: Partial<Session> = {}): Session {
    return {
        permissionMode: null,
        modelMode: null,
        effortLevel: null,
        serviceTier: undefined,
        metadata: { flavor: 'codex', version: CLI },
        ...overrides,
    } as unknown as Session;
}

const settings = (overrides: Settings['agentDefaultOverrides'] = {}): Settings =>
    ({ agentDefaultOverrides: overrides } as Settings);

describe('codex message permission mode', () => {
    it('sends nothing when the app has no idea what mode the session runs in', () => {
        // The regression: this used to send `auto`, the code default, which the
        // CLI applied as a mode change.
        const meta = resolveMessageModeMeta(codexSession(), settings());
        expect(meta.permissionMode).toBeUndefined();
    });

    it('sends the mode the user picked', () => {
        const meta = resolveMessageModeMeta(
            codexSession({ permissionMode: 'read-only' } as Partial<Session>),
            settings(),
        );
        expect(meta.permissionMode).toBe('read-only');
    });

    it('still re-asserts a pick after Codex resets to its launch mode on abort', () => {
        // The reason the old code sent a mode every turn; it must keep working
        // for a mode the user actually chose.
        const meta = resolveMessageModeMeta(
            codexSession({ permissionMode: 'yolo' } as Partial<Session>),
            settings(),
        );
        expect(meta.permissionMode).toBe('yolo');
    });

    it('sends an explicitly configured per-agent override', () => {
        // A setting the user made is real intent, unlike a built-in default.
        const meta = resolveMessageModeMeta(
            codexSession(),
            settings({ codex: { permissionMode: 'safe-yolo' } }),
        );
        expect(meta.permissionMode).toBe('safe-yolo');
    });

    it('prefers the session pick over the override', () => {
        const meta = resolveMessageModeMeta(
            codexSession({ permissionMode: 'read-only' } as Partial<Session>),
            settings({ codex: { permissionMode: 'safe-yolo' } }),
        );
        expect(meta.permissionMode).toBe('read-only');
    });

    it('leaves the claude path alone: a pick is still always sent', () => {
        const claude = {
            permissionMode: 'bypassPermissions',
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'claude', version: CLI },
        } as unknown as Session;
        expect(resolveMessageModeMeta(claude, settings()).permissionMode)
            .toBe('bypassPermissions');
    });
});
