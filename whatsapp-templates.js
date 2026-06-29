/**
 * WhatsApp Template Generator Module
 * Generates pre-filled WhatsApp message URLs for plan actions (renew, upgrade, cancel).
 * Can be used as a CommonJS module or copy-pasted inline into dashboard.html.
 */

const CONFIG = {
  WHATSAPP_NUMBER: '919019879108',
  MAX_WHATSAPP_MESSAGE_LENGTH: 1000
};

/**
 * Formats a date as DD/MM/YYYY.
 * Returns "N/A" if the date is null/undefined/invalid.
 *
 * @param {string|Date|null} dateValue - The date to format
 * @returns {string} Formatted date string or "N/A"
 */
function formatDate(dateValue) {
  if (!dateValue) {
    return 'N/A';
  }
  const date = new Date(dateValue);
  if (isNaN(date.getTime())) {
    return 'N/A';
  }
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Formats a UTC ISO timestamp as a "billing moment" — both IST and UTC, so
 * users reading the WhatsApp message can see the precise instant their
 * billing cycle starts / ends regardless of where they are.
 *
 * Example output: "1 Jul 2026, 5:30 AM IST (12:00 AM UTC)"
 *
 * Why both timezones: backend/utils/datefmt.js explains in detail —
 * plan_end_date is stored as 00:00 UTC of the 1st of next month, which
 * is 05:30 AM IST of the same date. Showing only one side leaves a
 * 5h30m ambiguity window that has bitten users before.
 *
 * Mirrors backend/utils/datefmt.js and admin.html / dashboard.html copies.
 * Keep all four implementations in sync.
 *
 * @param {string|Date|null} dateValue - UTC ISO string or Date
 * @returns {string} Formatted billing moment, or "N/A"
 */
function formatBillingMoment(dateValue) {
  if (!dateValue) return 'N/A';
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return 'N/A';
  const dOpts = { day: 'numeric', month: 'short', year: 'numeric' };
  const tOpts = { hour: 'numeric', minute: '2-digit', hour12: true };
  const ist = `${d.toLocaleDateString('en-IN', { ...dOpts, timeZone: 'Asia/Kolkata' })}, ` +
              `${d.toLocaleTimeString('en-IN', { ...tOpts, timeZone: 'Asia/Kolkata' })} IST`;
  const utc = `${d.toLocaleDateString('en-IN', { ...dOpts, timeZone: 'UTC' })}, ` +
              `${d.toLocaleTimeString('en-IN', { ...tOpts, timeZone: 'UTC' })} UTC`;
  return `${ist} (${utc})`;
}

/**
 * Safely retrieves a user field, substituting empty string if missing.
 *
 * @param {*} value - The field value
 * @returns {string} The value as a string, or empty string if null/undefined
 */
function safeField(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/**
 * Builds the WhatsApp URL, enforcing the max character limit on encoded text.
 * If the encoded message exceeds MAX_WHATSAPP_MESSAGE_LENGTH, the message body
 * is truncated while preserving all user detail fields.
 *
 * @param {string} message - The raw message text
 * @param {string} userFieldsSection - The section of the message containing user fields (preserved on truncation)
 * @returns {string} The full WhatsApp URL
 */
function buildWhatsAppUrl(message, userFieldsSection) {
  let encoded = encodeURIComponent(message);

  if (encoded.length > CONFIG.MAX_WHATSAPP_MESSAGE_LENGTH) {
    // We need to truncate the body while preserving user fields.
    // Strategy: find the user fields section and preserve it, truncate the surrounding text.
    const encodedFields = encodeURIComponent(userFieldsSection);
    const remainingBudget = CONFIG.MAX_WHATSAPP_MESSAGE_LENGTH - encodedFields.length;

    if (remainingBudget <= 0) {
      // Even the fields alone exceed the limit; encode fields and truncate them
      encoded = encodedFields.substring(0, CONFIG.MAX_WHATSAPP_MESSAGE_LENGTH);
    } else {
      // Split the message into parts around the user fields section
      const fieldsIndex = message.indexOf(userFieldsSection);
      const beforeFields = message.substring(0, fieldsIndex);
      const afterFields = message.substring(fieldsIndex + userFieldsSection.length);

      // Distribute remaining budget between before and after sections
      const combinedSurrounding = beforeFields + afterFields;
      let truncatedMessage;

      if (encodeURIComponent(combinedSurrounding).length <= remainingBudget) {
        // No truncation needed for surrounding text
        truncatedMessage = message;
      } else {
        // Truncate the after section (closing text) first, then before if needed
        let afterTruncated = afterFields;
        let beforeTruncated = beforeFields;

        // Calculate budget for before and after
        const encodedBefore = encodeURIComponent(beforeFields);
        const encodedAfter = encodeURIComponent(afterFields);

        if (encodedBefore.length + encodedAfter.length > remainingBudget) {
          // Need to truncate - give priority to before (header) and trim after (footer)
          const beforeBudget = Math.min(encodedBefore.length, Math.floor(remainingBudget * 0.4));
          const afterBudget = remainingBudget - beforeBudget;

          // Truncate before section
          beforeTruncated = '';
          for (let i = 0; i < beforeFields.length; i++) {
            const candidate = beforeFields.substring(0, i + 1);
            if (encodeURIComponent(candidate).length > beforeBudget) {
              break;
            }
            beforeTruncated = candidate;
          }

          // Truncate after section
          afterTruncated = '';
          for (let i = 0; i < afterFields.length; i++) {
            const candidate = afterFields.substring(0, i + 1);
            if (encodeURIComponent(candidate).length > afterBudget) {
              break;
            }
            afterTruncated = candidate;
          }
        }

        truncatedMessage = beforeTruncated + userFieldsSection + afterTruncated;
      }

      encoded = encodeURIComponent(truncatedMessage);

      // Final safety check - hard truncate if still over limit
      if (encoded.length > CONFIG.MAX_WHATSAPP_MESSAGE_LENGTH) {
        encoded = encoded.substring(0, CONFIG.MAX_WHATSAPP_MESSAGE_LENGTH);
      }
    }
  }

  return `https://api.whatsapp.com/send?phone=${CONFIG.WHATSAPP_NUMBER}&text=${encoded}`;
}

/**
 * Generates a WhatsApp URL for plan renewal.
 *
 * Includes the next billing cycle start in both IST and UTC, plus a clear
 * "renew or cancel before this date, otherwise access is auto-disabled"
 * statement so the recipient (the support team) sees exactly when the
 * cutoff is, no matter which timezone they read the message in.
 *
 * @param {object} user - User data object
 * @param {string} user.name - User's full name
 * @param {string} user.email - User's email address
 * @param {string} user.currentPlan - Current plan name
 * @param {string|Date|null} user.planEndDate - Plan expiration date (UTC ISO)
 * @returns {string} Encoded WhatsApp URL
 */
function generateRenewalMessage(user) {
  const name = safeField(user && user.name);
  const email = safeField(user && user.email);
  const plan = safeField(user && user.currentPlan);
  const cycleMoment = formatBillingMoment(user && user.planEndDate);

  const userFieldsSection = [
    `Name: ${name}`,
    `Email: ${email}`,
    `Current Plan: ${plan}`,
    `Next billing cycle: ${cycleMoment}`,
  ].join('\n');

  const message = [
    `Hi, I'd like to renew my plan.`,
    ``,
    userFieldsSection,
    ``,
    `Please process my renewal before the cutoff above so my access doesn't get disabled. Thank you!`,
  ].join('\n');

  return buildWhatsAppUrl(message, userFieldsSection);
}

/**
 * Generates a WhatsApp URL for plan upgrade.
 *
 * @param {object} user - User data object
 * @param {string} user.name - User's full name
 * @param {string} user.email - User's email address
 * @param {string} user.currentPlan - Current plan name
 * @param {string|Date|null} user.planEndDate - Plan expiration date (UTC ISO)
 * @param {string} newPlan - The plan to upgrade to
 * @returns {string} Encoded WhatsApp URL
 */
function generateUpgradeMessage(user, newPlan) {
  const name = safeField(user && user.name);
  const email = safeField(user && user.email);
  const currentPlan = safeField(user && user.currentPlan);
  const upgradeTo = safeField(newPlan);
  const cycleMoment = formatBillingMoment(user && user.planEndDate);

  const userFieldsSection = [
    `Name: ${name}`,
    `Email: ${email}`,
    `Current Plan: ${currentPlan}`,
    `Upgrade To: ${upgradeTo}`,
    `Current cycle ends: ${cycleMoment}`,
  ].join('\n');

  const message = [
    `Hi, I'd like to upgrade my plan.`,
    ``,
    userFieldsSection,
    ``,
    `Please process my upgrade. Thank you!`,
  ].join('\n');

  return buildWhatsAppUrl(message, userFieldsSection);
}

/**
 * Generates a WhatsApp URL for plan cancellation.
 *
 * Body explicitly spells out the cycle-end moment in IST + UTC so the
 * admin reading the message later sees an unambiguous deadline, and the
 * user acknowledges in writing that access will be auto-disabled after
 * that date unless they renew.
 *
 * @param {object} user - User data object
 * @param {string} user.name - User's full name
 * @param {string} user.email - User's email address
 * @param {string} user.currentPlan - Current plan name
 * @param {string|Date|null} user.planEndDate - Plan expiration date (UTC ISO)
 * @returns {string} Encoded WhatsApp URL
 */
function generateCancellationMessage(user) {
  const name = safeField(user && user.name);
  const email = safeField(user && user.email);
  const plan = safeField(user && user.currentPlan);
  const cycleMoment = formatBillingMoment(user && user.planEndDate);

  const userFieldsSection = [
    `Name: ${name}`,
    `Email: ${email}`,
    `Current Plan: ${plan}`,
    `Active until: ${cycleMoment}`,
  ].join('\n');

  const message = [
    `Hi, I'd like to cancel my plan.`,
    ``,
    userFieldsSection,
    ``,
    `I understand my plan stays active until the date above. After that, no further renewal will be taken and my account access will be automatically disabled until I renew.`,
    `If I change my mind, I'll renew before the cutoff. Please confirm my cancellation. Thank you!`,
  ].join('\n');

  return buildWhatsAppUrl(message, userFieldsSection);
}

/**
 * Opens the WhatsApp URL in a new browser tab.
 * Falls back to changing window.location if popup is blocked.
 *
 * @param {string} url - The WhatsApp URL to open
 */
function openWhatsApp(url) {
  const newWindow = window.open(url, '_blank');
  if (!newWindow || newWindow.closed || typeof newWindow.closed === 'undefined') {
    // Popup was blocked — fallback to navigating in the current window
    window.location.href = url;
  }
}

module.exports = {
  CONFIG,
  formatDate,
  formatBillingMoment,
  safeField,
  buildWhatsAppUrl,
  generateRenewalMessage,
  generateUpgradeMessage,
  generateCancellationMessage,
  openWhatsApp
};
