# Requirements Document

## Introduction

Integration of Google Sheets as a data storage backend for the DevTools Pro landing page. When a customer submits the signup form after making a UPI payment, the form data (name, email, selected plan, UTR/Transaction ID) along with subscription start and end dates will be stored in a Google Sheet. This enables subscription tracking and customer management without requiring a traditional backend server. The integration uses Google Apps Script deployed as a web app to receive form submissions from the static client-side page.

## Glossary

- **Landing_Page**: The existing static website that presents Kiro subscription plans and collects customer data via a signup form
- **Signup_Form**: The existing contact form that collects First Name, Last Name, Email, selected Plan, and UTR/Transaction ID
- **Google_Sheet**: A Google Sheets spreadsheet that stores all customer subscription records
- **Apps_Script_Endpoint**: A Google Apps Script web app deployed as an HTTPS endpoint that receives form data via POST requests and writes rows to the Google_Sheet
- **Subscription_Record**: A single row in the Google_Sheet representing one customer's subscription data
- **Subscription_Start_Date**: The date when the customer submits the form and payment is recorded
- **Subscription_End_Date**: The date exactly one month after the Subscription_Start_Date, representing when the subscription period expires
- **Subscription_Status**: A field indicating whether a subscription is "Active" or "Expired" based on the current date relative to the Subscription_End_Date
- **UTR**: Unique Transaction Reference number provided by the customer as proof of UPI payment
- **Submission_Payload**: The JSON object sent from the Landing_Page to the Apps_Script_Endpoint containing form field values

## Requirements

### Requirement 1: Google Apps Script Web App Endpoint

**User Story:** As the site owner, I want a serverless endpoint that receives form submissions, so that customer data is stored without requiring a dedicated backend server.

#### Acceptance Criteria

1. THE Apps_Script_Endpoint SHALL accept HTTP POST requests with a JSON Submission_Payload
2. THE Apps_Script_Endpoint SHALL be deployed as a Google Apps Script web app with "Anyone" access (no authentication required for submissions)
3. WHEN the Apps_Script_Endpoint receives a valid Submission_Payload, THE Apps_Script_Endpoint SHALL append a new Subscription_Record row to the Google_Sheet
4. WHEN the Apps_Script_Endpoint successfully writes data, THE Apps_Script_Endpoint SHALL return a JSON response with a "success" status and HTTP 200
5. IF the Apps_Script_Endpoint fails to write data, THEN THE Apps_Script_Endpoint SHALL return a JSON response with an "error" status and a descriptive error message

### Requirement 2: Submission Payload Structure

**User Story:** As the site owner, I want structured data sent from the form, so that all relevant customer and subscription information is captured consistently.

#### Acceptance Criteria

1. THE Submission_Payload SHALL contain the following fields: firstName, lastName, email, selectedPlan, utrId, submissionTimestamp
2. THE Landing_Page SHALL generate the submissionTimestamp as an ISO 8601 formatted date-time string at the moment of form submission
3. THE Submission_Payload SHALL use the selectedPlan value exactly as displayed in the form (e.g., "Pro", "Pro+", "Pro Max", "Power")

### Requirement 3: Google Sheet Data Schema

**User Story:** As the site owner, I want subscription data organized in clear columns, so that I can easily review and manage customer records.

#### Acceptance Criteria

1. THE Google_Sheet SHALL contain the following columns in order: Timestamp, First Name, Last Name, Email, Selected Plan, UTR/Transaction ID, Subscription Start Date, Subscription End Date, Subscription Status
2. THE Apps_Script_Endpoint SHALL write the Subscription_Start_Date as the date portion of the submissionTimestamp in DD/MM/YYYY format
3. THE Apps_Script_Endpoint SHALL calculate the Subscription_End_Date as exactly one calendar month after the Subscription_Start_Date in DD/MM/YYYY format
4. THE Apps_Script_Endpoint SHALL set the initial Subscription_Status value to "Active" for every new Subscription_Record

### Requirement 4: Client-Side Form Submission to Endpoint

**User Story:** As a customer, I want my form data sent to the storage backend when I submit, so that my subscription is recorded without disrupting my experience.

#### Acceptance Criteria

1. WHEN the Signup_Form passes all validation checks, THE Landing_Page SHALL send a POST request to the Apps_Script_Endpoint with the Submission_Payload before performing the WhatsApp redirect
2. THE Landing_Page SHALL send the POST request asynchronously without blocking the user interface
3. THE Landing_Page SHALL proceed with the WhatsApp redirect regardless of whether the POST request succeeds or fails
4. THE Landing_Page SHALL use the fetch API with mode "no-cors" or handle CORS appropriately when communicating with the Apps_Script_Endpoint

### Requirement 5: Duplicate Submission Prevention

**User Story:** As the site owner, I want to avoid storing duplicate records for the same transaction, so that subscription data remains clean and accurate.

#### Acceptance Criteria

1. WHEN the Apps_Script_Endpoint receives a Submission_Payload, THE Apps_Script_Endpoint SHALL check whether a Subscription_Record with the same UTR value already exists in the Google_Sheet
2. IF a Subscription_Record with the same UTR already exists, THEN THE Apps_Script_Endpoint SHALL skip the write operation and return a JSON response indicating "duplicate"
3. THE duplicate check SHALL be case-insensitive when comparing UTR values

### Requirement 6: Subscription Date Calculation

**User Story:** As the site owner, I want subscription end dates calculated automatically, so that I can track when each customer's subscription expires.

#### Acceptance Criteria

1. THE Apps_Script_Endpoint SHALL calculate the Subscription_End_Date by adding one calendar month to the Subscription_Start_Date
2. WHEN the Subscription_Start_Date is January 31, THE Apps_Script_Endpoint SHALL set the Subscription_End_Date to February 28 (or February 29 in a leap year)
3. WHEN the Subscription_Start_Date is the last day of a month, THE Apps_Script_Endpoint SHALL set the Subscription_End_Date to the last day of the following month

### Requirement 7: Error Handling on Client Side

**User Story:** As a customer, I want the form submission to work smoothly even if the data storage fails, so that my subscription process is not interrupted.

#### Acceptance Criteria

1. IF the POST request to the Apps_Script_Endpoint fails due to a network error, THEN THE Landing_Page SHALL log the error to the browser console and continue with the WhatsApp redirect
2. IF the POST request to the Apps_Script_Endpoint returns a non-success response, THEN THE Landing_Page SHALL log the response details to the browser console and continue with the WhatsApp redirect
3. THE Landing_Page SHALL set a timeout of 10 seconds for the POST request to the Apps_Script_Endpoint

### Requirement 8: Configuration Management

**User Story:** As the site owner, I want the endpoint URL stored in a single configurable location, so that I can update it without searching through the codebase.

#### Acceptance Criteria

1. THE Landing_Page SHALL store the Apps_Script_Endpoint URL in a named constant at the top of the JavaScript file alongside the existing WHATSAPP_NUMBER configuration
2. THE Landing_Page SHALL reference the Apps_Script_Endpoint URL only through the named constant
