"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

/**
 * ENCAPSULATION: All filesystem work for copying a Chrome user-data subtree
 * lives here so launch strategies do not touch `fs` directly.
 * ABSTRACTION: "Copy profile best-effort" — callers get structured result + skip list.
 */
class ChromeProfileCopier {
    /**
     * @private
     * @param {string} srcDir
     * @param {string} destDir
     * @param {{ path: string, err: string }[]} skipped
     */
    static #copyDirBestEffort(srcDir, destDir, skipped) {
        fs.mkdirSync(destDir, { recursive: true });
        let entries;
        try {
            entries = fs.readdirSync(srcDir, { withFileTypes: true });
        } catch (err) {
            skipped.push({ path: srcDir, err: String(err && err.message ? err.message : err) });
            return;
        }
        for (const ent of entries) {
            const from = path.join(srcDir, ent.name);
            const to = path.join(destDir, ent.name);
            try {
                if (ent.isDirectory()) {
                    ChromeProfileCopier.#copyDirBestEffort(from, to, skipped);
                } else {
                    fs.copyFileSync(from, to);
                }
            } catch (err) {
                skipped.push({ path: from, err: String(err && err.message ? err.message : err) });
            }
        }
    }

    /**
     * Copy Chrome profile to temp (or persistent dir) for Playwright persistent context.
     * @param {string} runId
     * @returns {{
     *   tempUserData: string,
     *   launchOptions: object,
     *   profileName: string,
     *   sourceProfileDir: string,
     *   copySkipped: { path: string, err: string }[],
     *   profileCopyMs: number
     * }}
     */
    static copyProfileToTemp(runId) {
        const copyStartedAt = Date.now();
        const profileName = process.env.CHROME_PROFILE_DIRECTORY || "Default";
        const userDataRoot =
            process.env.CHROME_USER_DATA_DIR ||
            path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
        const sourceProfileDir = path.join(userDataRoot, profileName);
        if (!fs.existsSync(sourceProfileDir)) {
            throw new Error(`Chrome profile not found: ${sourceProfileDir}`);
        }

        const persistEnabled = String(process.env.CHROME_COPIED_PROFILE_PERSIST || "").toLowerCase() === "true";
        const persistDir =
            process.env.CHROME_COPIED_PROFILE_PERSIST_DIR ||
            path.join(os.tmpdir(), "seek-talent-chrome-persist");
        const refreshFromSource =
            String(process.env.CHROME_COPIED_PROFILE_REFRESH_FROM_SOURCE || "").toLowerCase() === "true";

        const tempUserData = persistEnabled ? persistDir : path.join(os.tmpdir(), `seek-talent-chrome-${runId}`);
        const destProfileDir = path.join(tempUserData, profileName);
        fs.mkdirSync(tempUserData, { recursive: true });

        const skipped = [];
        if (!persistEnabled || refreshFromSource || !fs.existsSync(destProfileDir)) {
            if (persistEnabled && refreshFromSource && fs.existsSync(destProfileDir)) {
                fs.rmSync(destProfileDir, { recursive: true, force: true });
            }
            ChromeProfileCopier.#copyDirBestEffort(sourceProfileDir, destProfileDir, skipped);
        }
        if (skipped.length) {
            const sample = skipped
                .slice(0, 5)
                .map((s) => `${s.path}: ${s.err}`)
                .join("; ");
            const hint =
                skipped.length > 5
                    ? ` (${skipped.length} total; close Chrome for a complete copy)`
                    : " (close Chrome for a complete copy)";
            console.warn(`[chrome profile copy] skipped ${skipped.length} path(s): ${sample}${hint}`);
        }

        const executablePath = process.env.CHROME_EXECUTABLE_PATH || "";
        const launchOptions = {
            headless: false,
            args: [`--profile-directory=${profileName}`, "--start-maximized"],
            slowMo: Number(process.env.CHROME_SLOW_MO || 200),
        };
        if (executablePath && fs.existsSync(executablePath)) {
            launchOptions.executablePath = executablePath;
        } else {
            launchOptions.channel = "chrome";
        }

        return {
            tempUserData,
            launchOptions,
            profileName,
            sourceProfileDir,
            copySkipped: skipped,
            profileCopyMs: Date.now() - copyStartedAt,
        };
    }
}

module.exports = { ChromeProfileCopier };
