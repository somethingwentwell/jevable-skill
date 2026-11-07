/** Process-local occupancy only. No IDs, clocks, database reads or scheduling authority. */
export class QueueOccupancy {
    waiting = 0;
    active = 0;
    snapshot() { return { waiting: this.waiting, active: this.active }; }
    admit() {
        this.waiting++;
        let state = 'waiting';
        return {
            begin: () => {
                if (state !== 'waiting')
                    return;
                this.waiting--;
                this.active++;
                state = 'active';
            },
            end: () => {
                if (state === 'waiting')
                    this.waiting--;
                if (state === 'active')
                    this.active--;
                state = 'ended';
            },
        };
    }
}
