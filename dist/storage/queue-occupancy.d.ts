/** Process-local occupancy only. No IDs, clocks, database reads or scheduling authority. */
export declare class QueueOccupancy {
    private waiting;
    private active;
    snapshot(): {
        waiting: number;
        active: number;
    };
    admit(): {
        begin: () => void;
        end: () => void;
    };
}
