export declare const AGENT_SKILL_INSPECTION_LIMITS: Readonly<{
    archiveBytes: 65000000;
    entryBytes: 32000000;
    totalBytes: 64000000;
    entries: number;
}>;
/** Bounded offline consistency inspection. Never extract, import code, open state or authenticate a publisher. */
export declare function inspectAgentSkillZip(input: Uint8Array, expectedSha256?: string): Promise<{
    status: string;
    format: "jevable.ai/agent-skill-zip";
    version: "0.1.0-alpha.1";
    artifact: {
        bytes: number;
        sha256: string;
    };
    expectedChecksum: string;
    root: "jevable";
    entrypoint: "bin/jevable.mjs";
    files: number;
    runtimes: {
        role: "sqlite" | "postgres" | "management" | "sqlite-coordinated";
        sha256: string;
        bytes: number;
    }[];
    authenticity: string;
    privateDataAttestation: string;
    extraction: string;
    installation: string;
    execution: string;
    network: string;
    state: string;
    rateCoordinator?: "postgres";
    schemaVersion: 1 | 2;
}>;
