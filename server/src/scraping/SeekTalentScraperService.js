"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { randomUUID } = require("crypto");
const { PlaywrightCrawler, Configuration, MemoryStorage } = require("crawlee");

const { SORT_BY_DATE_UPDATED } = require("../constants/SeekTalentConstants");
const { SeekTalentUrlBuilder } = require("../url/SeekTalentUrlBuilder");
const { ChromeLaunchResolver } = require("../browser/ChromeLaunchResolver");
const { TextNormalizer } = require("../utils/TextNormalizer");
const { SeekTalentCrawlRequestHandler } = require("./SeekTalentCrawlRequestHandler");

/**
 * FACADE + ORCHESTRATION (ABSTRACTION):
 * This is the single entry class the HTTP layer calls. It hides:
 * - temp dirs, Crawlee `Configuration`, `PlaywrightCrawler`, cleanup in `finally`,
 * - deduplication of rows across pages.
 *
 * ENCAPSULATION: Run id, chrome resolution, and crawl timings live inside `execute` — not globals.
 */
class SeekTalentScraperService {
    /**
     * @param {{
     *   searchString: string,
     *   nation?: string,
     *   location?: string,
     *   pageNumber?: number,
     *   maxPages?: number,
     *   sortBy?: string,
     *   headless?: boolean
     * }} options
     * @returns {Promise<{ candidates: object[], debug: object }>}
     */
    async execute({
        searchString,
        nation = "AU",
        location,
        pageNumber = 1,
        maxPages: maxPagesRaw,
        sortBy = SORT_BY_DATE_UPDATED,
        headless = false,
    }) {
        const scrapeStartedAt = Date.now();
        const url = SeekTalentUrlBuilder.build({
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

        const localDataDirectory = path.join(os.tmpdir(), "seek-talent-notification-runs", runId);
        fs.mkdirSync(localDataDirectory, { recursive: true });

        const chromeResolved = ChromeLaunchResolver.resolve(headless, runId);
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

        const crawlHandler = new SeekTalentCrawlRequestHandler({
            runId,
            scrapeStartedAt,
            localDataDirectory,
            url,
            searchString,
            nation,
            location,
            maxResultPages,
            debug,
            allRows,
        });

        const crawler = new PlaywrightCrawler(
            {
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
                    await crawlHandler.handle(page);
                },
            },
            config,
        );

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
                TextNormalizer.normalize(row.profileUrl) ||
                TextNormalizer.normalize(
                    `${row.candidateName || ""}|${row.career1 || ""}|${row.duration1 || ""}|${row.location || ""}|${row.updatedStatus || ""}`,
                );
            if (!key || seen.has(key)) continue;
            seen.add(key);
            deduped.push({
                candidateName: TextNormalizer.normalize(row.candidateName),
                career1: TextNormalizer.normalize(row.career1),
                duration1: TextNormalizer.normalize(row.duration1),
                career2: TextNormalizer.normalize(row.career2),
                duration2: TextNormalizer.normalize(row.duration2),
                location: TextNormalizer.normalize(row.location),
                salary: TextNormalizer.normalize(row.salary),
                updatedStatus: TextNormalizer.normalize(row.updatedStatus),
                profileUrl: TextNormalizer.normalize(row.profileUrl),
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
}

module.exports = { SeekTalentScraperService };
