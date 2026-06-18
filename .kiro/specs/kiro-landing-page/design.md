# Design Document

## Overview

A single-page static landing page built with HTML, CSS, and vanilla JavaScript. The page showcases Kiro as an AI-powered development environment, displays promotional pricing at 50% off, collects user signup information, and redirects to WhatsApp with a pre-filled message. No build tools or frameworks required — production-ready as static files.

## Architecture

### Technology Stack

- **HTML5**: Semantic markup for page structure
- **CSS3**: Custom properties, Flexbox, Grid, media queries for responsive design
- **Vanilla JavaScript**: Form validation and WhatsApp redirect logic
- **No external dependencies**: Self-contained static page

### File Structure

```
/
├── index.html          # Main landing page with all sections
├── styles.css          # All styles (responsive, animations, layout)
└── script.js           # Form validation and WhatsApp redirect logic
```

## Design Details

### Section 1: Hero/About Section

**Layout**: Full-width section with centered content, gradient background, large heading, subtitle, and call-to-action button that smooth-scrolls to the signup form.

**Content**:
- Main heading: "Kiro — AI-Powered Development Environment"
- Subheading describing engineering rigor, intent management, long-running tasks, code validation
- CTA button: "Get Started" linking to signup form

### Section 2: AI Models Showcase

**Layout**: A horizontal scrollable or wrapping badge/chip layout displaying all supported AI models.

**Models displayed**: Claude Sonnet 4.5, Claude Sonnet 4.6, Claude Opus 4.8, Auto, Qwen3 Coder Next, DeepSeek v3.2, MiniMax 2.1

**Distinction**: Free-tier models vs premium models visually differentiated with labels/colors.

### Section 3: Pricing Section

**Layout**: Responsive card grid — single column on mobile, multi-column (up to 5 cards) on desktop.

**Each pricing card contains**:
- Plan name
- Original price (struck through with `<del>` tag) — except Free plan
- Discounted price (highlighted, larger font, accent color)
- Credit count
- Available models list
- "No GST" disclaimer at the bottom of the section

**Visual treatment**:
- Cards with subtle shadow and rounded corners
- Popular/recommended plan (Pro) gets a highlighted border or "Popular" badge
- Free plan shows "$0/month" without strikethrough

### Section 4: Trust/Legitimacy Section

**Layout**: Centered section with a badge/shield icon and "100% Working, No Scam" text.

**Elements**:
- Shield or checkmark SVG icon
- Bold trust statement
- Supporting text about legitimate service

### Section 5: Signup/Contact Form

**Layout**: Centered form card with input fields stacked vertically.

**Fields**:
- First Name (text input, required, `minlength="1"`)
- Last Name (text input, required, `minlength="1"`)
- Email ID (email input, required, with pattern validation)
- Kiro Plan (select dropdown: Free, Pro, Pro+, Pro Max, Power)
- Submit button

**Validation approach**: HTML5 native validation attributes + JavaScript for custom error messages and UX. Validation runs on submit and on blur for each field.

### Section 6: WhatsApp Redirect Logic

**Flow**:
1. User submits valid form
2. JavaScript constructs WhatsApp URL: `https://wa.me/<number>?text=<encoded_message>`
3. Pre-filled message template:
   ```
   Hi, I'm interested in Kiro!
   Name: {First Name} {Last Name}
   Email: {Email ID}
   Selected Plan: {Plan}
   ```
4. Message is URL-encoded via `encodeURIComponent()`
5. Opens WhatsApp link in new tab via `window.open(url, '_blank')`

**WhatsApp number**: Configurable constant at the top of `script.js`.

### Responsive Breakpoints

| Breakpoint | Behavior |
|---|---|
| < 768px | Single column, stacked cards, full-width form |
| 768px – 1024px | 2-3 column pricing grid, centered form |
| > 1024px | 5-column pricing grid, max-width container |

### Color Palette

- **Primary**: Deep blue/indigo (`#4F46E5`) — headers, CTA buttons
- **Accent**: Green (`#10B981`) — discounted prices, trust badge
- **Background**: White (`#FFFFFF`) with light gray sections (`#F9FAFB`)
- **Text**: Dark gray (`#111827`) for body, medium gray (`#6B7280`) for secondary
- **Danger/Strike**: Red-gray (`#9CA3AF`) for original prices

### Typography

- **Font**: System font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`)
- **Heading sizes**: 3rem (hero), 2rem (section), 1.25rem (card titles)
- **Body**: 1rem with 1.6 line-height

### Accessibility

- Semantic HTML (`<header>`, `<main>`, `<section>`, `<footer>`)
- Proper form labels with `for` attributes
- Color contrast meeting WCAG AA (4.5:1 for normal text)
- Focus-visible styles on interactive elements
- `aria-required="true"` on required form fields

## Correctness Properties

1. **Form submission gating**: The WhatsApp redirect SHALL only trigger when all required fields pass validation.
2. **Price accuracy**: Every paid plan card SHALL display exactly 50% of the original price as the discounted price.
3. **URL encoding correctness**: The pre-filled WhatsApp message SHALL properly encode all special characters including spaces, @, and + symbols.
4. **Responsive layout integrity**: At viewport width < 768px, no horizontal scrollbar SHALL appear on the page body.
5. **All plans present**: The pricing section SHALL always render exactly 5 plan cards.
