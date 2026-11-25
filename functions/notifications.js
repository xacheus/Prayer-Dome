'use strict';

/*
 * Prayer Dome transactional email and in-app notification service.
 * ===========================================================================
 * Every message is created from an event that has ALREADY been written to
 * Firestore. The browser never sends email directly and never supplies the
 * recipient address: the server resolves the registered account and records a
 * deterministic outbox document so a retry cannot send the same event twice.
 *
 * Firestore collections
 *   emailSettings/main          sender identity + category switches (admin)
 *   emailTemplates/{event}      optional subject/body overrides (admin)
 *   emailOutbox/{eventId}       delivery record and retry queue (admin only)
 *   userNotifications/{eventId} in-app bell entry (owner + admin read only)
 *
 * Credentials live in BREVO_API_KEY (Secret Manager / Vercel env). No key is
 * ever written to a document or returned by the callable.
 */

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const brevo = require('./brevo');
const design = require('./email-design');
const { defineSecret } = require('firebase-functions/params');

const REGION = 'us-central1';
const SITE_URL = String(process.env.PD_SITE_URL || 'https://prayerdome.net').replace(/\/+$/, '');
const brevoApiKey = defineSecret('BREVO_API_KEY');
const { HttpsError } = functions.https;

const EMAIL_CATEGORIES = {
  account: 'Membership, account and security',
  billing: 'Payments and subscriptions',
  giving: 'Giving and offerings',
  church_id: 'Church ID cards',
  certificates: 'Certificates and documents',
  prayer: 'Prayer requests',
  testimony: 'Testimonies',
  support: 'Support claims',
  newsletter: 'Newsletter and ministry updates',
  announcement: 'Ministry announcements'
};

/* ------------------------------------------------------------------ helpers */

function fail(code, message) {
  throw new HttpsError(code, message);
}

function text(value, max) {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max || 500);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cleanEmail(value) {
  return brevo.cleanEmail(value);
}

function formatDate(value) {
  if (!value) return '';
  let date = value;
  try {
    if (value && typeof value.toDate === 'function') date = value.toDate();
    else if (value && value.seconds) date = new Date(value.seconds * 1000);
    else if (typeof value === 'number') date = new Date(value);
    else date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Lusaka'
    }).format(date) + ' (Lusaka time)';
  } catch (error) { return ''; }
}

function formatAmount(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '';
  return (String(currency || 'USD').toUpperCase() === 'USD' ? 'USD ' : String(currency).toUpperCase() + ' ')
    + value.toFixed(2);
}

function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value.seconds) return Number(value.seconds) * 1000;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function eventSuffix(snap) {
  const stamp = snap && snap.updateTime ? millis(snap.updateTime) : Date.now();
  return String(stamp || Date.now());
}

function eventId(event, userId, suffix) {
  const raw = 'evt_' + event + '_' + (userId || 'member') + '_' + (suffix || Date.now());
  return raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 180);
}

function safePath(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw || raw.indexOf('//') !== -1 || raw.charAt(0) !== '/') return fallback || '/account.html';
  if (!/^\/[A-Za-z0-9_#?=&./-]*$/.test(raw)) return fallback || '/account.html';
  return raw;
}

function absoluteLink(path) {
  return SITE_URL + safePath(path, '/account.html');
}

/* --------------------------------------------------------------- settings */

function defaultSettings() {
  return {
    enabled: true,
    senderName: String(process.env.BREVO_SENDER_NAME || 'Prayer Dome').trim() || 'Prayer Dome',
    senderEmail: cleanEmail(process.env.BREVO_SENDER_EMAIL || 'noreply@prayerdome.net') || 'noreply@prayerdome.net',
    replyTo: cleanEmail(process.env.BREVO_REPLY_TO || '') || '',
    categories: Object.keys(EMAIL_CATEGORIES).reduce(function (out, key) { out[key] = true; return out; }, {})
  };
}

function normalizeSettings(stored) {
  const base = defaultSettings();
  const row = stored && typeof stored === 'object' ? stored : {};
  const categories = Object.assign({}, base.categories);
  if (row.categories && typeof row.categories === 'object') {
    Object.keys(EMAIL_CATEGORIES).forEach(function (key) {
      if (row.categories[key] === false) categories[key] = false;
    });
  }
  return {
    enabled: row.enabled !== false,
    senderName: text(row.senderName, 80) || base.senderName,
    senderEmail: cleanEmail(row.senderEmail) || base.senderEmail,
    replyTo: cleanEmail(row.replyTo) || '',
    categories
  };
}

async function loadSettings() {
  try {
    const snap = await admin.firestore().doc('emailSettings/main').get();
    return normalizeSettings(snap.exists ? snap.data() : null);
  } catch (error) {
    console.error('Email settings read failed:', error.message);
    return defaultSettings();
  }
}

/* --------------------------------------------------------------- templates */

const EVENTS = {
  membership_submitted: {
    category: 'account', essential: true, kind: 'account',
    subject: 'We received your Prayer Dome membership application',
    heading: 'Application received',
    message: 'Thank you for submitting your membership application to PRAYER DOME. Our team will review it and send you an update as soon as a decision is made.\nYou can follow the status in your Prayer Dome account. If we need anything else from you, we will contact you using this email address.',
    actionLabel: 'Open my account', actionPath: '/account.html',
    inAppTitle: 'Membership application received',
    inAppMessage: 'Your application is with the Prayer Dome team for review.'
  },
  membership_approved: {
    category: 'account', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Membership Has Been Approved',
    heading: 'Membership approved',
    message: 'We are pleased to inform you that your membership application has been approved.\nYou can now sign in to your Prayer Dome account to view your membership information and your digital membership card.\nWelcome to PRAYER DOME.',
    actionLabel: 'View my membership', actionPath: '/account.html',
    inAppTitle: 'Membership approved',
    inAppMessage: 'Welcome to PRAYER DOME. Your membership is now active.'
  },
  membership_rejected: {
    category: 'account', essential: true, kind: 'account',
    subject: 'Update on Your Prayer Dome Membership Application',
    heading: 'Application not approved',
    message: 'Thank you for applying to join PRAYER DOME. After reviewing your application, our team could not approve it at this time.\nThe reason for the decision is shown below. If you believe any information was incorrect, you may contact the ministry office and ask for the application to be reviewed again.',
    actionLabel: 'Contact the ministry', actionPath: '/contact.html',
    inAppTitle: 'Membership application update',
    inAppMessage: 'Please review the decision and reason in your account.'
  },
  membership_info_required: {
    category: 'account', essential: true, kind: 'account',
    subject: 'More Information Needed for Your Prayer Dome Application',
    heading: 'We need a little more information',
    message: 'Thank you for your membership application. Before we can complete the review, our team needs more information from you.\nPlease read the request below and send the missing details through the ministry office or reply to this email.',
    actionLabel: 'Contact the ministry', actionPath: '/contact.html',
    inAppTitle: 'More information needed',
    inAppMessage: 'The membership team has asked for additional information.'
  },
  membership_suspended: {
    category: 'account', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Membership Status Has Changed',
    heading: 'Membership suspended',
    message: 'Your Prayer Dome membership has been suspended while the ministry team reviews your account.\nIf you believe this is a mistake, please contact the ministry office so the team can assist you.',
    actionLabel: 'Contact the ministry', actionPath: '/contact.html',
    inAppTitle: 'Membership suspended',
    inAppMessage: 'Please contact the ministry office for assistance.'
  },
  church_id_issued: {
    category: 'church_id', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Church ID Has Been Issued',
    heading: 'Church ID issued',
    message: 'Your Prayer Dome church ID has been approved and issued.\nYou can open your account to view and download your digital membership card. The card can also be verified at the public verification page.',
    actionLabel: 'View my church ID', actionPath: '/membership.html',
    inAppTitle: 'Church ID issued',
    inAppMessage: 'Your digital church ID is ready in your account.'
  },
  church_id_rejected: {
    category: 'church_id', essential: true, kind: 'account',
    subject: 'Update on Your Prayer Dome Church ID',
    heading: 'Church ID not approved',
    message: 'Your church ID application could not be approved at this time. The reason is shown below.\nPlease contact the ministry office if you need help correcting the information on your card.',
    actionLabel: 'Contact the ministry', actionPath: '/contact.html',
    inAppTitle: 'Church ID update',
    inAppMessage: 'Please review the reason for this decision.'
  },
  church_id_suspended: {
    category: 'church_id', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Church ID Has Been Suspended',
    heading: 'Church ID suspended',
    message: 'Your Prayer Dome church ID has been suspended and should not be used until the ministry team restores it.\nPlease contact the ministry office if you need assistance.',
    actionLabel: 'Contact the ministry', actionPath: '/contact.html',
    inAppTitle: 'Church ID suspended',
    inAppMessage: 'Your card is temporarily suspended.'
  },
  church_id_revoked: {
    category: 'church_id', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Church ID Has Been Revoked',
    heading: 'Church ID revoked',
    message: 'Your Prayer Dome church ID has been revoked and is no longer valid.\nIf you believe this is a mistake, please contact the ministry office.',
    actionLabel: 'Contact the ministry', actionPath: '/contact.html',
    inAppTitle: 'Church ID revoked',
    inAppMessage: 'Your card is no longer valid. Please contact the office.'
  },
  payment_submitted: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'We Received Your Prayer Dome Payment Submission',
    heading: 'Payment submitted',
    message: 'Thank you for submitting your payment evidence. Our finance team will check it against the ministry account before any plan or wallet balance is activated.\nYou will receive another message when the review is complete.',
    actionLabel: 'View my support plan', actionPath: '/support.html#myplans',
    inAppTitle: 'Payment submitted',
    inAppMessage: 'Finance is checking your payment evidence.'
  },
  payment_approved: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Payment Has Been Approved',
    heading: 'Payment approved',
    message: 'We have verified your payment against the ministry account and approved it.\nYour subscription or wallet balance has been updated in your account.',
    actionLabel: 'View my support plan', actionPath: '/support.html#myplans',
    inAppTitle: 'Payment approved',
    inAppMessage: 'Your payment has been verified and applied.'
  },
  payment_rejected: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'Update on Your Prayer Dome Payment',
    heading: 'Payment could not be approved',
    message: 'We have reviewed your payment submission.\nUnfortunately, your payment could not be approved for the reason shown below. Your subscription has not been activated and no wallet balance has been changed.\nYou may review the reason and submit corrected payment evidence through your Prayer Dome account.',
    actionLabel: 'Review my payment', actionPath: '/support.html#myplans',
    inAppTitle: 'Payment not approved',
    inAppMessage: 'Please review the reason and submit corrected evidence.'
  },
  payment_finance_alert: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'Prayer Dome Finance: Payment Awaiting Verification',
    heading: 'Payment awaiting verification',
    message: 'A member has submitted payment evidence. Open the finance workspace, compare the receipt with the ministry account, and only then approve or reject it.\nNo plan or wallet balance changes until this review is complete.',
    actionLabel: 'Open payment verification', actionPath: '/admin.html#payment-verification',
    inAppTitle: 'Payment awaiting verification',
    inAppMessage: 'A receipt is ready for finance review.'
  },
  withdrawal_submitted: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'We Received Your Prayer Dome Withdrawal Request',
    heading: 'Withdrawal requested',
    message: 'Your withdrawal request has been recorded and the amount is on hold. It has not left your wallet yet.\nThe finance team will review it and send you another message when it is being processed and again when the Mobile Money payment is confirmed. If it is rejected, the hold is released and your balance does not change.',
    actionLabel: 'View my wallet', actionPath: '/support.html#wallet',
    inAppTitle: 'Withdrawal requested',
    inAppMessage: 'Finance will review your withdrawal. No money has moved yet.'
  },
  withdrawal_finance_alert: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'Prayer Dome Finance: Withdrawal Awaiting Review',
    heading: 'Withdrawal awaiting review',
    message: 'A member has requested a withdrawal and the amount is held in their wallet. Review the request before sending any money.\nThe balance is deducted only when you confirm the actual Mobile Money payment.',
    actionLabel: 'Review withdrawals', actionPath: '/admin.html#withdrawals',
    inAppTitle: 'Withdrawal awaiting review',
    inAppMessage: 'A member withdrawal needs finance review.'
  },
  withdrawal_processing: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Withdrawal Is Being Processed',
    heading: 'Withdrawal approved for processing',
    message: 'The finance team has approved your withdrawal for payment. Your Mobile Money payment is now being processed.\nYour wallet balance will be reduced only when the payment has actually been made. We will send another message when it is paid.',
    actionLabel: 'View my wallet', actionPath: '/support.html#wallet',
    inAppTitle: 'Withdrawal processing',
    inAppMessage: 'Finance approved your withdrawal and is processing the payment.'
  },
  withdrawal_rejected: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'Update on Your Prayer Dome Withdrawal Request',
    heading: 'Withdrawal not approved',
    message: 'Your withdrawal request could not be approved for the reason shown below. The amount has been released from hold and your verified wallet balance has not changed.\nYou may correct the details and submit a new request from your wallet.',
    actionLabel: 'Review my wallet', actionPath: '/support.html#wallet',
    inAppTitle: 'Withdrawal not approved',
    inAppMessage: 'No money was deducted. Please review the reason and try again.'
  },
  withdrawal_paid: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Withdrawal Has Been Paid',
    heading: 'Withdrawal paid',
    message: 'The finance team has confirmed your Mobile Money payment. Your wallet has been updated and the transaction is recorded in your ledger.\nThe payment reference and amount are shown below.',
    actionLabel: 'View my wallet', actionPath: '/support.html#wallet',
    inAppTitle: 'Withdrawal paid',
    inAppMessage: 'Your Mobile Money payment has been confirmed.'
  },
  subscription_activated: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Subscription Is Active',
    heading: 'Subscription activated',
    message: 'Your verified support payment has activated your PRAYER DOME subscription.\nYour plan details, renewal date and programme progress are available in your account.',
    actionLabel: 'View my subscription', actionPath: '/support.html#myplans',
    inAppTitle: 'Subscription activated',
    inAppMessage: 'Your support plan is now active.'
  },
  subscription_expiring: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Subscription Is Expiring Soon',
    heading: 'Subscription expiring soon',
    message: 'This is a reminder that your PRAYER DOME subscription is due to expire soon.\nTo keep your support plan active, submit your renewal payment before the expiry date shown below.',
    actionLabel: 'Renew my plan', actionPath: '/support.html#myplans',
    inAppTitle: 'Subscription expiring soon',
    inAppMessage: 'Submit your renewal payment to keep the plan active.'
  },
  subscription_expired: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Subscription Has Expired',
    heading: 'Subscription expired',
    message: 'Your PRAYER DOME subscription has reached its expiry date and is no longer active.\nYou can start a new checkout or submit a renewal payment from your account at any time.',
    actionLabel: 'Renew my plan', actionPath: '/support.html#myplans',
    inAppTitle: 'Subscription expired',
    inAppMessage: 'Your plan is no longer active. You can renew from your account.'
  },
  subscription_renewed: {
    category: 'billing', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Subscription Has Been Renewed',
    heading: 'Subscription renewed',
    message: 'Your verified renewal payment has extended your PRAYER DOME subscription.\nThe new expiry date is shown below and is also available in your account.',
    actionLabel: 'View my subscription', actionPath: '/support.html#myplans',
    inAppTitle: 'Subscription renewed',
    inAppMessage: 'Your support plan has been extended.'
  },
  certificate_requested: {
    category: 'certificates', essential: false, kind: 'document',
    subject: 'We Received Your Prayer Dome Certificate Request',
    heading: 'Certificate request received',
    message: 'Thank you for submitting your certificate request. The Academy team will review your submission and let you know the outcome.\nYou will receive another message when a certificate is approved or issued.',
    actionLabel: 'View my certificates', actionPath: '/account.html#certificates',
    inAppTitle: 'Certificate request received',
    inAppMessage: 'The Academy team is reviewing your request.'
  },
  certificate_approved: {
    category: 'certificates', essential: false, kind: 'document',
    subject: 'Your Prayer Dome Certificate Request Has Been Approved',
    heading: 'Certificate approved',
    message: 'We are pleased to inform you that your certificate request has been approved.\nWe will let you know as soon as the certificate is ready to download from your account.',
    actionLabel: 'View my certificates', actionPath: '/account.html#certificates',
    inAppTitle: 'Certificate approved',
    inAppMessage: 'Your certificate has been approved and is being prepared.'
  },
  certificate_rejected: {
    category: 'certificates', essential: false, kind: 'document',
    subject: 'Update on Your Prayer Dome Certificate Request',
    heading: 'Certificate request not approved',
    message: 'Thank you for your certificate request. After review, we could not approve it at this time. The reason is shown below.\nPlease contact the Academy team if you need help or would like the decision reviewed.',
    actionLabel: 'Contact the ministry', actionPath: '/contact.html',
    inAppTitle: 'Certificate request update',
    inAppMessage: 'Please review the reason for this decision.'
  },
  certificate_ready: {
    category: 'certificates', essential: false, kind: 'document',
    subject: 'Your Prayer Dome Certificate Is Ready to Download',
    heading: 'Certificate ready',
    message: 'Your PRAYER DOME certificate is ready. You can open your account to download the signed PDF or print a copy at any time.',
    actionLabel: 'Download my certificate', actionPath: '/account.html#certificates',
    inAppTitle: 'Certificate ready',
    inAppMessage: 'Download your signed PDF from your account.'
  },
  prayer_received: {
    category: 'prayer', essential: false, kind: 'prayer',
    subject: 'We Received Your Prayer Request',
    heading: 'Prayer request received',
    message: 'Thank you for sharing your prayer request with PRAYER DOME. Our prayer team will stand with you.\nYou are not alone, and we are praying with you.',
    actionLabel: 'Visit the prayer wall', actionPath: '/prayer.html',
    inAppTitle: 'Prayer request received',
    inAppMessage: 'Our prayer team has received your request.'
  },
  testimony_submitted: {
    category: 'testimony', essential: false, kind: 'prayer',
    subject: 'We Received Your Prayer Dome Testimony',
    heading: 'Testimony received',
    message: 'Thank you for sharing what God has done in your life. Our team will review your testimony before it is considered for publication.',
    actionLabel: 'Visit the testimony page', actionPath: '/testimony.html',
    inAppTitle: 'Testimony received',
    inAppMessage: 'The ministry team is reviewing your testimony.'
  },
  testimony_approved: {
    category: 'testimony', essential: false, kind: 'prayer',
    subject: 'Your Prayer Dome Testimony Has Been Approved',
    heading: 'Testimony approved',
    message: 'Thank you for your testimony. It has been approved for publication and may appear on the PRAYER DOME testimony page.',
    actionLabel: 'View testimonies', actionPath: '/testimony.html',
    inAppTitle: 'Testimony approved',
    inAppMessage: 'Your testimony has been approved for publication.'
  },
  testimony_rejected: {
    category: 'testimony', essential: false, kind: 'prayer',
    subject: 'Update on Your Prayer Dome Testimony',
    heading: 'Testimony not approved',
    message: 'Thank you for sharing your testimony. After review, our team was not able to approve it for publication at this time. The reason is shown below.',
    actionLabel: 'Contact the ministry', actionPath: '/contact.html',
    inAppTitle: 'Testimony update',
    inAppMessage: 'Please review the reason for this decision.'
  },
  support_claim_submitted: {
    category: 'support', essential: false, kind: 'prayer',
    subject: 'We Received Your Prayer Dome Support Claim',
    heading: 'Support claim received',
    message: 'Thank you for submitting your support claim. Our team will review the details and documents you provided.',
    actionLabel: 'View my support plan', actionPath: '/support.html#myplans',
    inAppTitle: 'Support claim received',
    inAppMessage: 'Our team is reviewing your claim.'
  },
  support_claim_approved: {
    category: 'support', essential: false, kind: 'prayer',
    subject: 'Your Prayer Dome Support Claim Has Been Approved',
    heading: 'Support claim approved',
    message: 'Your support claim has been approved by the ministry team. Please contact the office if you need the next steps or any clarification.',
    actionLabel: 'View my support plan', actionPath: '/support.html#myplans',
    inAppTitle: 'Support claim approved',
    inAppMessage: 'Your claim has been approved.'
  },
  support_claim_rejected: {
    category: 'support', essential: false, kind: 'prayer',
    subject: 'Update on Your Prayer Dome Support Claim',
    heading: 'Support claim not approved',
    message: 'After review, your support claim could not be approved at this time. The reason is shown below.\nPlease contact the ministry office if you need help.',
    actionLabel: 'View my support plan', actionPath: '/support.html#myplans',
    inAppTitle: 'Support claim update',
    inAppMessage: 'Please review the reason for this decision.'
  },

  /* ---------------------------------------------------- account + security */
  email_verification: {
    category: 'account', essential: true, kind: 'account',
    subject: 'Your Prayer Dome verification code',
    heading: 'Verify your email address',
    message: 'Enter the six-digit code below in Prayer Dome to verify this email address. The code expires in {{minutes}} minutes.\nIf you did not create a Prayer Dome account, you can ignore this message and do not share the code.',
    actionLabel: 'Open Prayer Dome', actionPath: '/account.html',
    inAppTitle: 'Verify your email',
    inAppMessage: 'Enter the six-digit code sent to your email address.'
  },
  welcome: {
    category: 'account', essential: true, kind: 'account',
    subject: 'Welcome to Prayer Dome',
    heading: 'Welcome to the Prayer Dome family',
    message: 'Your email address is now verified and your Prayer Dome account is ready.\nYou can use your account to join the prayer wall, follow daily devotionals, read the Bible, save your progress in the Academy and manage your giving records.\nThank you for joining a house of prayer for all nations. We look forward to praying with you.',
    actionLabel: 'Open my account', actionPath: '/account.html',
    inAppTitle: 'Welcome to Prayer Dome',
    inAppMessage: 'Your account is verified and ready to use.'
  },
  password_reset: {
    category: 'account', essential: true, kind: 'account',
    subject: 'Reset your Prayer Dome password',
    heading: 'Reset your password',
    message: 'We received a request to reset the password for your Prayer Dome account. Use the secure button below to choose a new password. The link can only be used once and expires shortly.\nIf you did not ask for a reset, you can ignore this message. Your current password will continue to work and no change will be made.',
    actionLabel: 'Choose a new password', actionPath: '{{resetLink}}',
    inAppTitle: 'Password reset requested',
    inAppMessage: 'A secure password reset link was requested for your account.'
  },
  password_changed: {
    category: 'account', essential: true, kind: 'account',
    subject: 'Your Prayer Dome password was changed',
    heading: 'Your password was changed',
    message: 'The password for your Prayer Dome account was changed successfully.\nIf you made this change, no further action is needed. If you did not make it, reset your password immediately and contact the ministry office so we can help secure your account.',
    actionLabel: 'Secure my account', actionPath: '/account.html',
    inAppTitle: 'Password changed',
    inAppMessage: 'Your Prayer Dome password was changed.'
  },
  new_login: {
    category: 'account', essential: true, kind: 'account',
    subject: 'New sign-in to your Prayer Dome account',
    heading: 'New sign-in detected',
    message: 'Your Prayer Dome account was signed in from a device or browser we have not seen before.\nIf this was you, no action is needed. If you do not recognise this sign-in, change your password immediately and contact the ministry office.',
    actionLabel: 'Review my account', actionPath: '/account.html',
    inAppTitle: 'New sign-in',
    inAppMessage: 'A new device signed in to your account.'
  },
  account_security_alert: {
    category: 'account', essential: true, kind: 'account',
    subject: 'Security notice for your Prayer Dome account',
    heading: 'Account security notice',
    message: 'There was a security-related change or request on your Prayer Dome account. The details are shown below.\nIf you do not recognise this activity, please reset your password and contact the ministry office immediately.',
    actionLabel: 'Review my account', actionPath: '/account.html',
    inAppTitle: 'Account security notice',
    inAppMessage: 'Please review recent security activity on your account.'
  },

  /* ------------------------------------------------------------- giving */
  giving_submitted: {
    category: 'giving', essential: true, kind: 'account',
    subject: 'We received your Prayer Dome giving record',
    heading: 'Thank you for giving',
    message: 'Thank you for supporting the work of Prayer Dome. Your giving record has been received and our finance team will review it.\nThis message confirms that your submission arrived. It does not confirm that the payment has been received or verified. You will receive another message when the review is complete.',
    actionLabel: 'View my giving record', actionPath: '/give.html',
    inAppTitle: 'Giving record received',
    inAppMessage: 'Your giving submission is with the finance team.'
  },
  giving_confirmed: {
    category: 'giving', essential: true, kind: 'account',
    subject: 'Your Prayer Dome giving has been confirmed',
    heading: 'Giving confirmed',
    message: 'Our finance team has reviewed and confirmed your giving record. Thank you for your generous support of the ministry.\nThe details of the confirmed record are shown below.',
    actionLabel: 'View my giving record', actionPath: '/give.html',
    inAppTitle: 'Giving confirmed',
    inAppMessage: 'Your giving record has been confirmed by finance.'
  },
  giving_rejected: {
    category: 'giving', essential: true, kind: 'account',
    subject: 'Update on your Prayer Dome giving record',
    heading: 'Giving record needs attention',
    message: 'Our finance team reviewed your giving record but could not confirm it for the reason shown below.\nIf you believe the information is correct, please contact the ministry office with your payment reference so the team can assist you.',
    actionLabel: 'Contact the ministry', actionPath: '/contact.html',
    inAppTitle: 'Giving record update',
    inAppMessage: 'Please review the reason on your giving record.'
  },

  /* ------------------------------------------------------------- prayer */
  prayer_request_confirmation: {
    category: 'prayer', essential: false, kind: 'prayer',
    subject: 'We received your Prayer Dome prayer request',
    heading: 'Your prayer request has been received',
    message: 'Thank you for sharing your prayer request with Prayer Dome. Our prayer team has received it and will stand with you in prayer.\nYou can return to the prayer wall at any time to read encouragement or share an update.',
    actionLabel: 'Open the prayer wall', actionPath: '/prayer.html',
    inAppTitle: 'Prayer request received',
    inAppMessage: 'The Prayer Dome team has received your request.'
  },
  prayer_request_update: {
    category: 'prayer', essential: false, kind: 'prayer',
    subject: 'An update on your Prayer Dome prayer request',
    heading: 'Your prayer request has been updated',
    message: 'There is an update on the prayer request you shared with Prayer Dome. The current status is shown below.\nThank you for letting us pray with you.',
    actionLabel: 'View my prayer request', actionPath: '/prayer.html',
    inAppTitle: 'Prayer request updated',
    inAppMessage: 'There is an update on your prayer request.'
  },

  /* -------------------------------------------------- ministry + updates */
  ministry_announcement: {
    category: 'announcement', essential: false, kind: 'news',
    subject: '{{title}}',
    heading: '{{title}}',
    message: '{{message}}',
    actionLabel: 'Read on Prayer Dome', actionPath: '/news.html',
    inAppTitle: 'Ministry announcement',
    inAppMessage: 'A new notice from Prayer Dome.'
  },
  /* ------------------------------------------------------------------ radio */
  radio_presenter_request: {
    category: 'announcement', essential: true, kind: 'news',
    subject: 'Radio presenter request: {{title}}',
    heading: 'A presenter has requested airtime',
    message: '{{name}} has requested a live presenter session on Prayer Dome Radio.\nProgramme: {{title}}\nRequested start: {{date}}\nDuration: {{minutes}} minutes\n\nReview the request in Admin → Radio Studio before granting access. No presenter can take over the station until an administrator approves it.',
    actionLabel: 'Review presenter request', actionPath: '/admin.html#radio',
    inAppTitle: 'Radio presenter request',
    inAppMessage: '{{name}} requested {{title}} at {{date}}.'
  },
  radio_presenter_decision: {
    category: 'account', essential: true, kind: 'account',
    subject: 'Your Prayer Dome Radio presenter request: {{status}}',
    heading: 'Presenter request update',
    message: 'Your request to present on Prayer Dome Radio has been updated.\nProgramme: {{title}}\nRequested start: {{date}}\nStatus: {{status}}\n{{reason}}\n\nYou can review the request in Presenter Studio on the Radio page. Live controls only become available while an approved session is inside its approved time window.',
    actionLabel: 'Open Presenter Studio', actionPath: '/radio.html#presenter-studio',
    inAppTitle: 'Presenter request {{status}}',
    inAppMessage: '{{title}}: {{status}}.'
  },
  newsletter_welcome: {
    category: 'newsletter', essential: false, kind: 'news',
    subject: 'Welcome to Prayer Dome updates',
    heading: 'Thank you for staying connected',
    message: 'Thank you for agreeing to receive Prayer Dome ministry updates. We will share service notices, devotional encouragement and ministry news with you from time to time.\nYou can change your email preferences at any time from your account, and every message includes a way to stop receiving updates.',
    actionLabel: 'Visit Prayer Dome', actionPath: '/',
    inAppTitle: 'Prayer Dome updates',
    inAppMessage: 'You are on the Prayer Dome updates list.'
  }
};

function defaultValue() {
  return {
    name: 'Prayer Dome member',
    status: '',
    reference: '',
    plan: '',
    amount: '',
    reason: '',
    date: formatDate(new Date()),
    next: '',
    score: '',
    site: SITE_URL
  };
}

function interpolate(value, values) {
  return String(value == null ? '' : value).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, function (_, key) {
    return values[key] == null ? '' : String(values[key]);
  });
}

function safeTemplateAction(value, fallback) {
  const raw = String(value == null ? '' : value).trim().slice(0, 1600);
  // A password-reset template legitimately points at a one-time link that is
  // only known when the event fires. Keep the placeholder here and validate the
  // resolved URL in buildEmail; every other value must be a safe site path.
  if (/\{\{\s*[A-Za-z0-9_]+\s*\}\}/.test(raw)) return raw;
  return safePath(raw, fallback);
}

function normalizeTemplate(event, custom) {
  const base = EVENTS[event] || EVENTS.membership_submitted;
  const row = custom && typeof custom === 'object' ? custom : {};
  return {
    subject: text(row.subject, 180) || base.subject,
    heading: text(row.heading, 120) || base.heading,
    message: (typeof row.message === 'string' ? row.message.replace(/\r\n/g, '\n').trim().slice(0, 3000) : '') || base.message,
    actionLabel: text(row.actionLabel, 80) || base.actionLabel,
    actionPath: safeTemplateAction(row.actionPath, base.actionPath)
  };
}

function buildEmail(event, values, settings, customTemplate) {
  const base = EVENTS[event] || EVENTS.membership_submitted;
  const template = normalizeTemplate(EVENTS[event] ? event : 'membership_submitted', customTemplate);
  const data = Object.assign(defaultValue(), values || {});
  const subject = interpolate(template.subject, data);
  const heading = interpolate(template.heading, data);
  const body = interpolate(template.message, data);
  const actionLabel = interpolate(template.actionLabel, data);
  const actionPath = interpolate(template.actionPath, data);
  const actionUrl = design.safeActionUrl(actionPath, SITE_URL);
  const details = [
    ['Status', data.status],
    ['Reference', data.reference],
    ['Plan', data.plan],
    ['Amount', data.amount],
    ['Date', data.date],
    ['Reason', data.reason],
    ['Device', data.device]
  ].filter(function (item) { return item[1]; });

  const rendered = design.renderEmail({
    subject: subject,
    heading: heading,
    preheader: body,
    greeting: 'Dear ' + (data.name || 'Prayer Dome member') + ',',
    paragraphs: body,
    details: details,
    code: data.code,
    action: actionLabel ? { label: actionLabel, url: actionUrl } : null,
    footerNote: base.footerNote,
    category: base.category,
    siteUrl: SITE_URL
  });

  return {
    subject: rendered.subject,
    heading: rendered.heading,
    html: rendered.html,
    text: rendered.text,
    actionUrl: rendered.actionUrl,
    kind: base.kind,
    category: base.category,
    essential: base.essential !== false
  };
}

async function loadCustomTemplate(event) {
  try {
    const snap = await admin.firestore().doc('emailTemplates/' + event).get();
    return snap.exists ? snap.data() : null;
  } catch (error) { return null; }
}

/* ---------------------------------------------------------------- recipient */

async function resolveRecipient(userId, hints) {
  const db = admin.firestore();
  const info = hints && typeof hints === 'object' ? hints : {};
  let authUser = null;
  try {
    const result = await admin.auth().getUser(userId);
    authUser = result || null;
  } catch (error) { /* deleted account or auth outage */ }
  const [userSnap, memberSnap] = await Promise.all([
    db.collection('users').doc(userId).get().catch(function () { return null; }),
    db.collection('memberships').doc(userId).get().catch(function () { return null; })
  ]);
  const user = userSnap && userSnap.exists ? userSnap.data() : {};
  const member = memberSnap && memberSnap.exists ? memberSnap.data() : {};
  const email = cleanEmail(
    (authUser && authUser.email) || user.email || member.email || info.email
  );
  const name = text(
    member.fullName || user.fullName || user.displayName || (authUser && authUser.displayName) || info.name || 'Prayer Dome member',
    120
  );
  return { email, name };
}

async function emailAllowed(userId, category, essential) {
  if (essential) return true;
  try {
    const snap = await admin.firestore().doc('userNotificationPrefs/' + userId).get();
    const prefs = snap.exists ? (snap.data() || {}).emailPrefs : null;
    return !(prefs && prefs[category] === false);
  } catch (error) { return true; }
}

/* ----------------------------------------------------------------- outbox */

async function sendOutbox(eventDocId) {
  const db = admin.firestore();
  const ref = db.collection('emailOutbox').doc(eventDocId);
  const snap = await ref.get();
  if (!snap.exists) return { sent: false, reason: 'missing' };
  const row = snap.data() || {};
  if (row.retryable === false) return { sent: false, reason: 'not-retryable' };
  if (['sent', 'accepted', 'delivered', 'bounced', 'disabled', 'opted_out', 'missing_email'].includes(row.status)) return { sent: false, reason: row.status };
  if (!row.recipient) {
    await ref.set({ status: 'missing_email', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { sent: false, reason: 'missing-email' };
  }
  const attempts = Number(row.attempts || 0);
  if (attempts >= 5) return { sent: false, reason: 'retry-limit' };
  const settings = await loadSettings();
  // A retry must obey the same switches as the first attempt. Without this
  // check, a message queued before an administrator disabled email (or before
  // a member opted out) would still be delivered by the retry job.
  if (!settings.enabled || (row.category && settings.categories[row.category] === false)) {
    await ref.set({ status: 'disabled', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { sent: false, reason: 'disabled' };
  }
  if (row.essential !== true && row.userId) {
    const allowed = await emailAllowed(row.userId, row.category, false);
    if (!allowed) {
      await ref.set({ status: 'opted_out', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { sent: false, reason: 'opted_out' };
    }
  }
  const template = await loadCustomTemplate(row.event);
  const email = buildEmail(row.event, row.values || {}, settings, template);
  await ref.set({
    status: 'sending', attempts: attempts + 1,
    lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  try {
    const result = await brevo.sendTransactionalEmail({
      to: row.recipient,
      toName: row.recipientName || '',
      subject: email.subject,
      html: email.html,
      text: email.text,
      senderName: settings.senderName,
      senderEmail: settings.senderEmail,
      replyTo: settings.replyTo,
      tags: ['prayer-dome', row.event]
    });
    await ref.set({
      // Brevo accepting the message is not proof that it reached the inbox.
      // The provider's later delivery/bounce state is recorded by
      // refreshProviderStatuses, and the admin console never calls this
      // "delivered" unless the provider actually says so.
      status: 'accepted',
      providerStatus: 'accepted',
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      providerMessageId: result && result.messageId ? String(result.messageId) : '',
      lastError: '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { sent: true, accepted: true, messageId: result && result.messageId };
  } catch (error) {
    const message = text(error && error.message, 300) || 'The email provider did not accept the message.';
    const nextAttempt = new Date(Date.now() + Math.min(60, Math.pow(2, attempts + 1)) * 60 * 1000);
    await ref.set({
      status: 'failed',
      lastError: message,
      nextAttemptAt: nextAttempt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.error('Email delivery failed for ' + eventDocId + ':', message);
    return { sent: false, error: message };
  }
}

async function deliverEvent(options) {
  const opts = options || {};
  const event = EVENTS[opts.event] ? opts.event : '';
  if (!event) return { skipped: true, reason: 'unknown-event' };
  const userId = text(opts.userId, 160);
  if (!userId) return { skipped: true, reason: 'missing-user' };
  const descriptor = EVENTS[event];
  const docId = text(opts.eventId, 220) || eventId(event, userId, Date.now());
  const outboxRef = admin.firestore().collection('emailOutbox').doc(docId);
  const existing = await outboxRef.get();
  if (existing.exists) return { skipped: true, reason: 'duplicate' };

  const recipient = await resolveRecipient(userId, opts);
  const settings = await loadSettings();
  const allowed = await emailAllowed(userId, descriptor.category, descriptor.essential !== false);
  const emailEnabled = settings.enabled && settings.categories[descriptor.category] !== false;
  const values = Object.assign({ name: recipient.name, site: SITE_URL }, opts.values || {});
  const template = await loadCustomTemplate(event);
  const rendered = buildEmail(event, values, settings, template);
  const status = !recipient.email ? 'missing_email'
    : !emailEnabled ? 'disabled'
      : !allowed ? 'opted_out'
        : 'pending';
  const title = text(opts.title, 140) || interpolate(descriptor.inAppTitle, values);
  const message = text(opts.message, 400) || interpolate(descriptor.inAppMessage, values);
  const link = safePath(opts.link || descriptor.actionPath, descriptor.actionPath);

  await admin.firestore().runTransaction(async function (tx) {
    const current = await tx.get(outboxRef);
    if (current.exists) return;
    tx.set(outboxRef, {
      eventId: docId,
      event,
      category: descriptor.category,
      essential: descriptor.essential !== false,
      userId,
      recipient: recipient.email,
      recipientName: recipient.name,
      subject: rendered.subject,
      values,
      status,
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(admin.firestore().collection('userNotifications').doc(docId), {
      userId,
      event,
      type: descriptor.kind || 'general',
      title,
      message,
      link,
      reference: text(values.reference, 160),
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  if (status !== 'pending') return { sent: false, reason: status };
  return sendOutbox(docId);
}

/**
 * Deliver one event to an address that is not necessarily tied to a member
 * account: a password-reset link, a newsletter welcome, or a receipt for a
 * guest giving. It still uses the same branded renderer, settings, outbox log
 * and deduplication contract as member email.
 */
async function deliverDirect(options) {
  const opts = options || {};
  const event = EVENTS[opts.event] ? opts.event : '';
  if (!event) return { skipped: true, reason: 'unknown-event' };
  const recipient = cleanEmail(opts.to || opts.email);
  if (!recipient) return { skipped: true, reason: 'invalid-recipient' };
  const descriptor = EVENTS[event];
  const docId = text(opts.eventId, 220)
    || eventId(event, 'direct-' + recipient.replace(/[^a-z0-9]/g, '-').slice(0, 40), Date.now());
  const outboxRef = admin.firestore().collection('emailOutbox').doc(docId);
  const existing = await outboxRef.get();
  if (existing.exists) return { skipped: true, reason: 'duplicate' };

  const settings = await loadSettings();
  const enabled = settings.enabled && (descriptor.essential === true || settings.categories[descriptor.category] !== false);
  if (!enabled) return { sent: false, reason: 'disabled' };
  const values = Object.assign({ name: text(opts.name, 120) || 'Prayer Dome member', site: SITE_URL }, opts.values || {});
  const template = await loadCustomTemplate(event);
  const rendered = buildEmail(event, values, settings, template);

  await outboxRef.set({
    eventId: docId,
    event,
    category: descriptor.category,
    essential: descriptor.essential !== false,
    userId: '',
    direct: true,
    recipient,
    recipientName: values.name,
    subject: rendered.subject,
    values,
    status: 'pending',
    attempts: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return sendOutbox(docId);
}

/**
 * Send a one-time password-reset link without writing that link (or the
 * member's password) into the outbox. The row keeps only the event, recipient,
 * subject and provider result so the admin log is useful but cannot be used to
 * reset somebody's account.
 */
async function sendPasswordResetEmail(options) {
  const opts = options || {};
  const to = cleanEmail(opts.to || opts.email);
  if (!to) return { sent: false, reason: 'invalid-recipient' };
  const settings = await loadSettings();
  if (!settings.enabled) return { sent: false, reason: 'disabled' };
  const values = { name: text(opts.name, 120) || 'Prayer Dome member', email: to };
  const rendered = buildEmail('password_reset', Object.assign({}, values, { resetLink: String(opts.link || '') }), settings, null);
  const docId = 'reset_' + Date.now().toString(36) + '_' + to.replace(/[^a-z0-9]/g, '').slice(0, 24);
  const ref = admin.firestore().collection('emailOutbox').doc(docId);
  await ref.set({
    event: 'password_reset', category: 'account', essential: true,
    userId: text(opts.userId, 160), recipient: to, recipientName: values.name,
    subject: rendered.subject, values, status: 'sending', attempts: 1,
    retryable: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  try {
    const result = await brevo.sendTransactionalEmail({
      to, toName: values.name, subject: rendered.subject,
      html: rendered.html, text: rendered.text,
      senderName: settings.senderName, senderEmail: settings.senderEmail,
      replyTo: settings.replyTo, tags: ['prayer-dome', 'password-reset']
    });
    await ref.set({
      status: 'accepted', providerStatus: 'accepted',
      providerMessageId: result && result.messageId ? String(result.messageId) : '',
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { sent: true, messageId: result && result.messageId };
  } catch (error) {
    const message = text(error && error.message, 300) || 'The email provider did not accept the message.';
    await ref.set({
      status: 'failed', lastError: message, failureReason: message,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch(() => {});
    return { sent: false, reason: error && error.code || 'provider-error' };
  }
}

/**
 * Ask Brevo for the current state of messages it accepted. This is the only
 * place an address is called "delivered": the provider has to say so.
 * Limited to recent rows so one admin click cannot exhaust the API quota.
 */
async function refreshProviderStatuses(limitValue) {
  const db = admin.firestore();
  const max = Math.min(25, Math.max(1, Number(limitValue) || 15));
  const snapshot = await db.collection('emailOutbox').orderBy('createdAt', 'desc').limit(80).get();
  let checked = 0;
  let updated = 0;
  for (const entry of snapshot.docs) {
    if (checked >= max) break;
    const row = entry.data() || {};
    if (!row.providerMessageId) continue;
    if (!['accepted', 'sent', 'delivered', 'bounced', 'failed'].includes(String(row.status || ''))) continue;
    if (row.deliveredAt || row.bouncedAt) continue;
    checked += 1;
    const result = await brevo.getEmailStatus(row.providerMessageId, process.env, row.recipient);
    if (!result || !result.ok) continue;
    const providerStatus = String(result.status || '').toLowerCase();
    if (!providerStatus) continue;
    const patch = {
      providerStatus,
      providerCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (providerStatus === 'delivered') {
      patch.status = 'delivered';
      patch.deliveredAt = admin.firestore.FieldValue.serverTimestamp();
      patch.failureReason = '';
    } else if (['bounced', 'blocked', 'invalid', 'spam', 'hard_bounce', 'soft_bounce'].includes(providerStatus)) {
      patch.status = providerStatus === 'bounced' || providerStatus === 'hard_bounce' ? 'bounced' : 'failed';
      patch.bouncedAt = admin.firestore.FieldValue.serverTimestamp();
      patch.failureReason = text(result.reason, 300) || 'The provider reported that the message was not delivered.';
      patch.lastError = patch.failureReason;
    } else if (providerStatus === 'deferred') {
      patch.failureReason = text(result.reason, 300) || 'The provider deferred delivery.';
    }
    await entry.ref.set(patch, { merge: true });
    updated += 1;
  }
  return { checked, updated };
}

async function emailDiagnostics() {
  const settings = await loadSettings();
  const connection = await brevo.checkConnection(process.env);
  const db = admin.firestore();
  let counts = { pending: 0, accepted: 0, delivered: 0, failed: 0, bounced: 0, disabled: 0, missing_email: 0, opted_out: 0 };
  try {
    const snapshot = await db.collection('emailOutbox').orderBy('createdAt', 'desc').limit(200).get();
    snapshot.forEach(function (entry) {
      const status = String((entry.data() || {}).status || 'pending');
      if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
    });
  } catch (error) { /* diagnostics must still return the credential check */ }
  return {
    provider: 'brevo',
    configured: connection.configured,
    connection: connection,
    sender: { name: settings.senderName, email: settings.senderEmail, replyTo: settings.replyTo || '' },
    enabled: settings.enabled,
    counts: counts,
    checkedAt: new Date().toISOString()
  };
}

/* --------------------------------------------------------------- admin auth */

async function isAdmin(uid) {
  if (!uid) return false;
  const db = admin.firestore();
  try {
    const [member, user] = await Promise.all([
      db.collection('memberships').doc(uid).get(),
      db.collection('users').doc(uid).get()
    ]);
    return (member.exists && member.data().role === 'admin') ||
      (user.exists && user.data().role === 'admin');
  } catch (error) { return false; }
}

async function requireAdmin(context) {
  if (!context || !context.auth || !context.auth.uid) fail('unauthenticated', 'Sign in to continue.');
  if (!(await isAdmin(context.auth.uid))) fail('permission-denied', 'Only an administrator can manage email delivery.');
  return context.auth;
}

/* ---------------------------------------------------------------- admin API */

async function listLogs(limitValue, statusFilter) {
  const db = admin.firestore();
  const snapshot = await db.collection('emailOutbox').orderBy('createdAt', 'desc').limit(Math.min(200, Math.max(1, Number(limitValue) || 100))).get();
  const rows = [];
  snapshot.forEach(function (entry) {
    const row = entry.data() || {};
    if (statusFilter && statusFilter !== 'all' && row.status !== statusFilter) return;
    rows.push({
      id: entry.id,
      event: row.event || '',
      userId: row.userId || '',
      recipient: row.recipient || '',
      recipientName: row.recipientName || '',
      subject: row.subject || '',
      status: row.status || 'pending',
      providerStatus: row.providerStatus || '',
      providerMessageId: row.providerMessageId || '',
      retryable: row.retryable !== false,
      attempts: Number(row.attempts || 0),
      lastError: row.lastError || '',
      failureReason: row.failureReason || '',
      createdAt: row.createdAt || null,
      acceptedAt: row.acceptedAt || row.sentAt || null,
      sentAt: row.sentAt || null,
      deliveredAt: row.deliveredAt || null,
      bouncedAt: row.bouncedAt || null,
      nextAttemptAt: row.nextAttemptAt || null
    });
  });
  return rows;
}

async function retryFailed(limitValue) {
  const db = admin.firestore();
  const snapshot = await db.collection('emailOutbox').where('status', '==', 'failed').limit(Math.min(75, Math.max(1, Number(limitValue) || 25))).get();
  const results = [];
  for (const entry of snapshot.docs) {
    const row = entry.data() || {};
    if (row.retryable === false) continue;
    if (Number(row.attempts || 0) >= 5) continue;
    // Respect the exponential backoff recorded when the last attempt failed;
    // the scheduler wakes every 30 minutes but a message is not retried before
    // its nextAttemptAt, which avoids hammering a provider outage.
    if (row.nextAttemptAt && millis(row.nextAttemptAt) > Date.now()) continue;
    results.push(await sendOutbox(entry.id));
  }
  return { attempted: results.length, sent: results.filter(function (item) { return item.sent; }).length };
}

async function saveSettings(data, actor) {
  const categories = {};
  Object.keys(EMAIL_CATEGORIES).forEach(function (key) {
    categories[key] = !(data && data.categories && data.categories[key] === false);
  });
  const senderEmail = cleanEmail(data && data.senderEmail);
  if (!senderEmail) fail('invalid-argument', 'Enter the verified sender email address.');
  const replyTo = text(data && data.replyTo, 254);
  if (replyTo && !cleanEmail(replyTo)) fail('invalid-argument', 'The reply-to address is not valid.');
  const payload = {
    enabled: !(data && data.enabled === false),
    senderName: text(data && data.senderName, 80) || 'Prayer Dome',
    senderEmail,
    replyTo: cleanEmail(replyTo) || '',
    categories,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: (actor && actor.token && actor.token.email) || (actor && actor.uid) || ''
  };
  await admin.firestore().doc('emailSettings/main').set(payload, { merge: true });
  return normalizeSettings(payload);
}

async function saveTemplate(data, actor) {
  const event = text(data && data.event, 80);
  if (!EVENTS[event]) fail('invalid-argument', 'Choose a known notification event.');
  const path = safeTemplateAction(data && data.actionPath, EVENTS[event].actionPath);
  const payload = {
    event,
    subject: text(data && data.subject, 180),
    heading: text(data && data.heading, 120),
    message: String((data && data.message) || '').replace(/\r\n/g, '\n').trim().slice(0, 3000),
    actionLabel: text(data && data.actionLabel, 80),
    actionPath: path,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: (actor && actor.token && actor.token.email) || (actor && actor.uid) || ''
  };
  if (!payload.subject || !payload.heading || !payload.message) {
    fail('invalid-argument', 'Subject, heading and message are required.');
  }
  await admin.firestore().doc('emailTemplates/' + event).set(payload, { merge: true });
  return { event: event, template: payload };
}

async function templatesList() {
  const db = admin.firestore();
  const snapshot = await db.collection('emailTemplates').get();
  const custom = {};
  snapshot.forEach(function (entry) { custom[entry.id] = entry.data() || {}; });
  return Object.keys(EVENTS).map(function (event) {
    const row = custom[event] || null;
    const template = normalizeTemplate(event, row);
    return {
      event,
      label: EVENTS[event].inAppTitle,
      category: EVENTS[event].category,
      essential: EVENTS[event].essential !== false,
      subject: template.subject,
      heading: template.heading,
      message: template.message,
      actionLabel: template.actionLabel,
      actionPath: template.actionPath,
      customized: Boolean(row)
    };
  });
}

async function sendTestEmail(data, context) {
  const actor = await requireAdmin(context);
  const settings = await loadSettings();
  const to = cleanEmail((data && data.to) || (actor.token && actor.token.email));
  if (!to) fail('invalid-argument', 'Enter a valid recipient email address.');
  const values = {
    name: (actor.token && actor.token.name) || 'Prayer Dome administrator',
    status: 'Test message',
    reference: 'EMAIL-TEST-' + Date.now().toString(36).toUpperCase(),
    date: formatDate(new Date()),
    site: SITE_URL
  };
  const email = buildEmail('membership_approved', values, settings, {
    subject: 'Prayer Dome email delivery test',
    heading: 'Email delivery test',
    message: 'This is a test of the PRAYER DOME notification service. If you can read this message, transactional email delivery is working.',
    actionLabel: 'Open Prayer Dome',
    actionPath: '/'
  });
  const logRef = admin.firestore().collection('emailOutbox').doc('test_' + Date.now().toString(36) + '_' + (actor.uid || 'admin'));
  await logRef.set({
    event: 'test', userId: actor.uid || '', recipient: to,
    recipientName: values.name, subject: email.subject,
    status: 'sending', attempts: 1, values,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  try {
    const result = await brevo.sendTransactionalEmail({
      to, toName: values.name, subject: email.subject, html: email.html, text: email.text,
      senderName: settings.senderName, senderEmail: settings.senderEmail,
      replyTo: settings.replyTo, tags: ['prayer-dome', 'test']
    });
    await logRef.set({
      status: 'accepted', providerStatus: 'accepted',
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      providerMessageId: result && result.messageId ? String(result.messageId) : '',
      lastError: '', updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { sent: true, accepted: true, messageId: result && result.messageId };
  } catch (error) {
    await logRef.set({
      status: 'failed', lastError: text(error && error.message, 300),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    fail('unavailable', 'The test email could not be delivered: ' + (error.message || 'provider error'));
  }
}

async function emailAdminHandler(data, context) {
  const payload = data && typeof data === 'object' ? data : {};
  const action = text(payload.action, 60) || 'settings.get';
  switch (action) {
    case 'settings.get':
      await requireAdmin(context);
      return { settings: await loadSettings(), categories: EMAIL_CATEGORIES };
    case 'settings.save':
      return { settings: await saveSettings(payload, await requireAdmin(context)) };
    case 'templates.list':
      await requireAdmin(context);
      return { templates: await templatesList(), categories: EMAIL_CATEGORIES };
    case 'templates.save':
      return await saveTemplate(payload, await requireAdmin(context));
    case 'logs.list':
      await requireAdmin(context);
      return { logs: await listLogs(payload.limit, payload.status) };
    case 'logs.refresh':
      await requireAdmin(context);
      return await refreshProviderStatuses(payload.limit);
    case 'diagnostics':
      await requireAdmin(context);
      return await emailDiagnostics();
    case 'retry':
      await requireAdmin(context);
      if (payload.id) return await sendOutbox(text(payload.id, 220));
      return await retryFailed(payload.limit);
    case 'test':
      return await sendTestEmail(payload, context);
    default:
      fail('invalid-argument', 'Unknown email administration action.');
  }
}

/* --------------------------------------------------------------- triggers */

function statusLabel(value) {
  return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
}

function memberValues(snap, userId, extra) {
  const row = snap && snap.data ? snap.data() : {};
  return Object.assign({
    name: row.fullName || row.displayName || '',
    reference: row.membershipId || userId,
    status: statusLabel(row.status),
    reason: row.rejectionReason || row.rejectReason || row.infoRequestReason || '',
    date: formatDate(snap && snap.updateTime ? snap.updateTime.toDate() : new Date())
  }, extra || {});
}

async function notifyMembership(change, context) {
  if (!change.after.exists) return null;
  const before = change.before.exists ? change.before.data() : null;
  const after = change.after.data() || {};
  const userId = context.params.uid;
  const previousStatus = before ? before.status : '';
  const currentStatus = after.status || '';
  const suffix = currentStatus + '-' + eventSuffix(change.after);
  const base = {
    userId,
    values: memberValues(change.after, userId),
  };
  if (!before) {
    if (currentStatus === 'pending') return deliverEvent(Object.assign(base, { event: 'membership_submitted', eventId: eventId('membership_submitted', userId, eventSuffix(change.after)), link: '/account.html' }));
    if (currentStatus === 'approved') return deliverEvent(Object.assign(base, { event: 'membership_approved', eventId: eventId('membership_approved', userId, suffix) }));
    return null;
  }
  if (currentStatus === previousStatus) return null;
  let event = '';
  if (currentStatus === 'approved') event = 'membership_approved';
  else if (currentStatus === 'rejected') event = 'membership_rejected';
  else if (currentStatus === 'needs_info') event = 'membership_info_required';
  else if (currentStatus === 'suspended') event = 'membership_suspended';
  if (!event) return null;
  return deliverEvent(Object.assign(base, { event, eventId: eventId(event, userId, suffix) }));
}

/*
 * Alert the finance team without ever blocking the member's own message.
 * Admin uids come from the server-side role records; the browser supplies
 * nothing. Each alert has a deterministic outbox id, so a trigger retry cannot
 * send the same alert twice.
 */
async function financeTeamIds() {
  const db = admin.firestore();
  const ids = new Set();
  const queries = [
    db.collection('users').where('role', '==', 'admin').limit(25).get(),
    db.collection('memberships').where('role', '==', 'admin').limit(25).get()
  ];
  const results = await Promise.allSettled(queries);
  results.forEach(function (result) {
    if (result.status !== 'fulfilled') return;
    result.value.forEach(function (entry) { ids.add(entry.id); });
  });
  return Array.from(ids);
}

async function notifyFinanceTeam(options) {
  const opts = options || {};
  try {
    const ids = await financeTeamIds();
    if (!ids.length) {
      console.warn('Finance alert skipped: no administrator role records were found.');
      return { sent: 0, reason: 'no-finance-recipients' };
    }
    let sent = 0;
    for (const uid of ids) {
      const result = await deliverEvent({
        event: opts.event,
        eventId: eventId(opts.event, uid, (opts.reference || '') + '-' + (opts.suffix || '')),
        userId: uid,
        values: opts.values || {},
        link: opts.link
      }).catch(function (error) {
        console.error('Finance alert failed for ' + uid + ':', error && error.message);
        return null;
      });
      if (result && result.sent) sent += 1;
    }
    return { sent, recipients: ids.length };
  } catch (error) {
    console.error('Finance alert could not be queued:', error && error.message);
    return { sent: 0, error: error && error.message };
  }
}

async function notifyPayment(change, context) {
  if (!change.after.exists) return null;
  const before = change.before.exists ? change.before.data() : null;
  const row = change.after.data() || {};
  const previous = before ? before.status : '';
  const current = row.status || '';
  if (previous === current) return null;
  let event = '';
  if (current === 'pending_verification' && previous !== 'pending_verification') event = 'payment_submitted';
  else if (current === 'approved') event = 'payment_approved';
  else if (current === 'rejected') event = 'payment_rejected';
  if (!event) return null;
  const result = await deliverEvent({
    event,
    eventId: eventId(event, row.userId, String(context.params.reference) + '-' + eventSuffix(change.after)),
    userId: row.userId,
    values: {
      name: row.userName || '',
      reference: row.reference || context.params.reference,
      status: statusLabel(current),
      plan: row.planName || (row.kind === 'wallet_deposit' ? 'Wallet deposit' : ''),
      amount: formatAmount(row.amount, row.currency),
      reason: row.rejectionReason || row.rejectReason || '',
      date: formatDate(change.after.updateTime ? change.after.updateTime.toDate() : new Date())
    },
    link: '/support.html#myplans'
  });
  // Receipt submitted: the member gets the confirmation above, and finance
  // gets its own alert (in-app + email). A failure here never hides the
  // member's message or pretends the alert was sent.
  if (event === 'payment_submitted') {
    await notifyFinanceTeam({
      event: 'payment_finance_alert',
      reference: String(context.params.reference),
      suffix: eventSuffix(change.after),
      link: '/admin.html#payment-verification',
      values: {
        reference: row.reference || context.params.reference,
        status: statusLabel(current),
        plan: row.planName || (row.kind === 'wallet_deposit' ? 'Wallet deposit' : ''),
        amount: formatAmount(row.amount, row.currency),
        date: formatDate(new Date())
      }
    });
  }
  return result;
}

async function notifyWithdrawal(change, context) {
  if (!change.after.exists) return null;
  const before = change.before.exists ? change.before.data() : null;
  const row = change.after.data() || {};
  const previous = before ? before.status : '';
  const current = row.status || '';
  if (previous === current) return null;
  let event = '';
  if (!before && current === 'pending_review') event = 'withdrawal_submitted';
  else if (current === 'processing' && previous !== 'processing') event = 'withdrawal_processing';
  else if (current === 'rejected' && previous !== 'rejected') event = 'withdrawal_rejected';
  else if (current === 'paid' && previous !== 'paid') event = 'withdrawal_paid';
  if (!event) return null;
  const reference = row.reference || String(context.params.id);
  const result = await deliverEvent({
    event,
    eventId: eventId(event, row.userId, reference + '-' + eventSuffix(change.after)),
    userId: row.userId,
    values: {
      name: row.userName || '',
      reference,
      status: statusLabel(current),
      plan: 'Savings wallet withdrawal',
      amount: formatAmount(row.amount, row.currency),
      reason: row.rejectionReason || '',
      date: formatDate(new Date())
    },
    link: '/support.html#wallet'
  });
  if (event === 'withdrawal_submitted') {
    await notifyFinanceTeam({
      event: 'withdrawal_finance_alert',
      reference,
      suffix: eventSuffix(change.after),
      link: '/admin.html#withdrawals',
      values: {
        reference,
        status: statusLabel(current),
        plan: 'Savings wallet withdrawal',
        amount: formatAmount(row.amount, row.currency),
        date: formatDate(new Date())
      }
    });
  }
  return result;
}

async function notifySubscription(change, context) {
  if (!change.after.exists) return null;
  const before = change.before.exists ? change.before.data() : null;
  const row = change.after.data() || {};
  const previousStatus = before ? before.status : '';
  const currentStatus = row.status || '';
  const beforeExpiry = before ? millis(before.expiresAt) : 0;
  const afterExpiry = millis(row.expiresAt);
  let event = '';
  if (currentStatus === 'active' && previousStatus !== 'active') event = 'subscription_activated';
  else if (currentStatus === 'active' && previousStatus === 'active' && afterExpiry > beforeExpiry) event = 'subscription_renewed';
  else if (currentStatus === 'expired' && previousStatus !== 'expired') event = 'subscription_expired';
  if (!event) return null;
  return deliverEvent({
    event,
    eventId: eventId(event, row.userId, String(context.params.id) + '-' + eventSuffix(change.after)),
    userId: row.userId,
    values: {
      name: row.userName || '',
      reference: row.planId || context.params.id,
      status: statusLabel(currentStatus),
      plan: row.planName || row.planId || '',
      amount: formatAmount(row.amount, row.currency),
      date: formatDate(row.expiresAt) || formatDate(new Date())
    },
    link: '/support.html#myplans'
  });
}

async function notifyVerification(change, context) {
  if (!change.after.exists) return null;
  const before = change.before.exists ? change.before.data() : null;
  const row = change.after.data() || {};
  const previous = before ? before.status : '';
  const current = row.status || '';
  if (previous === current && before) return null;
  let event = '';
  if (current === 'approved') event = 'church_id_issued';
  else if (current === 'rejected') event = 'church_id_rejected';
  else if (current === 'suspended') event = 'church_id_suspended';
  else if (current === 'revoked') event = 'church_id_revoked';
  if (!event || !row.userId) return null;
  return deliverEvent({
    event,
    eventId: eventId(event, row.userId, String(context.params.id) + '-' + eventSuffix(change.after)),
    userId: row.userId,
    values: {
      name: row.displayName || '',
      reference: row.membershipId || context.params.id,
      status: statusLabel(current),
      reason: row.rejectionReason || row.revokeReason || row.suspendReason || '',
      date: formatDate(change.after.updateTime ? change.after.updateTime.toDate() : new Date())
    },
    link: '/membership.html'
  });
}

/*
 * A Google sign-up has already proved the address, so it never passes through
 * the emailed-code step. Send the same one-time welcome as a verified
 * email/password sign-up; the deterministic event id means the two paths can
 * never produce two welcome messages for one account.
 */
async function notifyNewUser(snap, context) {
  const row = snap.data() || {};
  if (row.emailVerified !== true) return null;
  return deliverEvent({
    event: 'welcome',
    eventId: 'evt_welcome_' + context.params.uid,
    userId: context.params.uid,
    values: { name: row.fullName || row.displayName || '' },
    link: '/account.html'
  });
}

async function notifyPrayer(snap, context) {
  const row = snap.data() || {};
  const userId = row.userId || row.uid;
  if (!userId) return null;
  return deliverEvent({
    event: 'prayer_request_confirmation',
    eventId: eventId('prayer_request_confirmation', userId, snap.id),
    userId,
    values: {
      name: row.name || row.userName || '',
      reference: snap.id,
      status: 'Received',
      date: formatDate(snap.createTime ? snap.createTime.toDate() : new Date())
    },
    link: '/prayer.html'
  });
}

async function notifyAnnouncement(snap, context) {
  const row = snap.data() || {};
  if (row.emailMembers !== true) return null;
  const title = text(row.title, 140);
  const message = text(row.body, 900);
  if (!title || !message) return null;
  const db = admin.firestore();
  let users = [];
  try {
    const snapshot = await db.collection('users').limit(200).get();
    users = snapshot.docs.map((entry) => entry.id).filter(Boolean);
  } catch (error) {
    console.warn('Announcement recipients could not be listed:', error.message);
    return null;
  }
  let sent = 0;
  for (let index = 0; index < users.length; index += 20) {
    const batch = users.slice(index, index + 20);
    const results = await Promise.all(batch.map((userId) => deliverEvent({
      event: 'ministry_announcement',
      eventId: eventId('ministry_announcement', userId, String(context.params.id || snap.id)),
      userId,
      values: { title, message, name: '', reference: snap.id },
      title,
      message,
      link: '/news.html'
    }).catch((error) => ({ sent: false, error: error && error.message }))));
    sent += results.filter((result) => result && result.sent).length;
  }
  return { recipients: users.length, sent };
}

async function notifyGiving(change, context) {
  if (!change.after.exists) return null;
  const row = change.after.data() || {};
  const before = change.before.exists ? change.before.data() : null;
  const userId = row.donorUid || row.userId;
  const current = String(row.status || 'pending').toLowerCase();
  const previous = before ? String(before.status || 'pending').toLowerCase() : '';
  let event = '';
  if (!before) {
    if (current === 'pending') event = 'giving_submitted';
  } else if (previous !== current) {
    // Only a confirmed receipt is a payment confirmation. An approved record
    // is still awaiting the finance team's receipt check.
    if (current === 'received') event = 'giving_confirmed';
    else if (current === 'rejected') event = 'giving_rejected';
  }
  if (!event) return null;
  const values = {
    name: row.donorName || row.donor || '',
    reference: row.reference || context.params.reference || '',
    status: statusLabel(current),
    amount: formatAmount(row.amount, row.currency),
    plan: row.category || row.purpose || '',
    reason: row.rejectionReason || row.rejectReason || '',
    date: formatDate(change.after.updateTime ? change.after.updateTime.toDate() : new Date())
  };
  const id = eventId(event, userId || cleanEmail(row.donorEmail || row.email || row.receiptEmail) || 'guest',
    String(context.params.reference || context.params.id || '') + '-' + current + '-' + eventSuffix(change.after));
  if (!userId) {
    // A guest giver has no member record to resolve an address from, but still
    // deserves the same branded receipt. The address comes from the giving
    // record the finance team already reviews and is never used for marketing.
    const to = cleanEmail(row.donorEmail || row.email || row.receiptEmail);
    if (!to) return { skipped: true, reason: 'missing-email' };
    return deliverDirect({ event, eventId: id, to, name: values.name, values, link: '/give.html' });
  }
  return deliverEvent({ event, eventId: id, userId, values, link: '/give.html' });
}

async function notifyPrayerUpdate(change, context) {
  if (!change.after.exists || !change.before.exists) return null;
  const row = change.after.data() || {};
  const before = change.before.data() || {};
  const userId = row.userId || row.uid;
  if (!userId) return null;
  const current = String(row.status || '').toLowerCase();
  const previous = String(before.status || '').toLowerCase();
  if (!current || current === previous) return null;
  return deliverEvent({
    event: 'prayer_request_update',
    eventId: eventId('prayer_request_update', userId, context.params.id + '-' + current + '-' + eventSuffix(change.after)),
    userId,
    values: {
      name: row.name || row.userName || '',
      reference: context.params.id,
      status: statusLabel(current),
      date: formatDate(change.after.updateTime ? change.after.updateTime.toDate() : new Date())
    },
    link: '/prayer.html'
  });
}

async function notifyTestimony(change, context) {
  if (!change.after.exists) return null;
  const row = change.after.data() || {};
  const before = change.before.exists ? change.before.data() : null;
  const userId = row.userId || row.uid;
  if (!userId) return null;
  const previous = before ? before.status : '';
  const current = row.status || 'pending';
  let event = '';
  if (!before) event = 'testimony_submitted';
  else if (previous !== current && (current === 'approved' || current === 'published')) event = 'testimony_approved';
  else if (previous !== current && current === 'rejected') event = 'testimony_rejected';
  if (!event) return null;
  return deliverEvent({
    event,
    eventId: eventId(event, userId, context.params.id + '-' + eventSuffix(change.after)),
    userId,
    values: {
      name: row.userName || row.name || '',
      reference: context.params.id,
      status: statusLabel(current),
      reason: row.rejectionReason || row.rejectReason || '',
      date: formatDate(change.after.updateTime ? change.after.updateTime.toDate() : new Date())
    },
    link: '/testimony.html'
  });
}

async function notifyCertificate(snap, context) {
  const row = snap.data() || {};
  const userId = row.userId || row.uid;
  if (!userId) return null;
  return deliverEvent({
    event: 'certificate_ready',
    eventId: eventId('certificate_ready', userId, String(row.id || snap.id)),
    userId,
    values: {
      name: row.name || row.userName || '',
      reference: row.id || snap.id,
      status: 'Ready',
      plan: row.course || row.title || 'Prayer Dome Academy',
      score: row.score ? String(row.score) + '%' : '',
      date: formatDate(snap.createTime ? snap.createTime.toDate() : new Date())
    },
    link: '/account.html#certificates'
  });
}

async function notifyExam(change, context) {
  if (!change.after.exists) return null;
  const row = change.after.data() || {};
  const before = change.before.exists ? change.before.data() : null;
  const userId = row.studentUid || row.userId;
  if (!userId) return null;
  const current = row.status || '';
  const previous = before ? before.status : '';
  let event = '';
  if (!before) event = 'certificate_requested';
  else if (previous !== current && current === 'Passed') event = 'certificate_approved';
  else if (previous !== current && current === 'Failed') event = 'certificate_rejected';
  if (!event) return null;
  return deliverEvent({
    event,
    eventId: eventId(event, userId, context.params.id + '-' + eventSuffix(change.after)),
    userId,
    values: {
      name: row.studentName || '',
      reference: context.params.id,
      status: statusLabel(current),
      plan: row.courseTitle || 'Prayer Dome Academy',
      score: row.finalPercent || row.autoPercent ? String(row.finalPercent || row.autoPercent) + '%' : '',
      reason: current === 'Failed' ? 'The final exam did not reach the required pass mark.' : '',
      date: formatDate(change.after.updateTime ? change.after.updateTime.toDate() : new Date())
    },
    link: '/account.html#certificates'
  });
}

async function notifyClaim(change, context) {
  if (!change.after.exists) return null;
  const row = change.after.data() || {};
  const before = change.before.exists ? change.before.data() : null;
  const userId = row.userId;
  if (!userId) return null;
  const current = row.status || 'pending';
  const previous = before ? before.status : '';
  let event = '';
  if (!before) event = 'support_claim_submitted';
  else if (previous !== current && current === 'approved') event = 'support_claim_approved';
  else if (previous !== current && current === 'rejected') event = 'support_claim_rejected';
  if (!event) return null;
  return deliverEvent({
    event,
    eventId: eventId(event, userId, context.params.id + '-' + eventSuffix(change.after)),
    userId,
    values: {
      name: row.userName || '',
      reference: context.params.id,
      status: stateLabel(current),
      plan: row.planType || row.planId || '',
      amount: formatAmount(row.requestedAmount, 'USD'),
      reason: row.rejectReason || row.rejectionReason || '',
      date: formatDate(change.after.updateTime ? change.after.updateTime.toDate() : new Date())
    },
    link: '/support.html#myplans'
  });
}
function stateLabel(value) { return statusLabel(value); }

/* ------------------------------------------------------------------ jobs */

async function expiringSubscriptionNotifications() {
  const db = admin.firestore();
  const snapshot = await db.collection('subscriptions').where('status', '==', 'active').limit(500).get();
  const now = Date.now();
  const horizon = now + 7 * 24 * 60 * 60 * 1000;
  let sent = 0;
  for (const entry of snapshot.docs) {
    const row = entry.data() || {};
    const expiry = millis(row.expiresAt);
    if (!expiry || expiry < now || expiry > horizon) continue;
    const key = new Date(expiry).toISOString().slice(0, 10);
    const result = await deliverEvent({
      event: 'subscription_expiring',
      eventId: eventId('subscription_expiring', row.userId, entry.id + '-' + key),
      userId: row.userId,
      values: {
        name: row.userName || '',
        reference: row.planId || entry.id,
        status: 'Expiring soon',
        plan: row.planName || row.planId || '',
        amount: formatAmount(row.amount, row.currency),
        date: formatDate(row.expiresAt)
      },
      link: '/support.html#myplans'
    });
    if (result && result.sent) sent += 1;
  }
  return sent;
}

async function retryFailedEmails() {
  return retryFailed(50);
}

/* --------------------------------------------------------------- exports */

const runtime = functions.runWith({ secrets: [brevoApiKey] });
const region = runtime.region(REGION);

const emailAdmin = region.https.onCall(emailAdminHandler);
const membershipNotifications = region.firestore.document('memberships/{uid}').onWrite(notifyMembership);
const paymentNotifications = region.firestore.document('paymentRequests/{reference}').onWrite(notifyPayment);
const subscriptionNotifications = region.firestore.document('subscriptions/{id}').onWrite(notifySubscription);
const churchIdNotifications = region.firestore.document('membershipVerification/{id}').onWrite(notifyVerification);
const userWelcomeNotifications = region.firestore.document('users/{uid}').onCreate(notifyNewUser);
const prayerNotifications = region.firestore.document('prayers/{id}').onCreate(notifyPrayer);
const prayerUpdateNotifications = region.firestore.document('prayers/{id}').onWrite(notifyPrayerUpdate);
const givingNotifications = region.firestore.document('offerings/{reference}').onWrite(notifyGiving);
const announcementNotifications = region.firestore.document('announcements/{id}').onCreate(notifyAnnouncement);
const testimonyNotifications = region.firestore.document('testimonies/{id}').onWrite(notifyTestimony);
const certificateNotifications = region.firestore.document('certificates/{id}').onCreate(notifyCertificate);
const examNotifications = region.firestore.document('finalExamSubmissions/{id}').onWrite(notifyExam);
const claimNotifications = region.firestore.document('supportClaims/{id}').onWrite(notifyClaim);
const withdrawalNotifications = region.firestore.document('withdrawals/{id}').onWrite(notifyWithdrawal);
const expiringSubscriptionJob = region.pubsub.schedule('every day 04:10').timeZone('Africa/Lusaka').onRun(expiringSubscriptionNotifications);
const retryEmailJob = region.pubsub.schedule('every 30 minutes').timeZone('Africa/Lusaka').onRun(retryFailedEmails);

module.exports = {
  EMAIL_CATEGORIES,
  EVENTS,
  buildEmail,
  eventId,
  normalizeSettings,
  deliverEvent,
  deliverDirect,
  sendPasswordResetEmail,
  refreshProviderStatuses,
  emailDiagnostics,
  emailAdmin,
  membershipNotifications,
  userWelcomeNotifications,
  paymentNotifications,
  subscriptionNotifications,
  churchIdNotifications,
  prayerNotifications,
  prayerUpdateNotifications,
  givingNotifications,
  announcementNotifications,
  testimonyNotifications,
  certificateNotifications,
  examNotifications,
  claimNotifications,
  withdrawalNotifications,
  notifyFinanceTeam,
  expiringSubscriptionJob,
  retryEmailJob
};
