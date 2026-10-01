/**
 * Microphone capture and speaker playback for the Qwen voice provider.
 *
 * Qwen wants 16 kHz mono s16le in and returns 24 kHz mono s16le, so this owns
 * both conversions. Playback uses the library's buffer *queue* rather than
 * hand-scheduled sources: it is gapless, and `clearBuffers()` gives barge-in
 * for free — which matters because the server starts a new response while the
 * previous audio is still draining.
 *
 * Built on `react-native-audio-api`, which Happy already depends on for the
 * ElevenLabs path. Its shape mirrors the Web Audio API, so this is a close
 * port of the browser prototype in tools/qwen-realtime-web.
 */

import {
    AudioBuffer,
    AudioBufferQueueSourceNode,
    AudioContext,
    AudioManager,
    AudioRecorder,
} from 'react-native-audio-api';
import { QWEN_DEFAULTS } from './types';

/** 100 ms at 16 kHz — small enough for responsive VAD, cheap enough to send. */
const RECORDER_BUFFER_SAMPLES = QWEN_DEFAULTS.inputSampleRate / 10;

/**
 * Convert Float32 [-1,1] samples to little-endian signed 16-bit PCM.
 *
 * The asymmetric scaling (0x8000 vs 0x7fff) is the usual convention: it lets
 * -1.0 map exactly onto the most negative value without clipping +1.0.
 */
export function floatToPcm16(input: Float32Array): Uint8Array {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i]));
        out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return new Uint8Array(out.buffer);
}

/** Convert little-endian signed 16-bit PCM back to Float32 [-1,1]. */
export function pcm16ToFloat(input: Uint8Array): Float32Array {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const count = Math.floor(input.byteLength / 2);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
        out[i] = view.getInt16(i * 2, true) / 0x8000;
    }
    return out;
}

/**
 * Linear resampler, used only when the recorder hands back a rate other than
 * the 16 kHz the model expects. Linear interpolation is not audiophile-grade,
 * but this is speech going into an ASR front-end, and it keeps the hot path in
 * JS without pulling in a DSP dependency.
 */
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

export interface AudioCaptureOptions {
    /** Called for every ~100 ms of captured audio, already at 16 kHz. */
    onChunk(pcm: Uint8Array): void;
    /** RMS in [0,1] for a level meter. */
    onLevel?(level: number): void;
}

export class QwenAudioCapture {
    private recorder: AudioRecorder | null = null;
    private running = false;
    /** Rate the device actually records at; may differ from what we asked for. */
    private actualRate: number = QWEN_DEFAULTS.inputSampleRate;

    /**
     * Ensure microphone access.
     *
     * `startRealtimeSession` already prompts (with Happy's own denied-permission
     * dialog), so this checks first and only prompts when the answer is still
     * undetermined — asking twice would show two dialogs on Android.
     */
    static async requestPermission(): Promise<boolean> {
        try {
            const current = await AudioManager.checkRecordingPermissions();
            if (current === 'Granted') return true;
            if (current === 'Denied') return false;
            const status = await AudioManager.requestRecordingPermissions();
            return status === 'Granted';
        } catch {
            return false;
        }
    }

    /**
     * Configure the OS audio session for two-way voice.
     *
     * These options are iOS-only and ignored on Android, where the session is
     * managed by the recorder itself.
     */
    static configureSession(): void {
        try {
            AudioManager.setAudioSessionOptions({
                iosCategory: 'playAndRecord',
                iosMode: 'voiceChat',
                iosOptions: ['defaultToSpeaker', 'allowBluetooth'],
            });
        } catch {
            // Non-iOS platforms reject these keys; nothing to recover from.
        }
    }

    start(options: AudioCaptureOptions): void {
        if (this.running) return;

        const recorder = new AudioRecorder({
            sampleRate: QWEN_DEFAULTS.inputSampleRate,
            bufferLengthInSamples: RECORDER_BUFFER_SAMPLES,
        });

        recorder.onAudioReady(({ buffer, numFrames }) => {
            if (!this.running) return;

            const frame = buffer.getChannelData(0);
            const usable = numFrames > 0 ? frame.subarray(0, numFrames) : frame;

            if (options.onLevel) {
                let sum = 0;
                for (let i = 0; i < usable.length; i += 1) {
                    sum += usable[i] * usable[i];
                }
                options.onLevel(Math.sqrt(sum / Math.max(usable.length, 1)));
            }

            // Honour whatever rate the device settled on rather than assuming
            // the request was granted; a mismatch would pitch-shift the audio
            // and wreck recognition.
            this.actualRate = buffer.sampleRate || QWEN_DEFAULTS.inputSampleRate;
            const normalized =
                this.actualRate === QWEN_DEFAULTS.inputSampleRate
                    ? usable
                    : resampleLinear(
                          usable,
                          this.actualRate,
                          QWEN_DEFAULTS.inputSampleRate,
                      );

            options.onChunk(floatToPcm16(normalized));
        });

        this.recorder = recorder;
        this.running = true;
        recorder.start();
    }

    stop(): void {
        this.running = false;
        try {
            this.recorder?.stop();
        } catch {
            // Already stopped.
        }
        this.recorder = null;
    }
}

export class QwenAudioPlayer {
    private context: AudioContext | null = null;
    private queue: AudioBufferQueueSourceNode | null = null;
    /**
     * Context-clock time at which the last enqueued chunk finishes playing.
     *
     * Used for half-duplex gating: the speaker output is louder than the
     * microphone expects, so without echo cancellation the model hears itself,
     * the server VAD commits it as a user turn, and the model replies to its
     * own voice — an endless loop. `react-native-audio-api` exposes audio
     * session options for iOS only, so on Android there is no AEC to lean on
     * and the mic has to be gated instead.
     */
    private playbackEndsAt = 0;

    /**
     * Lazily create the context: building it before playback starts can fight
     * the recorder for the audio session on iOS.
     */
    private ensure(): boolean {
        if (this.context && this.queue) return true;
        try {
            const context = new AudioContext({
                sampleRate: QWEN_DEFAULTS.outputSampleRate,
            });
            const queue = context.createBufferQueueSource();
            queue.connect(context.destination);
            queue.start();
            this.context = context;
            this.queue = queue;
            return true;
        } catch {
            return false;
        }
    }

    /** Enqueue one chunk of 24 kHz mono s16le PCM. */
    enqueue(pcm: Uint8Array): void {
        if (pcm.byteLength < 2) return;
        if (!this.ensure()) return;

        const samples = pcm16ToFloat(pcm);
        try {
            const buffer: AudioBuffer = this.context!.createBuffer(
                1,
                samples.length,
                QWEN_DEFAULTS.outputSampleRate,
            );
            buffer.copyToChannel(samples, 0);
            this.queue!.enqueueBuffer(buffer);

            // Queue is gapless, so the next chunk starts where the last ends.
            const now = this.context!.currentTime;
            const start = Math.max(now, this.playbackEndsAt);
            this.playbackEndsAt = start + buffer.duration;
        } catch {
            // One dropped chunk is not worth tearing the session down; the next
            // one usually lands and the gap is inaudible in speech.
        }
    }

    /**
     * Whether assistant audio is (or is about to be) coming out of the speaker.
     *
     * `tailMs` covers the room reverb and the hardware buffer drain after the
     * last scheduled chunk: a little echo bleeding into the mic after playback
     * technically ends would still be enough to trip the server VAD.
     */
    isPlaying(tailMs = 500): boolean {
        if (!this.context) return false;
        return this.context.currentTime < this.playbackEndsAt + tailMs / 1000;
    }

    /** Drop everything queued. This is what makes barge-in feel instant. */
    flush(): void {
        try {
            this.queue?.clearBuffers();
        } catch {
            // Nothing queued.
        }
        // Playback stops here, so the gate should reopen immediately.
        this.playbackEndsAt = 0;
    }

    stop(): void {
        this.flush();
        try {
            this.queue?.stop();
            this.queue?.disconnect();
        } catch {
            // Already torn down.
        }
        try {
            void this.context?.close();
        } catch {
            // Already closed.
        }
        this.queue = null;
        this.context = null;
    }
}
