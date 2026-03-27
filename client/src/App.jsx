import React, { useState } from "react";

const DEFAULT_FROM = "Marcus Wong <marcus.wong@linktal.com.au>";
const DEFAULT_RECIPIENTS = "marcus.wong@linktal.com.au";

// Helper function - Escape a CSV cell (wrap in quotes if contains comma, quote, or newline). 
function csvEscape(value) {
  if (value == null) return "";
  const s = String(value).trim();
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCandidatesCsv(candidates, filename = "seek-candidates.csv") {

  // Guard clause
  if (!Array.isArray(candidates) || candidates.length === 0) return;
  
  // Add UTF-8 BOM so Excel opens UTF-8 reliably.
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

  //blob = binary large object - convert raw text into a virtual file, 
  // use URL.creatObjectURL to create a fake web address  for the file 
  // create invisible HTML link <a> and attach fake web address 
  // tell browsers to click and download 
  // URL.revokeObjectURL - delete fake web address from memory, so free resources 
  const csv = bom + [headers.join(","), ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" }); // utf is the modern one - accept special symbol 
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [searchString, setSearchString] = useState(""); // Boolean search string
  const [nation, setNation] = useState("AU");
  const [location, setLocation] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [emailFrom, setEmailFrom] = useState(() => {
    try {
      return DEFAULT_FROM;
    } catch(e) {
        throw e;
    }
  });

  const [emailRecipients, setEmailRecipients] = useState(() => {
    try {
      return DEFAULT_RECIPIENTS;
    } catch(e) {
        throw e;
    }
  });
  
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");


  async function onExtract() {
    setLoading(true);
    setError("");
    setResult(null);

    // api/extract is the window to enter into backend 
    // SEND REQUEST - POST 
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchString,
          nation,
          location,
          pageNumber: Number(pageNumber) || 1,
          sortBy: "dateUpdated",
          emailFrom: emailFrom.trim(),
          emailTo: emailRecipients,
        }),
      });

      // WAIT FOR RESPONSE 
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Extraction failed");
      }
        setResult(json);

      // DOWNLOAD FILE
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
          Market
          <select
            value={nation}
            onChange={(e) => setNation(e.target.value)}
            style={{ width: "100%", padding: 8, marginTop: 6 }}
          >
            <option value="AU">AU</option>
            <option value="MY">MY</option>
          </select>
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
          Page number
          <input
            type="number"
            min={1}
            value={pageNumber}
            onChange={(e) => setPageNumber(e.target.value)}
            style={{ width: "100%", padding: 8, marginTop: 6 }}
          />
        </label>

        <fieldset>
          <legend>Email Notification</legend>
          <label style={{ display: "block" }}>
            Sender (From)
            <input
              value={emailFrom}
              onChange={(e) => setEmailFrom(e.target.value)}
              placeholder='Marcus Wong <marcus.wong@linktal.com.au>'
              style={{ width: "100%", padding: 8, marginTop: 6 }}
            />
          </label>
          <label style={{ display: "block", marginTop: 10 }}>
            Recipients (To) - use comma to separete, max 50 recipients per email
            <textarea
              value={emailRecipients}
              onChange={(e) => setEmailRecipients(e.target.value)}
              placeholder="one@linktal.com.au, two@example.com"
              rows={3}
              style={{
                width: "100%",
                padding: 8,
                marginTop: 6
              }}
            />
          </label>
        </fieldset>

        <button onClick={onExtract} disabled={loading || !searchString}>
          {loading ? "Extracting..." : "Extract candidates (Date updated)"}
        </button>
      </div>

      {error ? (
        <pre style={{ marginTop: 16, color: "crimson" }}>{error}</pre>
      ) : null}

      {result ? (
        <pre style={{ marginTop: 16, background: "#f6f6f6", padding: 12 }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

