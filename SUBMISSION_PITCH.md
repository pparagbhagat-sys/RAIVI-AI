# RAIVI — Voice-first civic issue reporting

## The problem

Reporting a pothole, water leak, overflowing garbage or broken streetlight can be difficult when a person has to type a long form or does not know which department to contact. After submitting a complaint, people also need a simple way to follow its progress.

## The solution

RAIVI lets a resident describe a local issue by voice in Hindi, English or Hinglish. The citizen reviews the transcript, confirms or changes the suggested category, and can add a name, GPS coordinates or address, and a photo. RAIVI creates a complaint ID, suggests a sample department route, and provides a status timeline. Staff can review reports, listen to a synthetic Gnani voice readout of the transcript, and add status updates and notes for the citizen.

## What I built

The demo uses Gnani Prisma v3.0 for speech-to-text and Gnani Timbre v2.5 for text-to-speech. A Node.js server handles the Gnani API calls and routes; SQLite stores reports and status history. The browser records audio and converts it to WAV for transcription. Staff can review the complaint, see its submitted location, open the location on a map, and update its status.

## Scope and limitations

This is a Nagpur demonstration. Department routing is sample data, staff-entered statuses are internal to RAIVI, and the app does not file complaints with government systems. Official department contacts and an authorized filing integration would be needed for real-world deployment.
