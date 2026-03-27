/* eslint-disable no-console */
"use strict";

const express = require("express");
const cors = require("cors");
const { scrapeSeekTalent } = require("./scrapeTalent");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3002);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
    res.json({ ok: true });
});

app.post("/api/extract", async (req, res) => {
    try {
        const {
            searchString,
            nation = "AU",
            location = "",
            pageNumber = 1,
            headless,
        } = req.body || {};

        if (!searchString || !String(searchString).trim()) {
            return res.status(400).json({ error: "searchString is required" });
        }

        const result = await scrapeSeekTalent({
            searchString: String(searchString).trim(),
            nation,
            location,
            pageNumber: Number(pageNumber) || 1,
            headless:
                typeof headless === "boolean"
                    ? headless
                    : String(process.env.PLAYWRIGHT_HEADLESS || "false").toLowerCase() === "true",
        });

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
});
