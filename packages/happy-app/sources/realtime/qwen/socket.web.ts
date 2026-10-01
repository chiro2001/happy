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

import TauriWebSocket from '@tauri-apps/plugin-websocket';
import type { WebSocketFactory } from './client';

/** Tauri injects this global; it is absent in a normal browser tab. */
function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Adapt the Tauri plugin's promise-and-listener API to the `WebSocket` shape
 * the protocol client expects.
 *
 * The client is written against the browser interface — `onopen`, `onmessage`,
 * `send`, `close` — because that is also what React Native presents. Rather
 * than teach the client a second vocabulary, the difference is absorbed here.
 */
function createTauriSocket(url: string, headers: Record<string, string>): WebSocket {
    const socket = {
        readyState: 0, // CONNECTING
        onopen: null as ((event: Event) => void) | null,
        onmessage: null as ((event: WebSocketMessageEvent) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onclose: null as ((event: CloseEvent) => void) | null,
        _conn: null as Awaited<ReturnType<typeof TauriWebSocket.connect>> | null,
        _closed: false,

        send(data: string) {
            if (!this._conn) return;
            // The plugin rejects on a dead socket; the client already treats a
            // failed send as a dropped message, so swallow rather than throw
            // into a callback that has no way to handle it.
            void this._conn.send(data).catch(() => {});
        },

        close() {
            this._closed = true;
            this.readyState = 3; // CLOSED
            const conn = this._conn;
            this._conn = null;
            void conn?.disconnect().catch(() => {});
        },
    };

    TauriWebSocket.connect(url, { headers })
        .then((conn) => {
            // `close()` may have run while the handshake was still in flight.
            if (socket._closed) {
                void conn.disconnect().catch(() => {});
                return;
            }
            socket._conn = conn;
            socket.readyState = 1; // OPEN
            conn.addListener((msg) => {
                if (msg.type === 'Text') {
                    socket.onmessage?.({ data: msg.data } as WebSocketMessageEvent);
                } else if (msg.type === 'Close') {
                    socket.readyState = 3;
                    socket._conn = null;
                    socket.onclose?.({} as CloseEvent);
                }
            });
            socket.onopen?.({} as Event);
        })
        .catch(() => {
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
