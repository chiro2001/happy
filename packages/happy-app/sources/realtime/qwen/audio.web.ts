/**
 * Microphone capture and speaker playback for the Qwen voice provider, on web
 * and desktop.
 *
 * Same two-class interface as `audio.ts` (the React Native version), which is
 * the point: the session logic in `QwenVoiceSession.tsx` is shared verbatim and
 * the platform resolver picks whichever backend matches. Only the audio I/O
 * differs.
 *
 * Desktop is where this backend is actually better than the native one. A
 * Tauri window is a WebView, so `getUserMedia({ echoCancellation: true })`
 * gets the browser's own echo canceller — the Android build needed a native
 * patch (see patches/fix-react-native-audio-api-android-aec.cjs) to reach the
 * same place. Barge-in depends on that canceller: without it the model hears
 * its own reply and answers itself.
 */

import { QWEN_DEFAULTS } from './types';

/** 100 ms at 16 kHz — small enough for responsive VAD, cheap enough to send. */
const CHUNK_SAMPLES = QWEN_DEFAULTS.inputSampleRate / 10;

/**
 * The same 100 ms expressed in the rate the AudioContext actually runs at.
 *
 * A browser is free to ignore the requested sample rate, and the common case is
 * that it does: 48 kHz is the default on most desktops. Slicing by the 16 kHz
 * figure there would emit ~33 ms chunks — still contiguous, but three times the
 * message rate and a VAD that reacts three times as fast as intended.
 */
function chunkSamplesAt(rate: number): number {
    return Math.max(1, Math.round((CHUNK_SAMPLES * rate) / QWEN_DEFAULTS.inputSampleRate));
}

/** Convert Float32 [-1,1] samples to little-endian signed 16-bit PCM. */
export function floatToPcm16(input: Float32Array): Uint8Array {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i]));
        out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return new Uint8Array(out.buffer);
}

/**
 * Convert little-endian signed 16-bit PCM back to Float32 [-1,1].
 *
 * The result is pinned to `ArrayBuffer` rather than the default
 * `ArrayBufferLike`: `AudioBuffer.copyToChannel` in the DOM typings rejects a
 * possibly-shared buffer, and the only way to satisfy that is to say so here.
 */
export function pcm16ToFloat(input: Uint8Array): Float32Array<ArrayBuffer> {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const count = Math.floor(input.byteLength / 2);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
        out[i] = view.getInt16(i * 2, true) / 0x8000;
    }
    return out;
}

/** Linear resampler, for when a context refuses the rate we asked for. */
export function resampleLinear(
    input: Float32Array,
    fromRate: number,
    toRate: number,
): Float32Array {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const length = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
        const position = i * ratio;
        const lower = Math.floor(position);
        const upper = Math.min(lower + 1, input.length - 1);
        const t = position - lower;
        out[i] = input[lower] * (1 - t) + input[upper] * t;
    }
    return out;
}

/**
 * AudioWorklet that forwards raw frames to the main thread.
 *
 * Loaded from a blob URL rather than a file so it needs no asset plumbing in
 * the Expo web export — the bundle is static output, and a worklet has to be
 * fetched as a standalone script.
 */
const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel && channel.length) {
            // A copy: the render quantum's buffer is recycled by the engine.
            this.port.postMessage(new Float32Array(channel));
        }
        return true;
    }
}
registerProcessor('qwen-capture', CaptureProcessor);
`;

export interface AudioCaptureOptions {
    /** Called for every ~100 ms of captured audio, already at 16 kHz. */
    onChunk(pcm: Uint8Array): void;
    /** RMS in [0,1] for a level meter. */
    onLevel?(level: number): void;
}

export class QwenAudioCapture {
    private stream: MediaStream | null = null;
    private context: AudioContext | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private worklet: AudioWorkletNode | null = null;
    private processor: ScriptProcessorNode | null = null;
    private running = false;
    /** Frames buffered towards the next 100 ms chunk. */
    private pending: Float32Array[] = [];
    private pendingLength = 0;

    /**
     * Ensure microphone access.
     *
     * `startRealtimeSession` has already asked with Happy's own denied-
     * permission dialog, so this only reports the answer. Requesting again
     * would prompt twice, and on desktop a second prompt is a second dialog.
     */
    static async requestPermission(): Promise<boolean> {
        try {
            // Enumerate rather than re-prompt where the API allows it. There is
            // no reliable "just check" call across WebView2 and mobile Safari,
            // so a short-lived acquisition is the check.
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            return true;
        } catch {
            return false;
        }
    }

    /**
     * No-op on web: the audio session is the browser's to manage, and the
     * echo-cancellation mode is chosen per-stream in `start()` where the
     * constraints belong.
     */
    static configureSession(): void {}

    async start(options: AudioCaptureOptions): Promise<void> {
        if (this.running) return;

        // Deliberately does not reject: the session calls this without awaiting
        // (the native backend is synchronous), so a rejection here would be an
        // unhandled promise and the failure would vanish.
        try {
            await this.openCapture(options);
        } catch (error) {
            console.warn('[Qwen voice] microphone capture failed to start:', error);
            this.stop();
        }
    }

    private async openCapture(options: AudioCaptureOptions): Promise<void> {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                // The three constraints that make barge-in work. Echo
                // cancellation is the load-bearing one; without it the model
                // hears itself through the speakers and replies to its own
                // voice, which is the failure the Android AEC patch fixes.
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
            },
        });
        if (!this.running) {
            // stop() landed while the permission prompt was open.
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        this.stream = stream;

        // Ask for the model's rate so the common case needs no resampling;
        // `accept` reads the real rate back off the context either way.
        const context = new AudioContext({ sampleRate: QWEN_DEFAULTS.inputSampleRate });
        this.context = context;
        this.source = context.createMediaStreamSource(stream);

        try {
            const url = URL.createObjectURL(
                new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }),
            );
            await context.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            const worklet = new AudioWorkletNode(context, 'qwen-capture');
            worklet.port.onmessage = (event: MessageEvent) => {
                if (!this.running) return;
                this.accept(event.data as Float32Array, options);
            };
            this.source.connect(worklet);
            // A worklet only runs while it is part of the graph. Sending its
            // output to a muted gain node keeps it alive without duplicating
            // the microphone into the speakers.
            const sink = context.createGain();
            sink.gain.value = 0;
            worklet.connect(sink);
            sink.connect(context.destination);
            this.worklet = worklet;
        } catch {
            // Older WebView: fall back to the deprecated main-thread processor.
            // Audible glitches are preferable to a microphone that never opens.
            const processor = context.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (event) => {
                if (!this.running) return;
                const frame = event.inputBuffer.getChannelData(0);
                this.accept(new Float32Array(frame), options);
            };
            this.source.connect(processor);
            processor.connect(context.destination);
            this.processor = processor;
        }
    }

    /** Accumulate frames and emit them in 100 ms slices at 16 kHz. */
    private accept(frame: Float32Array, options: AudioCaptureOptions): void {
        this.pending.push(frame);
        this.pendingLength += frame.length;

        const rate = this.context?.sampleRate ?? QWEN_DEFAULTS.inputSampleRate;
        const chunk = chunkSamplesAt(rate);

        // Count samples, not frames: a 128-sample render quantum is ~8 ms at
        // 16 kHz, and treating each one as a chunk would send 8 ms of audio as
        // if it were 100 ms.
        while (this.pendingLength >= chunk) {
            const merged = new Float32Array(chunk);
            let filled = 0;
            while (filled < chunk && this.pending.length > 0) {
                const head = this.pending[0];
                const take = Math.min(head.length, chunk - filled);
                merged.set(head.subarray(0, take), filled);
                filled += take;
                if (take === head.length) {
                    this.pending.shift();
                } else {
                    this.pending[0] = head.subarray(take);
                }
            }
            this.pendingLength -= chunk;

            if (options.onLevel) {
                let sum = 0;
                for (let i = 0; i < merged.length; i += 1) sum += merged[i] * merged[i];
                options.onLevel(Math.sqrt(sum / merged.length));
            }

            const normalized = rate === QWEN_DEFAULTS.inputSampleRate
                ? merged
                : resampleLinear(merged, rate, QWEN_DEFAULTS.inputSampleRate);
            options.onChunk(floatToPcm16(normalized));
        }
    }

    stop(): void {
        this.running = false;
        this.pending = [];
        this.pendingLength = 0;
        try {
            this.worklet?.port.close();
            this.worklet?.disconnect();
            this.processor?.disconnect();
            this.source?.disconnect();
        } catch {
            // Already torn down.
        }
        this.worklet = null;
        this.processor = null;
        this.source = null;
        void this.context?.close().catch(() => {});
        this.context = null;
        this.stream?.getTracks().forEach(track => track.stop());
        this.stream = null;
    }
}

export class QwenAudioPlayer {
    private context: AudioContext | null = null;
    /** Scheduled sources, so `flush()` can cut playback short for barge-in. */
    private sources = new Set<AudioBufferSourceNode>();
    /**
     * Context-clock time at which the last enqueued chunk finishes playing.
     *
     * Used for half-duplex gating, and to schedule chunks gaplessly: each one
     * starts where the previous ended rather than at "now", which would clip
     * the overlap.
     */
    private playbackEndsAt = 0;

    private ensure(): boolean {
        if (this.context) return true;
        try {
            this.context = new AudioContext({ sampleRate: QWEN_DEFAULTS.outputSampleRate });
            return true;
        } catch {
            return false;
        }
    }

    /** Enqueue one chunk of 24 kHz mono s16le PCM. */
    enqueue(pcm: Uint8Array): void {
        if (pcm.byteLength < 2) return;
        if (!this.ensure() || !this.context) return;

        const samples = pcm16ToFloat(pcm);
        try {
            const buffer = this.context.createBuffer(
                1,
                samples.length,
                QWEN_DEFAULTS.outputSampleRate,
            );
            buffer.copyToChannel(samples, 0);

            const source = this.context.createBufferSource();
            source.buffer = buffer;
            source.connect(this.context.destination);
            // A context that is not running would schedule everything at the
            // same stalled timestamp and play it all at once on resume.
            if (this.context.state === 'suspended') void this.context.resume();

            const start = Math.max(this.context.currentTime, this.playbackEndsAt);
            this.playbackEndsAt = start + buffer.duration;
            source.onended = () => this.sources.delete(source);
            this.sources.add(source);
            source.start(start);
        } catch {
            // One dropped chunk is not worth tearing the session down; the next
            // one usually lands and the gap is inaudible in speech.
        }
    }

    /**
     * Whether assistant audio is (or is about to be) coming out of the speaker.
     *
     * `tailMs` covers the room reverb and the output buffer drain after the
     * last scheduled chunk: a little echo bleeding back into the microphone
     * after playback technically ends is still enough to trip the server VAD.
     */
    isPlaying(tailMs = 500): boolean {
        if (!this.context) return false;
        return this.context.currentTime < this.playbackEndsAt + tailMs / 1000;
    }

    /** Drop everything queued. This is what makes barge-in feel instant. */
    flush(): void {
        for (const source of this.sources) {
            try {
                source.stop();
            } catch {
                // Never started, or already stopped.
            }
        }
        this.sources.clear();
        this.playbackEndsAt = 0;
    }

    stop(): void {
        this.flush();
        void this.context?.close().catch(() => {});
        this.context = null;
    }
}
