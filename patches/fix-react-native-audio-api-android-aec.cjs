/**
 * Enable the system echo canceller for react-native-audio-api on Android.
 *
 * The recorder builds an Oboe stream without an input preset:
 *
 *   AudioStreamBuilder builder;
 *   builder.setSharingMode(...)->setDirection(Direction::Input)->...
 *
 * Android only engages AcousticEchoCanceler when the capture source is
 * VOICE_COMMUNICATION — the default (Generic) gets a raw mic feed. Without
 * AEC, speaker output loops back into the microphone, the server-side VAD
 * commits the assistant's own voice as a user turn, and the model answers
 * itself indefinitely. Measured on-device: the user transcript and the
 * previous assistant line came back word-for-word identical, "好，我停。" →
 * "好，我停。" → "行。" → "行。".
 *
 * With AEC the microphone can stay live while the assistant speaks, which is
 * what makes voice barge-in possible at all.
 *
 * This is the same mechanism react-native-webrtc relies on
 * (GetUserMediaImpl sets googEchoCancellation and routes capture through
 * WebRTC's AudioProcessing module); here we only ask the OS to do it.
 *
 * Applied from scripts/postinstall.cjs, like the other patches in this folder.
 */
const fs = require('fs');
const path = require('path');

const nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
];

const MARKER = 'setInputPreset(InputPreset::VoiceCommunication)';

let patched = 0;

for (const nodeModulesRoot of nodeModulesRoots) {
    const recorder = path.join(
        nodeModulesRoot,
        'react-native-audio-api/android/src/main/cpp/audioapi/android/core/AndroidAudioRecorder.cpp'
    );
    if (!fs.existsSync(recorder)) continue;

    let content = fs.readFileSync(recorder, 'utf8');

    // Idempotent: the native build re-runs on every clean checkout, and this
    // script runs on every install.
    if (content.includes(MARKER)) continue;

    const anchor = 'builder.setSharingMode(SharingMode::Exclusive)';
    if (!content.includes(anchor)) {
        console.warn(
            '[patch-rn-audio-api-aec] anchor not found in AndroidAudioRecorder.cpp;',
            'upstream may have changed. Skipping.'
        );
        continue;
    }

    content = content.replace(
        anchor,
        `${anchor}\n      ->setInputPreset(InputPreset::VoiceCommunication)`
    );

    fs.writeFileSync(recorder, content, 'utf8');
    patched++;
}

if (patched > 0) {
    console.log(
        `[patch-rn-audio-api-aec] enabled VOICE_COMMUNICATION preset in ${patched} copy/copies (system AEC).`
    );
}
