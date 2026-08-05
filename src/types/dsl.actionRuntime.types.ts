import type { WriteOp } from './core.apply.ops.types';
import type { OperationIntent } from './core.planes.operationState.types';
import type {
  ActionInput,
  GraphqlActionDefinition,
  GraphqlActionDurableDefinition,
  GraphqlActionRequestDefinition
} from './dsl.modelFacade.types';

export type ActionDefinitionData<TDefinition> = TDefinition extends GraphqlActionDefinition<infer TData, any, any, any, any> ? TData : never;

export type DurableActionTransportInput<TDefinition> = TDefinition extends GraphqlActionDurableDefinition<any, any, any, any, infer TInput, any, any, any>
  ? TInput
  : never;

export type ActionRequestDefinition<TDefinition, TStored extends { id: string }> = GraphqlActionRequestDefinition<
  ActionDefinitionData<TDefinition>,
  any,
  ActionInput<TDefinition>,
  keyof ActionDefinitionData<TDefinition> & string,
  string,
  unknown,
  TStored,
  boolean
>;

export type ActionRequestPlan = {
  ops: WriteOp[];
  intent: OperationIntent;
  tempIds: string[];
  rowIds: string[];
  rollbackRow?: Record<string, unknown>;
  rollbackMemberships?: Array<{ id: string; scopeKey: string; orderKey: string }>;
  patchedFields?: string[];
  patchedValues?: Record<string, unknown>;
};
