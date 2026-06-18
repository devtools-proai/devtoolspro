# Requirements Document

## Introduction

A single-page static landing page that showcases Kiro — an AI-powered development environment — and presents promotional pricing at 50% off. The page collects user information via a contact/signup form and redirects to WhatsApp with a pre-filled message containing the submitted form data. The page must be responsive, modern, and production-ready.

## Glossary

- **Landing_Page**: The single-page static website that presents Kiro product information, pricing, trust indicators, and a signup form
- **Hero_Section**: The top portion of the Landing_Page that introduces Kiro and its core value proposition
- **Pricing_Section**: The section displaying all Kiro subscription plans with original and discounted prices
- **Trust_Section**: The section displaying trust and legitimacy indicators to build user confidence
- **Signup_Form**: The contact form collecting user details and plan selection
- **WhatsApp_Redirect**: The action triggered on form submission that opens WhatsApp with a pre-filled message
- **Plan**: A Kiro subscription tier (Free, Pro, Pro+, Pro Max, or Power)
- **Original_Price**: The full listed price before the 50% discount
- **Discounted_Price**: The price after applying the 50% promotional discount
- **Pre_Filled_Message**: The automated WhatsApp message containing the user's submitted form data

## Requirements

### Requirement 1: Hero Section Display

**User Story:** As a visitor, I want to see a clear introduction to Kiro, so that I understand what the product is and its core capabilities.

#### Acceptance Criteria

1. THE Landing_Page SHALL display a Hero_Section as the first visible content area
2. THE Hero_Section SHALL describe Kiro as an AI-powered development environment that brings engineering rigor to agentic development
3. THE Hero_Section SHALL mention the following capabilities: managing intent, completing long-running tasks, and validating code correctness
4. THE Hero_Section SHALL display a visually prominent heading and supporting description text

### Requirement 2: Pricing Section Display

**User Story:** As a visitor, I want to see all available Kiro plans with their discounted pricing, so that I can choose a plan that fits my needs.

#### Acceptance Criteria

1. THE Pricing_Section SHALL display all five Kiro plans: Free, Pro, Pro+, Pro Max, and Power
2. WHEN displaying the Free plan, THE Pricing_Section SHALL show $0/month with 50 credits, Claude Sonnet 4.5, and open weight models
3. WHEN displaying the Pro plan, THE Pricing_Section SHALL show the Original_Price of $20/month crossed out and the Discounted_Price of $10/month highlighted
4. WHEN displaying the Pro+ plan, THE Pricing_Section SHALL show the Original_Price of $40/month crossed out and the Discounted_Price of $20/month highlighted
5. WHEN displaying the Pro Max plan, THE Pricing_Section SHALL show the Original_Price of $100/month crossed out and the Discounted_Price of $50/month highlighted
6. WHEN displaying the Power plan, THE Pricing_Section SHALL show the Original_Price of $200/month crossed out and the Discounted_Price of $100/month highlighted
7. THE Pricing_Section SHALL display credit allocations: Free (50), Pro (1,000), Pro+ (2,000), Pro Max (5,000), Power (10,000)
8. THE Pricing_Section SHALL indicate that all prices are shown without GST
9. THE Pricing_Section SHALL list premium models for paid plans: Auto, Claude Sonnet 4.6, and Claude Opus 4.8

### Requirement 3: AI Models Display

**User Story:** As a visitor, I want to see which AI models are available, so that I understand the technology backing Kiro.

#### Acceptance Criteria

1. THE Landing_Page SHALL mention the following AI models: Claude Sonnet 4.5, Claude Sonnet 4.6, Claude Opus 4.8, Auto, Qwen3 Coder Next, DeepSeek v3.2, and MiniMax 2.1
2. THE Pricing_Section SHALL differentiate between models available on the Free plan and models available on paid plans

### Requirement 4: Trust and Legitimacy Section

**User Story:** As a visitor, I want to see trust indicators, so that I feel confident the offer is legitimate.

#### Acceptance Criteria

1. THE Landing_Page SHALL display a Trust_Section with a visible "100% Working, No Scam" badge or indicator
2. THE Trust_Section SHALL be visually distinct and prominently placed on the Landing_Page

### Requirement 5: Signup Form Structure

**User Story:** As a visitor, I want to fill out a signup form with my details and plan selection, so that I can express interest in a Kiro plan.

#### Acceptance Criteria

1. THE Signup_Form SHALL contain a "First Name" text input field marked as required
2. THE Signup_Form SHALL contain a "Last Name" text input field marked as required
3. THE Signup_Form SHALL contain an "Email ID" text input field marked as required
4. THE Signup_Form SHALL contain a "Kiro Plan" dropdown selection field listing all five plans: Free, Pro, Pro+, Pro Max, and Power
5. THE Signup_Form SHALL contain a submit button
6. IF a required field is left empty on submission, THEN THE Signup_Form SHALL prevent submission and display a validation message for the empty field

### Requirement 6: Form Validation

**User Story:** As a visitor, I want the form to validate my inputs, so that I submit correct information.

#### Acceptance Criteria

1. WHEN the Email ID field contains a value that does not match a valid email format, THE Signup_Form SHALL display an email validation error and prevent submission
2. WHEN all required fields contain valid values, THE Signup_Form SHALL allow submission
3. THE Signup_Form SHALL validate the First Name field contains at least one character
4. THE Signup_Form SHALL validate the Last Name field contains at least one character

### Requirement 7: WhatsApp Redirect on Form Submission

**User Story:** As a visitor, I want to be redirected to WhatsApp after submitting the form, so that I can complete my signup via chat.

#### Acceptance Criteria

1. WHEN the Signup_Form is submitted with all valid fields, THE Landing_Page SHALL redirect the user to a WhatsApp chat URL
2. THE WhatsApp_Redirect SHALL include a Pre_Filled_Message containing the submitted First Name, Last Name, Email ID, and selected Plan
3. THE Pre_Filled_Message SHALL be URL-encoded for proper display in WhatsApp
4. THE WhatsApp_Redirect SHALL open in a new browser tab or window

### Requirement 8: Responsive Design

**User Story:** As a visitor on any device, I want the page to display correctly, so that I can use the page on mobile or desktop.

#### Acceptance Criteria

1. THE Landing_Page SHALL adapt its layout for viewport widths of 320px and above
2. WHILE the viewport width is below 768px, THE Landing_Page SHALL display content in a single-column layout
3. WHILE the viewport width is 768px or above, THE Landing_Page SHALL display the Pricing_Section plans in a multi-column grid layout
4. THE Landing_Page SHALL maintain readable text sizes and touch-friendly interactive elements on all supported viewport widths

### Requirement 9: Modern Visual Design

**User Story:** As a visitor, I want the page to look professional and modern, so that I trust the brand.

#### Acceptance Criteria

1. THE Landing_Page SHALL use a clean, modern visual design with consistent spacing, typography, and color palette
2. THE Landing_Page SHALL use smooth scroll behavior for in-page navigation
3. THE Landing_Page SHALL display the Discounted_Price in a visually highlighted style distinguishable from the crossed-out Original_Price
4. THE Landing_Page SHALL load without requiring external JavaScript frameworks at runtime for core functionality

### Requirement 10: Page Performance

**User Story:** As a visitor, I want the page to load quickly, so that I do not leave before seeing the content.

#### Acceptance Criteria

1. THE Landing_Page SHALL be a static HTML page with embedded or linked CSS and minimal JavaScript
2. THE Landing_Page SHALL not depend on server-side rendering or backend APIs for initial page display
3. THE Landing_Page SHALL render meaningful content within 2 seconds on a standard 4G connection
