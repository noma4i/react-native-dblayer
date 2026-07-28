"use strict";

export const createModelMembership = options => {
  const membershipForUpsert = (before, after) => {
    const id = String(after.id);
    const deltas = [];
    for (const [scopeName, spec] of options.membershipScopes) {
      const beforeValue = before && (spec.member?.(before) ?? true) ? options.scopeValueFromRow(spec.by, before) : null;
      const afterValue = spec.member?.(after) ?? true ? options.scopeValueFromRow(spec.by, after) : null;
      const beforeKey = beforeValue ? options.keyForScope(scopeName, beforeValue) : null;
      const afterKey = afterValue ? options.keyForScope(scopeName, afterValue) : null;
      if (beforeKey && beforeKey !== afterKey && options.isScopeMember(beforeKey, id)) deltas.push({
        scopeKey: beforeKey,
        detach: [id]
      });
      if (afterKey && !options.isScopeMember(afterKey, id)) deltas.push({
        scopeKey: afterKey,
        append: [id]
      });
    }
    return deltas;
  };
  return {
    membershipForUpsert,
    detachForDestroy: id => options.scopeKeysOf(id).map(scopeKey => ({
      scopeKey,
      detach: [id]
    }))
  };
};
//# sourceMappingURL=modelMembership.js.map