/**
 * Default WebSocket for the Qwen client on web and desktop.
 *
 * Two hosts, two mechanisms, one reason: DashScope authenticates with an
 * `Authorization` header, and the browser `WebSocket` constructor cannot set
 * request headers at all. That is why the browser prototype in
 * `tools/qwen-realtime-web` needed a proxy.
 *
 *  - Inside Tauri (the desktop app) `@tauri-apps/plugin-websocket` opens the
 *    socket in Rust, where headers are just headers. This is the supported
 *    path, and the only one that is secure: the key never leaves the machine.
 *  - In a plain browser there is nowhere to put a header, so the key rides in
 *    the query string. DashScope accepts `api_key` there, but a URL ends up in
 *    logs and history far more easily than a header does, so this is a
 *    fallback of last resort rather than the recommended path.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import type { WebSocketFactory } from './client';

/** Tauri injects this global; it is absent in a normal browser tab. */
function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Open a socket through the Tauri websocket plugin.
 *
 * This drives the plugin's commands directly instead of going through its
 * `WebSocket.connect()` helper, and that is the whole point of the function.
 *
 * The helper registers the frontend's listener *after* its `connect` promise
 * resolves, while the Rust side starts forwarding frames the instant the
 * handshake completes. DashScope sends `session.created` in the same
 * millisecond as the handshake — measured: `OPEN` and `session.created` both at
 * +131 ms — so that frame is reliably delivered to a listener set that is still
 * empty, and it is the frame the entire session setup hangs off: no
 * `session.created` means no `session.update`, no `session.updated`, and no
 * ready callback. The app sat on "connecting" forever with nothing in the logs,
 * because nothing had failed.
 *
 * Registering the handler before the connection exists removes the window
 * entirely. The plugin's own API gives no way to do that, which is why this is
 * a reimplementation of its ~40-line wrapper rather than a call to it.
 *
 * The client is written against the browser interface — `onopen`, `onmessage`,
 * `send`, `close` — because that is also what React Native presents. Rather
 * than teach the client a second vocabulary, the difference is absorbed here.
 */
/** What the Rust side serializes: `#[serde(tag = "type", content = "data")]`. */
type PluginMessage = { type?: string; data?: unknown };

function createTauriSocket(url: string, headers: Record<string, string>): WebSocket {
    const socket: {
        readyState: number;
        onopen: ((event: Event) => void) | null;
        onmessage: ((event: WebSocketMessageEvent) => void) | null;
        onerror: ((event: Event) => void) | null;
        onclose: ((event: CloseEvent) => void) | null;
        id: number | null;
        closed: boolean;
        send(data: string): void;
        close(): void;
    } = {
        readyState: 0, // CONNECTING
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        id: null,
        closed: false,

        send(data: string) {
            if (this.id === null) return;
            // The plugin rejects on a dead socket; the client already treats a
            // failed send as a dropped message, so swallow rather than throw
            // into a callback that has no way to handle it.
            void invoke('plugin:websocket|send', {
                id: this.id,
                message: { type: 'Text', data },
            }).catch(() => {});
        },

        close() {
            this.closed = true;
            this.readyState = 3; // CLOSED
            const id = this.id;
            this.id = null;
            if (id === null) return;
            void invoke('plugin:websocket|send', {
                id,
                message: { type: 'Close', data: { code: 1000, reason: 'Disconnected by client' } },
            }).catch(() => {});
        },
    };

    // The dispatcher exists before the connection does — the reason this file
    // does not use the plugin's helper. See the comment above.
    const handle = (message: PluginMessage | string) => {
        if (typeof message === 'string') {
            // The Rust side serializes a read error as a bare string. Treat it
            // as the end of the connection: without this the UI would keep
            // showing a call that had already dropped.
            console.warn('[Qwen voice] websocket error:', message);
            socket.readyState = 3;
            socket.id = null;
            socket.onclose?.({} as CloseEvent);
            return;
        }
        if (message.type === 'Text') {
            socket.onmessage?.({ data: message.data } as WebSocketMessageEvent);
        } else if (message.type === 'Close') {
            socket.readyState = 3;
            socket.id = null;
            socket.onclose?.({} as CloseEvent);
        }
        // Binary/Ping/Pong carry nothing this protocol needs.
    };

    const onMessage = new Channel<PluginMessage>();
    onMessage.onmessage = handle;

    void invoke<number>('plugin:websocket|connect', {
        url,
        // `headers` is `Vec<(String, String)>` on the Rust side, so it travels
        // as pairs rather than an object.
        config: { headers: Object.entries(headers) },
        onMessage,
    })
        .then((id) => {
            // `close()` may have run while the handshake was still in flight.
            if (socket.closed) {
                void invoke('plugin:websocket|send', {
                    id,
                    message: { type: 'Close', data: { code: 1000, reason: 'closed before open' } },
                }).catch(() => {});
                return;
            }
            socket.id = id;
            socket.readyState = 1; // OPEN
            socket.onopen?.({} as Event);
        })
        .catch((error) => {
            console.warn('[Qwen voice] websocket connect failed:', error);
            socket.readyState = 3;
            socket.onerror?.({} as Event);
        });

    return socket as unknown as WebSocket;
}

/**
 * Plain-browser fallback. The key goes in the query string because there is no
 * header to put it in; see the note at the top of this file.
 */
function createBrowserSocket(url: string, headers: Record<string, string>): WebSocket {
    const auth = headers.Authorization ?? headers.authorization ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const withKey = new URL(url);
    if (token) withKey.searchParams.set('api_key', token);
    return new WebSocket(withKey.toString());
}

export const createDefaultSocket: WebSocketFactory = (url, headers) => {
    return isTauri() ? createTauriSocket(url, headers) : createBrowserSocket(url, headers);
};
