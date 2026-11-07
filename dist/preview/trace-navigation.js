import { prepareEvidenceDownload } from "./evidence-download.js";
import { traceNavigationTools } from "../telemetry/navigation.js";
/** Verifies a metadata-only runtime envelope, then prepares links without contacting or opening their destination. */
export async function prepareTraceNavigation(expected, evidence, destination) {
    const tools = traceNavigationTools(), config = destination === undefined ? undefined : tools.config(destination);
    const artifact = await prepareEvidenceDownload(expected, evidence);
    return { ...tools.project(JSON.parse(artifact.contents).snapshot, config), snapshotSha256: artifact.snapshotSha256 };
}
