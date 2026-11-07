/** Only bounded categories cross the exporter boundary; never collector text or credentials. */
export declare class ExportFailure extends Error {
    readonly category: 'transport' | 'response' | 'serialization';
    constructor(category: 'transport' | 'response' | 'serialization');
}
