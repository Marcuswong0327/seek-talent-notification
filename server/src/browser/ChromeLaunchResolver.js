"use strict";

const path = require("path");
const fs = require("fs");
const { EphemeralChromeLaunchStrategy } = require("./strategies/EphemeralChromeLaunchStrategy");
const { CopiedProfileChromeLaunchStrategy } = require("./strategies/CopiedProfileChromeLaunchStrategy");

/**
 * POLYMORPHISM: Picks a `ChromeLaunchStrategy` subclass at runtime from env + disk,
 * then delegates to `buildResolvedLaunch` — no giant if/else at the call site of Crawlee.
 *
 * ABSTRACTION: External code asks only "resolve Chrome for this run", not which strategy won.
 */
class ChromeLaunchResolver {
    /**
     * @param {boolean} headless
     * @param {string} runId
     */
    static resolve(headless, runId) {
        const explicitEphemeral = String(process.env.CHROME_USE_EPHEMERAL || "").toLowerCase() === "true";
        const explicitNoCopy = String(process.env.CHROME_USE_COPIED_PROFILE || "").toLowerCase() === "false";
        const explicitRealProfile = String(process.env.CHROME_USE_REAL_PROFILE || "").toLowerCase() === "true";

        const profileName = process.env.CHROME_PROFILE_DIRECTORY || "Default";
        const userDataRoot =
            process.env.CHROME_USER_DATA_DIR ||
            path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
        const sourceProfileDir = path.join(userDataRoot, profileName);

        let useCopy = !explicitEphemeral && !explicitNoCopy;
        if (explicitRealProfile && !explicitEphemeral) {
            useCopy = true;
        }
        if (useCopy && !fs.existsSync(sourceProfileDir)) {
            console.warn(
                `[chrome] profile folder missing (${sourceProfileDir}); falling back to ephemeral Chrome. Set CHROME_USER_DATA_DIR / CHROME_PROFILE_DIRECTORY or CHROME_USE_EPHEMERAL=true.`,
            );
            useCopy = false;
        }

        const strategy = useCopy
            ? new CopiedProfileChromeLaunchStrategy()
            : new EphemeralChromeLaunchStrategy();

        return strategy.buildResolvedLaunch(headless, runId);
    }
}

module.exports = { ChromeLaunchResolver };
