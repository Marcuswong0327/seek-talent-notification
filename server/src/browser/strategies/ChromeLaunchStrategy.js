"use strict";

/**
 * INHERITANCE: Concrete strategies extend this class and override `buildResolvedLaunch`.
 * POLYMORPHISM: `ChromeLaunchResolver` calls `buildResolvedLaunch` on whichever subclass
 * was chosen — same message, different Chrome launch configuration.
 *
 * ABSTRACTION: Callers of the resolver only care about the unified "resolved launch" shape,
 * not whether we used ephemeral or copied profile.
 */
class ChromeLaunchStrategy {
    /**
     * @param {boolean} headless
     * @param {string} runId
     * @returns {object} Resolved launch DTO for Crawlee `launchContext`
     */
    // eslint-disable-next-line no-unused-vars
    buildResolvedLaunch(headless, runId) {
        throw new Error(`${this.constructor.name}: buildResolvedLaunch() must be implemented by subclass`);
    }
}

module.exports = { ChromeLaunchStrategy };
