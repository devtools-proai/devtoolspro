# Tasks

## Task 1: Create HTML Page Structure

Create `index.html` with the full semantic HTML structure for all sections.

- [x] 1.1 Create `index.html` with HTML5 boilerplate, meta viewport tag, page title, and links to `styles.css` and `script.js`
- [x] 1.2 Add `<header>` with navigation/logo area and smooth-scroll anchor links to each section
- [x] 1.3 Add Hero section with main heading ("Kiro — AI-Powered Development Environment"), subheading describing capabilities (engineering rigor, intent management, long-running tasks, code validation), and CTA button linking to signup form
- [x] 1.4 Add AI Models section with badge/chip elements for all 7 models (Claude Sonnet 4.5, Claude Sonnet 4.6, Claude Opus 4.8, Auto, Qwen3 Coder Next, DeepSeek v3.2, MiniMax 2.1) with visual distinction between free and premium models
- [x] 1.5 Add Pricing section with 5 plan cards (Free, Pro, Pro+, Pro Max, Power) each containing: plan name, original price with `<del>` tag (except Free), discounted price in highlighted `<span>`, credit count, model list, and a "Prices shown without GST" disclaimer
- [x] 1.6 Add Trust section with shield/checkmark SVG icon and "100% Working, No Scam" badge text
- [x] 1.7 Add Signup Form section with: First Name input (required), Last Name input (required), Email ID input (required, type="email"), Kiro Plan dropdown (5 options), and submit button — all with proper `<label>` elements and `aria-required` attributes
- [x] 1.8 Add `<footer>` with copyright text

## Task 2: Create CSS Styles

Create `styles.css` with all layout, typography, color, and responsive styles.

- [x] 2.1 Set up CSS custom properties for color palette (primary #4F46E5, accent #10B981, backgrounds, text colors), typography (system font stack), and spacing scale
- [x] 2.2 Add base reset styles, smooth scroll behavior on `html`, and box-sizing border-box
- [x] 2.3 Style the header/navigation with fixed or sticky positioning and transparent-to-solid scroll behavior
- [x] 2.4 Style the Hero section with gradient background, centered text layout, large heading (3rem), subtitle, and CTA button with hover/focus states
- [x] 2.5 Style the AI Models section with flexbox wrapping badge/chip layout, distinguishing free models (outlined) from premium models (filled accent)
- [x] 2.6 Style the Pricing section as a responsive grid: single column below 768px, multi-column above 768px; style cards with shadow, rounded corners, highlighted popular plan border; style original price with strikethrough in gray and discounted price in large accent green
- [x] 2.7 Style the Trust section with centered layout, badge styling with icon and bold text
- [x] 2.8 Style the Signup Form with centered card layout, proper input field styling, focus states, validation error styling (red border and message), and submit button matching CTA style
- [x] 2.9 Add responsive media queries: ≤768px single-column stacked layout, 768–1024px 2-3 column grid, >1024px up to 5-column grid with max-width container
- [x] 2.10 Add accessibility styles: focus-visible outlines, reduced-motion media query, minimum touch target sizes (44x44px)

## Task 3: Create JavaScript Form Logic

Create `script.js` with form validation and WhatsApp redirect functionality.

- [x] 3.1 Define configurable WhatsApp phone number constant at top of file
- [x] 3.2 Add form submit event listener that prevents default submission
- [x] 3.3 Implement validation logic: check First Name (min 1 char), Last Name (min 1 char), Email (valid format via regex), and Plan selection; display inline error messages for invalid fields
- [x] 3.4 Implement WhatsApp redirect: on successful validation, construct pre-filled message with template ("Hi, I'm interested in Kiro!\nName: {First} {Last}\nEmail: {Email}\nSelected Plan: {Plan}"), URL-encode with `encodeURIComponent()`, build `https://wa.me/{number}?text={encoded_message}`, and open in new tab with `window.open()`
- [x] 3.5 Add blur event listeners on form inputs for real-time validation feedback as user fills in fields

## Task 4: Final Polish and Verification

Verify the complete page works correctly end-to-end.

- [x] 4.1 Verify all 5 pricing cards display correct original and discounted prices (Free: $0, Pro: $20→$10, Pro+: $40→$20, Pro Max: $100→$50, Power: $200→$100)
- [x] 4.2 Verify form validation prevents submission with empty or invalid fields and shows error messages
- [x] 4.3 Verify WhatsApp redirect URL is correctly formed with all form data URL-encoded
- [x] 4.4 Verify responsive layout: test at 320px, 768px, and 1200px viewport widths — no horizontal overflow, readable text, touch-friendly targets
- [x] 4.5 Verify accessibility: all form fields have associated labels, focus styles are visible, color contrast meets WCAG AA
