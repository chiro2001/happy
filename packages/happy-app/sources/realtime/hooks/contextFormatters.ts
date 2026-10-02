import { Session } from "@/sync/storageTypes";
import { Message } from "@/sync/typesMessage";
import { trimIdent } from "@/utils/trimIdent";
import { getHarnessName } from "@/utils/harnessCatalog";
import { VOICE_CONFIG, type VoiceConfig } from "../voiceConfig";

interface SessionMetadata {
    summary?: { text?: string };
    path?: string;
    machineId?: string;
    homeDir?: string;
    /** Which coding agent runs in the session: claude, codex, agy, ... */
    flavor?: string | null;
    [key: string]: any;
}

/**
 * What to call the coding agent behind a session.
 *
 * This transcript was written when Claude Code was the only harness Happy
 * drove, so every line named it outright. That is wrong for a Codex session,
 * and not merely cosmetic: the assistant is explicitly asked what it can see,
 * and it answered "Claude Code is using CodexBash" — reporting the wrong agent
 * for work it had just been told about. The harness is in the session metadata,
 * so the name is derived rather than assumed.
 *
 * The fallback stays "Claude Code" because sessions predating multi-harness
 * support carry no flavor, and they were all Claude.
 */
export function resolveAgentName(flavor?: string | null): string {
    // `gpt` and `openai` are older Codex identifiers that still appear in
    // metadata written by earlier CLI versions.
    if (flavor === 'gpt' || flavor === 'openai') return getHarnessName('codex');
    if (!flavor) return getHarnessName('claude');
    return getHarnessName(flavor);
}

/**
 * Format a permission request for natural language context
 */
export function formatPermissionRequest(
    sessionId: string,
    requestId: string,
    toolName: string,
    toolArgs: any,
    agentName: string = getHarnessName('claude'),
): string {
    return trimIdent(`
        ${agentName} is requesting permission to use ${toolName} (session ${sessionId}):
        <request_id>${requestId}</request_id>
        <tool_name>${toolName}</tool_name>
        <tool_args>${JSON.stringify(toolArgs)}</tool_args>
    `);
}

//
// Message formatting
//

/**
 * Clip one field to the tier's per-message budget.
 *
 * The marker is part of the text rather than a log line because the assistant
 * has to know the difference between "the command was short" and "I am not
 * seeing all of it" — otherwise it will reason confidently about a truncated
 * command.
 */
function clip(text: string, config: VoiceConfig): string {
    const cap = config.MAX_MESSAGE_CHARS;
    if (text.length <= cap) return text;
    return `${text.slice(0, cap)}…[truncated, ${text.length - cap} more characters]`;
}

export function formatMessage(
    message: Message,
    config: VoiceConfig = VOICE_CONFIG,
    agentName: string = getHarnessName('claude'),
): string | null {

    // Lines
    let lines: string[] = [];
    if (message.kind === 'agent-text') {
        lines.push(`${agentName}: \n<text>${clip(message.text, config)}</text>`);
    } else if (message.kind === 'user-text') {
        lines.push(`User sent message: \n<text>${clip(message.text, config)}</text>`);
    } else if (message.kind === 'tool-call' && !config.DISABLE_TOOL_CALLS) {
        // Codex puts the whole shell command here, so this is usually the
        // largest thing in the transcript.
        const description = message.tool.description
            ? clip(message.tool.description, config)
            : '';
        const toolDescription = description ? ` - ${description}` : '';
        if (config.LIMITED_TOOL_CALLS) {
            if (message.tool.description) {
                lines.push(`${agentName} is using ${message.tool.name}${toolDescription}`);
            }
        } else {
            lines.push(`${agentName} is using ${message.tool.name}${toolDescription} (tool_use_id: ${message.id}) with arguments: <arguments>${clip(JSON.stringify(message.tool.input), config)}</arguments>`);
        }
    }
    if (lines.length === 0) {
        return null;
    }
    return lines.join('\n\n');
}

export function formatNewSingleMessage(
    sessionId: string,
    message: Message,
    config: VoiceConfig = VOICE_CONFIG,
    agentName: string = getHarnessName('claude'),
): string | null {
    let formatted = formatMessage(message, config, agentName);
    if (!formatted) {
        return null;
    }
    return 'New message in session: ' + sessionId + '\n\n' + formatted;
}

export function formatNewMessages(
    sessionId: string,
    messages: Message[],
    config: VoiceConfig = VOICE_CONFIG,
    agentName: string = getHarnessName('claude'),
): string | null {
    // Newest first to spend the budget, then put back in order to read.
    //
    // A batch is a burst of progress — a turn's worth of tool calls and text
    // arriving in one update — and what the assistant has to be able to answer
    // is "what is this session doing". The end of the burst says that; the
    // beginning of it is already described by the end. Spending the budget
    // from the front would keep the least useful part of every burst.
    const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
    const budget = config.MAX_INJECTION_CHARS;
    const kept: string[] = [];
    let used = 0;
    let dropped = 0;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
        const formatted = formatMessage(ordered[i], config, agentName);
        if (!formatted) continue;
        if (used + formatted.length > budget && kept.length > 0) {
            dropped = i + 1;
            break;
        }
        kept.push(formatted);
        used += formatted.length;
    }
    if (kept.length === 0) {
        return null;
    }
    kept.reverse();

    const header = dropped > 0
        ? `New messages in session: ${sessionId} (${dropped} earlier ${dropped === 1 ? 'message' : 'messages'} omitted; ask the session for detail if you need it)`
        : `New messages in session: ${sessionId}`;
    return header + '\n\n' + kept.join('\n\n');
}

export function formatHistory(
    sessionId: string,
    messages: Message[],
    config: VoiceConfig = VOICE_CONFIG,
    agentName: string = getHarnessName('claude'),
): string | null {
    // 0 means "no history at all" (the minimal tier); negative means "all of
    // it" (the pre-tier behaviour); positive is a cap.
    const limit = config.MAX_HISTORY_MESSAGES;
    let messagesToFormat = limit === 0
        ? []
        : limit > 0
            ? messages.slice(0, limit)
            : messages;
    let formatted = messagesToFormat.map((m) => formatMessage(m, config, agentName)).filter(Boolean);
    if (formatted.length === 0) {
        return null;
    }
    return 'History of messages in session: ' + sessionId + '\n\n' + formatted.join('\n\n');
}

//
// Session states
//

export function formatSessionFull(
    session: Session,
    messages: Message[],
    config: VoiceConfig = VOICE_CONFIG,
): string {
    const sessionName = session.metadata?.summary?.text;
    const sessionPath = session.metadata?.path;
    const agentName = resolveAgentName(session.metadata?.flavor);
    const lines: string[] = [];

    // Add session context
    lines.push(`# Session ID: ${session.id}`);
    lines.push(`# Project path: ${sessionPath}`);
    lines.push(`# Session summary:\n${sessionName}`);
    // Named explicitly so the assistant knows which agent it is talking about
    // even before the first message arrives.
    lines.push(`# Coding agent: ${agentName}`);

    // Add session metadata if available
    if (session.metadata?.summary?.text) {
        lines.push('## Session Summary');
        lines.push(session.metadata.summary.text);
        lines.push('');
    }

    // Add history — omitted entirely in the tiers that carry none, so the
    // prompt does not end on an empty section.
    const history = formatHistory(session.id, messages, config, agentName);
    if (history) {
        lines.push('## Our interaction history so far');
        lines.push('');
        lines.push(history);
    }

    return lines.join('\n\n');
}

/**
 * A background session finished something — say so, cheaply.
 *
 * ~60 tokens versus the thousands a message body costs, and it carries the
 * part the user actually acts on: which session wants attention. The
 * assistant can ask that session for detail if the user wants it.
 */
export function formatCompletionNotice(
    sessionId: string,
    summary?: string | null,
    agentName: string = getHarnessName('claude'),
): string {
    const label = summary?.trim() ? ` "${summary.trim()}"` : '';
    return (
        `${agentName} finished working in background session: ${sessionId}${label}. `
        + `Report this to the user in one short sentence. `
        + `Do not read its output aloud unless asked.`
    );
}

/**
 * One line naming the session the user is looking at right now.
 *
 * Sent whenever focus changes, and included in the opening brief, so the
 * assistant always has a current answer. The id is necessary — it is what
 * `sendMessageToSession` takes — but the summary is what lets the assistant
 * talk about the session without reading an opaque string out loud.
 */
export function formatCurrentSession(
    sessionId: string | null,
    summary?: string | null,
): string {
    if (!sessionId) {
        return 'Current session: none. Ask the user which session they mean.';
    }
    const name = summary?.trim() ? ` ("${summary.trim()}")` : '';
    return (
        `Current session: ${sessionId}${name}. `
        + `Send messages here unless the user names a different session.`
    );
}

export function formatSessionOffline(sessionId: string, metadata?: SessionMetadata): string {
    return `Session went offline: ${sessionId}`;
}

export function formatSessionOnline(sessionId: string, metadata?: SessionMetadata): string {
    return `Session came online: ${sessionId}`;
}

/**
 * Tell the assistant that the current session changed.
 *
 * The wording matters more than it looks. The earlier version said only
 * "Session became focused: X", which announces an event without stating the
 * fact that matters: that X is now the one the user is looking at, and the one
 * a message with no session named should go to. With only the event to go on,
 * the model kept sending to whichever session it had been told about first —
 * so switching sessions mid-call silently delivered the user's next instruction
 * to the previous session.
 *
 * The summary is included because "current session" is otherwise an opaque id,
 * and the model has to answer questions like "which session am I on?" out loud
 * without reading ids to the user.
 */
export function formatSessionFocus(
    sessionId: string,
    metadata?: SessionMetadata,
): string {
    const summary = metadata?.summary?.text?.trim();
    const name = summary ? ` ("${summary}")` : '';
    return (
        `Current session changed to: ${sessionId}${name}. `
        + `This is now the session the user is looking at, and the one to send `
        + `messages to when the user does not name a different session. `
        + `Forget the previous current session; anything it reports from now on `
        + `is a background update.`
    );
}

export function formatReadyEvent(
    sessionId: string,
    agentName: string = getHarnessName('claude'),
): string {
    return `${agentName} done working in session: ${sessionId}. The previous message(s) are the summary of the work done. Report this to the human immediately.`;
}
