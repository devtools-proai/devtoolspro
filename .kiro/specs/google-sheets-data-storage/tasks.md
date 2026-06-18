# Implementation Plan: Google Sheets Data Storage

## Overview

Implement a fire-and-forget Google Sheets integration for the DevTools Pro signup form. The server-side component (Code.gs) handles receiving POST requests, deduplicating by UTR, calculating subscription dates, and writing rows. The client-side modification (script.js) constructs the payload and sends it asynchronously before the WhatsApp redirect.

## Tasks

- [x] 1. Create Google Apps Script backend (Code.gs)
  - [x] 1.1 Create Code.gs with helper functions (formatDate, calculateEndDate, isDuplicate)
    - Create the file `/media/rishabhk165/DATA/kiri-sale/Code.gs`
    - Implement `formatDate(date)` that formats a Date object to DD/MM/YYYY string
    - Implement `calculateEndDate(startDate)` that adds one calendar month, clamping to last day of target month when overflow occurs (e.g., Jan 31 → Feb 28)
    - Implement `isDuplicate(utrId)` that reads column F (UTR/Transaction ID) from the active sheet and performs a case-insensitive comparison, returning true if a match exists
    - _Requirements: 3.2, 3.3, 5.1, 5.3, 6.1, 6.2, 6.3_

  - [x] 1.2 Implement doPost entry point in Code.gs
    - Add `doPost(e)` function that parses `e.postData.contents` as JSON
    - Validate that all required fields are present (firstName, lastName, email, selectedPlan, utrId, submissionTimestamp)
    - Return `{ status: "error", message: "Invalid payload" }` if JSON parsing fails
    - Return `{ status: "error", message: "Missing required field: <name>" }` if any field is missing
    - Call `isDuplicate(utrId)` and return `{ status: "duplicate", message: "UTR already exists" }` if duplicate found
    - Parse submissionTimestamp to derive Subscription Start Date (DD/MM/YYYY) and calculate End Date
    - Append a row to the sheet with columns: Timestamp, First Name, Last Name, Email, Selected Plan, UTR/Transaction ID, Subscription Start Date, Subscription End Date, "Active"
    - Return `{ status: "success", message: "Record added successfully" }` on success
    - Wrap in try-catch and return `{ status: "error", message: "Failed to write: <details>" }` on sheet API failure
    - All responses use `ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON)`
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1, 3.1, 3.2, 3.3, 3.4, 5.2_

- [x] 2. Checkpoint - Review Code.gs
  - Ensure Code.gs is complete and correct, ask the user if questions arise.

- [x] 3. Modify script.js for client-side integration
  - [x] 3.1 Add the Google Sheets endpoint constant and submitToGoogleSheets function
    - Add `const GOOGLE_SHEETS_ENDPOINT = 'https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec';` at the top of script.js alongside the existing `WHATSAPP_NUMBER` constant
    - Implement `async function submitToGoogleSheets(payload)` outside the DOMContentLoaded listener
    - Use `AbortController` with a 10-second timeout (`setTimeout(() => controller.abort(), 10000)`)
    - Send a `fetch` POST request with JSON body and `Content-Type: application/json` header, passing `signal: controller.signal`
    - On non-ok response, log to `console.error` with response status
    - Catch errors (network failures, AbortError for timeout) and log to `console.error`
    - Clear timeout in `finally` block
    - _Requirements: 4.2, 4.4, 7.1, 7.2, 7.3, 8.1, 8.2_

  - [x] 3.2 Integrate submitToGoogleSheets into the form submit handler
    - In the existing form submit event listener, after validation passes and before `window.open(whatsapp...)`:
    - Build the Submission_Payload object: `{ firstName, lastName, email, selectedPlan, utrId, submissionTimestamp: new Date().toISOString() }`
    - Use trimmed form values and the `selectedPlan` variable exactly as stored
    - Call `submitToGoogleSheets(payload)` without `await` (fire-and-forget)
    - The WhatsApp redirect and `showStep(4)` proceed immediately regardless of the fetch outcome
    - _Requirements: 2.1, 2.2, 2.3, 4.1, 4.3_

- [x] 4. Final checkpoint
  - Ensure all changes are complete and consistent, ask the user if questions arise.

## Notes

- Code.gs is a Google Apps Script file that the user will manually paste into the Apps Script editor and deploy as a web app with "Anyone" access
- The `GOOGLE_SHEETS_ENDPOINT` constant contains a placeholder `<DEPLOYMENT_ID>` that the user must replace with their actual deployment ID after deploying the Apps Script
- No test framework is set up for this static site; correctness is verified through manual testing against a live Google Sheet
- The Google Sheet must have headers in Row 1 matching the schema: Timestamp, First Name, Last Name, Email, Selected Plan, UTR/Transaction ID, Subscription Start Date, Subscription End Date, Subscription Status

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "3.1"] },
    { "id": 2, "tasks": ["3.2"] }
  ]
}
```
