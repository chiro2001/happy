/**
 * Default WebSocket for the Qwen client on native platforms.
 *
 * React Native's `WebSocket` takes a third argument carrying request headers,
 * which is the whole reason this provider can authenticate straight to
 * DashScope without a proxy. Node's global `WebSocket` silently ignores that
 * argument, so the integration test injects a `ws`-backed factory instead —
 * see `QwenClientOptions.createSocket`.
 *
 * The web/desktop counterpart lives in `socket.web.ts` and is picked up
 * automatically by the platform resolver.
 */

import type { WebSocketFactory } from './client';

/**
 * React Native's WebSocket with an options bag.
 *
 * The RN typings do not describe the third constructor argument, so the
 * constructor is widened here rather than sprinkled with casts at call sites.
 */
export const createDefaultSocket: WebSocketFactory = (url, headers) => {
    const WS = WebSocket as unknown as {
        new (
            url: string,
            protocols?: string | string[] | null,
            options?: unknown,
        ): WebSocket;
    };
    return new WS(url, null, { headers });
};
