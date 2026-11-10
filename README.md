# RAIVI - Reporting AI with Voice Integration

RAIVI lets citizens report civic issues by voice, with an optional photo and location. It transcribes the report with Gnani Prisma, speaks a confirmation with Gnani Timbre, routes the complaint to the responsible department from a directory, stores it in a database, and lets the citizen track its status until it is resolved.

## Files

| File | Purpose |
|---|---|
| `server.js` | Local server: serves the app, reads secrets from environment variables, runs the database and routing |
| `index.html` | Citizen app: voice report, confirmation, tracking |
| `staff.html` | Staff console: login, view complaints, update status |
| `common.js` | Shared helpers: report view, audio conversion, speech confirmation |
| `styles.css` | Styling |
| `data/raivi.db` | SQLite database, created automatically on first run |
| `data/uploads/` | Photos attached to complaints, created automatically |

## Setup (Node.js 22.5 or newer; Node 24 recommended)

1. Put all the files in one folder.
2. Copy `.env.example` to `.env` and fill in `GNANI_API_KEY` and a unique `STAFF_PASSWORD` of at least 12 characters. The `.env` file stays on the server and is ignored by Git.
3. Start the server: `node server.js`. The local `.env` values are loaded automatically; process environment variables override them.
4. Open:
   - Citizen app: http://localhost:3000
   - Staff console: http://localhost:3000/staff

Alternatively, set the values once in your deployment host's Environment Variables or Secrets settings. Visitors never need the API key; it stays server-side. Never put secrets in either HTML file or commit `.env`.

To set them for only the current PowerShell session instead of using `.env`:
```
$env:GNANI_API_KEY="your_key"; $env:STAFF_PASSWORD="a-unique-password-at-least-12-chars"; node server.js
```

## How a report flows

1. The citizen speaks (up to 25 seconds) in Hindi, English or Hinglish.
2. The transcript is shown for confirmation. The citizen can record again.
3. RAIVI suggests a category (Road, Water, Garbage, Streetlight, Electricity, or General) and the department it routes to. The citizen can change the category.
4. The citizen can optionally add their full name, GPS coordinates, an address or landmark, or both location types. Staff can see provided details and open a location on a map.
5. The report is saved with status history: Received, then Routed.
6. Staff update the status to In Progress or Resolved, with an optional note that the citizen can see.
7. The citizen tracks progress using the complaint ID.

## Important limits (say these in your submission)

- The department directory is **sample data for Nagpur**. Every routing must be verified against official sources before real use.
- RAIVI does not file complaints with government systems. The citizen uses the official channel, which is an authorised integration step outside this demo.
- Status updates come from the staff console. They are not live from government records.
- Complaint IDs act as access keys in this demo. Production use would need proper authentication and data protection.
- The full name is optional. When supplied, it and the location are visible to signed-in staff and are omitted from citizen tracking responses.
- Staff access uses a short-lived, HttpOnly, SameSite session cookie; failed sign-ins are rate-limited. Sessions are cleared when the server restarts. The staff password and Gnani API key must be supplied as environment variables.
- Use HTTPS if the server is reachable beyond your own computer. Do not expose this demo server directly to the public internet.
- Photos are stored locally. Faces and number plates should be avoided or blurred.
- Original recordings are sent to Gnani for transcription and are not saved with new complaints. Staff can request a synthetic Gnani Timbre readout of the transcript from the staff console instead of hearing the complainant's voice.
- Voice files saved by an earlier version remain on disk, but the app no longer serves or plays them.

## Troubleshooting

- `Set GNANI_API_KEY in the environment before starting RAIVI`: add the key to `.env` for local use or set it in your deployment host's environment/secrets settings.
- `422` from speech service: the request is missing a required field. Check the terminal output.
- `401` from speech service: the API key is wrong or expired. Create a new key at app.gnani.ai/voice.
- No sound after submitting: check your browser's audio and autoplay settings, and the terminal for `TTS call` messages.
- Microphone blocked: allow microphone access for localhost in your browser settings.

## Security reminders

- Never commit your API key or the `data/` folder to a public repository.
- Rotate the Gnani API key previously embedded in `server.js` before using this version, since it was stored in source code.
