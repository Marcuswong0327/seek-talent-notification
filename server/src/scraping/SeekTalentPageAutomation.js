"use strict";

const { BasePageInteractor } = require("./BasePageInteractor");
const { CandidateExtractor } = require("./CandidateExtractor");

/**
 * INHERITANCE: Extends `BasePageInteractor` so SEEK-specific automation shares one `page` handle.
 * ENCAPSULATION: Page interactions are methods — the Crawlee handler calls them in order.
 * ABSTRACTION: HTTP/API layer never sees Playwright; it only calls the scraper service.
 */
class SeekTalentPageAutomation extends BasePageInteractor {
    /** Close autocomplete, drawers, and the right-hand candidate preview (Escape is SEEK’s usual dismiss). */
    async dismissSeekOverlays() {
        const page = this._page;
        for (let i = 0; i < 3; i += 1) {
            await page.keyboard.press("Escape");
            await page.waitForTimeout(120);
        }
    }

    async warmUpLazyCards() {
        const page = this._page;
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

    /** @private */
    async #isDateUpdatedActive() {
        const page = this._page;
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
    }

    async forceDateUpdatedSort() {
        const page = this._page;

        if (await this.#isDateUpdatedActive()) return true;

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

            await Promise.race([
                page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {}),
                page.waitForTimeout(1200),
            ]);
            if (await this.#isDateUpdatedActive()) return true;
            await page.keyboard.press("Escape").catch(() => {});
        }

        return false;
    }

    async waitForCandidateContent() {
        const page = this._page;
        await page
            .waitForFunction(
                () => document.querySelectorAll("[data-testid='profileListItem'], [data-testid*='profileListItem']").length > 0,
                { timeout: 12000 },
            )
            .catch(() => {});

        await page.waitForFunction(
            () => {
                const body = (document.body && document.body.innerText) ? document.body.innerText : "";
                return /send message|download profile|access profile|send job|last interaction/i.test(body);
            },
            { timeout: 15000 },
        ).catch(() => {});
    }

    /**
     * @returns {Promise<{ ok: boolean, reason: string }>}
     */
    async loginSeekTalentIfNeeded() {
        const page = this._page;
        let state = await this.detectRunState();
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

        state = await this.detectRunState();
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

    async runTalentSearchFromUi({ searchString, nation, location }) {
        const page = this._page;
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

        await this.dismissSeekOverlays();

        return true;
    }

    async detectRunState() {
        const page = this._page;
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

    async extractCandidates() {
        return CandidateExtractor.extract(this._page);
    }

    async clickNextIfAvailable() {
        const page = this._page;
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
            await page.waitForTimeout(5000);
            return true;
        }
        return false;
    }
}

module.exports = { SeekTalentPageAutomation };
