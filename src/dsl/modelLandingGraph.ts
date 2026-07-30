import { createGenerationRegistry } from '../core/generationRegistry';
import { compositeKey } from '../core/serialize';
import type { ModelLandingHost, WriteOp } from '../types';

const hosts = createGenerationRegistry<ModelLandingHost>();

export const registerModelLandingHost = (model: string, host: ModelLandingHost): void => {
  hosts.register(model, host, `Model landing host already registered for ${model}`);
};

/**
 * Plan one model payload and every declared sideload before creating the commit envelope.
 *
 * @param model Root model key.
 * @param rows Raw root rows.
 * @param options Write origin propagated to every graph node.
 * @returns Deduplicated write operations for all models in the graph.
 */
const planLandingGraph = (
  model: string,
  rows: unknown[],
  options: { origin?: 'event' } | undefined,
  planRoot?: (rows: unknown[], options?: { origin?: 'event' }) => WriteOp[]
): WriteOp[] => {
  const queue: Array<{ model: string; input: unknown; id?: string }> = rows.map(input => ({ model, input }));
  const planned = new Map<string, Map<string, unknown>>();
  const expandedInputs = new WeakMap<object, Set<string>>();
  const expandedEdges = new Set<string>();

  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index]!;
    const host = hosts.get(entry.model);
    if (!host) throw new Error(`Model landing target ${entry.model} is not defined`);
    const id = entry.id ?? host.normalize(entry.input).id;
    const modelRows = planned.get(entry.model) ?? new Map<string, unknown>();
    modelRows.set(id, entry.input);
    planned.set(entry.model, modelRows);

    if (typeof entry.input === 'object' && entry.input !== null) {
      const expandedModels = expandedInputs.get(entry.input) ?? new Set<string>();
      if (expandedModels.has(entry.model)) continue;
      expandedModels.add(entry.model);
      expandedInputs.set(entry.input, expandedModels);
    }

    const edges = host.sideloads?.() ?? {};
    for (const [edgeName, edge] of Object.entries(edges).sort(([left], [right]) => left.localeCompare(right))) {
      const selected = edge.select(entry.input);
      const values = Array.isArray(selected) ? selected : [selected];
      for (const value of values) {
        if (value == null) continue;
        const target = hosts.get(edge.model.key);
        if (!target) throw new Error(`Model landing target ${edge.model.key} is not defined`);
        const targetId = target.normalize(value).id;
        const edgeKey = compositeKey(entry.model, id, edgeName, edge.model.key, targetId);
        if (expandedEdges.has(edgeKey)) continue;
        expandedEdges.add(edgeKey);
        queue.push({ model: edge.model.key, input: value, id: targetId });
      }
    }
  }

  return [...planned.entries()].flatMap(([modelKey, modelRows]) => {
    const host = hosts.get(modelKey);
    if (!host) throw new Error(`Model landing target ${modelKey} is not defined`);
    const values = [...modelRows.values()];
    return modelKey === model && planRoot ? planRoot(values, options) : host.planOwnRows(values, options);
  });
};

export const planModelLanding = (model: string, rows: unknown[], options?: { origin?: 'event' }): WriteOp[] =>
  planLandingGraph(model, rows, options);

/**
 * Plan a graph while replacing the root model's ordinary upsert planner.
 *
 * @param model Root model key.
 * @param rows Raw root rows.
 * @param planRoot Root-specific planner such as identity replacement.
 * @param options Write origin propagated to non-root graph nodes.
 * @returns Deduplicated write operations for all models in the graph.
 */
export const planModelLandingWithRoot = (
  model: string,
  rows: unknown[],
  planRoot: (rows: unknown[], options?: { origin?: 'event' }) => WriteOp[],
  options?: { origin?: 'event' }
): WriteOp[] => planLandingGraph(model, rows, options, planRoot);
