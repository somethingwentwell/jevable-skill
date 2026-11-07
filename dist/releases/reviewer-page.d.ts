/** The reviewer page is inert until a grant is entered. No owner credentials,
 * release source, review data, or bearer are included in the HTML or URL.
 */
export declare function renderReleaseReviewerPage(instanceId: string): {
    html: string;
    csp: string;
};
