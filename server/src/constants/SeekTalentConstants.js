"use strict";

/**
 * ABSTRACTION: Domain constants live in one place so URL building and tests
 * do not scatter magic strings/IDs across the codebase.
 * ENCAPSULATION: This module exports read-only data (objects are still mutable in JS;
 * treat as immutable by convention).
 */
const NATION_ID_MAP = Object.freeze({ AU: "3000", MY: "3005" });

const SORT_BY_DATE_UPDATED = "dateUpdated";

const AU_LOCATION_LIST_MAP = Object.freeze({
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
});

const MY_LOCATION_LIST_MAP = Object.freeze({
    kl: "5002",
    "kuala-lumpur": "5002",
    selangor: "5004",
    penang: "5006",
    johor: "5008",
});

module.exports = {
    NATION_ID_MAP,
    SORT_BY_DATE_UPDATED,
    AU_LOCATION_LIST_MAP,
    MY_LOCATION_LIST_MAP,
};
