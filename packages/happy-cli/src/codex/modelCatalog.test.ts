import { describe, expect, it, vi } from 'vitest';
import { readCodexModelCatalog, toCodexModelCatalog, type CodexModelCatalogSource } from './modelCatalog';
import type { CodexModelListEntry } from './codexAppServerTypes';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

function entry(overrides: Partial<CodexModelListEntry> & { model: string }): CodexModelListEntry {
    return overrides;
}

describe('toCodexModelCatalog', () => {
    it('keeps the registry order and carries each model’s declared levels', () => {
        const catalog = toCodexModelCatalog([
            entry({
                model: 'gpt-6-astra',
                displayName: 'GPT-6-Astra',
                description: 'Frontier intelligence for the most demanding work.',
                supportedReasoningEfforts: [
                    { reasoningEffort: 'low' },
                    { reasoningEffort: 'ultra' },
                ],
                defaultReasoningEffort: 'low',
                serviceTiers: [{ id: 'priority', name: 'Fast' }],
            }),
            entry({
                model: 'deepseek-flash',
                displayName: 'DeepSeek-Flash',
                supportedReasoningEfforts: [
                    { reasoningEffort: 'low' },
                    { reasoningEffort: 'high' },
                    { reasoningEffort: 'max' },
                ],
            }),
        ]);

        expect(catalog.map((model) => model.code)).toEqual(['gpt-6-astra', 'deepseek-flash']);
        expect(catalog[0]).toEqual({
            code: 'gpt-6-astra',
            value: 'GPT-6-Astra',
            description: 'Frontier intelligence for the most demanding work.',
            thinkingLevels: ['low', 'ultra'],
            defaultThinkingLevel: 'low',
            serviceTiers: ['priority'],
        });
        expect(catalog[1].thinkingLevels).toEqual(['low', 'high', 'max']);
    });

    it('drops hidden and duplicate models, and falls back to the id for a name', () => {
        const catalog = toCodexModelCatalog([
            entry({ model: 'gpt-5.4', displayName: 'GPT-5.4', hidden: true }),
            entry({ model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }),
            entry({ model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol (duplicate)' }),
            entry({ model: 'custom-gateway-model' }),
        ]);

        expect(catalog).toEqual([
            { code: 'gpt-6.1-sol', value: 'GPT-6.1-Sol' },
            { code: 'custom-gateway-model', value: 'custom-gateway-model' },
        ]);
    });

    it('omits keys the registry did not declare rather than sending empty ones', () => {
        const [model] = toCodexModelCatalog([entry({
            model: 'gpt-5.2',
            displayName: 'GPT-5.2',
            description: '   ',
            supportedReasoningEfforts: [],
            serviceTiers: [],
        })]);

        expect(model).toEqual({ code: 'gpt-5.2', value: 'GPT-5.2' });
    });
});

describe('readCodexModelCatalog', () => {
    function fakeClient(overrides: Partial<CodexModelCatalogSource> = {}): CodexModelCatalogSource {
        return {
            connect: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}),
            listModels: vi.fn(async () => []),
            ...overrides,
        };
    }

    it('reads and normalizes the registry, and always disconnects', async () => {
        const disconnect = vi.fn(async () => {});
        const client = fakeClient({
            disconnect,
            listModels: vi.fn(async () => [entry({ model: 'deepseek-flash', displayName: 'DeepSeek-Flash' })]),
        });

        await expect(readCodexModelCatalog(client)).resolves.toEqual([
            { code: 'deepseek-flash', value: 'DeepSeek-Flash' },
        ]);
        expect(disconnect).toHaveBeenCalledOnce();
    });

    it('reports no answer — not an empty catalog — when the registry cannot be read', async () => {
        // An older Codex answers `model/list` with a method-not-found error;
        // callers must leave the previously published catalog alone.
        const client = fakeClient({
            listModels: vi.fn(async () => { throw new Error('model/list not supported'); }),
        });

        await expect(readCodexModelCatalog(client)).resolves.toBeNull();
        expect(client.disconnect).toHaveBeenCalledOnce();
    });

    it('reports no answer when the app-server cannot be started', async () => {
        const client = fakeClient({
            connect: vi.fn(async () => { throw new Error('Codex CLI is not installed'); }),
        });

        await expect(readCodexModelCatalog(client)).resolves.toBeNull();
    });
});
