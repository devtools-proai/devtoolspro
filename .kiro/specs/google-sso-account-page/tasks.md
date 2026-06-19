# Implementation Plan: Google SSO Account Page

## Overview

This implementation enhances the existing `dashboard.html` with a full Account Page experience powered by Google SSO authentication. The backend endpoints already exist (`/auth/google`, `/auth/me`, `/auth/cancel-plan`, `/auth/google-client-id`), so the work is primarily frontend: building the Account Page State Manager, WhatsApp Template Generator, Plan Action Cards (renew, upgrade, cancel), and wiring confirmation flows. Property-based tests validate correctness of auth logic and WhatsApp URL generation using fast-check.

## Tasks

- [ ] 1. Set up testing infrastructure and shared utilities
  - [x] 1.1 Initialize test environment with fast-check and Jest
    - Create `backend/package.json` devDependencies for `jest` and `fast-check`
    - Create `backend/jest.config.js` with standard configuration
    - Create `backend/tests/` directory structure
    - Add `"test": "jest --run"` script to `backend/package.json`
    - _Requirements: Testing Strategy from design_

  - [x] 1.2 Create Plan Hierarchy utility module
    - Create `backend/plan-hierarchy.js` exporting `PLAN_HIERARCHY` array and `getUpgradeOptions(currentPlan)` function
    - `PLAN_HIERARCHY`: `[{ name: 'Pro', price: 946, priceUSD: 10 }, { name: 'Pro+', price: 1892, priceUSD: 20 }, { name: 'Pro Max', price: 4730, priceUSD: 50 }, { name: 'Power', price: 9461, priceUSD: 100 }]`
    - `getUpgradeOptions(planName)` returns only plans ranked above the given plan; returns empty array for "Power"
    - _Requirements: 4.2, 4.3_

  - [ ]* 1.3 Write property test for plan hierarchy filtering
    - **Property 5: Plan hierarchy filtering**
    - For any valid plan name, `getUpgradeOptions` returns only plans strictly ranked above the input plan; for "Power" returns empty list
    - **Validates: Requirements 4.2, 4.3**

- [x] 2. Implement WhatsApp Template Generator module
  - [x] 2.1 Create WhatsApp Template Generator as a standalone JS module
    - Create `whatsapp-templates.js` (can be included inline in dashboard.html or loaded separately)
    - Implement `CONFIG` object with `API_BASE`, `WHATSAPP_NUMBER: '919019879108'`, `MAX_WHATSAPP_MESSAGE_LENGTH: 1000`
    - Implement `generateRenewalMessage(user)` — returns encoded WhatsApp URL with renewal template
    - Implement `generateUpgradeMessage(user, newPlan)` — returns encoded WhatsApp URL with upgrade template
    - Implement `generateCancellationMessage(user)` — returns encoded WhatsApp URL with cancellation template
    - Implement `openWhatsApp(url)` — opens URL in new tab with fallback for blocked popups
    - Handle null `planEndDate` by substituting "N/A"
    - Handle missing name/email by substituting empty string
    - Enforce 1000 character limit on encoded message text, truncating body while preserving user fields
    - Templates must match formats defined in design: Renew, Upgrade, Cancel
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 3.5, 4.5, 5.6_

  - [ ]* 2.2 Write property test for WhatsApp URL structural correctness
    - **Property 6: WhatsApp URL structural correctness**
    - For any action type and user data, the URL matches `https://api.whatsapp.com/send?phone={supportNumber}&text={encodedMessage}`
    - **Validates: Requirements 6.1**

  - [ ]* 2.3 Write property test for required fields inclusion
    - **Property 7: WhatsApp message includes all required user fields**
    - For any user data and action type, the message contains name, email, plan, and expiry (or "N/A")
    - **Validates: Requirements 6.2, 6.5, 6.6, 3.4, 4.4, 5.5**

  - [ ]* 2.4 Write property test for template format correctness
    - **Property 8: WhatsApp message template format correctness**
    - For any user data, renewal/upgrade/cancel messages match their respective template formats with fields correctly substituted
    - **Validates: Requirements 3.5, 4.5, 5.6**

  - [ ]* 2.5 Write property test for URL encoding round-trip
    - **Property 9: URL encoding round-trip**
    - For any message string, URL-encoding then decoding produces the original string
    - **Validates: Requirements 6.3**

  - [ ]* 2.6 Write property test for message length constraint
    - **Property 10: Message length constraint with field preservation**
    - For any user data and action type, encoded message text does not exceed 1000 characters; if truncated, user detail fields are preserved
    - **Validates: Requirements 6.7**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement Account Page State Manager in dashboard.html
  - [x] 4.1 Add state management and expired plan state to dashboard.html
    - Refactor `init()` and `showDashboard()` to implement full state machine: LOADING, SIGNED_OUT, SIGNED_IN_NO_PLAN, SIGNED_IN_ACTIVE, SIGNED_IN_CANCELLED, SIGNED_IN_EXPIRED, ERROR
    - Add expired plan state UI: red "Expired" badge + "Renew" link to pricing
    - Add error state UI: error message + retry button
    - Add 10-second timeout on `/auth/me` fetch with AbortController
    - Show cached user data with "Data may be stale" indicator when network fails but localStorage has data
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 7.1, 7.2, 7.3, 7.4_

  - [x] 4.2 Implement Plan Renewal flow UI in dashboard.html
    - Add "Renew Plan" button visible when plan_status is "active", "cancelled", or "expired"; hidden when "none"
    - Add renewal confirmation card: shows current plan name, renewal price (from PLAN_HIERARCHY), and "Confirm via WhatsApp" button
    - On "Confirm via WhatsApp" click: call `generateRenewalMessage(user)` and `openWhatsApp(url)`
    - If `plan_end_date` or `current_plan` is null, show error message and do NOT open confirmation card
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 4.3 Implement Plan Upgrade flow UI in dashboard.html
    - Add "Upgrade Plan" button visible when plan_status is "active" or "cancelled"; hidden when current plan is "Power"
    - On click: show upgrade selection card listing plans above current plan (using `getUpgradeOptions`) with name and price
    - On plan selection + "Confirm via WhatsApp": call `generateUpgradeMessage(user, selectedPlan)` and `openWhatsApp(url)`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 4.4 Enhance Plan Cancellation flow in dashboard.html
    - Update existing cancel modal to include "Notify via WhatsApp" button alongside "Yes, Cancel"
    - On confirm: POST to `/auth/cancel-plan`, on success update badge to "Cancelled", hide cancel button, show "Your plan remains active until [date]"
    - On "Notify via WhatsApp": call `generateCancellationMessage(user)` and `openWhatsApp(url)`
    - On cancel API failure: show error message with WhatsApp support link fallback
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [x] 4.5 Implement Sign Out and session persistence
    - Ensure Sign Out clears `dt_token` and `dt_user` from localStorage, reloads to sign-in view
    - On page load: check for token → validate with `/auth/me` → render dashboard or sign-in
    - On 401 from `/auth/me`: clear localStorage and show sign-in screen
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement responsive design and accessibility
  - [x] 6.1 Apply responsive layout to Account Page
    - Ensure single-column layout below 640px, two-column grid at 640px+
    - Confirmation cards and plan selection lists render full-width stacked vertically on mobile
    - All interactive elements have minimum 44x44px touch targets on mobile
    - Minimum 16px font size on viewports narrower than 640px
    - Use same dark theme, glass morphism, indigo/purple color palette as landing page
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [x] 6.2 Add WhatsApp popup fallback
    - If `window.open` is blocked (returns null), display the message text in a copyable textarea
    - Add a "Copy Message" button that copies text to clipboard
    - _Requirements: Design — Graceful Degradation_

- [ ] 7. Write property-based tests for auth module
  - [ ]* 7.1 Write property test for token audience validation
    - **Property 1: Token audience validation**
    - For any token payload, if `aud` matches `GOOGLE_CLIENT_ID` → valid; if not → invalid with error message
    - Mock fetch to return controlled payloads
    - **Validates: Requirements 1.2, 1.6**

  - [ ]* 7.2 Write property test for user record invariants on findOrCreate
    - **Property 2: User record invariants on findOrCreate**
    - New user: `plan_status` = "none", `current_plan` = null, `last_login` recent; Existing user: only `last_login` and `picture` updated
    - Mock Supabase client
    - **Validates: Requirements 1.3, 1.4**

  - [ ]* 7.3 Write property test for JWT claims correctness
    - **Property 3: JWT claims correctness**
    - For any user object, JWT decodes to contain `userId`, `email`, `name` matching input, with 7-day expiry
    - **Validates: Requirements 1.5**

  - [ ]* 7.4 Write property test for expired/invalid JWT rejection
    - **Property 4: Expired or invalid JWT rejection**
    - Any non-valid JWT or expired JWT is rejected by `requireAuth` with 401 status
    - Mock req/res objects
    - **Validates: Requirements 1.7, 1.10**

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using fast-check
- Unit tests validate specific examples and edge cases
- All backend endpoints already exist — no new server routes needed
- The WhatsApp Template Generator module should be written so it can be copy-pasted inline into dashboard.html (no ES module imports in the browser)
- The plan-hierarchy.js module is shared between backend tests and frontend (inline copy in dashboard.html)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.6"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "4.5"] },
    { "id": 5, "tasks": ["6.1", "6.2"] },
    { "id": 6, "tasks": ["7.1", "7.2", "7.3", "7.4"] }
  ]
}
```
