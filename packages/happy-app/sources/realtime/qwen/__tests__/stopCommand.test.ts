/**
 * Guards the stop-word matcher.
 *
 * The risk here is asymmetric: a false negative means the assistant talks when
 * the user asked for silence, but a false positive means it ignores a real
 * request that merely contains 停. These cases pin both sides.
 */

import { describe, expect, it } from 'vitest';
import { isStopCommand } from '../stopCommand';

describe('isStopCommand', () => {
    it.each([
        '停止',
        '停下',
        '停',
        '停一下',
        '别说了',
        '不要说了',
        '安静',
        '闭嘴',
        '停止。',
        '停下！',
        ' 停 下 ',
        'Stop',
        'stop it',
        'Shut up',
    ])('treats %j as a stop command', (text) => {
        expect(isStopCommand(text)).toBe(true);
    });

    it.each([
        // Longer utterances that merely contain a stop-ish word are requests.
        '停一下，我看看这个',
        '先停下，然后告诉我进度',
        '不要说了是什么意思',
        '帮我停止这个服务',
        '这个进程需要停下来吗',
        // Ordinary speech.
        '你好',
        '继续',
        '好的',
        // Empty / whitespace only.
        '',
        '   ',
    ])('does not treat %j as a stop command', (text) => {
        expect(isStopCommand(text)).toBe(false);
    });
});
