import React, { useState } from "react";

const DEFAULT_FROM = "Marcus Wong <marcus.wong@linktal.com.au>";
const DEFAULT_RECIPIENTS = "marcus.wong@linktal.com.au";

function csvEscape(value) {
    if (value == null) return "";
    const s = String(value).trim();
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function downloadCandidatesCsv(candidates, filename = "seek-candidates.csv") {
    if (!Array.isArray(candidates) || candidates.length === 0) return;

    const bom = "\uFEFF";
    const headers = [
        "Name",
        "Career 1",
        "Duration 1",
        "Career 2",
        "Duration 2",
        "Location",
        "Salary",
        "Updated status",
        "Profile URL",
    ];
    const rows = candidates.map((c) =>
        [
            csvEscape(c.candidateName),
            csvEscape(c.career1),
            csvEscape(c.duration1),
            csvEscape(c.career2),
            csvEscape(c.duration2),
            csvEscape(c.location),
            csvEscape(c.salary),
            csvEscape(c.updatedStatus),
            csvEscape(c.profileUrl),
        ].join(","),
    );

    const csv = bom + [headers.join(","), ...rows].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

export default function App() {
    const [searchString, setSearchString] = useState("");
    const [location, setLocation] = useState("");
    const [maxPages, setMaxPages] = useState(1);
    const [emailFrom, setEmailFrom] = useState(() => DEFAULT_FROM);
    const [emailRecipients, setEmailRecipients] = useState(() => DEFAULT_RECIPIENTS);

    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState("");

    async function onExtract() {
        setLoading(true);
        setError("");
        setResult(null);

        try {
            const res = await fetch("/api/extract", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    searchString,
                    location,
                    maxPages: Math.max(1, Math.min(500, Number(maxPages) || 1)),
                    sortBy: "dateUpdated",
                    emailFrom: emailFrom.trim(),
                    emailTo: emailRecipients,
                }),
            });

            const json = await res.json();
            if (!res.ok) {
                throw new Error(json.error || "Extraction failed");
            }

            setResult(json);

            if (Array.isArray(json.candidates) && json.candidates.length > 0) {
                const name = `seek-candidates-${searchString}-${location || "all"}.csv`;
                downloadCandidatesCsv(json.candidates, name);
            }
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    }

    return (
        <div style={{ maxWidth: 720, margin: "40px auto", padding: 16 }}>
            <h2>Seek Talent Candidate Extraction</h2>
            <p style={{ fontSize: 14, color: "#555", marginTop: -8 }}>
                Market is fixed to <strong>AU</strong> on the server. Scraping always starts at result page <strong>1</strong>.
            </p>
            <div style={{ display: "grid", gap: 12 }}>
                <label>
                    Boolean search job title
                    <input
                        value={searchString}
                        onChange={(e) => setSearchString(e.target.value)}
                        placeholder='"estimator" OR "cost planner"'
                        style={{ width: "100%", padding: 8, marginTop: 6 }}
                    />
                </label>
                <label>
                    Suburb / city / region
                    <input
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                        placeholder="New South Wales, Melbourne, Queensland..."
                        style={{ width: "100%", padding: 8, marginTop: 6 }}
                    />
                </label>
                <label>
                    Max result pages to extract
                    <input
                        type="number"
                        min={1}
                        max={500}
                        value={maxPages}
                        onChange={(e) => setMaxPages(e.target.value)}
                        style={{ width: "100%", padding: 8, marginTop: 6 }}
                    />
                    <span style={{ display: "block", fontSize: 12, color: "#555", marginTop: 4 }}></span>
                </label>

                <fieldset>
                    <legend>Email Notification</legend>
                    <label style={{ display: "block" }}>
                        Sender (From)
                        <input
                            value={emailFrom}
                            onChange={(e) => setEmailFrom(e.target.value)}
                            placeholder="Marcus Wong <marcus.wong@linktal.com.au>"
                            style={{ width: "100%", padding: 8, marginTop: 6 }}
                        />
                    </label>
                    <label style={{ display: "block", marginTop: 10 }}>
                        Recipients (To) — comma-separated
                        <textarea
                            value={emailRecipients}
                            onChange={(e) => setEmailRecipients(e.target.value)}
                            placeholder="one@example.com, two@example.com"
                            rows={3}
                            style={{
                                width: "100%",
                                padding: 8,
                                marginTop: 6,
                            }}
                        />
                    </label>
                </fieldset>

                <button type="button" onClick={onExtract} disabled={loading || !searchString}>
                    {loading ? "Extracting..." : "Extract candidates (Date updated)"}
                </button>
            </div>

            {error ? <pre style={{ marginTop: 16, color: "crimson" }}>{error}</pre> : null}

            {result ? (
                <pre style={{ marginTop: 16, background: "#f6f6f6", padding: 12 }}>
                    {JSON.stringify(result, null, 2)}
                </pre>
            ) : null}
        </div>
    );
}
