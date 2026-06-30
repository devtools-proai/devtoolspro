/**
 * Google Meet Link Service
 *
 * Manages a strictly-validated pool of pre-created Google Meet links and
 * assigns them to new submissions.
 *
 * Pool semantics
 * ──────────────
 * The pool is loaded ONCE at module load from env vars `MEET_LINK_1..N`
 * (scanned with gap tolerance up to MAX_SLOT). Each value is validated
 * against the canonical Google Meet URL format and rejected if it
 * doesn't match — so a typo in the Render dashboard becomes an
 * immediate, loud failure at boot rather than a broken user
 * experience two days later.
 *
 * In *production* the server refuses to start if zero valid links are
 * configured. In *development* it warns instead, so contributors can
 * still iterate on unrelated features without touching the Meet pool.
 *
 * The cached pool is frozen, so nothing in the request path can mutate
 * it and slip an unapproved link to a user. Every assignment goes
 * through `getNextMeetLink()`, which reads from the frozen list only —
 * no env lookups, no fallbacks, no string concatenation.
 *
 * Selection strategy
 * ──────────────────
 * Per-request random choice over the frozen pool. With only two links
 * this gives ~50/50 distribution over time, no scheduling state to
 * persist across restarts. For very small pools (size 1 or 2) this is
 * the simplest correct option.
 */

// Canonical Google Meet URL pattern: lowercase-only, 3-4-3 dash-separated.
// Google has issued this exact shape since the 2020 redesign; anything
// off-format (uppercase, digits, missing dashes, trailing query string)
// is rejected so it can't sneak into the assignment pool.
const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

// Cap the env-var scan range so a typo (e.g. MEET_LINK_999) can't be
// abused to make the loader iterate forever. Twenty is well above any
// realistic pool size.
const MAX_SLOT = 20;

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

/**
 * Load + validate the pool from env. Called exactly once on require().
 *
 * Returns a frozen array of valid Meet URLs in slot-index order.
 * In production, throws (which surfaces as a process exit at module
 * load — see module bottom) when zero valid links are found, because
 * running without a pool means every new user gets a broken setup.
 */
function loadMeetLinkPool() {
  const pool = [];
  const rejected = [];

  for (let i = 1; i <= MAX_SLOT; i++) {
    const raw = process.env[`MEET_LINK_${i}`];
    if (raw == null || raw === '') continue;
    const trimmed = String(raw).trim();
    if (!MEET_URL_RE.test(trimmed)) {
      rejected.push({ slot: i, value: trimmed });
      continue;
    }
    // Defend against a misconfiguration where the same URL is set in
    // two slots — we want exact assignment counts to be predictable.
    if (pool.includes(trimmed)) {
      rejected.push({ slot: i, value: trimmed, reason: 'duplicate' });
      continue;
    }
    pool.push(trimmed);
  }

  // Emit a single, scannable boot line so the operator can confirm
  // the pool at a glance from the deploy logs.
  if (pool.length > 0) {
    console.log(`meet: pool loaded — ${pool.length} link(s): [${pool.join(', ')}]`);
  }

  // Log every rejected slot loudly. These are misconfigurations the
  // operator should fix even if the pool still has some valid entries.
  for (const r of rejected) {
    console.error(`meet: REJECTED MEET_LINK_${r.slot} — ${r.reason || 'not a valid Google Meet URL'}: "${r.value.slice(0, 80)}"`);
  }

  if (pool.length === 0) {
    const msg = 'No valid MEET_LINK_* env vars configured. Set MEET_LINK_1 (and optionally _2, _3, …) to canonical Google Meet URLs (https://meet.google.com/xxx-xxxx-xxx).';
    if (IS_PROD) {
      console.error(`FATAL: ${msg}`);
      // Exit, don't throw — throwing here would bubble through require()
      // and the user would see a confusing 500 on every request instead
      // of a clean fail-to-boot.
      process.exit(1);
    } else {
      console.warn(`⚠️  WARN: ${msg} (dev mode — booting anyway, but Meet link assignment will throw.)`);
    }
  }

  return Object.freeze(pool);
}

const MEET_LINK_POOL = loadMeetLinkPool();

/**
 * Return the frozen pool. Exposed for tests + the admin's diagnostic
 * endpoint (if it ever wants to render the active pool). Callers must
 * NOT mutate the returned array — it's frozen, but treat it as
 * read-only regardless.
 */
function getMeetLinks() {
  return MEET_LINK_POOL;
}

/**
 * Assign the next Meet link to a new submission.
 *
 * Pulls exclusively from the frozen pool — no env lookups, no
 * fallbacks, no client input. This is the only function that returns
 * a Meet URL to the rest of the system, so the strict-pool guarantee
 * holds end-to-end.
 *
 * Throws if the pool is empty (which can only happen in dev mode,
 * since prod refuses to boot with no links).
 */
function getNextMeetLink() {
  if (MEET_LINK_POOL.length === 0) {
    throw new Error('Meet link pool is empty. Set MEET_LINK_1 (and optionally _2, _3, …) in your environment.');
  }
  const idx = Math.floor(Math.random() * MEET_LINK_POOL.length);
  return MEET_LINK_POOL[idx];
}

/**
 * Validate a Meet URL against the canonical format. Exposed so the
 * admin PATCH endpoint can refuse to write a non-conforming URL to a
 * user's row — closes the last loophole where a manual edit could
 * bypass the pool guarantee.
 */
function isValidMeetUrl(url) {
  if (typeof url !== 'string') return false;
  return MEET_URL_RE.test(url.trim());
}

/**
 * Generate the complete setup message with Meet link and team note.
 * This message is sent automatically when a user submits their details.
 */
function generateSetupMessage(userData) {
  const meetLink = getNextMeetLink();
  const planName = userData.selectedPlan.split(' —')[0].trim();

  const message = {
    meetLink,
    whatsappMessage: buildWhatsAppMessage(userData, meetLink, planName),
    autoReplyNote: `Our team will join the Google Meet within 5 minutes for setup. Please keep the link open.`,
    planName,
  };

  return message;
}

/**
 * Build the WhatsApp message that gets sent automatically.
 * Includes: user details, Meet link, and setup instructions.
 */
function buildWhatsAppMessage(userData, meetLink, planName) {
  return [
    `✅ *Payment Received — Setup Scheduled!*`,
    ``,
    `Hi ${userData.firstName}! Thanks for choosing DevTools Pro.`,
    ``,
    `📋 *Your Details:*`,
    `• Name: ${userData.firstName} ${userData.lastName}`,
    `• Email: ${userData.email}`,
    `• Plan: ${planName}`,
    `• UTR: ${userData.utrId}`,
    ``,
    `🎥 *Google Meet Setup Link:*`,
    `${meetLink}`,
    ``,
    `⏰ *Note:* Our team will be joining the Meet within *5 minutes* to help you set up everything. Please:`,
    `1. Click the Meet link above`,
    `2. Keep your screen ready for sharing`,
    `3. We'll walk you through the complete installation`,
    ``,
    `If you need to reschedule, just reply here.`,
    ``,
    `— DevTools Pro Team 🚀`,
  ].join('\n');
}

/**
 * Generate a shorter confirmation message for immediate auto-reply.
 */
function generateQuickReply(userData, meetLink) {
  const planName = userData.selectedPlan.split(' —')[0].trim();
  return [
    `Hey ${userData.firstName}! 👋`,
    ``,
    `Payment confirmed for *${planName}* plan.`,
    ``,
    `🔗 Your setup Meet link: ${meetLink}`,
    `⏰ Team joins in ~5 minutes.`,
    ``,
    `Keep the link open — we'll screen share and get you set up! 🎯`,
  ].join('\n');
}

/**
 * Renewal / plan-change WhatsApp payload. Used by /api/submit when the
 * client passes flow !== 'first-time' — the user already went through
 * Meet setup on their original signup, so a fresh Meet link would only
 * confuse them. The submissions row is still recorded (meet_link is
 * left null) so admin can correlate the renewal payment with the user.
 *
 * Mirrors the structure of generateSetupMessage so the route handler
 * can use either return shape interchangeably (meetLink may be null).
 */
function generateRenewalSetupMessage(userData, opts = {}) {
  const planName = userData.selectedPlan.split(' —')[0].trim();
  const isChange = opts.flow === 'change';
  const verb = isChange ? 'plan change' : 'renewal';
  const title = isChange ? 'Plan change — payment received' : 'Renewal — payment received';

  const message = [
    `✅ *${title}*`,
    ``,
    `Hi ${userData.firstName}! Your ${verb} payment is in.`,
    ``,
    `📋 *Your details*`,
    `• Name: ${userData.firstName} ${userData.lastName}`.trim(),
    `• Email: ${userData.email}`,
    `• Plan: ${planName}`,
    `• UTR: ${userData.utrId}`,
    ``,
    `🔔 We've queued this for verification. You'll get a confirmation here once it's active — no Meet call needed for ${verb}s; you're already set up.`,
    ``,
    `Reply here if anything needs attention.`,
    ``,
    `— DevTools Pro Team 🚀`,
  ].join('\n');

  return {
    meetLink: null,
    whatsappMessage: message,
    autoReplyNote: `Renewal queued for verification — typically completes within a few hours.`,
    planName,
  };
}

module.exports = {
  getNextMeetLink,
  generateSetupMessage,
  generateRenewalSetupMessage,
  generateQuickReply,
  getMeetLinks,
  isValidMeetUrl,
  // Exposed for tests
  MEET_URL_RE,
};
