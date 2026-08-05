import type { WriteOp } from './core.apply.ops.types';
import type { SideloadEdge } from './dsl.modelFacade.types';

export type ModelLandingHost = {
  admitPlanRow(input: unknown): { id: string } | undefined;
  planOwnRows(rows: unknown[], options?: { origin?: 'event' }): WriteOp[];
  sideloads?: () => Record<string, SideloadEdge>;
};

export type ModelLandingOptions = {
  sideloads?: () => Record<string, SideloadEdge>;
};
