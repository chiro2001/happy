# Qwen-Omni-Realtime voice provider

A second realtime voice backend, added **alongside** ElevenLabs rather than
replacing it. Switch with **设置 → 语音助手 → 语音后端**; the ElevenLabs path is
untouched and remains the default.

## Why it exists

| | ElevenLabs (default) | Qwen (this provider) |
|---|---|---|
| Cost | ~¥0.57/min | **~¥0.03/min** |
| Billing | connected time, silence included | **speech only** — measured |
| Free tier | 20 min / 30 days | 1M tokens (expires 2026-12-21) |
| Credentials | Happy's server issues a token | your own DashScope key |
| Self-host | server is open source | weights not released |

Measurements and the reasoning behind each constant live in
`tools/qwen-realtime-test/FINDINGS.md`.

## Layout

| File | Responsibility |
|---|---|
| `client.ts` | WebSocket protocol. Plain TypeScript, no React, no React Native. |
| `audio.ts` | 16 kHz capture / 24 kHz playback, plus resampling. |
| `QwenVoiceSession.tsx` | Glue: implements the app's `VoiceSession` contract. |
| `types.ts` | Config, usage, callbacks, and the tuned defaults. |

## Design notes

**Why `client.ts` is framework-free.** It holds all the protocol subtlety, so
being able to run it under `vitest` against the live API matters more than
convenience. Socket creation is injected (`QwenClientOptions.createSocket`)
because React Native's `WebSocket` takes an options bag for headers while
Node's does not.

**Three behaviours came from getting them wrong first** (see
`tools/qwen-realtime-web/PITFALLS.md`):

1. **Tool calls are answered as a batch.** One response can carry several
   `function_call_arguments.done` events. Replying after each and firing
   `response.create` per reply makes the server reject the extras and the model
   re-issue them — a loop. They are collected and answered once, at
   `response.done`, with a single continuation. `MAX_TOOL_ROUNDS` is a backstop.
2. **`cancelResponse()` checks local state.** Sending `response.cancel` while
   idle returns "Cannot cancel response before response.created", so it only
   reaches the wire when a response is actually in flight.
3. **`silenceDurationMs` is 1000, not the 600 default.** Chinese speech pauses
   400–600 ms at a comma; 600 ms split one sentence into two turns (measured),
   1200 ms did not.

**Audio goes to the buffer queue, not scheduled sources.** That makes playback
gapless and gives barge-in for free via `clearBuffers()` — the server starts a
new response while the old audio is still draining.

## Testing

Unit-ish integration tests hit the live API. They skip unless both variables are
set, so CI stays green:

```bash
export DASHSCOPE_API_KEY=sk-...
export BAILIAN_WORKSPACE_ID=ws-...
cd packages/happy-app
npx vitest run sources/realtime/qwen/__tests__/client.integration.test.ts
```

Three cases: a text turn (checks usage accounting), a tool turn (checks the
batching rule), and context injection (checks the model uses supplied context
without echoing the wrapper).

## Configuration

Set in-app under **设置 → 语音助手 → 语音后端**:

| Field | Where to get it |
|---|---|
| DashScope API Key | Bailian console → API-KEY |
| 业务空间 ID | Shape `ws-xxxx`; also the `workspace_id` in `~/.bailian/config.json` |
| 实时模型 | Default `qwen3.8-omni-flash-realtime` |

The API key is stored on-device via Happy's settings store. It is a long-lived
credential, so treat it like a password.
