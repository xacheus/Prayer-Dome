/*!
 * Prayer Dome — Brevo update signup
 * ===========================================================================
 * The support page form posts one email address with explicit consent to
 * /api/newsletter. The server holds the Brevo key; nothing secret is shipped
 * here. If the endpoint is not configured (or the app is running inside the
 * packaged Android shell where /api is unavailable), the member is given the
 * ministry address instead of a dead button.
 */
(function (global) {
  'use strict';

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function setStatus(host, message, kind) {
    if (!host) return;
    host.textContent = message;
    host.dataset.state = kind || 'info';
    host.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  function bind(form) {
    var email = form.querySelector('[name="email"]');
    var name = form.querySelector('[name="name"]');
    var consent = form.querySelector('[name="consent"]');
    var website = form.querySelector('[name="website"]');
    var button = form.querySelector('button[type="submit"]');
    var status = form.querySelector('[data-pd-newsletter-status]');
    if (!email || !consent || !button) return;

    var nativeShell = !!(global.Capacitor && typeof global.Capacitor.isNativePlatform === 'function' && global.Capacitor.isNativePlatform());

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var address = String(email.value || '').trim().toLowerCase();
      if (!EMAIL_RE.test(address)) {
        setStatus(status, 'Enter a valid email address, for example name@example.com.', 'error');
        email.focus();
        return;
      }
      if (!consent.checked) {
        setStatus(status, 'Please tick the box to agree to receive Prayer Dome updates.', 'error');
        consent.focus();
        return;
      }
      if (nativeShell) {
        setStatus(status, 'Open prayerdome.net/support in a browser to join, or write to info@prayerdome.net and we will add you.', 'info');
        return;
      }

      var original = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<i class="pd-i pd-i-loader-circle pd-i-spin" aria-hidden="true"></i> Joining…';
      setStatus(status, 'Sending your request…', 'info');
      try {
        var response = await fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            email: address,
            name: name ? String(name.value || '').trim() : '',
            consent: true,
            website: website ? String(website.value || '') : ''
          })
        });
        var payload = null;
        try { payload = await response.json(); } catch (error) { payload = null; }
        if (response.ok && payload && payload.ok) {
          setStatus(status, payload.doubleOptIn
            ? 'Almost there — check your inbox and confirm the subscription.'
            : 'You are on the Prayer Dome updates list. Every message includes an unsubscribe link.', 'success');
          form.reset();
        } else if (response.status === 503) {
          setStatus(status, 'Email updates are being set up. Please write to info@prayerdome.net and we will add you.', 'info');
        } else {
          setStatus(status, (payload && payload.message) || 'We could not add you just now. Please try again or write to info@prayerdome.net.', 'error');
        }
      } catch (error) {
        setStatus(status, 'The connection failed. Please try again or write to info@prayerdome.net.', 'error');
      } finally {
        button.disabled = false;
        button.innerHTML = original;
      }
    });
  }

  function init() {
    document.querySelectorAll('form[data-pd-newsletter]').forEach(bind);
    // Brevo's double opt-in redirects back here with ?subscribed=1 after the
    // member clicks the confirmation link. Say so once, then clean the URL.
    try {
      var params = new URLSearchParams(global.location.search || '');
      if (params.get('subscribed') !== '1') return;
      var status = document.querySelector('[data-pd-newsletter-status]');
      setStatus(status, 'Your subscription is confirmed. Welcome to the Prayer Dome family.', 'success');
      params.delete('subscribed');
      var query = params.toString();
      history.replaceState(null, '', global.location.pathname + (query ? '?' + query : '') + global.location.hash);
    } catch (error) { /* older browsers keep the query string; the page still works */ }
  }

  global.PDNewsletter = { init: init, bind: bind };
  ready(init);
})(typeof window !== 'undefined' ? window : globalThis);
