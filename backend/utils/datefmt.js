/**
 * Date Formatting Utility — single source of truth for renewal/billing
 * timestamp presentation across server-side surfaces.
 *
 * Why this module exists
 * ──────────────────────
 * The DB stores `plan_end_date` etc. as UTC ISO strings. Specifically the
 * server pins them to *00:00 UTC of the 1st of the next calendar month*.
 * In IST (UTC+5:30) that same instant is *05:30 AM on the 1st*. Showing
 * only one timezone is ambiguous — users reading "1 Jul" alone don't know
 * whether the cutoff is midnight or 5:30 AM their time, so we always show
 * both.
 *
 * `formatBillingMoment("2026-07-01T00:00:00Z")` →
 *   "1 Jul 2026, 5:30 AM IST (12:00 AM UTC)"
 *
 * The frontend (dashboard.html, admin.html) has a mirrored implementation
 * with the same name + behaviour. Both must stay in sync — if the format
 * here changes, update those copies too.
 */

const IST_TZ = 'Asia/Kolkata';
const UTC_TZ = 'UTC';
const LOCALE = 'en-IN';

const DATE_OPTS = { day: 'numeric', month: 'short', year: 'numeric' };
const TIME_OPTS = { hour: 'numeric', minute: '2-digit', hour12: true };

/**
 * Format a UTC ISO string as a "billing moment" string in IST + UTC.
 *
 * Returns "N/A" for null / invalid input so callers can drop the value
 * straight into a template without a guard.
 */
function formatBillingMoment(iso) {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'N/A';

  const ist = `${d.toLocaleDateString(LOCALE, { ...DATE_OPTS, timeZone: IST_TZ })}, ` +
              `${d.toLocaleTimeString(LOCALE, { ...TIME_OPTS, timeZone: IST_TZ })} IST`;
  const utc = `${d.toLocaleDateString(LOCALE, { ...DATE_OPTS, timeZone: UTC_TZ })}, ` +
              `${d.toLocaleTimeString(LOCALE, { ...TIME_OPTS, timeZone: UTC_TZ })} UTC`;
  return `${ist} (${utc})`;
}

/**
 * Date-only variant for places where the time isn't useful (audit logs,
 * "Member since" rows). Still shows both timezones because the IST and
 * UTC *date* can disagree near the 5:30am IST boundary.
 *
 * Returns "1 Jul 2026 IST / 1 Jul 2026 UTC" or, when the dates differ,
 * "30 Jun 2026 IST / 1 Jul 2026 UTC".
 */
function formatBillingDate(iso) {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'N/A';
  const ist = d.toLocaleDateString(LOCALE, { ...DATE_OPTS, timeZone: IST_TZ });
  const utc = d.toLocaleDateString(LOCALE, { ...DATE_OPTS, timeZone: UTC_TZ });
  return ist === utc ? `${ist} (IST / UTC)` : `${ist} IST / ${utc} UTC`;
}

/**
 * Short "now" timestamp for Slack footers. Always IST since the team
 * lives there; UTC is implied by the +5:30 offset.
 */
function nowIst() {
  return new Date().toLocaleString(LOCALE, {
    timeZone: IST_TZ,
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' IST';
}

module.exports = {
  formatBillingMoment,
  formatBillingDate,
  nowIst,
  IST_TZ,
  UTC_TZ,
};
