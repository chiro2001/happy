import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the Tauri websocket adapter.
 *
 * The regression this pins down is a race, and it fails silently: the socket
 * connects, the UI reports "connecting", and nothing ever arrives — no error,
 * no close, because nothing went wrong. DashScope sends `session.created` in
 * the same millisecond the handshake completes, so any listener registered
 * after `connect` resolves has already missed the one frame the whole session
 * setup depends on.
 */

/** Frames the fake backend pushes, and what the adapter's handler did with them. */
const harness = {
    /** Set by the adapter when it creates its channel. */
    onmessage: null as ((message: unknown) => void) | null,
    /** Resolves the `connect` invoke, standing in for the handshake. */
    releaseConnect: null as ((id: number) => void) | null,
    invokes: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
    /** True once the adapter has registered its handler. */
    handlerRegistered: false,
};

class FakeChannel<T> {
    onmessage: ((message: T) => void) | null = null;
    constructor() {
        // The real Channel is handed to the backend, which calls `onmessage`
        // when a frame arrives. The adapter must set it before connecting.
        queueMicrotask(() => {
            harness.onmessage = (message: unknown) => this.onmessage?.(message as T);
            harness.handlerRegistered = this.onmessage !== null;
        });
    }
}

vi.mock('@tauri-apps/api/core', () => ({
    Channel: FakeChannel,
    invoke: async (cmd: string, args: Record<string, unknown>) => {
        harness.invokes.push({ cmd, args });
        if (cmd === 'plugin:websocket|connect') {
            return new Promise<number>((resolve) => {
                harness.releaseConnect = resolve;
            });
        }
        return undefined;
    },
}));

async function loadAdapter() {
    vi.resetModules();
    return import('../socket.web');
}

/** The adapter decides Tauri-vs-browser from this global. */
function pretendTauri() {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
}

beforeEach(() => {
    harness.onmessage = null;
    harness.releaseConnect = null;
    harness.invokes.length = 0;
    harness.handlerRegistered = false;
    pretendTauri();
});

describe('Tauri websocket adapter', () => {
    it('registers its handler before the connection resolves', async () => {
        const { createDefaultSocket } = await loadAdapter();
        const socket = createDefaultSocket('wss://example.test/ws', { Authorization: 'Bearer k' });
        const received: string[] = [];
        socket.onmessage = (e) => received.push(String(e.data));

        // Let the microtask that installs the handler run, as it would while
        // the handshake is still in flight.
        await Promise.resolve();
        await Promise.resolve();
        expect(harness.handlerRegistered).toBe(true);

        harness.releaseConnect?.(1);
        await Promise.resolve();
        await Promise.resolve();

        // Now the frame DashScope sends immediately after the handshake.
        harness.onmessage?.({ type: 'Text', data: '{"type":"session.created"}' });
        expect(received).toEqual(['{"type":"session.created"}']);
    });

    it('delivers a frame that arrives before connect resolves', async () => {
        const { createDefaultSocket } = await loadAdapter();
        const socket = createDefaultSocket('wss://example.test/ws', { Authorization: 'Bearer k' });
        const received: string[] = [];
        socket.onmessage = (e) => received.push(String(e.data));
        await Promise.resolve();
        await Promise.resolve();

        // The exact race: the frame lands while the connect promise is still
        // pending. With the plugin's own helper this is where it was dropped.
        harness.onmessage?.({ type: 'Text', data: '{"type":"session.created"}' });

        expect(received).toEqual(['{"type":"session.created"}']);
    });

    it('sends headers as pairs, matching the Rust config type', async () => {
        const { createDefaultSocket } = await loadAdapter();
        createDefaultSocket('wss://example.test/ws', { Authorization: 'Bearer k', 'X-A': 'b' });
        await Promise.resolve();

        const connect = harness.invokes.find((i) => i.cmd === 'plugin:websocket|connect')!;
        // `Vec<(String, String)>` on the Rust side — not an object.
        expect(connect.args).toMatchObject({
            url: 'wss://example.test/ws',
            config: { headers: [['Authorization', 'Bearer k'], ['X-A', 'b']] },
        });
    });

    it('reports a read error as the end of the connection', async () => {
        const { createDefaultSocket } = await loadAdapter();
        const socket = createDefaultSocket('wss://example.test/ws', {});
        await Promise.resolve();
        await Promise.resolve();
        harness.releaseConnect?.(2);
        await Promise.resolve();
        await Promise.resolve();

        let closed = false;
        socket.onclose = () => { closed = true; };
        // The Rust side serializes errors as a bare string; without handling it
        // the UI would keep showing a call that had already dropped.
        harness.onmessage?.('connection reset by peer');

        expect(closed).toBe(true);
        expect(socket.readyState).toBe(3);
    });

    it('closes a socket that was closed while connecting', async () => {
        const { createDefaultSocket } = await loadAdapter();
        const socket = createDefaultSocket('wss://example.test/ws', {});
        await Promise.resolve();
        await Promise.resolve();

        socket.close();
        harness.releaseConnect?.(3);
        await Promise.resolve();
        await Promise.resolve();

        const closeFrame = harness.invokes.find(
            (i) => i.cmd === 'plugin:websocket|send'
                && (i.args.message as { type?: string })?.type === 'Close',
        );
        expect(closeFrame).toBeDefined();
        // It must never have been adopted as an open connection.
        expect(socket.readyState).toBe(3);
    });
});
