import { parseSpecialCommand } from '@/parsers/specialCommands';
import type { PendingAttachment } from '@/utils/MessageQueue2';

type CodexUserTextQueue<T> = {
    push: (message: string, mode: T, attachments?: PendingAttachment[]) => void;
    pushIsolateAndClear: (message: string, mode: T, attachments?: PendingAttachment[]) => void;
    pushCompact: (mode: T) => void;
};

export function isCodexClearText(text: string): boolean {
    return parseSpecialCommand(text).type === 'clear';
}

export function isCodexCompactText(text: string): boolean {
    return parseSpecialCommand(text).type === 'compact';
}

export function enqueueCodexUserText<T>(opts: {
    text: string;
    mode: T;
    queue: CodexUserTextQueue<T>;
    attachments?: PendingAttachment[];
}): 'clear' | 'compact' | 'queued' {
    // Checked before the generic push, because `/compact` was previously
    // delivered as ordinary turn input — which asks the model to summarise
    // itself while leaving the context untouched. Confirmed on a live thread:
    // input tokens rose from 573,988 to 575,019 across the "compaction".
    //
    // Compaction is its own app-server operation (`thread/compact/start`), so it
    // travels as its own queue action rather than as text.
    if (isCodexCompactText(opts.text)) {
        opts.queue.pushCompact(opts.mode);
        return 'compact';
    }

    if (isCodexClearText(opts.text)) {
        opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments);
        return 'clear';
    }

    opts.queue.push(opts.text, opts.mode, opts.attachments);
    return 'queued';
}
