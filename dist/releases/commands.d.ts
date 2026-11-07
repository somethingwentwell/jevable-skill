/** Shared exported-app grammar. It is not the authoring/management CLI. */
interface ReleaseCommand {
    strings: string[];
    booleans?: string[];
    positional?: string;
    required?: string[];
    description: string;
}
export declare const releaseAppCommands: Record<string, ReleaseCommand>;
export declare function releaseCommandStrings(command: string, storage: 'sqlite' | 'postgres', rateCoordinator?: 'postgres'): string[];
export declare function releaseCommandReference(storage: 'sqlite' | 'postgres', rateCoordinator?: 'postgres'): string;
export {};
