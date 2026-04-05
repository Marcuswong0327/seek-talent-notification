"use strict";

/**
 * ABSTRACTION: "Give me candidate rows from the current DOM" — callers do not implement DOM walking.
 * ENCAPSULATION: All browser-only DOM logic stays inside `page.evaluate` (runs in Chromium, not Node).
 *
 * TECHNICAL: `page.evaluate(fn)` serializes `fn` into the browser; closures cannot capture Node variables.
 * That is why extraction is one big function body, not scattered Node helpers.
 */
class CandidateExtractor {
    /**
     * @param {import('playwright').Page} page
     * @returns {Promise<{ rows: object[], stats: object }>}
     */
    static async extract(page) {
        return page.evaluate(() => {
            const rows = [];
            const seen = new Set();

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
}

module.exports = { CandidateExtractor };
