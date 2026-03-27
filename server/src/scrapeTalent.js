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

        let clicked = await page.evaluate(() => {
            const isVisible = (el) => {
                if (!el) return false;
                const s = window.getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
            };

            const all = Array.from(document.querySelectorAll("li, button, [role='menuitem'], [role='option'], div, span, a"));
            const optionsLike = all.filter(
                (el) => /options|date updated|relevance|date created/i.test((el.textContent || "").trim()) && isVisible(el),
            );

            const exact = optionsLike.find((el) => (el.textContent || "").replace(/\s+/g, " ").trim() === "Date updated");
            if (exact && typeof exact.click === "function") {
                exact.click();
                return true;
            }

            // fallback: visible element containing Date updated but not Date updated + Relevance
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

async function loginSeekTalentIfNeeded(page) {
    const email = process.env.SEEK_TALENT_EMAIL || "";
    const password = process.env.SEEK_TALENT_PASSWORD || "";
    if (!email || !password) return false;

    const emailInput = page.locator("input[type='email'], input[name='email'], #email").first();
    const passwordInput = page.locator("input[type='password'], input[name='password'], #password").first();

    const hasEmail = await emailInput.count();
    const hasPassword = await passwordInput.count();
    if (!hasEmail || !hasPassword) return false;

    // Wait briefly on sign-in page, then type credentials.
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

    // Keep post-submit wait short to avoid unnecessary lag.
    await page.waitForTimeout(1500);
    await Promise.race([
        page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}),
        page.waitForURL((u) => !/login|signin/i.test(u.toString()), { timeout: 20000 }).catch(() => {}),
        page.waitForTimeout(2500),
    ]);

    return true;
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
            await page
                .locator("[role='option'], li, button")
                .filter({ hasText: new RegExp(`^${String(nation).toUpperCase()}$`) })
                .first()
                .click({ timeout: 6000 })
                .catch(() => {});
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

        const suggestionCandidates = [
            page.locator("[role='option']").filter({ hasText: preferredSuggestion }).first(),
            page.locator("li").filter({ hasText: preferredSuggestion }).first(),
            page.locator("div").filter({ hasText: preferredSuggestion }).first(),
            page.locator("[role='option'], li").filter({ hasText: locationText }).first(),
        ];

        let suggestionClicked = false;
        for (const suggestion of suggestionCandidates) {
            if (!(await suggestion.count())) continue;
            await suggestion.click({ timeout: 4000 }).catch(() => {});
            suggestionClicked = true;
            break;
        }

        await page.waitForTimeout(500);
    }

    await seekButton.click({ timeout: 10000 }).catch(() => {});
    await Promise.race([
        page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}),
        page.waitForURL((u) => /talentsearch\/search\/profiles/i.test(u.toString()), {
            timeout: 20000,
        }).catch(() => {}),
        page.waitForTimeout(2500),
    ]);

    return true;
}

async function detectRunState(page) {
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const isLoginPage = /sign in|login|email address|password/i.test(bodyText) || /login|signin/i.test(currentUrl);
    const isSearchPage =
        /talentsearch\/search/i.test(currentUrl) ||
        /boolean search|sorted by|suburb, city or region/i.test(bodyText);
    const hasSearchForCandidatesCta = /search for candidates/i.test(bodyText);
    const possibleBotChallenge =
        /verify you are human|captcha|access denied|temporarily blocked|unusual traffic/i.test(bodyText);

    return {
        currentUrl,
        pageTitle,
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

        const monthYearRangeRegex =
            /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*-\s*(Present|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/i;

        const isVisible = (el) => {
            if (!el) return false;
            const s = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
        };

        const profileItemCards = Array.from(
            document.querySelectorAll("[data-testid='profileListItem'], [data-testid*='profileListItem']"),
        );
        const genericCards = Array.from(
            document.querySelectorAll(
                "article, li, div[role='listitem'], [data-automation*='candidate' i], [data-automation*='result' i]",
            ),
        );
        const cardCandidates = profileItemCards.length > 0 ? profileItemCards : genericCards;
        const cards = cardCandidates.filter((el) => isVisible(el));

        for (const card of cards) {
            if (!card) continue;

            const txt = (sel) => {
                const el = card.querySelector(sel);
                return el ? (el.textContent || "").trim() : "";
            };

            const profileLink = card.querySelector(
                "a[href*='/talentsearch/profile/'], a[href*='/talentsearch/profiles/'], a[href*='/profile/']",
            );
            const href = profileLink ? profileLink.getAttribute("href") || "" : "";
            const name =
                (profileLink ? (profileLink.textContent || "").trim() : "") ||
                txt("h3, h2, [data-testid='name'], [data-testid*='name']") ||
                txt("h3 a, h3") ||
                txt("h2 a, h2");
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
                    /,\s*(AU|MY)\b/i.test(line) &&
                    !/Updated|Send job|Send message|Download profile|Access profile/i.test(line),
                ) || "";
            const salaryFromText =
                rawLines.find((line) => /(AUD|MYR|\$|annually|monthly)/i.test(line)) || "";

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

        return rows;
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
    sortBy = SORT_BY_DATE_UPDATED,
    headless = false,
}) {
    const url = buildSeekTalentUrl({
        searchTitle: searchString,
        nation,
        locationSlug: location,
        sortBy,
        pageNumber,
    });

    const runId = randomUUID();
    const localDataDirectory = path.join(
        os.tmpdir(),
        "seek-talent-notification-runs",
        runId,
    );
    fs.mkdirSync(localDataDirectory, { recursive: true });

    const debug = {
        runId,
        url,
        storageMode: "crawlee-memory-per-run",
        localDataDirectory,
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
                launchOptions: {
                    headless,
                    args: ["--start-maximized"],
                },
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
                await page.setViewportSize({ width: 1920, height: 1080 });
                await page.waitForLoadState("networkidle").catch(() => {});
                await page.waitForTimeout(1200);
                debug.loggedIn = await loginSeekTalentIfNeeded(page);
                debug.stateBeforeSearch = await detectRunState(page);
                debug.searchSubmittedFromUi = await runTalentSearchFromUi(page, {
                    searchString,
                    nation,
                    location,
                });
                debug.stateAfterSearch = await detectRunState(page);
                debug.sortLabelBefore = await page
                    .locator("text=/Sorted by/i")
                    .first()
                    .textContent()
                    .catch(() => "");

                if (!debug.searchSubmittedFromUi && !debug.stateAfterSearch.isSearchPage) {
                    debug.failureStage = "search-page-not-opened";
                    // Fallback: navigate directly to built search URL.
                    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
                    debug.stateAfterSearch = await detectRunState(page);
                }

                // Apply human-like sort click instead of trusting URL-only sort params.
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
                    if (String(process.env.SEEK_TALENT_KEEP_BROWSER_OPEN || "").toLowerCase() === "true") {
                        await page.waitForTimeout(30000);
                    }
                    // Continue scraping even if sort label verification is ambiguous.
                }
                const maxPages = Number(process.env.SEEK_TALENT_MAX_PAGES || 5);

                for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
                    debug.pagesVisited += 1;
                    // Give cards time to render from skeleton placeholders.
                    await page.waitForTimeout(1500);
                    await waitForCandidateContent(page);
                    await warmUpLazyCards(page);
                    await page.waitForTimeout(1000);
                    await waitForCandidateContent(page);

                    const rows = await extractCandidates(page);
                    allRows.push(...rows);
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

    try {
        await crawler.run([{ url, uniqueKey: `seek-talent-${runId}` }]);
    } finally {
        try {
            await memoryStorage.teardown();
        } catch {
            // ignore
        }
        try {
            if (debug.failureStage !== "sort-switch-failed") {
                fs.rmSync(localDataDirectory, { recursive: true, force: true });
            }
        } catch {
            // ignore
        }
    }

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

    return {
        candidates: deduped,
        debug,
    };
}

module.exports = {
    buildSeekTalentUrl,
    scrapeSeekTalent,
};