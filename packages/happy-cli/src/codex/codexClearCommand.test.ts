import { describe, expect, it, vi } from 'vitest';

import { enqueueCodexUserText } from './codexClearCommand';

/** A queue stub with all three actions, so each test can assert on the gaps. */
function makeQueue() {
    return {
        push: vi.fn(),
        pushIsolateAndClear: vi.fn(),
        pushCompact: vi.fn(),
    };
}

describe('enqueueCodexUserText', () => {
    it('queues /clear in isolation instead of batching it into a model prompt', () => {
        const mode = { permissionMode: 'default' as const };
        const queue = makeQueue();

        const result = enqueueCodexUserText({
            text: '  /clear  ',
            mode,
            queue,
        });

        expect(result).toBe('clear');
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('  /clear  ', mode, undefined);
        expect(queue.push).not.toHaveBeenCalled();
    });

    /**
     * `/compact` used to be pushed as ordinary turn input, which asks the model
     * to summarise itself and leaves the context untouched — measured on a live
     * thread, input went 573,988 → 575,019 tokens across the "compaction".
     *
     * Compaction is its own app-server operation, so it must not travel as text.
     * It also must not clear the queue the way `/clear` does: compaction keeps
     * the conversation in summarised form, so anything the user queued is still
     * meaningful.
     */
    it('routes /compact to the compaction action, not to the model', () => {
        const mode = { permissionMode: 'default' as const };
        const queue = makeQueue();

        const result = enqueueCodexUserText({ text: '/compact', mode, queue });

        expect(result).toBe('compact');
        expect(queue.pushCompact).toHaveBeenCalledWith(mode);
        expect(queue.push).not.toHaveBeenCalled();
        expect(queue.pushIsolateAndClear).not.toHaveBeenCalled();
    });

    it('recognises /compact with arguments and surrounding whitespace', () => {
        const mode = { permissionMode: 'default' as const };
        const queue = makeQueue();

        expect(enqueueCodexUserText({ text: '  /compact focus on the parser  ', mode, queue }))
            .toBe('compact');
        expect(queue.pushCompact).toHaveBeenCalledOnce();
    });

    it('does not treat a message that merely mentions /compact as the command', () => {
        const mode = { permissionMode: 'default' as const };
        const queue = makeQueue();

        const result = enqueueCodexUserText({ text: 'why did /compact do nothing?', mode, queue });

        expect(result).toBe('queued');
        expect(queue.pushCompact).not.toHaveBeenCalled();
        expect(queue.push).toHaveBeenCalledOnce();
    });

    it('passes attachments to normal queued messages', () => {
        const mode = { permissionMode: 'default' as const };
        const attachments = [{
            data: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            name: 'screen.png',
        }];
        const queue = makeQueue();

        const result = enqueueCodexUserText({
            text: 'inspect this image',
            mode,
            queue,
            attachments,
        });

        expect(result).toBe('queued');
        expect(queue.push).toHaveBeenCalledWith('inspect this image', mode, attachments);
        expect(queue.pushIsolateAndClear).not.toHaveBeenCalled();
    });

    it('passes attachments to isolated clear messages', () => {
        const mode = { permissionMode: 'default' as const };
        const attachments = [{
            data: new Uint8Array([4, 5, 6]),
            mimeType: 'image/jpeg',
            name: 'photo.jpg',
        }];
        const queue = makeQueue();

        const result = enqueueCodexUserText({
            text: '/clear',
            mode,
            queue,
            attachments,
        });

        expect(result).toBe('clear');
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('/clear', mode, attachments);
        expect(queue.push).not.toHaveBeenCalled();
    });
});
