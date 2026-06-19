# Requirements Document

## Introduction

This feature integrates Google Single Sign-On (SSO) authentication and creates a dedicated Account Page where authenticated users can view their current subscription plan, and manage it through actions (renew, upgrade, cancel) — each with an option to contact support via a pre-filled WhatsApp message template containing the user's details.

## Glossary

- **Account_Page**: The authenticated frontend page where users view and manage their subscription plan
- **Auth_Service**: The backend authentication module that handles Google SSO token verification, user creation, and JWT session management
- **Plan_Manager**: The backend service responsible for handling plan renewal, upgrade, and cancellation operations
- **WhatsApp_Template_Generator**: The component that constructs pre-filled WhatsApp message URLs containing user details (name, email, current plan, expiration date) and the requested action
- **User**: A person who authenticates via Google SSO and has a record in the users table
- **Session_Token**: A JWT token issued after successful Google SSO authentication, stored in localStorage and sent with API requests
- **Subscription**: A user's active plan record including plan name, status, start date, and end date

## Requirements

### Requirement 1: Google SSO Authentication

**User Story:** As a user, I want to sign in using my Google account, so that I can securely access my account page without creating a separate username and password.

#### Acceptance Criteria

1. WHEN a user clicks the "Sign in with Google" button, THE Auth_Service SHALL initiate the Google OAuth consent flow using the Google Identity Services library
2. WHEN Google returns a valid ID token, THE Auth_Service SHALL verify the token against the Google tokeninfo endpoint and confirm the audience matches the configured GOOGLE_CLIENT_ID
3. WHEN a verified Google user does not exist in the users table, THE Auth_Service SHALL create a new user record with google_id, email, name, picture, plan_status set to "none", current_plan set to null, and current timestamp as last_login
4. WHEN a verified Google user already exists in the users table, THE Auth_Service SHALL update the last_login timestamp and picture field
5. WHEN authentication is successful, THE Auth_Service SHALL return a JWT Session_Token with a 7-day expiry containing userId, email, and name claims, and the client SHALL include this token in subsequent protected requests via the Authorization header using the Bearer scheme
6. IF the Google token verification fails or the audience does not match GOOGLE_CLIENT_ID, THEN THE Auth_Service SHALL return a 401 status with an error message indicating the token is invalid
7. IF the JWT Session_Token is expired or invalid on a protected request, THEN THE Auth_Service SHALL return a 401 status with an error message indicating the session is invalid or expired
8. IF the idToken field is missing or empty in the authentication request body, THEN THE Auth_Service SHALL return a 400 status with an error message indicating that the ID token is required
9. IF the Auth_Service fails to create or retrieve the user record from the database, THEN THE Auth_Service SHALL return a 500 status with an error message indicating that user creation failed
10. IF a protected request is made without an Authorization header or without the Bearer scheme, THEN THE Auth_Service SHALL return a 401 status with an error message indicating that authentication is required

### Requirement 2: Account Page — Plan Display

**User Story:** As an authenticated user, I want to see my current subscription details on my account page, so that I know which plan I am on and when it expires.

#### Acceptance Criteria

1. WHEN an authenticated user navigates to the Account_Page, THE Account_Page SHALL display the user's name, email, profile picture, current plan name, plan status, subscription start date (formatted as DD/MM/YYYY in the user's locale), and subscription end date (formatted as DD/MM/YYYY in the user's locale)
2. WHILE the user has plan_status "active", THE Account_Page SHALL display a green "Active" badge next to the plan name
3. WHILE the user has plan_status "cancelled", THE Account_Page SHALL display an amber "Cancelled" badge and show the text "Active until [plan_end_date]"
4. WHILE the user has plan_status "expired", THE Account_Page SHALL display a red "Expired" badge and provide a link to the pricing section on the landing page labeled as a renewal action
5. WHILE the user has plan_status "none", THE Account_Page SHALL display "No Active Plan" and provide a link to the pricing section on the landing page
6. WHEN the Account_Page is loading user data, THE Account_Page SHALL display a loading indicator until the data is retrieved or the request fails within 10 seconds
7. IF the Account_Page fails to retrieve user data, THEN THE Account_Page SHALL display an error message indicating the data could not be loaded and provide an option to retry

### Requirement 3: Plan Renewal

**User Story:** As an authenticated user with an expiring or expired plan, I want to renew my current plan, so that I can continue using the service without interruption.

#### Acceptance Criteria

1. WHILE the user has a plan_status of "active", "cancelled", or "expired", THE Account_Page SHALL display a "Renew Plan" button within the active plan state card
2. IF the user has a plan_status of "none", THEN THE Account_Page SHALL NOT display the "Renew Plan" button
3. WHEN the user clicks the "Renew Plan" button, THE Account_Page SHALL display a confirmation card showing the user's current plan name (as stored in the current_plan field), the renewal price matching that plan's listed price, and a "Confirm via WhatsApp" button
4. WHEN the user clicks "Confirm via WhatsApp" for renewal, THE WhatsApp_Template_Generator SHALL open the device's default WhatsApp handler with a pre-filled message to the configured support number containing: action type ("Renew"), user's full name, email, current plan name, and plan expiration date formatted as DD/MM/YYYY
5. THE WhatsApp_Template_Generator SHALL format the renewal message as: "Hi, I'd like to renew my plan.\n\nName: [name]\nEmail: [email]\nCurrent Plan: [plan]\nExpiry Date: [expiration_date]\n\nPlease process my renewal. Thank you!"
6. IF the user's plan_end_date or current_plan is unavailable when the "Renew Plan" button is clicked, THEN THE Account_Page SHALL display an error message indicating that plan details could not be loaded and SHALL NOT open the confirmation card

### Requirement 4: Plan Upgrade

**User Story:** As an authenticated user, I want to upgrade to a higher plan, so that I can access more features and credits.

#### Acceptance Criteria

1. WHILE the user has plan_status "active" or "cancelled", THE Account_Page SHALL display an "Upgrade Plan" button
2. WHEN the user clicks the "Upgrade Plan" button, THE Account_Page SHALL display a list of available plans ranked above the user's current plan in the defined plan hierarchy (Pro < Pro+ < Pro Max < Power), showing each plan's name and monthly price
3. IF the user's current plan is the highest in the hierarchy (Power), THEN THE Account_Page SHALL hide the "Upgrade Plan" button
4. WHEN the user selects a plan to upgrade to and clicks "Confirm via WhatsApp", THE WhatsApp_Template_Generator SHALL open a WhatsApp message pre-filled with: action type ("Upgrade"), user's full name, email, current plan name, desired new plan name, and plan expiration date
5. THE WhatsApp_Template_Generator SHALL format the upgrade message as: "Hi, I'd like to upgrade my plan.\n\nName: [name]\nEmail: [email]\nCurrent Plan: [current_plan]\nUpgrade To: [new_plan]\nExpiry Date: [expiration_date]\n\nPlease process my upgrade. Thank you!"

### Requirement 5: Plan Cancellation

**User Story:** As an authenticated user with an active plan, I want to cancel my subscription, so that I am not charged for the next billing cycle.

#### Acceptance Criteria

1. WHILE the user has plan_status "active", THE Account_Page SHALL display a "Cancel Plan" button
2. WHEN the user clicks the "Cancel Plan" button, THE Account_Page SHALL display a confirmation modal stating that the plan will remain active until the end of the current billing cycle and that no further charges will apply
3. WHEN the user confirms cancellation via the modal, THE Plan_Manager SHALL update the user's plan_status to "cancelled" in the database and return a success response within 5 seconds
4. IF the cancellation request fails due to a network error or server error, THEN THE Account_Page SHALL display an error message indicating that the cancellation could not be processed and advising the user to contact support via WhatsApp
5. WHEN the user confirms cancellation and also clicks "Notify via WhatsApp" in the confirmation modal, THE WhatsApp_Template_Generator SHALL open a WhatsApp message pre-filled with: action type ("Cancel"), user's full name, email, current plan name, and plan expiration date
6. THE WhatsApp_Template_Generator SHALL format the cancellation message as: "Hi, I'd like to cancel my plan.\n\nName: [name]\nEmail: [email]\nCurrent Plan: [plan]\nExpiry Date: [expiration_date]\n\nPlease confirm my cancellation. Thank you!"
7. WHEN cancellation is successful, THE Account_Page SHALL update the plan badge to "Cancelled", hide the "Cancel Plan" button, and display the message "Your plan remains active until [plan_end_date]" where plan_end_date is formatted as DD/MM/YYYY in the user's locale
8. WHILE the user has plan_status "cancelled", THE Account_Page SHALL continue to display the active plan details with the "Cancelled" badge until plan_end_date is reached

### Requirement 6: WhatsApp Message Template Generation

**User Story:** As a user performing any plan action, I want a pre-filled WhatsApp message sent to support, so that I do not need to manually type my details and the request is processed quickly.

#### Acceptance Criteria

1. THE WhatsApp_Template_Generator SHALL construct message URLs using the format "https://api.whatsapp.com/send?phone=[support_number]&text=[encoded_message]" where the support_number is a configured constant containing the full international phone number without the "+" prefix
2. THE WhatsApp_Template_Generator SHALL include the following user details in every message template in this order: full name (first name followed by last name), email address, current plan name, and plan expiration date
3. THE WhatsApp_Template_Generator SHALL URL-encode the entire message text using percent-encoding so that special characters, spaces, and line breaks are transmitted without corruption
4. WHEN the user confirms a plan action (renewal, upgrade, or cancellation), THE WhatsApp_Template_Generator SHALL open the constructed WhatsApp URL in a new browser tab
5. IF the user's plan_end_date is null, THEN THE WhatsApp_Template_Generator SHALL display "N/A" in place of the expiration date in the message template
6. IF any required user detail (full name or email address) is unavailable at the time of message construction, THEN THE WhatsApp_Template_Generator SHALL substitute an empty string for the missing field and still proceed with opening the WhatsApp URL
7. THE WhatsApp_Template_Generator SHALL limit the total encoded message text to a maximum of 1000 characters, truncating the message body if necessary while preserving all user detail fields

### Requirement 7: Session Persistence and Security

**User Story:** As a user, I want to stay signed in across page refreshes and browser sessions, so that I do not need to log in every time I visit the account page.

#### Acceptance Criteria

1. WHEN authentication is successful, THE Account_Page SHALL store the Session_Token in localStorage
2. WHEN the Account_Page loads, THE Account_Page SHALL check for an existing Session_Token and validate it by calling the /auth/me endpoint
3. WHEN the /auth/me endpoint returns a success response, THE Account_Page SHALL render the dashboard with the returned user data
4. IF the stored Session_Token is rejected by /auth/me, THEN THE Account_Page SHALL clear localStorage and display the sign-in screen
5. WHEN the user clicks "Sign Out", THE Account_Page SHALL remove the Session_Token from localStorage and redirect to the sign-in view

### Requirement 8: Account Page Responsive Design

**User Story:** As a user, I want the account page to work on both desktop and mobile devices, so that I can manage my plan from any device.

#### Acceptance Criteria

1. WHILE the viewport width is less than 640px, THE Account_Page SHALL render all plan information, action buttons, and confirmation cards in a single-column layout with no horizontal overflow
2. WHILE the viewport width is 640px or wider, THE Account_Page SHALL render plan information and action buttons in a two-column grid layout
3. THE Account_Page SHALL use the same dark theme, glass morphism styling, and indigo/purple color palette as the existing landing page and dashboard
4. WHILE the viewport width is less than 640px, THE Account_Page SHALL ensure all interactive elements (buttons, links) have a minimum touch target size of 44x44 CSS pixels
5. THE Account_Page SHALL render all text content at a minimum font size of 16px on viewports narrower than 640px to ensure readability without zooming
6. WHILE the viewport width is less than 640px, THE Account_Page SHALL display confirmation cards and plan selection lists (from renewal, upgrade, and cancellation flows) as full-width elements stacked vertically within the single-column layout
