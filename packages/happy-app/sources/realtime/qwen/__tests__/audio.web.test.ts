import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Capture-side tests for the web audio backend.
 *
 * These exist because the failure they cover is invisible: a capture whose
 * `running` flag is never set acquires the microphone and immediately stops it
 * again. Nothing throws, the session connects, the status reads "connected" —
 * and the server simply never receives audio, so it never answers. From the
 * outside that is indistinguishable from "the microphone is broken" or "the
 * model is slow", which is exactly how it was reported.
 */

interface FakeTrack {
    readyState: string;
    stopped: boolean;
    stop(): void;
}

function fakeStream(): { stream: MediaStream; tracks: FakeTrack[] } {
    const tracks: FakeTrack[] = [{
        readyState: 'live',
        stopped: false,
        stop() { this.stopped = true; this.readyState = 'ended'; },
    }];
    return {
        stream: { getTracks: () => tracks } as unknown as MediaStream,
        tracks,
    };
}

/** Minimal Web Audio surface: only what the capture actually touches. */
class FakeAudioContext {
    sampleRate: number;
    state = 'running';
    destination = {};
    audioWorklet = { addModule: async () => {} };
    constructor(options?: { sampleRate?: number }) {
        this.sampleRate = options?.sampleRate ?? 48000;
    }
    createMediaStreamSource() { return { connect: () => {} }; }
    createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    createScriptProcessor() {
        return { onaudioprocess: null, connect: () => {}, disconnect: () => {} };
    }
    close() { this.state = 'closed'; return Promise.resolve(); }
}

/** The worklet node whose port the test drives, standing in for the real one. */
let lastWorklet: { port: { onmessage: ((e: { data: Float32Array }) => void) | null; close(): void }; connect(): void; disconnect(): void };

class FakeAudioWorkletNode {
    port = { onmessage: null as ((e: { data: Float32Array }) => void) | null, close: () => {} };
    connect() {}
    disconnect() {}
    constructor() { lastWorklet = this; }
}

/** The stream handed out by the most recent grant, for assertions. */
let granted: { stream: MediaStream; tracks: FakeTrack[] } | null = null;

const mediaDevices = {
    getUserMedia: vi.fn(async (_constraints?: MediaStreamConstraints) => {
        granted = fakeStream();
        return granted.stream;
    }),
};

/** 16 kHz: the rate the model wants, so no resampling is involved. */
const NATIVE_RATE = 16000;

beforeEach(() => {
    vi.stubGlobal('navigator', { mediaDevices });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    vi.stubGlobal('Blob', class { constructor(_parts: unknown[], _opts?: unknown) {} });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} });
    mediaDevices.getUserMedia.mockClear();
    granted = null;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** Import fresh so the module-level granted-stream cache does not leak. */
async function loadModule() {
    vi.resetModules();
    return import('../audio.web');
}

function samples(count: number): Float32Array {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) out[i] = Math.sin(i / 10) * 0.5;
    return out;
}

describe('QwenAudioCapture (web)', () => {
    it('keeps the microphone open once started', async () => {
        const { QwenAudioCapture } = await loadModule();
        const capture = new QwenAudioCapture();

        await capture.start({ onChunk: () => {} });

        // The regression: the stream was acquired and stopped in the same
        // breath, so capture produced nothing for the whole session.
        expect(granted!.tracks[0].stopped).toBe(false);
        expect(lastWorklet.port.onmessage).toBeTypeOf('function');
    });

    it('releases the microphone when stopped', async () => {
        const { QwenAudioCapture } = await loadModule();
        const capture = new QwenAudioCapture();
        await capture.start({ onChunk: () => {} });

        capture.stop();

        expect(granted!.tracks[0].stopped).toBe(true);
    });

    it('holds the permission grant and does not ask twice', async () => {
        const { QwenAudioCapture } = await loadModule();

        expect(await QwenAudioCapture.requestPermission()).toBe(true);
        const capture = new QwenAudioCapture();
        await capture.start({ onChunk: () => {} });

        // One prompt for the session: the check hands its stream to the capture.
        expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('asks with echo cancellation, which is what makes barge-in work', async () => {
        const { QwenAudioCapture } = await loadModule();
        await QwenAudioCapture.requestPermission();

        const constraints = mediaDevices.getUserMedia.mock.calls[0][0];
        expect((constraints?.audio as MediaTrackConstraints).echoCancellation).toBe(true);
    });

    it('emits one 100 ms chunk for 1600 samples at 16 kHz', async () => {
        const { QwenAudioCapture } = await loadModule();
        const capture = new QwenAudioCapture();
        const chunks: Uint8Array[] = [];
        await capture.start({ onChunk: (pcm) => chunks.push(pcm) });

        lastWorklet.port.onmessage!({ data: samples(NATIVE_RATE / 10) });

        expect(chunks).toHaveLength(1);
        // 1600 samples of s16le.
        expect(chunks[0].byteLength).toBe(3200);
    });

    it('splits a larger frame into whole chunks and carries the remainder', async () => {
        const { QwenAudioCapture } = await loadModule();
        const capture = new QwenAudioCapture();
        const chunks: Uint8Array[] = [];
        await capture.start({ onChunk: (pcm) => chunks.push(pcm) });

        // 2.5 chunks: two go out now, half a chunk is carried over.
        lastWorklet.port.onmessage!({ data: samples(NATIVE_RATE / 4) });
        expect(chunks).toHaveLength(2);

        // Half a chunk on its own is too little to send. That it completes a
        // chunk here is the whole point: without the carried remainder this
        // frame would be held back and the audio would drift.
        lastWorklet.port.onmessage!({ data: samples(NATIVE_RATE / 20) });
        expect(chunks).toHaveLength(3);
    });

    it('stops emitting after stop()', async () => {
        const { QwenAudioCapture } = await loadModule();
        const capture = new QwenAudioCapture();
        const chunks: Uint8Array[] = [];
        await capture.start({ onChunk: (pcm) => chunks.push(pcm) });

        capture.stop();
        lastWorklet.port.onmessage!({ data: samples(NATIVE_RATE / 10) });

        expect(chunks).toHaveLength(0);
    });

    it('is idempotent: a second start does not open a second capture', async () => {
        const { QwenAudioCapture } = await loadModule();
        const capture = new QwenAudioCapture();
        await capture.start({ onChunk: () => {} });
        await capture.start({ onChunk: () => {} });

        expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('reports a denied microphone instead of claiming success', async () => {
        const { QwenAudioCapture } = await loadModule();
        mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('NotAllowedError'));

        expect(await QwenAudioCapture.requestPermission()).toBe(false);
    });
});
