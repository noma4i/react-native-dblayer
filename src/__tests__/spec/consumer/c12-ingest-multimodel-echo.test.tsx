import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind, OperationTypeNode } from 'graphql';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { configureDb, defineModel, defineShape, f, resetRuntime, useDbSubscriptions, type DbTransport } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted } from '../helpers/harness';

type Moment = { id: string; uuid: string; status: string };
type Audit = { id: string; momentId: string };
type Payload = { moment: Moment; audit: Audit };
type Data = { momentChanged: Payload };

const document: TypedDocumentNode<Data, Record<string, never>> = {
  kind: Kind.DOCUMENT,
  definitions: [
    {
      kind: Kind.OPERATION_DEFINITION,
      operation: OperationTypeNode.SUBSCRIPTION,
      variableDefinitions: [],
      directives: [],
      selectionSet: {
        kind: Kind.SELECTION_SET,
        selections: [{ kind: Kind.FIELD, name: { kind: Kind.NAME, value: 'momentChanged' }, arguments: [], directives: [] }]
      }
    }
  ]
};
const MomentSchema = defineShape<Moment>()({ uuid: f.str(), status: f.str() });
const AuditSchema = defineShape<Audit>()({ momentId: f.str() });

function Activation(): null {
  useDbSubscriptions(true);
  return null;
}

afterEach(resetRuntime);

describe('multi-model event idempotency', () => {
  it('applies root and cross-model rows once across duplicate deliveries', () => {
    let next!: (data: unknown) => void;
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      subscribe: (
        _options: Parameters<NonNullable<DbTransport['subscribe']>>[0],
        handlers: Parameters<NonNullable<DbTransport['subscribe']>>[1]
      ) => {
        next = handlers.next;
        return () => undefined;
      }
    });
    configureDb({ storage, transport });
    const audits = defineModel('SpecEventEchoAudits', { schema: AuditSchema });
    const moments = defineModel('SpecEventEchoMoments', {
      schema: MomentSchema,
      events: owner => ({
        changed: owner.gql.live(document, {
          variables: {},
          root: { insert: { select: ({ payload }) => payload.moment } },
          write: ({ payload }, plan) => plan.upsert(audits, payload.audit)
        })
      })
    });
    const unrelated = defineModel('SpecEventEchoUnrelated', { schema: MomentSchema });
    unrelated.insert({ id: 'unrelated', uuid: 'unrelated', status: 'kept' });
    const momentReader = renderCounted(() => moments.useFind('moment-1'));
    const auditReader = renderCounted(() => audits.useFind('audit-1'));
    const unrelatedReader = renderCounted(() => unrelated.useFind('unrelated'));
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Activation));
    });
    const before = {
      moment: momentReader.renders(),
      audit: auditReader.renders(),
      unrelated: unrelatedReader.renders(),
      commits: diagnostics().snapshot().commits
    };
    const payload: Payload = {
      moment: { id: 'moment-1', uuid: 'uuid-1', status: 'ready' },
      audit: { id: 'audit-1', momentId: 'moment-1' }
    };

    act(() => next({ momentChanged: payload }));
    act(() => next({ momentChanged: payload }));

    expect(moments.find('moment-1')).toEqual(payload.moment);
    expect(audits.find('audit-1')).toEqual(payload.audit);
    expect(momentReader.renders() - before.moment).toBe(1);
    expect(auditReader.renders() - before.audit).toBe(1);
    expect(unrelatedReader.renders() - before.unrelated).toBe(0);
    expect(diagnostics().snapshot().commits - before.commits).toBe(1);
    momentReader.unmount();
    auditReader.unmount();
    unrelatedReader.unmount();
    act(() => root.unmount());
  });
});
