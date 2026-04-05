"use strict";

/**
 * INHERITANCE: Base for any Playwright "screen" automation that needs a `page` handle.
 * Subclasses inherit `_page` and can add SEEK-specific flows.
 *
 * ENCAPSULATION: We keep the Playwright `page` reference in one place (`#page` is private).
 * ABSTRACTION: Future shared waits (e.g. `waitForNetworkIdle`) can live here once.
 */
class BasePageInteractor {
    /** @param {import('playwright').Page} page */
    constructor(page) {
        /** @private @readonly */
        this.#page = page;
    }

    /** @private */
    #page;

    /** @protected — subclasses read the active tab */
    get _page() {
        return this.#page;
    }
}

module.exports = { BasePageInteractor };
