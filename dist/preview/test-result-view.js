/** Pure browser-safe presentation of an already-authorized retained assessment.
 * No result evaluation, workflow control, private-value reconstruction or IO. */
export function projectPreviewTestResult(value, target) {
    const invalid = () => { throw Error('Test result does not match the selected run, revision or inspection mode. Inspect retained state explicitly.'); };
    const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
    const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
    const identity = (value) => value && uuid(value.id) && integer(value.generation) && value.generation > 0 && hash(value.sha256);
    const same = (a, b) => identity(a) && identity(b) && a.id === b.id && a.generation === b.generation && a.sha256 === b.sha256;
    if (!target || !uuid(target.runId) || !hash(target.revision) || typeof target.inspect !== 'boolean'
        || (target.test !== undefined && !identity(target.test)))
        return invalid();
    let report;
    try {
        const encoded = JSON.stringify(value);
        if (!encoded || encoded.length > 20000000 || new TextEncoder().encode(encoded).byteLength > 20000000)
            return invalid();
        report = JSON.parse(encoded);
    }
    catch {
        return invalid();
    }
    const outcomes = { completed: 'Finished successfully', waiting: "Waiting for a person's approval",
        paused: 'Paused', executing: 'Execution outcome is unsettled', failed: 'Reported a failure', cancelled: 'Stopped after cancellation' };
    if (!report || report.schemaVersion !== 1 || report.evidence !== 'retained-run'
        || report.privateInspection !== target.inspect || report.run?.id !== target.runId || report.run?.revision !== target.revision
        || !same(report.test, report.run.test) || (target.test !== undefined && !same(report.test, target.test))
        || !hash(report.run.checkpointSha256) || report.run.status !== report.workflowStatus
        || !Object.hasOwn(outcomes, report.workflowStatus) || report.observedRunUpdatedAt !== report.run.updatedAt
        || typeof report.observedRunUpdatedAt !== 'string' || !Number.isFinite(Date.parse(report.observedRunUpdatedAt))
        || !['passed', 'failed', 'pending', 'uncertain'].includes(report.assessment)
        || typeof report.terminal !== 'boolean' || report.terminal !== ['completed', 'failed', 'cancelled'].includes(report.workflowStatus)
        || !Array.isArray(report.checks) || report.checks.length < 1 || report.checks.length > 64)
        return invalid();
    const allMatched = report.checks.every((check) => check?.matched === true && check.available === true);
    if ((report.terminal && !['passed', 'failed'].includes(report.assessment))
        || (report.workflowStatus === 'executing' && report.assessment !== 'uncertain')
        || (report.workflowStatus === 'paused' && report.assessment !== 'pending')
        || (report.assessment === 'passed' && !allMatched) || (report.assessment === 'failed' && allMatched))
        return invalid();
    const node = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value);
    const names = { status: 'Workflow outcome', 'output-equals': 'Final result', 'failure-code': 'Reported failure',
        'node-visited': 'Step reached', 'node-output-equals': 'Step result', 'node-port-equals': 'Branch chosen' };
    let statuses = 0;
    const checks = report.checks.map((check, index) => {
        if (!check || check.index !== index || !Object.hasOwn(names, check.kind) || typeof check.matched !== 'boolean'
            || typeof check.available !== 'boolean' || (check.matched && !check.available))
            return invalid();
        const scoped = check.kind.startsWith('node-');
        if (scoped ? !node(check.nodeId) : check.nodeId !== undefined || check.scope !== undefined)
            return invalid();
        if (check.scope !== undefined && (!check.scope || !node(check.scope.loop) || !integer(check.scope.index, 1000000)))
            return invalid();
        if (check.kind === 'status') {
            statuses++;
            if (!check.available)
                return invalid();
        }
        let label = names[check.kind];
        if (scoped)
            label += `: ${check.nodeId}${check.scope ? ` (loop ${check.scope.loop}, iteration ${check.scope.index + 1})` : ''}`;
        // Metadata-only receipts never grant access to unexpected host-supplied value fields.
        if (!target.inspect)
            return { label, outcome: !check.available ? 'Not recorded' : check.matched ? 'Matches' : 'Does not match',
                expected: 'Private value not inspected', actual: check.available ? 'Private value not inspected' : 'Not recorded', excerpt: false };
        if (!Object.hasOwn(check, 'expected'))
            return invalid();
        if (check.kind === 'status' && (!['completed', 'waiting', 'failed', 'cancelled'].includes(check.expected)
            || check.actual !== report.workflowStatus || check.matched !== (check.actual === check.expected)))
            return invalid();
        if (check.kind === 'node-visited' && (check.expected !== true || typeof check.actual !== 'boolean' || !check.available
            || check.matched !== check.actual))
            return invalid();
        if (check.kind === 'node-port-equals' && (!node(check.expected) || (check.available && !node(check.actual))))
            return invalid();
        const text = (present, value) => {
            if (!present)
                return { text: 'Value not included in this receipt', excerpt: false };
            let text = typeof value === 'string' ? value === '' ? '(empty text)' : value : JSON.stringify(value, null, 2);
            if (typeof text !== 'string')
                return invalid();
            if (check.kind === 'status' && typeof value === 'string' && Object.hasOwn(outcomes, value))
                text = outcomes[value];
            return { text: text.length > 4000 ? text.slice(0, 4000) + '\n[Excerpt: value continues in the advanced receipt]' : text, excerpt: text.length > 4000 };
        };
        const expected = text(true, check.expected), actual = check.available
            ? text(Object.hasOwn(check, 'actual'), check.actual) : { text: 'Not recorded', excerpt: false };
        return { label, outcome: !check.available ? 'Not recorded' : check.matched ? 'Matches' : 'Does not match',
            expected: expected.text, actual: actual.text, excerpt: expected.excerpt || actual.excerpt };
    });
    if (statuses !== 1)
        return invalid();
    const heading = { passed: 'Test expectations matched', failed: 'Test expectations did not match', pending: 'Test not finished',
        uncertain: 'Test outcome needs inspection' }[report.assessment];
    const explanation = report.terminal
        ? 'This workflow has stopped. Matching expectations does not prove model quality or external effects; a test may intentionally expect failure or cancellation.'
        : report.workflowStatus === 'waiting'
            ? 'The workflow is still waiting for approval. A matching wait expectation does not approve the request or mean the workflow finished.'
            : report.workflowStatus === 'paused' ? 'The workflow is paused. Inspection does not continue it. Choose an explicit control separately when ready.'
                : 'The recorded outcome is unsettled. Inspection does not retry, recover or start another run.';
    const context = `Results for saved test version ${report.test.generation} · run ${report.run.id.slice(0, 8)}. These results belong to the version that ran, not to unsaved changes or a newer test version.`;
    return { heading, explanation: `${context} ${explanation}`, workflow: outcomes[report.workflowStatus], inspected: target.inspect, checks };
}
