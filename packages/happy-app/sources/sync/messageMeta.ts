import type { Session } from './storageTypes';
import type { Settings } from './settings';
import type { MessageMeta } from './typesMessageMeta';
import { resolveSessionState } from './sessionState';
import { getAgentDefaultOverride, resolveAgentDefaultConfig, retirePermissionMode } from './agentDefaults';
import { permissionModeSupportedByCli } from '@/components/modelModeOptions';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import {
    getRigComposerMode,
    getRigCurrentModel,
    getRigModels,
    getRigReasoningLevels,
    getRigReasoningSelection,
    getRigSelectedModelKey,
    isRigMetadataV1,
    rigSendsMessageReceipts,
} from './rig';

export function resolveMessageDeliveryMeta(
    session: Pick<Session, 'metadata' | 'thinking' | 'agentState'>,
    isNewSession = false,
    hasPendingUserMessage = false,
): Pick<MessageMeta, 'expectsAcceptance' | 'queuedWhileBusy'> {
    if (!rigSendsMessageReceipts(session.metadata)) return {};
    const state = resolveSessionState({
        agentState: session.agentState,
        thinking: session.thinking,
        isOnline: true,
    });
    return {
        expectsAcceptance: true,
        // Startup is not a previous turn to wait for. Ignore connectivity here:
        // being offline alone does not mean another turn is occupying the agent.
        // A pending question is also ready for the user's answer, not a turn the
        // answer must wait behind. Permission requests still block new input.
        queuedWhileBusy: !isNewSession && (
            hasPendingUserMessage || state === 'thinking' || state === 'permission_required'
        ),
    };
}

export type MessageModeMeta = {
    permissionMode?: PermissionModeKey;
    model?: string | null;
    modelProviderId?: string;
    effort?: string | null;
    serviceTier?: string | null;
};

/**
 * The session or a saved default carries a permission mode the session's CLI
 * cannot parse. Thrown instead of substituting another mode: swapping in the
 * code default would silently change what the agent is allowed to do — for
 * Claude it would escalate a user who chose reviewed Auto into yolo. Callers
 * surface the message and do not send.
 */
export class UnsupportedPermissionModeError extends Error {
    readonly mode: string;
    readonly cliVersion: string;

    constructor(mode: string, cliVersion: string) {
        super(
            `This session's Happy CLI (v${cliVersion}) does not support the '${mode}' permission mode. `
            + 'Pick a different mode for this session, or update the Happy CLI on that machine.',
        );
        this.name = 'UnsupportedPermissionModeError';
        this.mode = mode;
        this.cliVersion = cliVersion;
        Object.setPrototypeOf(this, UnsupportedPermissionModeError.prototype);
    }
}

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel' | 'serviceTier'>,
    settings?: Pick<Settings, 'agentDefaultOverrides'>,
): MessageModeMeta {
    if (isRigMetadataV1(session.metadata)) {
        // The local mirror is the composer (draft, then lastMode); the
        // deprecated display fields are only the final fallback.
        const meta: MessageModeMeta = {};
        const composerMode = getRigComposerMode(session.metadata);
        const permissionMode = session.permissionMode
            ?? composerMode?.permissionMode
            ?? session.metadata?.currentOperatingModeCode
            ?? session.metadata?.permissionMode
            ?? session.metadata?.session?.permissionMode;
        if (permissionMode) meta.permissionMode = permissionMode;
        if (session.serviceTier !== undefined) meta.serviceTier = session.serviceTier;
        else if (composerMode) meta.serviceTier = composerMode.serviceTier;

        const selectedKey = session.modelMode ?? getRigSelectedModelKey(session.metadata);
        const selectedModel = getRigModels(session.metadata).find((model) => model.key === selectedKey)
            ?? (selectedKey === getRigSelectedModelKey(session.metadata) ? getRigCurrentModel(session.metadata) : null);
        if (selectedModel) {
            meta.model = selectedModel.id;
            meta.modelProviderId = selectedModel.providerId;
        } else if (selectedKey?.includes(':')) {
            const separator = selectedKey.indexOf(':');
            meta.modelProviderId = selectedKey.slice(0, separator);
            meta.model = selectedKey.slice(separator + 1);
        }

        const levels = getRigReasoningLevels(session.metadata, selectedKey);
        const localEffort = session.effortLevel;
        const effort = localEffort && levels.includes(localEffort)
            ? localEffort
            : getRigReasoningSelection(session.metadata, selectedKey);
        if (effort) meta.effort = effort;
        return meta;
    }

    const flavor = session.metadata?.flavor;
    const agentOverrides = getAgentDefaultOverride(settings?.agentDefaultOverrides, flavor);
    const meta: MessageModeMeta = {};
    // The happy-cli version running this session. A mode key saved before the
    // session's CLI learned it (an old session's `auto`, or a global default of
    // `auto` applied to an old CLI) must not reach the wire: the old CLI's
    // schema rejects it and drops the whole message. It is refused here, not
    // mapped: substituting a mode would silently change permissions.
    const cliVersion = session.metadata?.version;
    const supported = (mode: PermissionModeKey | undefined) => {
        if (mode !== undefined && !permissionModeSupportedByCli(mode, cliVersion)) {
            throw new UnsupportedPermissionModeError(mode, cliVersion ?? 'unknown');
        }
        return mode;
    };

    // Codex and Agy turns always run with a concrete permission, model, and
    // effort. Send the same effective defaults the composer displays instead
    // of omitting them: Codex can reset to its launch mode during an abort, and
    // Agy maps its model + effort pair independently at the provider boundary.
    // In either case an omitted fallback could execute differently from the UI.
    if (flavor === 'codex' || flavor === 'agy') {
        const defaults = resolveAgentDefaultConfig(settings?.agentDefaultOverrides, flavor, cliVersion);

        // Only a mode the user actually chose is sent. This used to fall back
        // to the code default, which is harmless-looking and is not: the CLI
        // treats a permission mode on a message as an instruction to *change*
        // modes ("Permission mode updated from user message to: …"), and
        // sending nothing means "keep the current one".
        //
        // A session started from the CLI records no permission mode at all —
        // verified against eighteen live sessions, whose metadata carries
        // `dangerouslySkipPermissions` and nothing else — so a freshly opened
        // client has an empty mirror and substituted `auto` for every message.
        // A session launched with `--permission-mode yolo` was quietly turned
        // back into one that stops and asks, which is exactly what a user
        // reported after opening the desktop app.
        //
        // The intent behind the old fallback was to keep re-asserting a mode the
        // user picked, because Codex can reset to its launch mode after an
        // abort. That still holds: a pick lives in the mirror, and an explicit
        // per-agent override lives in settings. Both are real intent. A code
        // default is not.
        const override = getAgentDefaultOverride(settings?.agentDefaultOverrides, flavor);
        const chosenMode = session.permissionMode ?? override.permissionMode;
        if (chosenMode !== undefined && chosenMode !== null) {
            meta.permissionMode = supported(retirePermissionMode(chosenMode));
        }

        const modelMode = session.modelMode ?? defaults.modelMode;
        meta.model = modelMode === 'default' ? null : modelMode;

        // Same rule as the permission mode above, and for the same reason: an
        // effort on a message is an instruction to change the effort, and the
        // CLI says so in its own log — "Effort updated from user message" versus
        // "kind: retained".
        //
        // This one was worse in practice because it failed silently. The code
        // default is `medium`, so every message carried `medium` and quietly
        // overrode whatever the agent was actually configured with — including
        // `model_reasoning_effort = "max"` in `~/.codex/config.toml`. The
        // session ran at `medium` while every surface said `max`, which is
        // exactly the class of bug that is impossible to notice from the UI.
        //
        // A pick, or an explicit per-agent override, is still sent: those are
        // choices, and re-asserting them survives Codex resetting its mode.
        const chosenEffort = session.effortLevel ?? override.effortLevel;
        if (chosenEffort !== undefined && chosenEffort !== null) {
            meta.effort = chosenEffort;
        }
        return meta;
    }

    if (session.permissionMode !== null && session.permissionMode !== undefined) {
        // A session picked before a mode was retired still carries the old key,
        // and the CLI rejects the whole message envelope on an unknown one.
        meta.permissionMode = supported(retirePermissionMode(session.permissionMode));
    } else if (agentOverrides.permissionMode !== undefined) {
        meta.permissionMode = supported(agentOverrides.permissionMode);
    }

    const modelMode = session.modelMode ?? agentOverrides.modelMode;
    if (modelMode !== undefined) {
        meta.model = modelMode === 'default' ? null : modelMode;
    }

    const effort = session.effortLevel ?? agentOverrides.effortLevel;
    if (effort !== undefined) {
        meta.effort = effort;
    }

    return meta;
}
