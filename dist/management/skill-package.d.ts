import { type RuntimeArchiveOptions } from './package.ts';
export { AGENT_SKILL_RESOURCES } from './skill-resources.ts';
export declare const AGENT_SKILL_PACKAGE_LIMITS: Readonly<{
    resourceBytes: 4000000;
    totalBytes: 64000000;
}>;
/** Package-owned assets only, including ancestors; never follow a linked resource or fall back. */
declare function readOwnedAsset(path: string, limit: number): Promise<Buffer<ArrayBufferLike>>;
/** Offline distributable agent instructions plus the owned CLI; not a workflow release or image.
 * The optional reader is trusted SDK dependency injection, not an untrusted path/configuration input.
 */
export declare function createAgentSkillZip(readBytes?: typeof readOwnedAsset, options?: RuntimeArchiveOptions): Promise<{
    bytes: Buffer<ArrayBuffer>;
    manifest: {
        format: string;
        version: string;
        root: string;
        skill: {
            name: string;
            instructions: string;
        };
        entrypoint: string;
        requires: {
            node: string;
            sqlite: string;
            npmInstall: boolean;
            docker: boolean;
        } | {
            node: string;
            sqlite: string;
            npmInstall: boolean;
            docker: boolean;
        };
        runtimes: {
            role: string;
            sha256: string;
            bytes: number;
        }[];
        runtimeManifest: string;
        files: {
            path: string;
            bytes: number;
            sha256: string;
        }[];
        state: string;
        credentials: string;
        developerArtifacts: string;
        installation: string;
        authenticity: string;
        execution: string;
        rateCoordinator?: "postgres";
        schemaVersion: 1 | 2;
    };
}>;
