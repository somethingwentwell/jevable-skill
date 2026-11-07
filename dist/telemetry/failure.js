/** Only bounded categories cross the exporter boundary; never collector text or credentials. */
export class ExportFailure extends Error {
    category;
    constructor(category) {
        super(category);
        this.category = category;
    }
}
