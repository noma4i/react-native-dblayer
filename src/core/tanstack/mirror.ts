import type { CommitBus } from '../apply/commitBus'
import { getApplyTarget } from '../apply/transaction'
import {
  ensureModelCollection,
  runInWriteBatch,
  writerFor,
} from './facade'

/** Starts synchronously mirroring every commit-bus row batch into TanStack model collections. */
export function startCollectionMirror(bus: CommitBus): () => void {
  return bus.subscribeAll((batch) => {
    const rowIdsByModel = new Map<string, Set<string>>()
    for (const row of batch.rows) {
      const rowIds = rowIdsByModel.get(row.model) ?? new Set<string>()
      rowIds.add(row.id)
      rowIdsByModel.set(row.model, rowIds)
    }

    runInWriteBatch(() => {
      for (const [modelId, rowIds] of rowIdsByModel) {
        let target
        try {
          target = getApplyTarget(modelId)
        } catch {
          continue
        }
        const collection = ensureModelCollection(modelId)
        const writer = writerFor(modelId)
        writer.begin()
        for (const id of rowIds) {
          const row = target.readRow(id)
          const current = collection.get(id)
          if (!row) {
            if (current) writer.write({ type: `delete`, key: id })
            continue
          }
          const next = { ...row, id }
          if (!current) {
            writer.write({ type: `insert`, value: next })
            continue
          }
          if (Object.entries(next).some(([key, value]) => current[key] !== value)) {
            writer.write({ type: `update`, value: next })
          }
        }
        writer.commit()
      }
    })
  })
}

/** Seeds model collections from their visible EntityState rows after hydration. */
export function seedCollections(models: string[]): void {
  runInWriteBatch(() => {
    for (const modelId of models) {
      const collection = ensureModelCollection(modelId)
      const writer = writerFor(modelId)
      const target = getApplyTarget(modelId)
      writer.begin()
      for (const row of target.readAllRows()) {
        const id = String(row.id)
        const current = collection.get(id)
        const next = { ...row, id }
        if (!current) {
          writer.write({ type: `insert`, value: next })
          continue
        }
        if (Object.entries(next).some(([key, value]) => current[key] !== value)) {
          writer.write({ type: `update`, value: next })
        }
      }
      writer.commit()
    }
  })
}
