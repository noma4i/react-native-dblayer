"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createOperation = exports.createAction = void 0;
var _react = require("react");
var _rowOperationState = require("./rowOperationState.js");
var _fieldCodec = require("../schema/fieldCodec.js");
var _mutationVariables = require("./mutationVariables.js");
var _mutationRootPlan = require("./mutationRootPlan.js");
var _internalHandles = require("../core/internalHandles.js");
/**
 * A declared action becomes its runtime handle here. The declared mode decides which machinery
 * carries it - a durable operation, a poller, or a mutation - and the caller sees one handle either
 * way, so a consumer never reproduces the lifecycle of the mode it happened to get.
 */
const createOperation = (runtime, id) => ({
  read: () => (0, _rowOperationState.readRowOperationState)(runtime.modelId, id),
  use: () => (0, _rowOperationState.useRowOperationState)(runtime.modelId, id)
});
exports.createOperation = createOperation;
const createAction = (runtime, name, definition) => {
  const readActionId = value => {
    const id = _fieldCodec.scalarFieldCodecs.id.read(value);
    if (id === undefined) throw new Error(`${name}: action requires id`);
    return id;
  };
  if (definition.mode === 'durable') {
    if (!definition.optimistic) throw new Error(`${name}: durable insert requires optimistic build`);
    const insert = definition.optimistic;
    const handle = runtime.detached(name, {
      build: (input, context) => insert.build(input, context),
      resume: definition.resume,
      failure: insert.failure,
      onFailurePatch: insert.onFailurePatch ? input => insert.onFailurePatch(input) : undefined
    });
    return {
      run: handle.start,
      complete: handle.complete,
      fail: handle.fail,
      retry: handle.retry,
      discard: handle.discard
    };
  }
  if (definition.mode === 'poll') {
    const inputs = new Map();
    const refs = new Map();
    const poller = runtime.poller(name, {
      document: definition.document,
      vars: id => {
        return definition.variables(inputs.get(id), {
          tempId: null,
          operationId: ''
        });
      },
      apply: (id, data) => {
        const patch = definition.select(data);
        if (patch != null) runtime.update(id, patch);
      },
      classify: definition.poll.classify,
      intervalMs: definition.poll.intervalMs,
      maxAttempts: definition.poll.maxAttempts
    });
    const idFor = input => readActionId(definition.id(input));
    const retain = id => {
      refs.set(id, (refs.get(id) ?? 0) + 1);
    };
    const release = id => {
      const next = refs.get(id) - 1;
      if (next > 0) {
        refs.set(id, next);
        return;
      }
      refs.delete(id);
      inputs.delete(id);
    };
    return {
      run: async input => {
        const id = idFor(input);
        inputs.set(id, input);
        try {
          await poller.refresh(id);
        } finally {
          if (!refs.has(id)) inputs.delete(id);
        }
      },
      use: input => {
        const id = input == null ? null : idFor(input);
        if (id) inputs.set(id, input);
        const phase = poller.usePhase(id ?? `${name}:inactive`);
        (0, _react.useEffect)(() => {
          if (!id) return;
          retain(id);
          const detach = poller.attach(id);
          return () => {
            detach();
            release(id);
          };
        }, [id]);
        return {
          ...(id ? phase : {
            phase: 'idle',
            attempts: 0
          }),
          refresh: async () => {
            if (!id || input == null) return;
            inputs.set(id, input);
            await poller.refresh(id, {
              resetBudget: true
            });
          }
        };
      }
    };
  }
  const optimistic = (() => {
    if (definition.kind === 'insert' && definition.optimistic) {
      const insert = definition.optimistic;
      return {
        model: runtime,
        build: (input, context) => {
          return insert.build(input, {
            ...context,
            tempId: context.tempId
          });
        },
        selectServerNode: definition.select,
        existingTempId: insert.existingTempId,
        failure: insert.failure,
        onFailurePatch: insert.onFailurePatch,
        onRetryPatch: insert.onRetryPatch,
        correlate: insert.correlate
      };
    }
    if (definition.kind === 'update' && definition.optimistic) {
      return {
        method: 'patch',
        model: runtime,
        selectId: input => readActionId(definition.id(input)),
        selectPatch: definition.optimistic.patch
      };
    }
    if (definition.kind === 'destroy' && definition.optimistic === true) {
      return {
        method: 'destroy',
        model: runtime,
        selectId: input => readActionId(definition.id(input))
      };
    }
    return undefined;
  })();
  const rootPlanner = definition.kind === 'update' || definition.kind === 'insert' && !definition.optimistic ? ({
    data
  }) => {
    const row = definition.select(data);
    return row == null ? [] : (0, _internalHandles.getInternalModelHandle)(runtime).planRows([row]);
  } : definition.kind === 'custom' && definition.select ? (() => {
    const select = definition.select;
    return ({
      data
    }) => {
      const row = select(data);
      return row == null ? [] : (0, _internalHandles.getInternalModelHandle)(runtime).planRows([row]);
    };
  })() : undefined;
  const mutationConfig = {
    document: definition.document,
    result: definition.result,
    [_mutationVariables.exactMutationVariables]: definition.variables,
    optimistic,
    [_mutationRootPlan.exactMutationRootPlan]: rootPlanner,
    write: definition.write,
    dedupe: definition.dedupe,
    once: definition.once,
    onMutate: definition.before,
    onError: definition.error,
    track: definition.track
  };
  const mutation = runtime.mutation(name, mutationConfig);
  return {
    run: input => mutation.run(input),
    retry: tempId => mutation.retry(tempId),
    discard: tempId => mutation.discard(tempId),
    use: () => {
      const handle = mutation.use();
      return {
        run: input => handle.mutateAsync(input),
        isPending: handle.isPending,
        error: handle.error
      };
    }
  };
};
exports.createAction = createAction;
//# sourceMappingURL=facadeActions.js.map