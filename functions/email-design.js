'use strict';

/*
 * Prayer Dome email design system.
 * ===========================================================================
 * One renderer for every automatic message: the six-digit verification code,
 * account security notices, giving and prayer receipts, ministry updates and
 * the existing membership/payment notifications.
 *
 * The identity below is taken from the live site, not invented:
 *   logo      /assets/logo.png
 *   colours   #0A4D9B royal blue, #D4AF37 gold, #07244D deep navy
 *   type      Poppins headings, Inter/Segoe UI body (system fallbacks)
 *   contact   info@prayerdome.net · +260 973 028 342
 *   website   https://prayerdome.net
 *
 * Every message has a branded header, responsive body, a real text alternative
 * and a footer that states why the member received it. Nothing in this file
 * reads a credential or contacts a provider.
 */

const BRAND = Object.freeze({
  name: 'Prayer Dome',
  legalName: 'Prayer Dome Ministry',
  tagline: 'A House of Prayer for All Nations',
  siteUrl: 'https://prayerdome.net',
  logoUrl: 'https://prayerdome.net/assets/logo.png',
  contactEmail: 'info@prayerdome.net',
  contactPhone: '+260 973 028 342',
  address: 'Manzini, Eswatini',
  blue: '#0A4D9B',
  blueDeep: '#07244D',
  blueSoft: '#EEF4FB',
  gold: '#D4AF37',
  goldSoft: '#F6DF8A',
  surface: '#F3F6FB',
  border: '#DBE3EE',
  ink: '#172033',
  muted: '#5B6B82'
});

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max || 500);
}

function safeSite(value) {
  const raw = String(value || BRAND.siteUrl).trim().replace(/\/+$/, '');
  try {
    const url = new URL(raw);
    const allowed = url.protocol === 'https:' && (
      url.hostname === 'prayerdome.net' ||
      url.hostname === 'www.prayerdome.net' ||
      url.hostname === 'prayer-dome.firebaseapp.com'
    );
    return allowed ? url.origin : BRAND.siteUrl;
  } catch (error) {
    return BRAND.siteUrl;
  }
}

/** Only same-site or Firebase's own auth handler may be used as a CTA. */
function safeActionUrl(value, fallback) {
  const raw = String(value == null ? '' : value).trim();
  const fallbackUrl = safeSite(fallback || BRAND.siteUrl);
  if (!raw) return fallbackUrl + '/account.html';
  try {
    const url = new URL(raw, BRAND.siteUrl + '/');
    const allowed = url.protocol === 'https:' && (
      url.hostname === 'prayerdome.net' ||
      url.hostname === 'www.prayerdome.net' ||
      url.hostname === 'prayer-dome.firebaseapp.com'
    );
    return allowed ? url.toString() : fallbackUrl + '/account.html';
  } catch (error) {
    return fallbackUrl + '/account.html';
  }
}

function paragraphsFrom(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function detailRows(details) {
  if (!Array.isArray(details)) return [];
  return details
    .filter((item) => item && item[1] != null && String(item[1]).trim() !== '')
    .map((item) => [cleanText(item[0], 60), cleanText(item[1], 500)]);
}

function buttonHtml(action) {
  if (!action || !action.label) return '';
  const url = safeActionUrl(action.url, action.fallback);
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;">'
    + '<tr><td align="center" bgcolor="' + BRAND.blue + '" style="border-radius:10px;">'
    + '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" '
    + 'style="display:inline-block;padding:14px 26px;font-family:Poppins,Segoe UI,Arial,sans-serif;'
    + 'font-size:15px;line-height:1.2;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;">'
    + escapeHtml(action.label) + '</a></td></tr></table>';
}

function codeHtml(code) {
  const value = String(code == null ? '' : code).replace(/\D/g, '');
  if (!/^\d{6}$/.test(value)) return '';
  const spaced = value.split('').join(' ');
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px;">'
    + '<tr><td align="center">'
    + '<div style="display:inline-block;background:' + BRAND.blueSoft + ';border:1px solid ' + BRAND.border + ';'
    + 'border-radius:14px;padding:18px 24px;font-family:Consolas,Menlo,monospace;font-size:34px;'
    + 'line-height:1.1;letter-spacing:.12em;font-weight:700;color:' + BRAND.blue + ';">'
    + escapeHtml(spaced) + '</div>'
    + '<div style="margin-top:10px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:' + BRAND.muted + ';">'
    + 'Enter this code in Prayer Dome</div>'
    + '</td></tr></table>';
}

function headerHtml() {
  return '<tr><td style="background:' + BRAND.blue + ';padding:0;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
    + '<tr><td style="padding:22px 26px 18px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td valign="middle" width="52" style="padding-right:14px;">'
    + '<img src="' + escapeHtml(BRAND.logoUrl) + '" width="48" height="48" alt="Prayer Dome" '
    + 'style="display:block;width:48px;height:48px;border-radius:12px;background:#FFFFFF;padding:4px;"></td>'
    + '<td valign="middle">'
    + '<div style="font-family:Poppins,Segoe UI,Arial,sans-serif;font-size:13px;letter-spacing:.18em;'
    + 'text-transform:uppercase;color:' + BRAND.goldSoft + ';font-weight:700;">Prayer Dome</div>'
    + '<div style="font-family:Poppins,Segoe UI,Arial,sans-serif;font-size:17px;line-height:1.35;'
    + 'color:#FFFFFF;font-weight:700;margin-top:3px;">A House of Prayer for All Nations</div>'
    + '</td></tr></table>'
    + '</td></tr>'
    + '<tr><td style="background:' + BRAND.gold + ';height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>'
    + '</table></td></tr>';
}

function footerHtml(footerNote, category) {
  const note = cleanText(footerNote, 400)
    || 'You received this message because it relates to your Prayer Dome account or a request you made.';
  const manage = category === 'newsletter' || category === 'announcement'
    ? '<br><a href="' + escapeHtml(BRAND.siteUrl) + '/account.html" style="color:' + BRAND.blue + ';">Manage your email preferences</a>'
    : '';
  return '<tr><td style="padding:20px 26px 26px;border-top:1px solid ' + BRAND.border + ';background:#FFFFFF;">'
    + '<p style="margin:0 0 8px;font-family:Poppins,Segoe UI,Arial,sans-serif;font-size:12px;'
    + 'line-height:1.6;color:' + BRAND.blueDeep + ';font-weight:700;">PRAYER DOME MINISTRY</p>'
    + '<p style="margin:0 0 8px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;line-height:1.7;color:' + BRAND.muted + ';">'
    + '<a href="' + escapeHtml(BRAND.siteUrl) + '" style="color:' + BRAND.blue + ';text-decoration:none;">prayerdome.net</a>'
    + ' &nbsp;·&nbsp; <a href="mailto:' + escapeHtml(BRAND.contactEmail) + '" style="color:' + BRAND.blue + ';text-decoration:none;">'
    + escapeHtml(BRAND.contactEmail) + '</a>'
    + ' &nbsp;·&nbsp; ' + escapeHtml(BRAND.contactPhone) + '<br>' + escapeHtml(BRAND.address) + '</p>'
    + '<p style="margin:0;font-family:Segoe UI,Arial,sans-serif;font-size:11px;line-height:1.7;color:' + BRAND.muted + ';">'
    + escapeHtml(note) + manage + '</p>'
    + '</td></tr>';
}

/**
 * Render one complete transactional email.
 *
 * @param {object} options
 * @param {string} options.subject
 * @param {string} options.heading
 * @param {string} [options.preheader] hidden inbox preview
 * @param {string} [options.greeting] e.g. "Dear Grace,"
 * @param {string|string[]} [options.paragraphs]
 * @param {Array<[string,string]>} [options.details]
 * @param {string} [options.code] six digits for verification messages
 * @param {{label:string,url:string}} [options.action]
 * @param {string} [options.footerNote]
 * @param {string} [options.category]
 * @param {string} [options.siteUrl]
 * @returns {{subject:string, heading:string, html:string, text:string, actionUrl:string}}
 */
function renderEmail(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const site = safeSite(opts.siteUrl);
  const subject = cleanText(opts.subject, 180) || 'A message from Prayer Dome';
  const heading = cleanText(opts.heading, 140) || 'Message from Prayer Dome';
  const preheader = cleanText(opts.preheader || subject, 180);
  const greeting = cleanText(opts.greeting, 160);
  const bodyLines = Array.isArray(opts.paragraphs) ? opts.paragraphs.map((line) => cleanText(line, 1200)).filter(Boolean) : paragraphsFrom(opts.paragraphs);
  const details = detailRows(opts.details);
  const actionUrl = opts.action && opts.action.url
    ? safeActionUrl(opts.action.url, site)
    : safeActionUrl('/', site);
  const action = opts.action && opts.action.label ? { label: cleanText(opts.action.label, 80), url: actionUrl } : null;

  const detailsTable = details.length
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
      + 'style="margin:0 0 20px;background:' + BRAND.surface + ';border:1px solid ' + BRAND.border + ';border-radius:10px;">'
      + details.map((item) => '<tr>'
        + '<td style="padding:9px 12px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:' + BRAND.muted + ';'
        + 'font-weight:700;width:36%;vertical-align:top;">' + escapeHtml(item[0]) + '</td>'
        + '<td style="padding:9px 12px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:' + BRAND.ink + ';'
        + 'font-weight:600;overflow-wrap:break-word;">' + escapeHtml(item[1]) + '</td></tr>').join('')
      + '</table>'
    : '';

  const actionHtml = buttonHtml(action);
  const safeCodeHtml = codeHtml(opts.code);

  const html = '<!doctype html>'
    + '<html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>'
    + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="x-apple-disable-message-reformatting">'
    + '<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">'
    + '<title>' + escapeHtml(subject) + '</title>'
    + '<style>'
    + '@media only screen and (max-width:620px){'
    + '.pd-wrap{padding:12px 8px!important}.pd-card{border-radius:12px!important}'
    + '.pd-pad{padding:24px 20px 8px!important}.pd-foot{padding:18px 20px 22px!important}'
    + 'h1{font-size:21px!important}'
    + '}'
    + 'a{text-decoration:none}'
    + '</style></head>'
    + '<body style="margin:0;padding:0;background:' + BRAND.surface + ';color:' + BRAND.ink + ';">'
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">'
    + escapeHtml(preheader) + '</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
    + 'style="background:' + BRAND.surface + ';padding:24px 12px;" class="pd-wrap"><tr><td align="center">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="pd-card" '
    + 'style="max-width:580px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid ' + BRAND.border + ';">'
    + headerHtml()
    + '<tr><td class="pd-pad" style="padding:30px 30px 8px;">'
    + '<h1 style="margin:0 0 16px;font-family:Poppins,Segoe UI,Arial,sans-serif;font-size:23px;'
    + 'line-height:1.3;color:' + BRAND.blueDeep + ';font-weight:700;">' + escapeHtml(heading) + '</h1>'
    + (greeting ? '<p style="margin:0 0 14px;font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.7;">'
      + escapeHtml(greeting) + '</p>' : '')
    + bodyLines.map((line) => '<p style="margin:0 0 14px;font-family:Segoe UI,Arial,sans-serif;font-size:15px;'
      + 'line-height:1.7;color:' + BRAND.ink + ';">' + escapeHtml(line) + '</p>').join('')
    + safeCodeHtml
    + detailsTable
    + actionHtml
    + '<p style="margin:0 0 20px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;line-height:1.6;color:' + BRAND.muted + ';">'
    + 'If the button does not open, copy this secure address into your browser:<br>'
    + '<a href="' + escapeHtml(actionUrl) + '" style="color:' + BRAND.blue + ';word-break:break-all;">'
    + escapeHtml(actionUrl) + '</a></p>'
    + '</td></tr>'
    + footerHtml(opts.footerNote, cleanText(opts.category, 40))
    + '</table></td></tr></table></body></html>';

  const textLines = [
    'PRAYER DOME',
    BRAND.tagline,
    '',
    heading,
    ''
  ];
  if (greeting) textLines.push(greeting, '');
  bodyLines.forEach((line) => textLines.push(line, ''));
  if (opts.code && /^\d{6}$/.test(String(opts.code))) {
    textLines.push('Verification code: ' + String(opts.code), '');
  }
  details.forEach((item) => textLines.push(item[0] + ': ' + item[1]));
  if (details.length) textLines.push('');
  if (action) textLines.push(action.label + ': ' + actionUrl, '');
  textLines.push(
    'Prayer Dome Ministry',
    BRAND.siteUrl,
    BRAND.contactEmail + ' · ' + BRAND.contactPhone,
    BRAND.address,
    cleanText(opts.footerNote, 400) || 'You received this message because it relates to your Prayer Dome account or a request you made.'
  );

  return {
    subject,
    heading,
    html,
    text: textLines.join('\n'),
    actionUrl
  };
}

module.exports = {
  BRAND,
  escapeHtml,
  cleanText,
  safeActionUrl,
  renderEmail
};
