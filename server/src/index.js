/* eslint-disable no-console */
"use strict";

/**
 * HTTP ADAPTER (ABSTRACTION): Express route details are isolated in `AppServer`.
 * The rest of the app could be invoked from CLI/tests without listening on a port.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const cors = require("cors");

const { scrapeSeekTalent } = require("./scrapeTalent");

/**
 * ENCAPSULATION: Port, Express `app`, and route registration live on the class.
 * INHERITANCE: Not used here — HTTP servers are often plain classes or factories.
 */
class AppServer {
    constructor() {
        /** @private */
        this.#app = express();
        /** @private */
        this.#port = Number(process.env.PORT || 3002);
        this.#registerMiddleware();
        this.#registerRoutes();
    }

    /** @private */
    #app;

    /** @private */
    #port;

    /** @private */
    #registerMiddleware() {
        this.#app.use(cors());
        this.#app.use(express.json({ limit: "1mb" }));
    }

    /** @private */
    #registerRoutes() {
        this.#app.get("/health", (_req, res) => {
            res.json({ ok: true });
        });

        this.#app.post("/api/extract", async (req, res) => {
            try {
                const { searchString, location = "", maxPages, headless } = req.body || {};

                if (!searchString || !String(searchString).trim()) {
                    return res.status(400).json({ error: "searchString is required" });
                }

                const nation = "AU";
                const startPage = 1;
                const resultPages = Math.max(1, Math.min(500, Number(maxPages) || 1));
                console.log(
                    `[extract] UI triggered — search="${String(searchString).trim()}" nation=${nation} (fixed) location="${location || ""}" pages=1..${resultPages}`,
                );

                const result = await scrapeSeekTalent({
                    searchString: String(searchString).trim(),
                    nation,
                    location,
                    pageNumber: startPage,
                    maxPages: resultPages,
                    headless:
                        typeof headless === "boolean"
                            ? headless
                            : String(process.env.PLAYWRIGHT_HEADLESS || "false").toLowerCase() === "true",
                });

                const n = result && result.candidates ? result.candidates.length : 0;
                console.log(`[extract] Finished — ${n} candidate row(s) returned`);
                return res.json(result);
            } catch (error) {
                console.error("extract failed", error);
                return res.status(500).json({
                    error: error && error.message ? error.message : "Extraction failed",
                });
            }
        });
    }

    /** Start listening (blocking for the process). */
    start() {
        this.#app.listen(this.#port, () => {
            console.log(`Server listening on http://localhost:${this.#port}`);
            console.log(`UI (Vite): run "npm run client" → http://localhost:5174 (proxies /api to this server)`);
        });
    }
}

new AppServer().start();
