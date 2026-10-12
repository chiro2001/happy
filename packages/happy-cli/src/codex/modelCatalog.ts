/**
 * The model registry a machine's Codex actually resolves.
 *
 * Codex decides which models exist from its own registry — the built-in list,
 * replaced by whatever `model_catalog_json` points at — so a gateway model a
 * user added lives in no Happy release, and only Codex can be asked what the
 * machine supports. It is asked over app-server `model/list`; the answer is
 * normalized here once and then published as metadata, as machine-wide catalog
 * (so the new-session picker can offer a model before any session exists) and
 * as per-session catalog (so an open session's composer can).
 *
 * Both consumers want the same shape as the model options Happy already
 * publishes: `code` is the value a turn accepts, `value` is what a person
 * reads, and the reasoning levels ride along so a model newer than this app
 * still gets a correct effort picker.
 *
 * @module modelCatalog
 */

import { logger } from '@/ui/logger';
import { CodexAppServerClient } from './codexAppServerClient';
import type { CodexModelListEntry } from './codexAppServerTypes';

/**
 * One model, in the shape Happy publishes as metadata. Mirrors the model
 * entries in `Metadata` (api/types.ts), which the app already parses; unknown
 * keys are dropped rather than sent as nulls so an older client reading this
 * metadata is unaffected.
 */
export type CodexModelCatalogEntry = {
    code: string;
    value: string;
    description?: string;
    thinkingLevels?: string[];
    defaultThinkingLevel?: string;
    serviceTiers?: string[];
};

function trimmed(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * The registry as catalog entries, in the registry's own order.
 *
 * Hidden models are dropped: they are Codex's own internal entries (a review
 * model, a deprecated preview), and Codex's picker does not offer them either.
 * A model the user selected that is hidden is still reachable in the app,
 * which appends a configured-but-missing model as its own row.
 */
export function toCodexModelCatalog(entries: readonly CodexModelListEntry[]): CodexModelCatalogEntry[] {
    const catalog: CodexModelCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const entry of entries ?? []) {
        const code = trimmed(entry?.model);
        if (!code || entry?.hidden === true || seen.has(code)) {
            continue;
        }
        seen.add(code);

        const item: CodexModelCatalogEntry = {
            code,
            value: trimmed(entry.displayName) || code,
        };
        const description = trimmed(entry.description);
        if (description) {
            item.description = description;
        }

        const thinkingLevels = (entry.supportedReasoningEfforts ?? [])
            .map((effort) => trimmed(effort?.reasoningEffort))
            .filter((effort) => effort.length > 0);
        if (thinkingLevels.length > 0) {
            item.thinkingLevels = thinkingLevels;
        }
        const defaultThinkingLevel = trimmed(entry.defaultReasoningEffort);
        if (defaultThinkingLevel) {
            item.defaultThinkingLevel = defaultThinkingLevel;
        }

        const serviceTiers = (entry.serviceTiers ?? [])
            .map((tier) => trimmed(tier?.id))
            .filter((tier) => tier.length > 0);
        if (serviceTiers.length > 0) {
            item.serviceTiers = serviceTiers;
        }

        catalog.push(item);
    }
    return catalog;
}

/**
 * The part of the app-server client this module needs, so a test can stand in
 * for it without spawning anything.
 */
export interface CodexModelCatalogSource {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    listModels(): Promise<CodexModelListEntry[]>;
}

/**
 * Read this machine's registry, or null when Codex could not be asked.
 *
 * Null and an empty catalog mean different things and are kept apart: an empty
 * catalog is a registry with nothing in it, while null is "no answer" — an old
 * Codex without `model/list`, or one that failed to start — and callers leave
 * whatever they published before alone rather than replacing it with nothing.
 */
export async function readCodexModelCatalog(
    client: CodexModelCatalogSource = new CodexAppServerClient(),
): Promise<CodexModelCatalogEntry[] | null> {
    try {
        await client.connect();
        const models = await client.listModels();
        return toCodexModelCatalog(models);
    } catch (error) {
        logger.debug('[Codex] Could not read the model registry:', error);
        return null;
    } finally {
        await client.disconnect().catch(() => {});
    }
}
