/* eslint-disable no-console */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const cors = require("cors");

const UI_HINT = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Seek Talent API</title></head><body>
<p>API is running. Open the UI at <a href="http://localhost:5174">http://localhost:5174</a></p>
<p>In another terminal run: <code>npm run client</code></p>
</body></html>`;
const { scrapeSeekTalent } = require("./scrapeTalent");

const app = express();
const PORT = Number(process.env.PORT || 3002);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
    res.json({ ok: true });
});

app.post("/api/extract", async (req, res) => {
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

app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`UI (Vite): run "npm run client" → http://localhost:5174 (proxies /api to this server)`);
});
