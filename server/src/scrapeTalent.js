"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { randomUUID } = require("crypto");
const { PlaywrightCrawler, Configuration, MemoryStorage } = require("crawlee");

const NATION_ID_MAP = { AU: "3000", MY: "3005" };
const SORT_BY_DATE_UPDATED = "dateUpdated";

const AU_LOCATION_LIST_MAP = {
    "new-south-wales": "3101",
    nsw: "3101",
    victoria: "3106",
    vic: "3106",
    melbourne: "3106",
    queensland: "3115",
    qld: "3115",
    brisbane: "3115",
    "south-australia": "3118",
    adelaide: "3118",
    "western-australia": "3122",
    perth: "3122",
    tasmania: "3127",
    hobart: "3127",
    "australian-capital-territory": "3130",
    canberra: "3130",
    "northern-territory": "3135",
    darwin: "3135",
};

const MY_LOCATION_LIST_MAP = {
    kl: "5002",
    "kuala-lumpur": "5002",
    selangor: "5004",
    penang: "5006",
    johor: "5008",
};

function slugifyLocation(location) {
    if (!location) return "";
    return String(location)
        .trim()
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

function resolveLocationList(nation, locationSlug) {
    if (!locationSlug) return "";
    const slug = slugifyLocation(locationSlug);

    if (nation === "AU") {
        return AU_LOCATION_LIST_MAP[slug] || "";
    }
    if (nation === "MY") {
        return MY_LOCATION_LIST_MAP[slug] || "";
    }

    return "";
}

function buildSeekTalentUrl({
    searchTitle,
    nation = "AU",
    locationSlug,
    sortBy = SORT_BY_DATE_UPDATED,
    pageNumber = 1,
}) {
    if (!searchTitle || !String(searchTitle).trim()) {
        throw new Error("searchTitle is required");
    }

    const normalizedNation = String(nation).toUpperCase();
    const nationId = NATION_ID_MAP[normalizedNation];
    if (!nationId) {
        throw new Error("nation must be AU or MY");
    }

    const normalizedLocationSlug = slugifyLocation(locationSlug);
    const locationList = resolveLocationList(normalizedNation, normalizedLocationSlug);
    const sortValue = sortBy || SORT_BY_DATE_UPDATED;
    const params = new URLSearchParams({
        nation: nationId,
        salaryNation: nationId,
        salaryType: "ANNUAL",
        pageNumber: String(pageNumber),
        sortBy: sortValue,
        uncoupledFreeText: `"${String(searchTitle).trim()}"`,
        searchType: "new_search",
        willingToRelocate: "false",
    });

    if (normalizedLocationSlug) {
        params.set("locationSlug", normalizedLocationSlug);
    }

    if (locationList) {
        params.set("locationList", locationList);
    }

    return `https://talent.seek.com.au/talentsearch/search/profiles?${params.toString()}`;
}

function normalizeText(value) {
    if (value == null) return "";
    return String(value).replace(/\s+/g, " ").trim();
}

/**
 * Default: copy your real Chrome profile into a temp dir and launch that (same idea as Crawlee’s Python example).
 * Ephemeral / “guest” Chrome only when you opt out (see env below).
 *
 * Env:
 * - CHROME_USE_EPHEMERAL=true — fresh profile each run (no copy)
 * - CHROME_USE_COPIED_PROFILE=false — opt out of copy (ephemeral)
 * - CHROME_USE_REAL_PROFILE=true — alias: use copied User Data profile (overrides CHROME_USE_COPIED_PROFILE=false)
 * - CHROME_USER_DATA_DIR — parent "User Data" folder (default: %LOCALAPPDATA%\\Google\\Chrome\\User Data)
 * - CHROME_PROFILE_DIRECTORY — folder name inside User Data, e.g. Default, Profile 2
 * - CHROME_EXECUTABLE_PATH — optional path to chrome.exe
 * Close Chrome before runs for a full copy (otherwise some DB files are skipped as locked).
 */
function buildEphemeralChromeLaunch(headless) {
    /** `channel` alone is not enough for Crawlee — it must also set `useChrome: true` on launchContext. */
    return {
        headless,
        channel: "chrome",
        args: ["--start-maximized"],
    };
}

/**
 * Copy profile tree; skip locked files.
 *
 * Important:
 * - Chrome locks parts of its profile while running, so a full copy is only guaranteed when Chrome is fully quit.
 * - If you want to reduce MFA re-prompts across runs, enable a persistent copied profile (see env vars below)
 *   so auth updates made during a successful run are kept.
 *
 * Env (optional):
 * - CHROME_COPIED_PROFILE_PERSIST=true — keep the copied profile directory across runs
 * - CHROME_COPIED_PROFILE_PERSIST_DIR — fixed temp dir path (defaults to %TEMP%/seek-talent-chrome-persist)
 * - CHROME_COPIED_PROFILE_REFRESH_FROM_SOURCE=true — force re-copy from source even if persist dir already exists
 */
function copyDirBestEffort(srcDir, destDir, skipped) {
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
                copyDirBestEffort(from, to, skipped);
            } else {
                fs.copyFileSync(from, to);
            }
        } catch (err) {
            skipped.push({ path: from, err: String(err && err.message ? err.message : err) });
        }
    }
}

function copyChromeProfileToTemp(runId) {
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

    // If persist is enabled we keep a fixed profile dir across runs to preserve auth updates (trusted device, etc.).
    const tempUserData = persistEnabled ? persistDir : path.join(os.tmpdir(), `seek-talent-chrome-${runId}`);
    const destProfileDir = path.join(tempUserData, profileName);
    fs.mkdirSync(tempUserData, { recursive: true });

    const skipped = [];
    if (!persistEnabled || refreshFromSource || !fs.existsSync(destProfileDir)) {
        if (persistEnabled && refreshFromSource && fs.existsSync(destProfileDir)) {
            fs.rmSync(destProfileDir, { recursive: true, force: true });
        }
        copyDirBestEffort(sourceProfileDir, destProfileDir, skipped);
    } else {
        // Keep existing persistent auth state and avoid overwriting it.
        // (Overwriting can re-trigger step-up because SEEK may treat the "new" state as untrusted.)
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
    /** userDataDir is passed via Crawlee launchContext (Playwright launchPersistentContext), not --user-data-dir. */
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

function resolveChromeLaunch(headless, runId) {
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

    if (!useCopy) {
        return {
            launchOptions: buildEphemeralChromeLaunch(headless),
            tempUserData: null,
            launchContextUserDataDir: undefined,
            browserMode: "ephemeral-chrome",
            profileCopyMs: null,
        };
    }
    const copied = copyChromeProfileToTemp(runId);
    copied.launchOptions.headless = headless;
    return {
        launchOptions: copied.launchOptions,
        tempUserData: copied.tempUserData,
        /** Same folder that contains the profile subdirectory (e.g. …/Default). */
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

/** Close autocomplete, drawers, and the right-hand candidate preview (Escape is SEEK’s usual dismiss). */
async function dismissSeekOverlays(page) {
    for (let i = 0; i < 3; i += 1) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(120);
    }
}

async function warmUpLazyCards(page) {
    const scrollRounds = 5;
    for (let i = 0; i < scrollRounds; i += 1) {
        await page.evaluate(() => {
            window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
        });
        await page.waitForTimeout(400);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
}

async function forceDateUpdatedSort(page) {
    const isDateUpdatedActive = async () => {
        const bodyText = await page.locator("body").innerText().catch(() => "");
        if (/sorted by\s*date updated/i.test(String(bodyText || ""))) return true;
        const sortControl = page
            .locator("button, [role='button'], [role='combobox']")
            .filter({ hasText: /sorted by\s*date updated|date updated/i })
            .first();
        if (await sortControl.count().catch(() => 0)) {
            if (await sortControl.isVisible().catch(() => false)) return true;
        }
        const texts = await page
            .locator("button, [role='button'], span, div")
            .allTextContents()
            .catch(() => []);
        const merged = texts.join(" | ");
        return /sorted by\s*date updated|date updated\s*$/i.test(merged);
    };

    if (await isDateUpdatedActive()) return true;

    const relevanceTriggers = [
        page.getByText(/sorted by\s*relevance/i).first(),
        page.getByRole("button", { name: /relevance/i }).first(),
        page.locator("button:has-text('Relevance')").first(),
        page.locator("[role='button']:has-text('Relevance')").first(),
        page.getByText("Relevance", { exact: true }).first(),
    ];

    for (let attempt = 0; attempt < 2; attempt += 1) {
        let opened = false;
        for (const trigger of relevanceTriggers) {
            if (!(await trigger.count())) continue;
            if (!(await trigger.isVisible().catch(() => false))) continue;
            await trigger.click({ timeout: 2500 }).catch(() => {});
            opened = true;
            break;
        }

        if (!opened) {
            await page.waitForTimeout(250);
            continue;
        }

        await page.waitForTimeout(200);
        await page.locator('[role="listbox"], [role="menu"]').first().waitFor({ state: "visible", timeout: 3000 }).catch(() => {});

        let clicked = await page.evaluate(() => {
            const isVisible = (el) => {
                if (!el) return false;
                const s = window.getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
            };

            const menuRoot =
                Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]')).find(isVisible) || null;
            const root = menuRoot || document.body;

            const all = Array.from(
                root.querySelectorAll("[role='option'], [role='menuitem'], li, button, div, span, a"),
            );
            const optionsLike = all.filter(
                (el) =>
                    root.contains(el) &&
                    /options|date updated|relevance|date created/i.test((el.textContent || "").trim()) &&
                    isVisible(el),
            );

            const exact = optionsLike.find((el) => (el.textContent || "").replace(/\s+/g, " ").trim() === "Date updated");
            if (exact && typeof exact.click === "function") {
                exact.click();
                return true;
            }

            const fallback = optionsLike.find((el) => {
                const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
                return t.includes("date updated") && !t.includes("+");
            });
            if (fallback && typeof fallback.click === "function") {
                fallback.click();
                return true;
            }

            return false;
        }).catch(() => false);

        if (!clicked) {
            await page.keyboard.press("ArrowDown").catch(() => {});
            await page.waitForTimeout(100);
            await page.keyboard.press("ArrowDown").catch(() => {});
            await page.waitForTimeout(100);
            await page.keyboard.press("Enter").catch(() => {});
        }

        // wait page to load after clicking date updated button 
        await Promise.race([
            page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {}),
            page.waitForTimeout(1200),
        ]);
        if (await isDateUpdatedActive()) return true;
        await page.keyboard.press("Escape").catch(() => {});
    }

    return false;
}

async function waitForCandidateContent(page) {
    await page
        .waitForFunction(
            () => document.querySelectorAll("[data-testid='profileListItem'], [data-testid*='profileListItem']").length > 0,
            { timeout: 12000 },
        )
        .catch(() => {});

    await page.waitForFunction(
        () => {
            const body = (document.body && document.body.innerText) ? document.body.innerText : "";
            // Real candidate cards usually expose at least one of these actions/strings.
            return /send message|download profile|access profile|send job|last interaction/i.test(body);
        },
        { timeout: 15000 },
    ).catch(() => {});
}

/**
 * @returns {{ ok: boolean, reason: string }}
 * `ok` means we appear to be signed in on Talent (or no login was needed). Not "password was typed".
 */
async function loginSeekTalentIfNeeded(page) {
    let state = await detectRunState(page);
    if (state.isMfaPage) {
        return { ok: false, reason: "mfa-or-step-up-required" };
    }
    if (state.isSearchPage && /talentsearch\/search/i.test(state.currentUrl)) {
        return { ok: true, reason: "already-on-talent-search" };
    }

    const email = process.env.SEEK_TALENT_EMAIL || "";
    const password = process.env.SEEK_TALENT_PASSWORD || "";
    const onSeekAuth = /authenticate\.seek\.com/i.test(state.currentUrl);

    const emailInput = page.locator("input[type='email'], input[name='email'], #email").first();
    const passwordInput = page.locator("input[type='password'], input[name='password'], #password").first();
    const hasEmail = await emailInput.count();
    const hasPassword = await passwordInput.count();

    if (!hasEmail || !hasPassword) {
        if (/talent\.seek\.com\.au\/talentsearch/i.test(page.url())) {
            return { ok: true, reason: "session-active-no-login-form" };
        }
        if (!email || !password) {
            if (onSeekAuth || state.isLoginPage) {
                return { ok: false, reason: "missing-credentials-in-env" };
            }
            return { ok: true, reason: "no-credentials-env-not-on-login" };
        }
        return { ok: false, reason: "login-form-not-found" };
    }

    if (!email || !password) {
        return { ok: false, reason: "missing-credentials-in-env" };
    }

    await page.waitForTimeout(5000);
    await emailInput.fill(email, { timeout: 10000 }).catch(() => {});
    await passwordInput.fill(password, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);

    const signInButton = page
        .locator("button:has-text('Sign in'), button:has-text('Log in'), [type='submit']")
        .first();
    if (await signInButton.count()) {
        await signInButton.click({ timeout: 10000 }).catch(() => {});
    } else {
        await passwordInput.press("Enter").catch(() => {});
    }

    await page.waitForTimeout(1500);
    await Promise.race([
        page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}),
        page.waitForURL((u) => !/login|signin/i.test(u.toString()), { timeout: 20000 }).catch(() => {}),
        page.waitForTimeout(2500),
    ]);

    state = await detectRunState(page);
    if (state.isMfaPage) {
        return { ok: false, reason: "mfa-or-step-up-required" };
    }
    if (/authenticate\.seek\.com/i.test(state.currentUrl)) {
        return { ok: false, reason: "still-on-seek-auth-host" };
    }
    if (state.isSearchPage || /talentsearch\/search/i.test(state.currentUrl)) {
        return { ok: true, reason: "login-submitted-to-talent" };
    }
    return { ok: false, reason: "unexpected-post-login-state" };
}

async function runTalentSearchFromUi(page, { searchString, nation, location }) {
    await page.waitForTimeout(2000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    const searchForCandidatesButtonCandidates = [
        page.locator("button:has-text('Search for candidates')").first(),
        page.locator("a:has-text('Search for candidates')").first(),
        page.getByRole("button", { name: /search for candidates/i }).first(),
        page.getByRole("link", { name: /search for candidates/i }).first(),
    ];
    let searchForCandidatesButton = null;
    for (const candidate of searchForCandidatesButtonCandidates) {
        if (!(await candidate.count())) continue;
        searchForCandidatesButton = candidate;
        break;
    }
    if (searchForCandidatesButton) {
        await searchForCandidatesButton.click({ timeout: 12000 }).catch(() => {});
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(900);
    }

    const booleanInput = page
        .locator(
            "input[placeholder*='sales consultant'], input[placeholder*='Boolean search'], input[aria-label*='Boolean' i]",
        )
        .first();

    const locationInput = page
        .locator("input[placeholder*='Suburb, city or region'], input[aria-label*='location' i]")
        .first();

    const seekButton = page.locator("button:has-text('SEEK')").first();
    if (!(await booleanInput.count()) || !(await seekButton.count())) {
        return false;
    }

    await booleanInput.click({ timeout: 6000 }).catch(() => {});
    await booleanInput.fill(searchString, { timeout: 10000 }).catch(() => {});

    const nationButton = page
        .locator("button")
        .filter({ hasText: /^AU$|^MY$/ })
        .first();
    if (nation && (await nationButton.count())) {
        const currentNation = (await nationButton.textContent().catch(() => "")) || "";
        if (currentNation.trim().toUpperCase() !== String(nation).toUpperCase()) {
            await nationButton.click({ timeout: 6000 }).catch(() => {});
            const nationList = page.locator('[role="listbox"]').first();
            await nationList.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
            await nationList
                .locator('[role="option"]')
                .filter({ hasText: new RegExp(`^${String(nation).toUpperCase()}$`) })
                .first()
                .click({ timeout: 6000 })
                .catch(() => {});
            await page.keyboard.press("Escape").catch(() => {});
        }
    }

    if (location && (await locationInput.count())) {
        await locationInput.click({ timeout: 6000 }).catch(() => {});
        await locationInput.fill("", { timeout: 10000 }).catch(() => {});

        // Type location one-by-one to trigger autosuggest like a human.
        const locationText = String(location).trim();
        for (const ch of locationText) {
            await locationInput.type(ch, { delay: 70 + Math.floor(Math.random() * 60) }).catch(() => {});
        }
        await page.waitForTimeout(700);

        const locLower = locationText.toLowerCase();
        let preferredSuggestion = locationText;
        if (locLower === "new south wales" || locLower === "nsw") {
            preferredSuggestion = "New South Wales NSW";
        } else if (locLower.includes("melbourne")) {
            preferredSuggestion = "All Melbourne VIC";
        }

        /**
         * Never use page-wide `div` / `li` for suggestions — those match candidate rows (e.g. "NSW")
         * and open the right-hand preview. Only click options inside the location autocomplete listbox.
         */
        const listbox = page.locator('[role="listbox"]').first();
        await listbox.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});

        const clickOptionInListbox = async (label) => {
            if (!label) return false;
            const opt = listbox.locator('[role="option"]').filter({ hasText: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
            if (await opt.count()) {
                await opt.click({ timeout: 4000 }).catch(() => {});
                return true;
            }
            return false;
        };

        let suggestionClicked = false;
        if (await listbox.isVisible().catch(() => false)) {
            suggestionClicked =
                (await clickOptionInListbox(preferredSuggestion)) || (await clickOptionInListbox(locationText));
        }

        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(300);
    }

    await seekButton.click({ timeout: 10000 }).catch(() => {});
    await Promise.race([
        page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}),
        page.waitForURL((u) => /talentsearch\/search\/profiles/i.test(u.toString()), {
            timeout: 20000,
        }).catch(() => {}),
        page.waitForTimeout(2500),
    ]);

    await dismissSeekOverlays(page);

    return true;
}

async function detectRunState(page) {
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText().catch(() => "");

    const isMfaPage =
        /\/mfa|webauthn|step-up|u\/mfa/i.test(currentUrl) ||
        /verify with fingerprint|face recognition|security key|webauthn|authenticator app|two-step verification/i.test(
            `${pageTitle} ${bodyText}`,
        );

    const isLoginPage =
        !isMfaPage &&
        (/sign in|login|email address|password/i.test(bodyText) || /login|signin/i.test(currentUrl));

    const isSearchPage =
        !isMfaPage &&
        (/talentsearch\/search/i.test(currentUrl) ||
            /boolean search|sorted by|suburb, city or region/i.test(bodyText));

    const hasSearchForCandidatesCta = /search for candidates/i.test(bodyText);
    const possibleBotChallenge =
        /verify you are human|captcha|access denied|temporarily blocked|unusual traffic/i.test(bodyText);

    return {
        currentUrl,
        pageTitle,
        isMfaPage,
        isLoginPage,
        isSearchPage,
        hasSearchForCandidatesCta,
        possibleBotChallenge,
    };
}

async function extractCandidates(page) {
    return page.evaluate(() => {
        const rows = [];
        const seen = new Set();

        /** Not a real candidate profile (e.g. search hub link). */
        function isValidCandidateProfileHref(href) {
            if (!href || typeof href !== "string") return false;
            const path = (() => {
                try {
                    return new URL(href, window.location.origin).pathname;
                } catch {
                    return href.split("?")[0].split("#")[0];
                }
            })();
            if (/talentsearch\/profiles\/search/i.test(path)) return false;
            if (/talentsearch\/profile\/search/i.test(path)) return false;
            if (/\/profiles\/?search$/i.test(path)) return false;
            if (/\/profile\/?search$/i.test(path)) return false;
            if (/talentsearch\/profile\/[^/]+/i.test(path)) return true;
            if (/talentsearch\/profiles\/[^/]+/i.test(path) && !/search$/i.test(path)) return true;
            return false;
        }

        /**
         * Profile links often wrap the whole card; text becomes one blob. Pull a short name only.
         */
        function extractCandidateNameFromLink(anchor, card) {
            if (!anchor) return "";
            const direct = (anchor.textContent || "").replace(/\s+/g, " ").trim();
            if (direct.length > 0 && direct.length <= 80 && !/\bat\s+[A-Za-z]/i.test(direct)) {
                return cleanCandidateName(direct);
            }
            const inner =
                anchor.querySelector("span:first-child, [class*='name' i], [data-testid*='name' i], h2, h3, h4") ||
                card.querySelector("[data-testid*='name' i], [class*='candidateName' i]");
            if (inner) {
                const t = (inner.textContent || "").replace(/\s+/g, " ").trim();
                if (t && t.length <= 120) return cleanCandidateName(t);
            }
            return cleanCandidateName(direct);
        }

        function cleanCandidateName(raw) {
            if (!raw) return "";
            let s = String(raw).replace(/\s+/g, " ").trim();
            s = s.split(
                /\s*(Verified credentials|Verified|Add to pool|Updated today|Send job|Send message|Access profile|Download profile|May be approachable)/i,
            )[0].trim();
            s = s.replace(/_[a-z0-9]{5,}/gi, " ").replace(/\s+/g, " ").trim();
            if (s.length <= 70 && !/ at |AUD|annually|months?\)/i.test(s)) return s;
            const atJob = s.search(/\s+at\s+[A-Za-z0-9&]/i);
            if (atJob > 1 && atJob <= 100) return s.slice(0, atJob).trim();
            const dateR = s.search(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*-/i);
            if (dateR > 1 && dateR <= 90) return s.slice(0, dateR).trim();
            const stuck = s.match(
                /^([A-Za-z][A-Za-z\s\-'.]*[A-Za-z])(?=(?:Junior|Senior|Lead|Principal|Chief|Graduate|Trainee|Project|Estimator|Manager|Coordinator|Engineer|Director|Analyst|Planner|Technician|Specialist|Designer|Architect|Surveyor|Supervisor|Buyer|Administrator|Executive|Assistant|Associate|Consultant|Developer|Officer|Representative|Intern|Partner|Head)\b)/i,
            );
            if (stuck) return stuck[1].replace(/\s+/g, " ").trim();
            return s.slice(0, 70).trim();
        }

        const monthYearRangeRegex =
            /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*-\s*(Present|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/i;

        const isVisible = (el) => {
            if (!el) return false;
            const s = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
        };

        const stats = {
            profileListItemCount: 0,
            profileLinkCount: 0,
            cardRootsBuilt: 0,
        };

        const profileListSelectors =
            "[data-testid='profileListItem'], [data-testid*='profileListItem'], [data-testid*='ProfileListItem']";

        const listByTestId = Array.from(document.querySelectorAll(profileListSelectors));
        stats.profileListItemCount = listByTestId.length;

        const anchors = Array.from(
            document.querySelectorAll(
                "a[href*='/talentsearch/profile/'], a[href*='/talentsearch/profiles/'], a[href*='/talent/profile/']",
            ),
        ).filter((a) => isValidCandidateProfileHref(a.getAttribute("href") || ""));
        stats.profileLinkCount = anchors.length;

        const cardRoots = [];
        const rootSeen = new WeakSet();

        const addRoot = (el) => {
            if (!el || rootSeen.has(el)) return;
            rootSeen.add(el);
            cardRoots.push(el);
        };

        for (const el of listByTestId) {
            addRoot(el);
        }

        for (const a of anchors) {
            const byTest =
                a.closest("[data-testid='profileListItem'], [data-testid*='profileListItem'], [data-testid*='ProfileListItem']") ||
                null;
            let card = byTest || a.closest("article") || a.closest("[role='listitem']") || a.closest("li");
            if (!card) {
                let p = a.parentElement;
                for (let d = 0; d < 14 && p; d += 1) {
                    const len = (p.innerText || "").length;
                    if (len > 120 && len < 12000) {
                        card = p;
                        break;
                    }
                    p = p.parentElement;
                }
            }
            if (card) addRoot(card);
        }

        stats.cardRootsBuilt = cardRoots.length;

        const cards = cardRoots.filter((el) => isVisible(el));

        for (const card of cards) {
            if (!card) continue;

            const txt = (sel) => {
                const el = card.querySelector(sel);
                return el ? (el.textContent || "").trim() : "";
            };

            const profileLinks = Array.from(
                card.querySelectorAll(
                    "a[href*='/talentsearch/profile/'], a[href*='/talentsearch/profiles/'], a[href*='/talent/profile/']",
                ),
            ).filter((a) => isValidCandidateProfileHref(a.getAttribute("href") || ""));

            if (profileLinks.length === 0) continue;

            let profileLink = profileLinks[0] || null;
            let shortest = profileLink;
            let shortestLen = (shortest.textContent || "").length;
            for (const pl of profileLinks) {
                const len = (pl.textContent || "").length;
                if (len > 0 && len < shortestLen) {
                    shortestLen = len;
                    shortest = pl;
                }
            }
            if (shortestLen > 0 && shortestLen < 200) profileLink = shortest;

            const href = profileLink ? profileLink.getAttribute("href") || "" : "";
            if (!isValidCandidateProfileHref(href)) continue;

            let name = extractCandidateNameFromLink(profileLink, card);
            if (!name || name.length > 100) {
                name =
                    txt("[data-testid='name'], [data-testid*='name']") ||
                    (() => {
                        for (const sel of ["h1", "h2", "h3", "h4"]) {
                            const h = card.querySelector(sel);
                            const t = (h && (h.textContent || "").trim()) || "";
                            if (t.length > 1 && t.length < 100) return cleanCandidateName(t);
                        }
                        return "";
                    })();
            }
            name = cleanCandidateName(name || "");

            const location = txt("[data-automation*='location' i], [aria-label*='location' i], [data-testid*='location']");
            const salary = txt("[data-automation*='salary' i], [aria-label*='salary' i], [data-testid*='salary']");
            const cardText = card.innerText || card.textContent || "";
            const updatedMatch = cardText.match(/Updated\s+[^\n\r]+/i);
            const updatedStatus = updatedMatch ? updatedMatch[0].trim() : "";

            const rawLines = cardText
                .split(/\n+/)
                .map((line) => line.replace(/\s+/g, " ").trim())
                .filter(Boolean);

            const careerLines = rawLines.filter((line) => monthYearRangeRegex.test(line)).slice(0, 2);

            const parseCareerLine = (line) => {
                const d = line.match(
                    /((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*-\s*(Present|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\s*(\([^)]*\))?)/i,
                );
                if (!d) return { career: line || "", duration: "" };
                return {
                    career: (line || "").replace(d[1], "").replace(/\s+/g, " ").trim(),
                    duration: d[1].replace(/\s+/g, " ").trim(),
                };
            };

            const c1 = parseCareerLine(careerLines[0] || "");
            const c2 = parseCareerLine(careerLines[1] || "");

            const locationFromText =
                rawLines.find((line) =>
                    /(NSW|VIC|QLD|WA|SA|TAS|ACT|NT|AU|MY)\b/i.test(line) &&
                    /,/.test(line) &&
                    !/Updated|Send job|Send message|Download profile|Access profile|Add to pool|Verified/i.test(line),
                ) || "";

            const salaryFromText =
                rawLines.find((line) => /(AUD|MYR|\$|annually|monthly|\+)/i.test(line)) || "";

            if (!href || !isValidCandidateProfileHref(href)) continue;
            if (!name && !monthYearRangeRegex.test(cardText)) continue;
            const rowKey = href || `${name}|${c1.career}|${location || locationFromText}|${updatedStatus}`;
            if (seen.has(rowKey)) continue;
            seen.add(rowKey);
            rows.push({
                candidateName: name,
                career1: c1.career,
                duration1: c1.duration,
                career2: c2.career,
                duration2: c2.duration,
                location: location || locationFromText,
                salary: salary || salaryFromText,
                updatedStatus,
                profileUrl: href
                    ? (href.startsWith("http")
                        ? href
                        : `${window.location.origin}${href}`)
                    : "",
            });
        }

        return { rows, stats };
    });
}

async function clickNextIfAvailable(page) {
    const nextCandidates = [
        page.locator("[aria-label*='Next' i]").first(),
        page.locator("button:has-text('Next')").first(),
        page.locator("a:has-text('Next')").first(),
        page.locator("[data-automation*='next' i]").first(),
    ];

    for (const nextBtn of nextCandidates) {
        if (!(await nextBtn.count())) continue;
        if (!(await nextBtn.isVisible().catch(() => false))) continue;
        if (!(await nextBtn.isEnabled().catch(() => false))) continue;

        const previousUrl = page.url();
        const firstProfileHref = await page
            .locator("a[href*='/talentsearch/profile/'], a[href*='/talentsearch/profiles/']")
            .first()
            .getAttribute("href")
            .catch(() => null);

        await nextBtn.click({ timeout: 7000 }).catch(() => {});

        await Promise.race([
            page.waitForURL((u) => u.toString() !== previousUrl, { timeout: 12000 }).catch(() => {}),
            page
                .waitForFunction(
                    (oldHref) => {
                        const current = document.querySelector(
                            "a[href*='/talentsearch/profile/'], a[href*='/talentsearch/profiles/']",
                        );
                        const href = current ? current.getAttribute("href") : null;
                        return !!href && href !== oldHref;
                    },
                    firstProfileHref,
                    { timeout: 12000 },
                )
                .catch(() => {}),
            page.waitForTimeout(2000),
        ]);

        await page.waitForLoadState("networkidle").catch(() => {});
        // User requested slower page transitions to avoid scraping skeleton states.
        await page.waitForTimeout(5000);
        return true;
    }
    return false;
}

// Main method used by index.js - entry point.
async function scrapeSeekTalent({
    searchString,
    nation = "AU",
    location,
    pageNumber = 1,
    /** How many result pages to walk (Next), starting from the search URL’s pageNumber. From UI `maxPages`. */
    maxPages: maxPagesRaw,
    sortBy = SORT_BY_DATE_UPDATED,
    headless = false,
}) {
    const scrapeStartedAt = Date.now();
    const url = buildSeekTalentUrl({
        searchTitle: searchString,
        nation,
        locationSlug: location,
        sortBy,
        pageNumber,
    });

    const runId = randomUUID();
    const maxResultPages = Math.max(1, Math.min(500, Number(maxPagesRaw) || 1));

    console.log(
        `[extract] Starting crawler runId=${runId} q="${searchString}" nation=${nation} location="${location || ""}" startPage=${pageNumber} maxResultPages=${maxResultPages}`,
    );
    const localDataDirectory = path.join(
        os.tmpdir(),
        "seek-talent-notification-runs",
        runId,
    );
    fs.mkdirSync(localDataDirectory, { recursive: true });

    const chromeResolved = resolveChromeLaunch(headless, runId);
    const chromeLaunch = chromeResolved.launchOptions;
    const profileResolveMs = Date.now() - scrapeStartedAt;
    console.log(
        `[crawler ${runId}] Profile resolved browserMode=${chromeResolved.browserMode} profileCopyMs=${chromeResolved.profileCopyMs ?? "n/a"} (+${profileResolveMs}ms) — next: launch Chrome + navigate`,
    );

    const debug = {
        runId,
        url,
        storageMode: "crawlee-memory-per-run",
        localDataDirectory,
        browserMode: chromeResolved.browserMode || "unknown",
        chromeCopiedProfileDir: chromeResolved.tempUserData || null,
        chromeCopiedFrom: chromeResolved.copiedFrom || null,
        chromeProfileName: chromeResolved.profileName || null,
        chromeProfileCopySkipped: chromeResolved.chromeProfileCopySkipped ?? null,
        profileCopyMs: chromeResolved.profileCopyMs ?? null,
        loginDetail: null,
        pagesVisited: 0,
        nextClicks: 0,
        sortClicked: false,
        extractedBeforeDedupe: 0,
        extractedAfterDedupe: 0,
        stateBeforeSearch: null,
        stateAfterSearch: null,
        failureStage: null,
        sortLabelBefore: "",
        sortLabelAfter: "",
        perPageExtracted: [],
        timings: null,
        extractorStats: null,
        maxResultPages,
    };
    const allRows = [];
    const memoryStorage = new MemoryStorage({
        localDataDirectory,
        persistStorage: false,
    });
    const config = new Configuration({
        storageClient: memoryStorage,
        purgeOnStart: true,
    });

    const crawler = new PlaywrightCrawler({
            maxRequestsPerCrawl: 1,
            maxRequestRetries: 0,
            useSessionPool: true,
            sessionPoolOptions: {
                persistenceOptions: { enable: false },
            },
            navigationTimeoutSecs: 90,
            headless,
            requestHandlerTimeoutSecs: 900,
            launchContext: {
                useChrome: true,
                launchOptions: chromeLaunch,
                ...(chromeResolved.launchContextUserDataDir
                    ? { userDataDir: chromeResolved.launchContextUserDataDir }
                    : {}),
            },
            browserPoolOptions: {
                useFingerprints: false,
            },
            preNavigationHooks: [
                async (_ctx, gotoOptions) => {
                    gotoOptions.waitUntil = "networkidle";
                },
            ],
            async requestHandler({ page }) {
                console.log(`[crawler ${runId}] Browser + first navigation ready (+${Date.now() - scrapeStartedAt}ms) — login / search pipeline`);
                await page.setViewportSize({ width: 1920, height: 1080 });
                await page.waitForLoadState("networkidle").catch(() => {});
                await page.waitForTimeout(1200);
                const loginResult = await loginSeekTalentIfNeeded(page);
                debug.loggedIn = loginResult.ok;
                debug.loginDetail = { reason: loginResult.reason };
                console.log(
                    `[crawler ${runId}] Login step: ok=${loginResult.ok} reason=${loginResult.reason} (+${Date.now() - scrapeStartedAt}ms)`,
                );

                debug.stateBeforeSearch = await detectRunState(page);
                if (debug.stateBeforeSearch.isMfaPage) {
                    debug.failureStage = "mfa-or-step-up-required";
                    const p = path.join(localDataDirectory, "mfa-or-auth.png");
                    await page.screenshot({ path: p, fullPage: true }).catch(() => {});
                    debug.authBlockedScreenshot = p;
                    console.warn(`[crawler ${runId}] Stopped: MFA / step-up required`);
                    return;
                }

                debug.searchSubmittedFromUi = await runTalentSearchFromUi(page, {
                    searchString,
                    nation,
                    location,
                });
                debug.stateAfterSearch = await detectRunState(page);
                console.log(
                    `[crawler ${runId}] Search UI: submitted=${debug.searchSubmittedFromUi} url=${debug.stateAfterSearch.currentUrl.slice(0, 120)}… (+${Date.now() - scrapeStartedAt}ms)`,
                );
                if (debug.stateAfterSearch.isMfaPage) {
                    debug.failureStage = "mfa-or-step-up-required";
                    const p = path.join(localDataDirectory, "mfa-or-auth.png");
                    await page.screenshot({ path: p, fullPage: true }).catch(() => {});
                    debug.authBlockedScreenshot = p;
                    console.warn(`[crawler ${runId}] Stopped: MFA / step-up after search UI`);
                    return;
                }

                if (!loginResult.ok && /authenticate\.seek\.com/i.test(debug.stateAfterSearch.currentUrl)) {
                    debug.failureStage =
                        loginResult.reason === "missing-credentials-in-env"
                            ? "missing-credentials-in-env"
                            : "auth-blocked-not-on-talent";
                    const p = path.join(localDataDirectory, "auth-blocked.png");
                    await page.screenshot({ path: p, fullPage: true }).catch(() => {});
                    debug.authBlockedScreenshot = p;
                    console.warn(`[crawler ${runId}] Stopped: still on SEEK auth host`);
                    return;
                }

                debug.sortLabelBefore = await page
                    .locator("text=/Sorted by/i")
                    .first()
                    .textContent()
                    .catch(() => "");

                if (!debug.searchSubmittedFromUi && !debug.stateAfterSearch.isSearchPage) {
                    debug.failureStage = "search-page-not-opened";
                    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
                    debug.stateAfterSearch = await detectRunState(page);
                }

                if (!debug.stateAfterSearch.isSearchPage) {
                    debug.sortClicked = false;
                    debug.sortLabelAfter = "";
                    if (!debug.failureStage) {
                        debug.failureStage = "not-on-search-page";
                    }
                    const p = path.join(localDataDirectory, "not-on-search.png");
                    await page.screenshot({ path: p, fullPage: true }).catch(() => {});
                    debug.notOnSearchScreenshot = p;
                    console.warn(`[crawler ${runId}] Stopped: not on search page`);
                    return;
                }

                await dismissSeekOverlays(page);
                console.log(`[crawler ${runId}] Dismissed overlays / preview before sort (+${Date.now() - scrapeStartedAt}ms)`);

                debug.sortClicked = await forceDateUpdatedSort(page);
                debug.sortLabelAfter = await page
                    .locator("text=/Sorted by/i")
                    .first()
                    .textContent()
                    .catch(() => "");
                if (!debug.sortClicked) {
                    debug.failureStage = "sort-switch-failed";
                    const screenshotPath = path.join(localDataDirectory, "sort-failure.png");
                    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
                    debug.sortFailureScreenshot = screenshotPath;
                    console.warn(
                        `[crawler ${runId}] Sort: could not confirm "Date updated" (see sort-failure.png) (+${Date.now() - scrapeStartedAt}ms)`,
                    );
                    if (String(process.env.SEEK_TALENT_KEEP_BROWSER_OPEN || "").toLowerCase() === "true") {
                        await page.waitForTimeout(30000);
                    }
                } else {
                    console.log(`[crawler ${runId}] Sort: Date updated OK (+${Date.now() - scrapeStartedAt}ms)`);
                }
                for (let pageIndex = 1; pageIndex <= maxResultPages; pageIndex += 1) {
                    debug.pagesVisited += 1;
                    console.log(
                        `[crawler ${runId}] Extracting results page ${pageIndex}/${maxResultPages}… (+${Date.now() - scrapeStartedAt}ms)`,
                    );
                    // Give cards time to render from skeleton placeholders.
                    await page.waitForTimeout(1500);
                    await waitForCandidateContent(page);
                    await warmUpLazyCards(page);
                    await page.waitForTimeout(1000);
                    await waitForCandidateContent(page);

                    const { rows, stats } = await extractCandidates(page);
                    allRows.push(...rows);
                    debug.extractorStats = stats;
                    debug.perPageExtracted.push({
                        pageIndex,
                        rows: rows.length,
                        sampleName: rows[0] ? rows[0].candidateName : "",
                    });

                    const hasNext = await clickNextIfAvailable(page);
                    if (!hasNext) break;
                    debug.nextClicks += 1;
                }
            },
        }, config);

    const crawlRunStartedAt = Date.now();
    let crawlRunMs = 0;
    console.log(`[crawler ${runId}] PlaywrightCrawler.run starting (browser launch + first URL)…`);
    try {
        await crawler.run([{ url, uniqueKey: `seek-talent-${runId}` }]);
        crawlRunMs = Date.now() - crawlRunStartedAt;
        console.log(
            `[crawler ${runId}] PlaywrightCrawler.run finished (+${crawlRunMs}ms crawl wall time, +${Date.now() - scrapeStartedAt}ms total)`,
        );
    } finally {
        try {
            await memoryStorage.teardown();
        } catch {
            // ignore
        }
        try {
            const persistEnabled =
                String(process.env.CHROME_COPIED_PROFILE_PERSIST || "").toLowerCase() === "true";
            if (chromeResolved.tempUserData && !persistEnabled) {
                fs.rmSync(chromeResolved.tempUserData, { recursive: true, force: true });
            }
        } catch {
            // ignore
        }
        try {
            const keepRunArtifacts =
                debug.failureStage === "sort-switch-failed" ||
                debug.failureStage === "mfa-or-step-up-required" ||
                debug.failureStage === "auth-blocked-not-on-talent" ||
                debug.failureStage === "missing-credentials-in-env" ||
                debug.failureStage === "not-on-search-page";
            if (!keepRunArtifacts) {
                fs.rmSync(localDataDirectory, { recursive: true, force: true });
            }
        } catch {
            // ignore
        }
    }

    debug.timings = {
        totalMs: Date.now() - scrapeStartedAt,
        profileResolveMs,
        profileCopyMs: chromeResolved.profileCopyMs ?? null,
        crawlRunMs,
    };

    const deduped = [];
    const seen = new Set();
    for (const row of allRows) {
        const key =
            normalizeText(row.profileUrl) ||
            normalizeText(
                `${row.candidateName || ""}|${row.career1 || ""}|${row.duration1 || ""}|${row.location || ""}|${row.updatedStatus || ""}`,
            );
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.push({
            candidateName: normalizeText(row.candidateName),
            career1: normalizeText(row.career1),
            duration1: normalizeText(row.duration1),
            career2: normalizeText(row.career2),
            duration2: normalizeText(row.duration2),
            location: normalizeText(row.location),
            salary: normalizeText(row.salary),
            updatedStatus: normalizeText(row.updatedStatus),
            profileUrl: normalizeText(row.profileUrl),
        });
    }

    debug.extractedBeforeDedupe = allRows.length;
    debug.extractedAfterDedupe = deduped.length;

    console.log(
        `[crawler ${runId}] Extract complete: ${deduped.length} candidate(s) after dedupe (+${Date.now() - scrapeStartedAt}ms total)`,
    );

    return {
        candidates: deduped,
        debug,
    };
}

module.exports = {
    buildSeekTalentUrl,
    scrapeSeekTalent,
    resolveChromeLaunch,
};