export declare const releaseMark = "<svg viewBox=\"0 0 40 40\" width=\"32\" height=\"32\" aria-hidden=\"true\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"3.9\" y=\"3.9\" width=\"32.2\" height=\"32.2\" rx=\"7.3\" fill=\"#111827\"/><g stroke=\"#fff\" stroke-width=\"3\" stroke-linecap=\"round\" transform=\"translate(3.9 3.9) scale(.805)\"><circle cx=\"26\" cy=\"10.5\" r=\"3\"/><path d=\"M26 13.5V23a7 7 0 0 1-7 7h-3\"/><circle cx=\"13\" cy=\"30\" r=\"3\"/></g></svg>";
/** Browser code is serialized into the immutable release bundle. It uses only
 * same-origin, bearer-authenticated exact-release operations; opening is inert.
 */
export declare function releaseBrowser(): void;
/** Inert public shell: no release source, run, token or account data is embedded.
 * Authenticated browser requests are same-origin and explicit user actions only.
 */
export declare function renderReleasePage(reviewerDecisions?: boolean): {
    html: string;
    csp: string;
};
