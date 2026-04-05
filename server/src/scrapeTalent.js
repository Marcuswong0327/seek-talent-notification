"use strict";

/**
 * BACKWARD-COMPATIBLE FACADE (ABSTRACTION):
 * Existing `require("./scrapeTalent")` keeps the same three exports while the implementation
 * lives in classes under `url/`, `browser/`, `scraping/`.
 */

const { SeekTalentScraperService } = require("./scraping/SeekTalentScraperService");
const { SeekTalentUrlBuilder } = require("./url/SeekTalentUrlBuilder");
const { ChromeLaunchResolver } = require("./browser/ChromeLaunchResolver");

async function scrapeSeekTalent(options) {
    return new SeekTalentScraperService().execute(options);
}

module.exports = {
    buildSeekTalentUrl: (params) => SeekTalentUrlBuilder.build(params),
    scrapeSeekTalent,
    resolveChromeLaunch: (headless, runId) => ChromeLaunchResolver.resolve(headless, runId),
};
