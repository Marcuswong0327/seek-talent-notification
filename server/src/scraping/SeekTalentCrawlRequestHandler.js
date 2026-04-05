"use strict";

const path = require("path");
const { SeekTalentPageAutomation } = require("./SeekTalentPageAutomation");

/**
 * ENCAPSULATION: Crawlee calls `handle` with a Playwright `page` — this class owns the ordered
 * pipeline (login → search UI → sort → paginate → extract) and mutates the shared `debug` + `allRows`.
 *
 * ABSTRACTION: `SeekTalentScraperService` does not embed this 100+ line flow; it only wires `new …Handler(...).handle`.
 */
class SeekTalentCrawlRequestHandler {
    /**
     * @param {{
     *   runId: string,
     *   scrapeStartedAt: number,
     *   localDataDirectory: string,
     *   url: string,
     *   searchString: string,
     *   nation: string,
     *   location: string|undefined,
     *   maxResultPages: number,
     *   debug: Record<string, unknown>,
     *   allRows: object[],
     * }} ctx
     */
    constructor(ctx) {
        /** @private */
        this.#ctx = ctx;
    }

    /** @private */
    #ctx;

    /**
     * POLYMORPHISM: Same signature Crawlee expects inside `requestHandler({ page })`.
     * @param {import('playwright').Page} page
     */
    async handle(page) {
        const {
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
        } = this.#ctx;

        const automation = new SeekTalentPageAutomation(page);

        console.log(`[crawler ${runId}] Browser + first navigation ready (+${Date.now() - scrapeStartedAt}ms) — login / search pipeline`);
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(1200);

        const loginResult = await automation.loginSeekTalentIfNeeded();
        debug.loggedIn = loginResult.ok;
        debug.loginDetail = { reason: loginResult.reason };
        console.log(
            `[crawler ${runId}] Login step: ok=${loginResult.ok} reason=${loginResult.reason} (+${Date.now() - scrapeStartedAt}ms)`,
        );

        debug.stateBeforeSearch = await automation.detectRunState();
        if (debug.stateBeforeSearch.isMfaPage) {
            debug.failureStage = "mfa-or-step-up-required";
            const p = path.join(localDataDirectory, "mfa-or-auth.png");
            await page.screenshot({ path: p, fullPage: true }).catch(() => {});
            debug.authBlockedScreenshot = p;
            console.warn(`[crawler ${runId}] Stopped: MFA / step-up required`);
            return;
        }

        debug.searchSubmittedFromUi = await automation.runTalentSearchFromUi({
            searchString,
            nation,
            location,
        });
        debug.stateAfterSearch = await automation.detectRunState();
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
            debug.stateAfterSearch = await automation.detectRunState();
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

        await automation.dismissSeekOverlays();
        console.log(`[crawler ${runId}] Dismissed overlays / preview before sort (+${Date.now() - scrapeStartedAt}ms)`);

        debug.sortClicked = await automation.forceDateUpdatedSort();
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
            await page.waitForTimeout(1500);
            await automation.waitForCandidateContent();
            await automation.warmUpLazyCards();
            await page.waitForTimeout(1000);
            await automation.waitForCandidateContent();

            const { rows, stats } = await automation.extractCandidates();
            allRows.push(...rows);
            debug.extractorStats = stats;
            debug.perPageExtracted.push({
                pageIndex,
                rows: rows.length,
                sampleName: rows[0] ? rows[0].candidateName : "",
            });

            const hasNext = await automation.clickNextIfAvailable();
            if (!hasNext) break;
            debug.nextClicks += 1;
        }
    }
}

module.exports = { SeekTalentCrawlRequestHandler };
