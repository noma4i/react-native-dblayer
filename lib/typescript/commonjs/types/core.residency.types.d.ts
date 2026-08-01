/** How many entries one named internal collection is holding right now. */
export type ResidencyGauge = {
    name: string;
    size: () => number;
};
/** Resident entry count per named collection, summed across every instance registered under that name. */
export type ResidencySnapshot = Record<string, number>;
//# sourceMappingURL=core.residency.types.d.ts.map