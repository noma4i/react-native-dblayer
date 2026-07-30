import type { WriteOp } from './core.apply.journal.types';
import type { SideloadEdge } from './dsl.modelFacade.types';

export type ModelLandingHost = {
  normalize(input: unknown): { id: string };
  planOwnRows(rows: unknown[], options?: { origin?: 'event' }): WriteOp[];
  sideloads?: () => Record<string, SideloadEdge>;
};

export type ModelLandingOptions = {
  sideloads?: () => Record<string, SideloadEdge>;
};
