/** Process-local HTTP capacity observation only; never dispatches, cancels or reads a run. */
export function observeAsyncSlot(change) {
    let phase = 'admitting', ended = false;
    const record = (stage, delta) => {
        try {
            change(stage, delta);
        }
        catch { /* Diagnostics must not change slot ownership or workflow results. */ }
    };
    record(phase, 1);
    return {
        admitted() {
            if (ended || phase === 'completing')
                return;
            record(phase, -1);
            phase = 'completing';
            record(phase, 1);
        },
        end() {
            if (ended)
                return;
            ended = true;
            record(phase, -1);
        },
    };
}
