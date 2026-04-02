# Newsletter Digest — Startup Instructions

When the user says **"go"**, do all of the following steps in order:

## 1. Verify the server is running
The server runs automatically as a macOS background service (launchd). Just confirm it's up:
```
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
```
If it returns 200, skip ahead. If not, run: `node server.js &`

## 2. Check if the digest is stale
Read `data.json` and check `lastRun.date`.
- If `lastRun` is missing OR the date is not today → **run the digest now**
- If `lastRun.date` is already today → skip and tell the user the digest is fresh

## 3. Run the digest (if stale)
Use the Gmail MCP tool to search for recent newsletter emails with a **single broad search**:
- Query: `in:inbox newer_than:3d`
- Read the top 10 results and identify newsletter content from FT, TechCrunch, NYT (or any enabled source in `data.json`)
- Note: emails may arrive as forwards (subject starts with "FW:") — look inside the body for the original newsletter content
- Do NOT search per-source — one search only

Summarise all the content into the following JSON structure and POST it to `http://localhost:3000/api/push-digest`:

```json
{
  "digest": {
    "date": "<today's date, e.g. March 2, 2026>",
    "top_today": [ ...10 most important stories across all sources... ],
    "tech": [ ...tech stories... ],
    "us_business": [ ...US business stories... ],
    "india_business": [ ...India business stories... ],
    "global_economies": [ ...global economy stories... ],
    "politics": [ ...politics stories... ],
    "everything_else": [ ...anything that doesn't fit the above... ]
  }
}
```

Each item in every array: `{ "headline": "...", "description": "...", "source": "<source name>" }`

Rules:
- Max 10 items per category, 10 items in top_today
- top_today = the single most important story from each major topic (no topic repeated)
- One headline per topic — don't repeat the same event across multiple items
- Be concise: headlines under 120 chars, descriptions under 180 chars

## 4. Confirm
Tell the user the digest is ready at http://localhost:3000
(No need to mention server startup — it runs automatically.)

---

## Inbox snapshot (only when user says "sync inbox")
Use the Gmail MCP tool to fetch recent emails from the past 3 days — **any sender, not just newsletter sources**.
Compute 3 days before today's date and use `after:YYYY/MM/DD` format in the search query.
Fetch up to 50 emails total. Use the snippet returned directly from the search results — do NOT call gmail_read_message for individual emails.

For each email, extract:
- `from` — sender name + email address
- `subject` — email subject line
- `date` — date received (e.g. "Mar 1, 2026")
- `snippet` — first 200 characters of the email body

Then POST to `http://localhost:3000/api/push-inbox`:
```json
{
  "emails": [
    { "from": "John Doe <john@example.com>", "subject": "...", "date": "Mar 1, 2026", "snippet": "..." },
    ...
  ]
}
```

# currentDate
Today's date is 2026-03-02.
