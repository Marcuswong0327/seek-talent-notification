"use strict";

/**
 * ENCAPSULATION: Small utility class — callers only see `normalize`, not how
 * whitespace rules might evolve later.
 * ABSTRACTION: "Turn any cell value into a comparable string" without exposing regex details.
 */
class TextNormalizer {
    /**
     * @param {unknown} value
     * @returns {string}
     */
    static normalize(value) {
        if (value == null) return "";
        return String(value).replace(/\s+/g, " ").trim();
    }
}

module.exports = { TextNormalizer };
