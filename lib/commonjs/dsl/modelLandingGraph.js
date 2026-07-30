"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerModelLandingHost = exports.planModelLandingWithRoot = exports.planModelLanding = void 0;
var _generationRegistry = require("../core/generationRegistry.js");
var _serialize = require("../core/serialize.js");
const hosts = (0, _generationRegistry.createGenerationRegistry)();
const registerModelLandingHost = (model, host) => {
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
exports.registerModelLandingHost = registerModelLandingHost;
const planLandingGraph = (model, rows, options, planRoot) => {
  const queue = rows.map(input => ({
    model,
    input
  }));
  const planned = new Map();
  const expandedInputs = new WeakMap();
  const expandedEdges = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    const host = hosts.get(entry.model);
    if (!host) throw new Error(`Model landing target ${entry.model} is not defined`);
    const id = entry.id ?? host.normalize(entry.input).id;
    const modelRows = planned.get(entry.model) ?? new Map();
    modelRows.set(id, entry.input);
    planned.set(entry.model, modelRows);
    if (typeof entry.input === 'object' && entry.input !== null) {
      const expandedModels = expandedInputs.get(entry.input) ?? new Set();
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
        const edgeKey = (0, _serialize.compositeKey)(entry.model, id, edgeName, edge.model.key, targetId);
        if (expandedEdges.has(edgeKey)) continue;
        expandedEdges.add(edgeKey);
        queue.push({
          model: edge.model.key,
          input: value,
          id: targetId
        });
      }
    }
  }
  return [...planned.entries()].flatMap(([modelKey, modelRows]) => {
    const host = hosts.get(modelKey);
    const values = [...modelRows.values()];
    return modelKey === model && planRoot ? planRoot(values, options) : host.planOwnRows(values, options);
  });
};
const planModelLanding = (model, rows, options) => planLandingGraph(model, rows, options);

/**
 * Plan a graph while replacing the root model's ordinary upsert planner.
 *
 * @param model Root model key.
 * @param rows Raw root rows.
 * @param planRoot Root-specific planner such as identity replacement.
 * @param options Write origin propagated to non-root graph nodes.
 * @returns Deduplicated write operations for all models in the graph.
 */
exports.planModelLanding = planModelLanding;
const planModelLandingWithRoot = (model, rows, planRoot, options) => planLandingGraph(model, rows, options, planRoot);
exports.planModelLandingWithRoot = planModelLandingWithRoot;
//# sourceMappingURL=modelLandingGraph.js.map