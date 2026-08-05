import { configureDb, putQuarantine, readQuarantineEntries } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

/**
 * Quarantine retention: the cap bounds ONLY the diagnostic `plan-row-rejected` class. User-input
 * tickets (`orphan-temp-row`) are invariant-W records and never leave through the cap. Every
 * eviction is a named loss, not a silent splice.
 */
describe('quarantine retention cap', () => {
  it('[P44] caps only plan-row-rejected tickets oldest-first, exempts orphan-temp-row, and counts each eviction', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    diagnostics().reset();
    for (let index = 0; index < 3; index += 1) {
      putQuarantine({ kind: 'row', model: 'SpecQuarantineCap', id: `orphan-${index}`, raw: { id: `orphan-${index}` }, reason: 'orphan-temp-row' });
    }
    for (let index = 0; index < 102; index += 1) {
      putQuarantine({ kind: 'row', model: 'SpecQuarantineCap', id: `diag-${index}`, raw: { id: `diag-${index}` }, reason: 'plan-row-rejected' });
    }

    const entries = readQuarantineEntries();
    const orphanTickets = entries.filter(entry => entry.reason === 'orphan-temp-row');
    const diagnosticTickets = entries.filter(entry => entry.reason === 'plan-row-rejected');
    expect(orphanTickets).toHaveLength(3);
    expect(diagnosticTickets).toHaveLength(100);
    // Oldest-first: diag-0 and diag-1 left, the survivors start at diag-2.
    expect(diagnosticTickets[0]!.id).toBe('diag-2');
    const evictions = diagnostics().snapshot().dataLossEvents.filter(event => event.mechanism === 'quarantine-evicted');
    expect(evictions).toEqual([
      { mechanism: 'quarantine-evicted', model: 'SpecQuarantineCap', count: 1 },
      { mechanism: 'quarantine-evicted', model: 'SpecQuarantineCap', count: 1 }
    ]);
  });
});
