"use strict";

const {
    NATION_ID_MAP,
    SORT_BY_DATE_UPDATED,
    AU_LOCATION_LIST_MAP,
    MY_LOCATION_LIST_MAP,
} = require("../constants/SeekTalentConstants");

/**
 * ABSTRACTION: Hides SEEK URL parameter rules behind one method: `build`.
 * ENCAPSULATION: Slug + location resolution are private static helpers — not exported.
 */
class SeekTalentUrlBuilder {
    /**
     * @private
     * @param {string} [location]
     */
    static #slugifyLocation(location) {
        if (!location) return "";
        return String(location)
            .trim()
            .toLowerCase()
            .replace(/&/g, " and ")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "");
    }

    /**
     * @private
     * @param {string} nation
     * @param {string} locationSlug
     */
    static #resolveLocationList(nation, locationSlug) {
        if (!locationSlug) return "";
        const slug = SeekTalentUrlBuilder.#slugifyLocation(locationSlug);

        if (nation === "AU") {
            return AU_LOCATION_LIST_MAP[slug] || "";
        }
        if (nation === "MY") {
            return MY_LOCATION_LIST_MAP[slug] || "";
        }

        return "";
    }

    /**
     * @param {{
     *   searchTitle: string,
     *   nation?: string,
     *   locationSlug?: string,
     *   sortBy?: string,
     *   pageNumber?: number
     * }} params
     * @returns {string}
     */
    static build({
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

        const normalizedLocationSlug = SeekTalentUrlBuilder.#slugifyLocation(locationSlug);
        const locationList = SeekTalentUrlBuilder.#resolveLocationList(normalizedNation, normalizedLocationSlug);
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
}

module.exports = { SeekTalentUrlBuilder };
