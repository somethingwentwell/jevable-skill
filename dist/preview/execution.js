/** Pure metadata projection, also serialized for the live page. No imports, execution, payloads or guessed ports. */
export function projectPreviewExecution(preview, value) {
    const object = (item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            throw Error('Invalid execution receipt metadata.');
        return item;
    };
    const uuid = (item) => typeof item === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(item);
    const integer = (item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
    const run = object(value);
    if (!uuid(run.id) || !preview.revision || run.revision !== preview.revision || preview.validation.status !== 'valid'
        || !['paused', 'waiting', 'executing', 'completed', 'failed', 'cancelled'].includes(String(run.status))
        || !Array.isArray(run.steps) || run.steps.length > 50000)
        throw Error('Execution receipt does not match this admitted preview.');
    const graphs = preview.graphs.map(graph => ({ scope: graph.scope,
        nodes: graph.nodes.map(node => ({ id: node.id, status: 'unobserved', count: 0, iterations: [], recordedDurationMs: 0,
            timedRecords: 0, records: [], omittedRecords: 0 })),
        edges: graph.edges.map((_edge, index) => ({ index, status: 'unobserved', count: 0, selectedCount: 0 })),
        exits: graph.exits.map((_exit, index) => ({ index, selectedCount: 0 })) }));
    const roots = preview.graphs[0], root = graphs[0];
    const byScope = new Map(graphs.map(graph => [graph.scope, graph]));
    const definitions = new Map(preview.graphs.map(graph => [graph.scope, graph]));
    const byNode = new Map(graphs.map(graph => [graph.scope, new Map(graph.nodes.map(node => [node.id, node]))]));
    const connections = new Map(preview.graphs.map(graph => {
        const pairs = new Map();
        graph.edges.forEach((edge, index) => { const key = JSON.stringify([edge.from, edge.to]); pairs.set(key, [...pairs.get(key) ?? [], index]); });
        return [graph.scope, pairs];
    }));
    const iterations = new Map();
    const previous = new Map();
    let ambiguousConnections = 0;
    const locate = (item, checkpoint = false) => {
        if (typeof item.nodeId !== 'string')
            throw Error('Missing execution node identity.');
        if (item.scope === undefined) {
            const node = byNode.get(root.scope).get(item.nodeId);
            if (!node)
                throw Error('Execution refers to an unknown workflow node.');
            return { node, scope: root.scope, iteration: undefined, loop: undefined, bookkeeping: false };
        }
        const scope = object(item.scope);
        if (typeof scope.loop !== 'string' || !integer(scope.index))
            throw Error('Invalid loop execution scope.');
        const loop = roots.nodes.find(node => node.id === scope.loop && node.bodyScope);
        if (!loop?.bodyScope || !byScope.has(loop.bodyScope))
            throw Error('Execution refers to an unknown loop scope.');
        // Loop iteration-result records have no attempt; do not count them as an extra body dispatch.
        const bookkeeping = !checkpoint && item.nodeId === scope.loop && item.attemptId === undefined;
        // Older receipts without attempts cannot distinguish a colliding body ID from a loop return.
        if (bookkeeping && byNode.get(loop.bodyScope).has(item.nodeId))
            throw Error('Ambiguous legacy loop result identity.');
        const node = bookkeeping ? byNode.get(root.scope).get(loop.id) : byNode.get(loop.bodyScope).get(item.nodeId);
        if (!node)
            throw Error('Execution refers to an unknown loop node.');
        return { node, scope: bookkeeping ? root.scope : loop.bodyScope, iteration: scope.index, loop: loop.id, bookkeeping };
    };
    const recordMetadata = (item, index, iteration) => {
        const record = { index, ...(iteration === undefined ? {} : { iteration }) };
        if (item.port !== undefined) {
            if (typeof item.port !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(item.port))
                throw Error('Invalid recorded port.');
            record.port = item.port;
        }
        if (item.attemptId !== undefined) {
            if (!uuid(item.attemptId))
                throw Error('Invalid attempt identity.');
            record.attemptId = item.attemptId;
        }
        if (item.startedAt !== undefined) {
            if (typeof item.startedAt !== 'string' || !Number.isFinite(Date.parse(item.startedAt)))
                throw Error('Invalid recorded time.');
            record.startedAt = item.startedAt;
        }
        if (item.durationMs !== undefined) {
            if (!integer(item.durationMs))
                throw Error('Invalid recorded duration.');
            record.durationMs = item.durationMs;
        }
        if (item.modelUsage !== undefined) {
            const usage = object(item.modelUsage);
            if (!integer(usage.tries) || usage.tries === 0
                || (usage.inputTokens !== undefined && !integer(usage.inputTokens)) || (usage.outputTokens !== undefined && !integer(usage.outputTokens)))
                throw Error('Invalid recorded model usage.');
            record.modelUsage = { tries: usage.tries,
                ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
                ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }) };
        }
        if (item.trace !== undefined) {
            const trace = object(item.trace);
            if (typeof trace.traceId !== 'string' || !/^(?!0{32}$)[a-f0-9]{32}$/.test(trace.traceId)
                || typeof trace.spanId !== 'string' || !/^(?!0{16}$)[a-f0-9]{16}$/.test(trace.spanId) || ![0, 1].includes(trace.traceFlags))
                throw Error('Invalid recorded trace identity.');
            record.trace = { traceId: trace.traceId, spanId: trace.spanId, traceFlags: trace.traceFlags };
        }
        return record;
    };
    const visit = (scope, node, iteration, port) => {
        const prior = previous.get(scope);
        if (prior && prior.node !== node && prior.iteration === iteration) {
            const target = byScope.get(scope);
            const matches = (connections.get(scope).get(JSON.stringify([prior.node, node])) ?? [])
                .filter(index => prior.port === undefined || (definitions.get(scope).edges[index].port ?? 'next') === prior.port);
            if (matches.length > 1)
                ambiguousConnections++;
            for (const index of matches) {
                const edge = target.edges[index];
                if (edge.selectedCount === 0)
                    edge.status = matches.length === 1 ? 'observed' : 'ambiguous';
                edge.count++;
            }
        }
        const selected = port ?? (prior?.node === node && prior.iteration === iteration ? prior.port : undefined);
        previous.set(scope, { node, ...(iteration === undefined ? {} : { iteration }), ...(selected === undefined ? {} : { port: selected }) });
    };
    for (const [index, raw] of run.steps.entries()) {
        const item = object(raw), location = locate(item), { node, iteration } = location;
        const record = recordMetadata(item, index, iteration);
        if (record.port !== undefined) {
            const graph = definitions.get(location.scope), target = byScope.get(location.scope);
            const edges = graph.edges.flatMap((edge, i) => edge.from === node.id && (edge.port ?? 'next') === record.port ? [i] : []);
            const exits = graph.exits.flatMap((exit, i) => exit.from === node.id && (exit.port ?? 'next') === record.port ? [i] : []);
            if (location.bookkeeping || edges.length + exits.length !== 1)
                throw Error('Recorded port does not identify one outgoing route.');
            for (const i of edges) {
                target.edges[i].selectedCount++;
                target.edges[i].status = 'selected';
            }
            for (const i of exits)
                target.exits[i].selectedCount++;
        }
        node.count++;
        node.status = 'settled';
        if (iteration !== undefined) {
            const set = iterations.get(node) ?? new Set();
            set.add(iteration);
            iterations.set(node, set);
        }
        if (record.durationMs !== undefined) {
            node.recordedDurationMs += record.durationMs;
            node.timedRecords++;
            if (!Number.isSafeInteger(node.recordedDurationMs))
                throw Error('Recorded duration exceeds the safe integer range.');
        }
        node.records.push(record);
        if (node.records.length > 200) {
            node.records.shift();
            node.omittedRecords++;
        }
        if (location.loop) {
            visit(root.scope, location.loop);
            if (!location.bookkeeping)
                visit(location.scope, node.id, iteration, record.port);
        }
        else
            visit(root.scope, node.id, undefined, record.port);
    }
    if (run.status !== 'completed') {
        const location = locate(run, true), node = location.node;
        node.status = run.status === 'paused' ? 'next' : run.status === 'waiting' ? 'waiting' : run.status === 'executing' ? 'unsettled'
            : run.status === 'failed' ? 'failed' : 'stopped';
        if (run.attemptId !== undefined) {
            if (!uuid(run.attemptId))
                throw Error('Invalid pending attempt identity.');
            node.attemptId = run.attemptId;
        }
        if (location.iteration !== undefined)
            node.currentIteration = location.iteration;
        if (typeof run.code === 'string' && /^[a-z-]{1,64}$/.test(run.code))
            node.code = run.code;
        if (location.loop) {
            const parent = byNode.get(root.scope).get(location.loop);
            parent.status = run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'stopped' : 'active-loop';
            parent.currentIteration = location.iteration;
            visit(root.scope, location.loop);
            if (!location.bookkeeping)
                visit(location.scope, node.id, location.iteration);
        }
        else
            visit(root.scope, node.id);
    }
    for (const [node, set] of iterations)
        node.iterations = [...set].sort((a, b) => a - b);
    const warning = run.status === 'executing' ? 'Intent recorded; outcome unsettled. No redispatch is implied.'
        : run.status === 'paused' ? 'Next checkpoint is not yet executed.' : run.status === 'waiting' ? 'Waiting for an explicit Human Approval decision.'
            : run.status === 'cancelled' ? 'Stopped checkpoint; external effects are not reverted and unsettled outcomes may be unknown.'
                : run.status === 'failed' ? 'Retained failure; inspect the recorded code and checkpoint.' : 'Retained workflow completion; not a test-assessment claim.';
    return { format: 'jevable.preview-execution/v1', runId: run.id, revision: preview.revision, status: String(run.status),
        recordedSteps: run.steps.length, ambiguousConnections, graphs,
        summary: `Run ${run.id} · ${run.status} · ${run.steps.length} recorded results. ${warning} Selected ports are recorded choices, not proof of target completion or successful loop return. Records without ports show adjacency only. ${ambiguousConnections} ambiguous connection observations.` };
}
