/*!
 * Prayer Dome — billing API client (browser)
 * ---------------------------------------------------------------------------
 * Replaces the old Firebase Functions callable on the support and admin pages.
 * Every money action now goes to the same-origin Vercel endpoint
 * /api/billing with a short-lived Firebase ID token. No payment secret, admin
 * credential or provider key is ever present in this file or in a page.
 *
 * The server response carries a stable code and a safe message. Detailed
 * technical errors stay in the protected Vercel logs.
 */
(function (global) {
  'use strict';

  var tokenProvider = null;
  var TRANSIENT_CODES = ['unavailable', 'internal', 'deadline-exceeded',
    'resource-exhausted', 'unknown', 'aborted'];

  function setTokenProvider(provider) {
    tokenProvider = typeof provider === 'function' ? provider : null;
  }

  function copy(error, options) {
    var billing = global.PDBilling;
    if (billing && typeof billing.billingErrorCopy === 'function') {
      return billing.billingErrorCopy(error, options);
    }
    return String((error && error.message) || 'Billing could not complete this request.');
  }

  function makeError(response, error, action, status) {
    var result = new Error(copy(error, { staff: Boolean(response && response.staff) }));
    result.code = String((error && error.code) || 'unknown');
    result.details = error && error.details || {};
    result.action = action;
    result.status = status || 0;
    return result;
  }

  async function call(action, payload, options) {
    var settings = options || {};
    var attempts = settings.attempts === 2 ? 2 : 1;
    var last = null;
    var lastStatus = 0;
    for (var attempt = 0; attempt < attempts; attempt += 1) {
      var token = '';
      try {
        token = tokenProvider ? await tokenProvider() : '';
      } catch (error) {
        last = { code: 'unauthenticated', message: 'Your sign-in could not be verified. Sign in again.', details: { billing: true } };
        break;
      }
      if (!token) {
        last = { code: 'unauthenticated', message: 'Your sign-in has expired. Sign in again and retry.', details: { billing: true } };
        break;
      }
      try {
        var response = await fetch('/api/billing', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: 'Bearer ' + token
          },
          body: JSON.stringify(Object.assign({ action: action }, payload || {})),
          cache: 'no-store',
          credentials: 'same-origin'
        });
        var data = null;
        try { data = await response.json(); } catch (error) { data = null; }
        if (response.ok && data && data.ok !== false) return data;
        last = (data && data.error) || { code: 'unknown', message: 'Billing did not confirm the request.', details: { billing: true } };
        lastStatus = response.status;
        // Auth, permission and validation failures are final: retrying only
        // creates duplicate audit noise and cannot change the server decision.
        if (response.status < 500) break;
      } catch (networkError) {
        last = { code: 'unavailable', message: 'Billing could not be reached. Check your connection and retry.', details: { billing: true } };
        lastStatus = 0;
      }
      if (attempt + 1 < attempts && TRANSIENT_CODES.indexOf(String(last.code)) !== -1) {
        await new Promise(function (resolve) { setTimeout(resolve, 900); });
      }
    }
    var failure = makeError({ staff: settings.staff }, last, action, lastStatus);
    console.error('Billing ' + action + ' failed:', failure.code, failure.message);
    throw failure;
  }

  global.PDBillingClient = {
    call: call,
    setTokenProvider: setTokenProvider
  };
})(window);
