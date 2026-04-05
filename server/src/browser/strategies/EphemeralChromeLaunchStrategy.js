"use strict";

const { ChromeLaunchStrategy } = require("./ChromeLaunchStrategy");

/**
 * INHERITANCE: Specialized strategy — fresh Chrome channel profile (no copied user data).
 * Use when env forces ephemeral or when source profile path is missing.
 */
class EphemeralChromeLaunchStrategy extends ChromeLaunchStrategy {
    /**
     * `channel` alone is not enough for Crawlee — Crawlee also sets `useChrome: true` on launchContext.
     * @param {boolean} headless
     * @param {string} [_runId] unused — kept for polymorphic signature match with copied-profile strategy
     */
    buildResolvedLaunch(headless, _runId) {
        const launchOptions = {
            headless,
            channel: "chrome",
            args: ["--start-maximized"],
        };
        return {
            launchOptions,
            tempUserData: null,
            launchContextUserDataDir: undefined,
            browserMode: "ephemeral-chrome",
            profileCopyMs: null,
        };
    }
}

module.exports = { EphemeralChromeLaunchStrategy };
