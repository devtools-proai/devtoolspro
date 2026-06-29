/**
 * Slack Notification Module
 *
 * Routes business events to channel-specific Slack incoming webhooks.
 * Every event is also mirrored to the firehose channel (#all-devtools-pro)
 * so the team has one timeline of everything. Webhooks are configured per
 * channel via env vars; any unset channel quietly skips (so dev/test
 * environments stay clean).
 *
 * Channels (env → Slack channel):
 *   SLACK_WEBHOOK_ALL                 → #all-devtools-pro    (firehose)
 *   SLACK_WEBHOOK_REGISTRATION        → #registartion        (sign-ups + new subs)
 *   SLACK_WEBHOOK_RENEW               → #renew_plan          (same-plan renewals)
 *   SLACK_WEBHOOK_CHANGE              → #change_plan         (upgrade/downgrade/pending)
 *   SLACK_WEBHOOK_CANCEL              → #cancel_sub          (cancellations)
 *   SLACK_WEBHOOK_EXPIRY              → #plan_expiry         (expired payments/plans)
 *   SLACK_WEBHOOK_PAYMENTS_PENDING    → #payments_pending    (UTRs awaiting verify)
 *   SLACK_WEBHOOK_PAYMENTS_VERIFIED   → #payments_verified   (verified payments)
 *   SLACK_WEBHOOK_ADMIN               → #admin_audit         (admin actions)
 *   SLACK_WEBHOOK_REVIEWS             → #reviews             (new user reviews)
 *   SLACK_WEBHOOK_VIP                 → #vip (optional)      (Pro Max / Power)
 *
 * Delivery is fire-and-forget — handlers never await the network round-trip,
 * so a slow Slack response cannot block API responses to users.
 */

const { formatBillingMoment, nowIst } = require('./utils/datefmt');

// Resolve every webhook URL once at module load. Mutating env at runtime
// won't be picked up, which is fine — process restart is the supported
// way to rotate webhook URLs.
const CHANNELS = {
  ALL:                process.env.SLACK_WEBHOOK_ALL || '',
  REGISTRATION:       process.env.SLACK_WEBHOOK_REGISTRATION || '',
  RENEW:              process.env.SLACK_WEBHOOK_RENEW || '',
  CHANGE:             process.env.SLACK_WEBHOOK_CHANGE || '',
  CANCEL:             process.env.SLACK_WEBHOOK_CANCEL || '',
  EXPIRY:             process.env.SLACK_WEBHOOK_EXPIRY || '',
  PAYMENTS_PENDING:   process.env.SLACK_WEBHOOK_PAYMENTS_PENDING || '',
  PAYMENTS_VERIFIED:  process.env.SLACK_WEBHOOK_PAYMENTS_VERIFIED || '',
  ADMIN:              process.env.SLACK_WEBHOOK_ADMIN || '',
  REVIEWS:            process.env.SLACK_WEBHOOK_REVIEWS || '',
  VIP:                process.env.SLACK_WEBHOOK_VIP || '',
};

// Public-facing surfaces referenced from inside Slack messages — admin
// deep-link + WhatsApp click-to-chat. The admin URL honours `?uid=` so
// pressing the button drops the admin straight on the user's row.
const ADMIN_URL = process.env.ADMIN_URL || 'https://devtools-proai.github.io/devtoolspro/admin.html';
const SUPPORT_WA_NUMBER = process.env.WHATSAPP_NUMBER || '919019879108';

// Per-plan INR ceilings — mirrors PLAN_INR_LIMITS in server.js. We
// duplicate the constant here only to avoid an import cycle.
const PLAN_PRICE_INR = { 'Pro': 946, 'Pro+': 1892, 'Pro Max': 4731, 'Power': 9461 };

// Which plans count as "VIP" for the optional secondary alert channel.
const VIP_PLANS = new Set(['Pro Max', 'Power']);

// ─── Plumbing ──────────────────────────────────────────────────────────

/**
 * Fire-and-forget HTTP POST to a Slack webhook URL.
 * Silent on failure — the worst case is a missed alert, which must never
 * surface as an error to the end user.
 */
async function postToWebhook(url, payload) {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // 400-class is usually a malformed Block Kit payload — log so we can fix it.
      const body = await res.text().catch(() => '');
      console.warn(`slack: post ${res.status} ${body.slice(0, 120)}`);
    }
  } catch (e) {
    console.warn(`slack: post error ${e.message}`);
  }
}

/**
 * Send the same payload to one or more channel keys plus the firehose.
 * Duplicate URLs (e.g. someone reuses the same webhook for two channels)
 * are deduped so the same message doesn't land twice.
 */
function dispatch(channelKeys, payload) {
  const keys = Array.isArray(channelKeys) ? channelKeys : [channelKeys];
  const urls = new Set();
  // Firehose first, in stable order — but de-duped against per-channel URLs
  // so a misconfig where ALL == REGISTRATION doesn't double-post.
  urls.add(CHANNELS.ALL);
  for (const k of keys) urls.add(CHANNELS[k] || '');
  for (const url of urls) {
    if (url) postToWebhook(url, payload); // intentionally not awaited
  }
}

// ─── Block Kit helpers ────────────────────────────────────────────────

const COLORS = {
  green:  '#22c55e',
  amber:  '#f59e0b',
  red:    '#ef4444',
  violet: '#8b5cf6',
  blue:   '#3b82f6',
  gray:   '#6b7280',
};

function header(text) {
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } };
}

function section(text, accessory) {
  const block = { type: 'section', text: { type: 'mrkdwn', text } };
  if (accessory) block.accessory = accessory;
  return block;
}

function fieldsSection(fields, accessory) {
  // Slack caps `fields` arrays at 10 entries. Drop empties so the alert
  // doesn't render with blank rows when a user has no phone, source, etc.
  const filtered = fields.filter(f => f && f.value);
  const block = {
    type: 'section',
    fields: filtered.slice(0, 10).map(f => ({
      type: 'mrkdwn',
      text: `*${f.label}*\n${f.value}`,
    })),
  };
  if (accessory) block.accessory = accessory;
  return block;
}

function contextLine(text) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function divider() {
  return { type: 'divider' };
}

/** Render the Action buttons row: Admin link + (optional) WhatsApp. */
function actions(buttons) {
  const elements = buttons.filter(Boolean);
  if (elements.length === 0) return null;
  return { type: 'actions', elements };
}

function adminButton(userId) {
  if (!userId) return null;
  return {
    type: 'button',
    text: { type: 'plain_text', text: 'Open in Admin', emoji: true },
    url: `${ADMIN_URL}?uid=${encodeURIComponent(userId)}`,
    style: 'primary',
  };
}

function waButton(phone, prefilledMessage) {
  const cleaned = phone ? String(phone).replace(/\D+/g, '') : '';
  if (cleaned.length < 8) return null;
  const text = encodeURIComponent(prefilledMessage || 'Hi from DevTools Pro!');
  return {
    type: 'button',
    text: { type: 'plain_text', text: '💬 WhatsApp', emoji: true },
    url: `https://api.whatsapp.com/send?phone=${cleaned}&text=${text}`,
  };
}

function avatarAccessory(pictureUrl, alt) {
  if (!pictureUrl) return undefined;
  return { type: 'image', image_url: pictureUrl, alt_text: alt || 'avatar' };
}

// ─── Common user/section builders ─────────────────────────────────────

/** Standard "who is this about" fields block used in most events. */
function userFields(user) {
  return [
    { label: 'Name', value: user.name || '—' },
    { label: 'Email', value: user.email || '—' },
    { label: 'Phone', value: user.phone ? `+${user.phone}` : '—' },
    { label: 'Source', value: user.source || '—' },
  ];
}

function planFields(user) {
  return [
    { label: 'Plan', value: user.currentPlan || user.plan || '—' },
    { label: 'Status', value: user.planStatus || '—' },
    {
      label: 'Cycle ends',
      value: user.planEndDate ? formatBillingMoment(user.planEndDate) : '—',
    },
    {
      label: 'Cycle started',
      value: user.planStartDate ? formatBillingMoment(user.planStartDate) : '—',
    },
  ];
}

function footerContext(userId, extra) {
  const parts = [];
  if (userId) parts.push(`\`uid: ${userId}\``);
  parts.push(nowIst());
  if (extra) parts.push(extra);
  return contextLine(parts.join(' · '));
}

// ─── Public API: per-event notify functions ───────────────────────────

/**
 * New user signed up (first Google login). Fires from /auth/google when
 * the upsert created a fresh row.
 */
function notifyNewUser(user) {
  const blocks = [
    header('🆕 New user signed up'),
    fieldsSection(userFields(user), avatarAccessory(user.picture, user.name)),
    actions([adminButton(user.id), waButton(user.phone, `Hi ${user.name || 'there'}, welcome to DevTools Pro!`)]),
    footerContext(user.id),
  ].filter(Boolean);

  dispatch(['REGISTRATION'], {
    text: `🆕 New user: ${user.name || user.email}`,
    blocks,
  });
}

/**
 * Registration completed — user filled in phone + source after sign-in.
 */
function notifyRegistrationComplete(user) {
  const blocks = [
    header('✅ Registration completed'),
    section(`*${user.name || 'A user'}* finished onboarding. Ready to pick a plan.`),
    fieldsSection(userFields(user), avatarAccessory(user.picture, user.name)),
    actions([
      adminButton(user.id),
      waButton(user.phone, `Hi ${user.name || 'there'}! Thanks for signing up with DevTools Pro. Need help picking a plan?`),
    ]),
    footerContext(user.id),
  ].filter(Boolean);

  dispatch(['REGISTRATION'], {
    text: `✅ Registration completed: ${user.name || user.email}`,
    blocks,
  });
}

/**
 * UTR submitted, payment is now in awaiting_verification state. This is
 * the work-queue alert — the admin needs to verify in admin.html.
 *
 * `autoVerified` flips this to the post-verify channel instead.
 */
function notifyUtrSubmitted({ user, payment, confidence, autoVerified }) {
  if (autoVerified) {
    return notifyPaymentVerified({ user, payment, autoVerified: true, confidence });
  }
  const blocks = [
    header('📩 New UTR awaiting verification'),
    section(`*${user.name || user.email}* has submitted a UTR. Please verify in the admin console.`),
    fieldsSection([
      { label: 'Name', value: user.name || '—' },
      { label: 'Email', value: user.email || '—' },
      { label: 'Plan', value: payment.plan || '—' },
      { label: 'Amount', value: payment.amount != null ? `₹${Number(payment.amount).toLocaleString('en-IN')}` : '—' },
      { label: 'UTR', value: payment.utrId ? `\`${payment.utrId}\`` : '—' },
      { label: 'Confidence', value: confidence != null ? `${confidence}/100` : '—' },
    ], avatarAccessory(user.picture, user.name)),
    actions([
      adminButton(user.id),
      waButton(user.phone, `Hi ${user.name || 'there'}! We've received your UTR and are verifying your payment.`),
    ]),
    footerContext(user.id, `payment: \`${payment.id || '—'}\``),
  ].filter(Boolean);

  dispatch(['PAYMENTS_PENDING'], {
    text: `📩 UTR pending verification — ${user.name || user.email}`,
    blocks,
  });
}

/**
 * Payment verified — either auto-verified by the >=95 confidence path or
 * manually verified by an admin.
 */
function notifyPaymentVerified({ user, payment, autoVerified, confidence, verifiedBy }) {
  const title = autoVerified ? '🤖 Payment auto-verified' : '✅ Payment verified by admin';
  const blocks = [
    header(title),
    fieldsSection([
      { label: 'Name', value: user.name || '—' },
      { label: 'Email', value: user.email || '—' },
      { label: 'Plan', value: payment.plan || '—' },
      { label: 'Amount', value: payment.amount != null ? `₹${Number(payment.amount).toLocaleString('en-IN')}` : '—' },
      { label: 'UTR', value: payment.utrId ? `\`${payment.utrId}\`` : '—' },
      autoVerified
        ? { label: 'Confidence', value: confidence != null ? `${confidence}/100` : '—' }
        : { label: 'Verified by', value: verifiedBy || 'admin' },
    ], avatarAccessory(user.picture, user.name)),
    actions([
      adminButton(user.id),
      waButton(user.phone, `Hi ${user.name || 'there'}! Your payment is verified. We'll share your Google Meet link shortly.`),
    ]),
    footerContext(user.id, `payment: \`${payment.id || '—'}\``),
  ].filter(Boolean);

  const channels = ['PAYMENTS_VERIFIED'];
  if (payment.plan && VIP_PLANS.has(payment.plan)) channels.push('VIP');

  dispatch(channels, {
    text: `${title} — ${user.name || user.email} (${payment.plan || '—'})`,
    blocks,
  });
}

/**
 * Plan activated — called from /auth/update-plan. Detects the direction
 * by comparing the user's previous plan vs the new one and routes to the
 * matching channel:
 *   no previous plan        → REGISTRATION (it's part of onboarding)
 *   same plan as before     → RENEW
 *   higher-tier plan        → CHANGE (upgrade)
 *   lower-tier plan         → CHANGE (downgrade)
 *
 * `previousPlan` is null/undefined when the user is going from "no plan"
 * to a plan, which we treat as a new subscription.
 */
const PLAN_TIERS = ['Pro', 'Pro+', 'Pro Max', 'Power'];

function notifyPlanActivated({ user, previousPlan, newPlan, payment }) {
  let kind; // 'new' | 'renewal' | 'upgrade' | 'downgrade'
  let title;
  let channelKey;
  const emoji = '🎯';

  if (!previousPlan) {
    kind = 'new';
    title = `${emoji} New subscription activated`;
    channelKey = 'REGISTRATION';
  } else if (previousPlan === newPlan) {
    kind = 'renewal';
    title = '🔄 Plan renewed';
    channelKey = 'RENEW';
  } else {
    const prevIdx = PLAN_TIERS.indexOf(previousPlan);
    const nextIdx = PLAN_TIERS.indexOf(newPlan);
    if (nextIdx > prevIdx) {
      kind = 'upgrade';
      title = '⬆️ Plan upgraded';
    } else {
      kind = 'downgrade';
      title = '⬇️ Plan downgraded';
    }
    channelKey = 'CHANGE';
  }

  const transitionText = previousPlan
    ? `*${previousPlan}* → *${newPlan}*`
    : `→ *${newPlan}*`;

  const blocks = [
    header(title),
    section(`*${user.name || user.email}* — ${transitionText}`),
    fieldsSection([
      { label: 'Email', value: user.email || '—' },
      { label: 'Phone', value: user.phone ? `+${user.phone}` : '—' },
      { label: 'Amount', value: payment && payment.amount != null
        ? `₹${Number(payment.amount).toLocaleString('en-IN')}`
        : (PLAN_PRICE_INR[newPlan] ? `₹${PLAN_PRICE_INR[newPlan].toLocaleString('en-IN')} (full month)` : '—') },
      { label: 'UTR', value: payment && payment.utrId ? `\`${payment.utrId}\`` : (user.utrId ? `\`${user.utrId}\`` : '—') },
      { label: 'Cycle started', value: formatBillingMoment(user.planStartDate) },
      { label: 'Next renewal', value: formatBillingMoment(user.planEndDate) },
    ], avatarAccessory(user.picture, user.name)),
    actions([
      adminButton(user.id),
      waButton(user.phone, kind === 'renewal'
        ? `Hi ${user.name || 'there'}! Your *${newPlan}* renewal is confirmed.`
        : `Hi ${user.name || 'there'}! Your *${newPlan}* plan is now active.`),
    ]),
    footerContext(user.id, payment && payment.id ? `payment: \`${payment.id}\`` : null),
  ].filter(Boolean);

  const channels = [channelKey];
  if (VIP_PLANS.has(newPlan) && (kind === 'new' || kind === 'upgrade')) {
    channels.push('VIP');
  }

  dispatch(channels, {
    text: `${title}: ${user.name || user.email} ${previousPlan ? `(${previousPlan} → ${newPlan})` : `(${newPlan})`}`,
    blocks,
  });
}

/**
 * User cancelled their subscription (or admin set status=cancelled).
 * The plan keeps running until plan_end_date — that's the moment to call
 * out so the team knows when the auto-disable actually lands.
 */
function notifyPlanCancelled({ user, byAdmin }) {
  const blocks = [
    header(byAdmin ? '❌ Plan cancelled by admin' : '❌ Plan cancelled by user'),
    section(`*${user.name || user.email}* cancelled *${user.currentPlan || 'their plan'}*.`),
    fieldsSection([
      { label: 'Email', value: user.email || '—' },
      { label: 'Phone', value: user.phone ? `+${user.phone}` : '—' },
      { label: 'Current plan', value: user.currentPlan || '—' },
      { label: 'Active until', value: formatBillingMoment(user.planEndDate) },
    ], avatarAccessory(user.picture, user.name)),
    section(`The user keeps access until the date above. After that, the account is automatically disabled until they renew.`),
    actions([
      adminButton(user.id),
      waButton(user.phone, `Hi ${user.name || 'there'}, your cancellation is confirmed. You'll keep access until ${formatBillingMoment(user.planEndDate)}.`),
    ]),
    footerContext(user.id),
  ].filter(Boolean);

  dispatch(['CANCEL'], {
    text: `❌ Plan cancelled — ${user.name || user.email}`,
    blocks,
  });
}

/**
 * Deferred downgrade scheduled — user picked a lower plan for next cycle.
 */
function notifyDowngradeScheduled({ user, pendingPlan, effectiveAt }) {
  const blocks = [
    header('⏬ Downgrade scheduled'),
    section(`*${user.name || user.email}* will move *${user.currentPlan}* → *${pendingPlan}* on *${formatBillingMoment(effectiveAt)}*.`),
    fieldsSection([
      { label: 'Email', value: user.email || '—' },
      { label: 'Phone', value: user.phone ? `+${user.phone}` : '—' },
      { label: 'Current plan', value: user.currentPlan || '—' },
      { label: 'Pending plan', value: pendingPlan },
      { label: 'Effective from', value: formatBillingMoment(effectiveAt) },
    ], avatarAccessory(user.picture, user.name)),
    actions([adminButton(user.id), waButton(user.phone, `Hi ${user.name || 'there'}, your downgrade to ${pendingPlan} is scheduled for ${formatBillingMoment(effectiveAt)}.`)]),
    footerContext(user.id),
  ].filter(Boolean);

  dispatch(['CHANGE'], {
    text: `⏬ Downgrade scheduled — ${user.name || user.email} (${user.currentPlan} → ${pendingPlan})`,
    blocks,
  });
}

/**
 * Admin applied a pending plan early (or on schedule).
 */
function notifyPendingApplied({ user }) {
  const blocks = [
    header('⚡ Pending plan applied'),
    section(`*${user.name || user.email}* is now on *${user.currentPlan}*. Next renewal: *${formatBillingMoment(user.planEndDate)}*.`),
    fieldsSection(planFields(user), avatarAccessory(user.picture, user.name)),
    actions([adminButton(user.id), waButton(user.phone, `Hi ${user.name || 'there'}, your *${user.currentPlan}* plan is now live.`)]),
    footerContext(user.id),
  ].filter(Boolean);
  dispatch(['CHANGE'], {
    text: `⚡ Pending plan applied — ${user.name || user.email} (${user.currentPlan})`,
    blocks,
  });
}

/**
 * Payment row expired (30-minute pending window elapsed without a UTR).
 */
function notifyPaymentExpired({ payment, user }) {
  const blocks = [
    header('💀 Payment session expired'),
    section(`A payment session expired without a UTR submission.`),
    fieldsSection([
      { label: 'User', value: user && (user.name || user.email) ? (user.name || user.email) : '—' },
      { label: 'Plan', value: payment.plan || '—' },
      { label: 'Amount', value: payment.amount != null ? `₹${Number(payment.amount).toLocaleString('en-IN')}` : '—' },
      { label: 'Payment ID', value: payment.id ? `\`${payment.id}\`` : '—' },
    ], user ? avatarAccessory(user.picture, user.name) : undefined),
    user ? actions([
      adminButton(user.id),
      waButton(user.phone, `Hi ${user.name || 'there'}, looks like your payment session expired. Want help finishing up?`),
    ]) : null,
    footerContext(user && user.id ? user.id : null, `payment: \`${payment.id || '—'}\``),
  ].filter(Boolean);

  dispatch(['EXPIRY'], {
    text: `💀 Payment expired — ${user ? (user.name || user.email) : payment.id}`,
    blocks,
  });
}

/**
 * Admin edited a user — surface which fields changed so the audit trail
 * is meaningful (just "user updated" with no diff is useless).
 */
function notifyAdminPatched({ user, changedFields }) {
  const blocks = [
    header('🔧 Admin patched a user'),
    section(`*${user.name || user.email}* was edited. Fields: \`${(changedFields || []).join(', ') || '—'}\``),
    fieldsSection([
      { label: 'Email', value: user.email || '—' },
      { label: 'Plan', value: user.currentPlan || '—' },
      { label: 'Status', value: user.planStatus || '—' },
      { label: 'Cycle ends', value: formatBillingMoment(user.planEndDate) },
    ], avatarAccessory(user.picture, user.name)),
    actions([adminButton(user.id)]),
    footerContext(user.id),
  ].filter(Boolean);

  dispatch(['ADMIN'], {
    text: `🔧 Admin patched ${user.name || user.email}`,
    blocks,
  });
}

function notifyUserSuspended({ user }) {
  const blocks = [
    header('🗑️ User suspended (soft delete)'),
    fieldsSection(userFields(user), avatarAccessory(user.picture, user.name)),
    actions([adminButton(user.id)]),
    footerContext(user.id),
  ].filter(Boolean);
  dispatch(['ADMIN'], { text: `🗑️ Suspended ${user.name || user.email}`, blocks });
}

function notifyUserRestored({ user }) {
  const blocks = [
    header('🔄 User restored'),
    fieldsSection(userFields(user), avatarAccessory(user.picture, user.name)),
    actions([adminButton(user.id)]),
    footerContext(user.id),
  ].filter(Boolean);
  dispatch(['ADMIN'], { text: `🔄 Restored ${user.name || user.email}`, blocks });
}

/**
 * Duplicate UTR rejected. Possible fraud signal worth logging.
 */
function notifyDuplicateUtr({ utrId, attemptedBy }) {
  const blocks = [
    header('🚫 Duplicate UTR rejected'),
    section(`Someone tried to reuse a UTR that's already verified.`),
    fieldsSection([
      { label: 'UTR', value: utrId ? `\`${utrId}\`` : '—' },
      { label: 'Attempted by', value: attemptedBy || '—' },
    ]),
    footerContext(null),
  ].filter(Boolean);
  dispatch(['ADMIN'], { text: `🚫 Duplicate UTR rejected: ${utrId}`, blocks });
}

/**
 * New user review posted — needs moderation before it appears publicly.
 */
function notifyNewReview({ review }) {
  const stars = '⭐'.repeat(Math.max(0, Math.min(5, Number(review.rating) || 0)));
  const blocks = [
    header('⭐ New review submitted'),
    section(`*${review.name || 'Anon'}* · ${review.city || '—'} · ${review.role || 'Developer'}\n${stars} (${review.rating}/5)`),
    section(`>${(review.review_text || '').slice(0, 500).replace(/\n/g, '\n>')}`),
    contextLine(`Review needs admin approval before it appears on the public site. · ${nowIst()}`),
  ];
  dispatch(['REVIEWS'], {
    text: `⭐ New review (${review.rating}/5) — ${review.name || 'Anon'}`,
    blocks,
  });
}

module.exports = {
  // Channel config (exposed for diagnostics, not for direct use)
  CHANNELS,

  // Public event API
  notifyNewUser,
  notifyRegistrationComplete,
  notifyUtrSubmitted,
  notifyPaymentVerified,
  notifyPlanActivated,
  notifyPlanCancelled,
  notifyDowngradeScheduled,
  notifyPendingApplied,
  notifyPaymentExpired,
  notifyAdminPatched,
  notifyUserSuspended,
  notifyUserRestored,
  notifyDuplicateUtr,
  notifyNewReview,
};
