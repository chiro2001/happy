import * as z from 'zod';

//
// Schema
//

export const LocalSettingsSchema = z.object({
    // Developer settings (device-specific)
    debugMode: z.boolean().describe('Enable debug logging'),
    devModeEnabled: z.boolean().describe('Enable developer menu in settings'),
    voiceUpsellOverride: z.enum(['control', 'show-paywall-before-first-voice-chat', 'voice-onboarding-and-upsell']).nullable().describe('Developer-only local override for the voice-upsell PostHog flag'),
    commandPaletteEnabled: z.boolean().describe('Enable CMD+K command palette (web only)'),
    themePreference: z.enum(['light', 'dark', 'adaptive']).describe('Theme preference: light, dark, or adaptive (follows system)'),
    markdownCopyV2: z.boolean().describe('Replace native paragraph selection with long-press modal for full markdown copy'),
    consoleLoggingEnabled: z.boolean().describe('Enable console output in production builds'),
    verboseLogging: z.boolean().describe('Log all network requests and responses'),
    zenMode: z.boolean().describe('Hide all sidebars and non-essential UI for focused work'),
    // Right file sidebar: which panels the user has opened and which is active.
    // Persisted so the layout survives reloads and long absences.
    sidebarPanelsOpen: z.array(z.enum(['changes', 'allFiles', 'sideChat'])).describe('Open right-sidebar panels, in tab order'),
    sidebarPanelActive: z.enum(['changes', 'allFiles', 'sideChat']).nullable().describe('Currently active right-sidebar panel (null shows the picker)'),
    // CLI version acknowledgments - keyed by machineId
    acknowledgedCliVersions: z.record(z.string(), z.string()).describe('Acknowledged CLI versions per machine'),
    // Projects showing every workspace rather than the first few - keyed by project id
    expandedProjects: z.record(z.string(), z.boolean()).describe('Projects showing all workspaces instead of the first few'),
    // Boxes ticked on the "Link your computer" checklist - keyed by step id
    linkComputerChecklist: z.record(z.string(), z.boolean()).describe('Ticked steps on the link-your-computer checklist'),
    // ── Qwen voice: device-local by design ────────────────────────────────
    // The account settings blob is uploaded to /v1/account/settings, so the
    // credential and anything that only makes sense on one device belong here.
    qwenApiKey: z.string().nullable().describe('DashScope API key. Never leaves the device.'),
    qwenWorkspaceId: z.string().nullable().describe('Bailian workspace id, used as the WebSocket host prefix'),
    /**
     * Mute the microphone while the assistant speaks.
     *
     * Off by default: the Android recorder is patched to use the
     * VOICE_COMMUNICATION input preset, so the system echo canceller removes
     * the assistant's voice from the mic feed and voice barge-in works. Turn
     * this on for devices whose AEC is too weak — it guarantees no self-echo
     * at the cost of not being able to interrupt by speaking.
     *
     * Device-local because AEC quality varies by device, not by account.
     */
    qwenHalfDuplex: z.boolean().describe('Mute mic during playback (disables voice barge-in)'),
    /** Log every assistant text delta instead of one line per turn. */
    qwenLogDeltas: z.boolean().describe('Verbose voice logging: one line per assistant delta'),
});

//
// NOTE: Local settings are device-specific and should NOT be synced.
// These are preferences that make sense to be different on each device.
//

const LocalSettingsSchemaPartial = LocalSettingsSchema.passthrough().partial();

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

//
// Defaults
//

export const localSettingsDefaults: LocalSettings = {
    debugMode: false,
    devModeEnabled: false,
    voiceUpsellOverride: null,
    commandPaletteEnabled: false,
    themePreference: 'adaptive',
    markdownCopyV2: false,
    consoleLoggingEnabled: false,
    verboseLogging: false,
    zenMode: false,
    sidebarPanelsOpen: [],
    sidebarPanelActive: null,
    acknowledgedCliVersions: {},
    expandedProjects: {},
    linkComputerChecklist: {},
    qwenApiKey: null,
    qwenWorkspaceId: null,
    qwenHalfDuplex: false,
    qwenLogDeltas: false,
};
Object.freeze(localSettingsDefaults);

//
// Parsing
//

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        return { ...localSettingsDefaults };
    }
    return { ...localSettingsDefaults, ...parsed.data };
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
