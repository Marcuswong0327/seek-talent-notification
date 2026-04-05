"use strict";

const { ChromeLaunchStrategy } = require("./ChromeLaunchStrategy");
const { ChromeProfileCopier } = require("../ChromeProfileCopier");

/**
 * INHERITANCE: Specialized strategy — copy real Chrome profile to temp/persist dir
 * so existing SEEK sessions/cookies can be reused (when Chrome is closed for a full copy).
 */
class CopiedProfileChromeLaunchStrategy extends ChromeLaunchStrategy {
    /**
     * @param {boolean} headless
     * @param {string} runId
     */
    buildResolvedLaunch(headless, runId) {
        const copied = ChromeProfileCopier.copyProfileToTemp(runId);
        copied.launchOptions.headless = headless;
        return {
            launchOptions: copied.launchOptions,
            tempUserData: copied.tempUserData,
            launchContextUserDataDir: copied.tempUserData,
            browserMode:
                String(process.env.CHROME_COPIED_PROFILE_PERSIST || "").toLowerCase() === "true"
                    ? "persisted-copied-chrome-profile"
                    : "copied-chrome-profile",
            copiedFrom: copied.sourceProfileDir,
            profileName: copied.profileName,
            chromeProfileCopySkipped: copied.copySkipped ? copied.copySkipped.length : 0,
            profileCopyMs: copied.profileCopyMs ?? null,
        };
    }
}

module.exports = { CopiedProfileChromeLaunchStrategy };
