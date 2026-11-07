/** Serialized metadata-only admission hint. Only the runtime can prove a saved response exists and settle it. */
export function previewRecoveryTarget(preview, run) {
    const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
    if (!preview?.revision || preview.validation?.status !== 'valid' || run?.revision !== preview.revision
        || run.status !== 'executing' || run.cancellation || !uuid(run.id) || !uuid(run.attemptId)
        || typeof run.checkpointSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(run.checkpointSha256))
        return null;
    const root = preview.graphs[0];
    let graph = root;
    if (run.scope !== undefined) {
        if (!run.scope || !Number.isSafeInteger(run.scope.index) || run.scope.index < 0 || typeof run.scope.loop !== 'string')
            return null;
        const loop = root?.nodes.find(node => node.id === run.scope.loop);
        if (loop?.node.type !== 'loop' || !loop.bodyScope)
            return null;
        graph = preview.graphs.find(item => item.scope === loop.bodyScope);
    }
    const node = graph?.nodes.find(item => item.id === run.nodeId);
    if (!node || !['llm', 'decision'].includes(node.node.type))
        return null;
    return { id: run.id, attemptId: run.attemptId, checkpointSha256: run.checkpointSha256,
        identity: JSON.stringify([run.id, run.revision, run.attemptId, run.checkpointSha256, graph.scope, run.scope?.index ?? null]),
        label: `${node.id}${run.scope ? ` · loop ${run.scope.loop}, iteration ${run.scope.index} (zero-based)` : ''}` };
}
