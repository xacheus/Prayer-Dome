/*!
 * Prayer Dome — administrator email delivery workspace
 * ---------------------------------------------------------------------------
 * Settings, templates and the delivery log for the transactional email
 * service. All work goes through the `emailAdmin` callable, so the browser
 * never holds a Brevo key and never writes an outbox row directly.
 */
(function () {
  'use strict';

  var state = {
    settings: null,
    categories: {},
    templates: [],
    loaded: false
  };
  var bootTimer = null;

  function bridge() { return window.PDAdmin || null; }

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(message, type) {
    var b = bridge();
    if (b && typeof b.toast === 'function') b.toast(message, type || 'success');
    else if (typeof window.toast === 'function') window.toast(message, type || 'success');
  }

  function call(action, payload) {
    var b = bridge();
    if (!b || typeof b.httpsCallable !== 'function') {
      return Promise.reject(new Error('The admin bridge is still loading. Please try again.'));
    }
    var callable;
    try {
      callable = b.httpsCallable(b.cloudFunctions, 'emailAdmin');
    } catch (error) {
      return Promise.reject(new Error('Email delivery is not available until the Cloud Functions are deployed.'));
    }
    return Promise.resolve(callable(Object.assign({ action: action }, payload || {})))
      .then(function (result) { return (result && result.data) || {}; })
      .catch(function (error) {
        var raw = error && error.message ? error.message : 'The email service could not be reached.';
        throw new Error(/not found|unavailable|internal/i.test(raw)
          ? 'Email delivery is temporarily unavailable. Deploy the functions and try again.'
          : raw.replace(/^FirebaseError:\s*/i, ''));
      });
  }

  function toDate(value) {
    if (!value) return null;
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
    if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
    var parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function when(value) {
    var date = toDate(value);
    if (!date) return '—';
    return date.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function statusTone(status) {
    if (status === 'sent') return 'ok';
    if (status === 'failed') return 'bad';
    if (status === 'missing_email') return 'bad';
    if (status === 'disabled' || status === 'opted_out') return 'warn';
    return 'warn';
  }

  function chip(status) {
    return '<span class="audit-pill ' + statusTone(status) + '">' + esc(String(status || 'unknown').replace(/_/g, ' ')) + '</span>';
  }

  function renderHealth(logs) {
    var counts = { sent: 0, failed: 0, pending: 0, missing_email: 0, disabled: 0, opted_out: 0 };
    (logs || []).forEach(function (row) {
      if (Object.prototype.hasOwnProperty.call(counts, row.status)) counts[row.status] += 1;
      else if (row.status === 'sending') counts.pending += 1;
    });
    var grid = $('emailHealthGrid');
    if (grid) {
      var cards = [
        { key: 'sent', label: 'Delivered', tone: 'green' },
        { key: 'failed', label: 'Failed', tone: 'red' },
        { key: 'pending', label: 'Pending / sending', tone: 'blue' },
        { key: 'missing_email', label: 'No email on file', tone: 'red' },
        { key: 'opted_out', label: 'Opted out', tone: 'gold' }
      ];
      grid.innerHTML = cards.map(function (card) {
        return '<div class="kpi-card" style="cursor:default;padding:16px;">' +
          '<div class="kpi-details"><h3 style="margin:0;">' + counts[card.key] + '</h3><p style="margin:2px 0 0;">' + esc(card.label) + '</p></div>' +
          '</div>';
      }).join('');
    }
    var summary = $('emailHealthSummary');
    if (summary) {
      summary.textContent = (logs || []).length
        ? 'Showing the latest ' + logs.length + ' deliveries.'
        : 'No email has been queued yet.';
    }
  }

  function fillSettings(settings) {
    state.settings = settings || {};
    if ($('emailSenderName')) $('emailSenderName').value = state.settings.senderName || 'Prayer Dome';
    if ($('emailSenderEmail')) $('emailSenderEmail').value = state.settings.senderEmail || '';
    if ($('emailReplyTo')) $('emailReplyTo').value = state.settings.replyTo || '';
    if ($('emailEnabled')) $('emailEnabled').checked = state.settings.enabled !== false;
    var b = bridge();
    if ($('emailTestTo') && !$('emailTestTo').value && b && b.auth && b.auth.currentUser && b.auth.currentUser.email) {
      $('emailTestTo').value = b.auth.currentUser.email;
    }
  }

  function renderCategories(categories) {
    state.categories = categories || {};
    var host = $('emailCategoryList');
    if (!host) return;
    var saved = (state.settings && state.settings.categories) || {};
    host.innerHTML = Object.keys(state.categories).map(function (key) {
      return '<label class="notif-pref-item" style="display:flex;justify-content:space-between;gap:10px;align-items:center;">' +
        '<span>' + esc(state.categories[key]) + '</span>' +
        '<input type="checkbox" data-email-category="' + esc(key) + '" ' + (saved[key] === false ? '' : 'checked') + '>' +
        '</label>';
    }).join('');
  }

  function renderTemplates() {
    var select = $('emailTemplateEvent');
    if (!select) return;
    var chosen = select.value;
    select.innerHTML = state.templates.map(function (row) {
      return '<option value="' + esc(row.event) + '">' + esc(row.label) + (row.essential ? ' — essential' : ' — optional') + '</option>';
    }).join('');
    if (chosen && state.templates.some(function (row) { return row.event === chosen; })) select.value = chosen;
    loadTemplate();
  }

  function loadTemplate() {
    var select = $('emailTemplateEvent');
    if (!select) return;
    var row = state.templates.filter(function (item) { return item.event === select.value; })[0];
    if (!row) return;
    if ($('emailTemplateSubject')) $('emailTemplateSubject').value = row.subject || '';
    if ($('emailTemplateHeading')) $('emailTemplateHeading').value = row.heading || '';
    if ($('emailTemplateMessage')) $('emailTemplateMessage').value = row.message || '';
    if ($('emailTemplateActionLabel')) $('emailTemplateActionLabel').value = row.actionLabel || '';
    if ($('emailTemplateActionPath')) $('emailTemplateActionPath').value = row.actionPath || '';
  }

  function renderLogs(logs) {
    var body = $('emailLogsBody');
    if (!body) return;
    if (!logs || !logs.length) {
      body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-sub);">No email deliveries match this filter.</td></tr>';
      renderHealth([]);
      return;
    }
    body.innerHTML = logs.map(function (row) {
      var canRetry = row.status === 'failed' || row.status === 'pending' || row.status === 'sending';
      var actions = canRetry
        ? '<button class="btn btn-outline btn-sm" type="button" onclick="retryEmailDelivery(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-refresh-cw"></i> Retry</button>'
        : '—';
      return '<tr>' +
        '<td style="white-space:nowrap;">' + esc(when(row.createdAt)) + '</td>' +
        '<td>' + esc(String(row.event || '').replace(/_/g, ' ')) + '</td>' +
        '<td>' + esc(row.recipient || '—') + (row.recipientName ? '<br><span style="font-size:.68rem;color:var(--text-sub);">' + esc(row.recipientName) + '</span>' : '') + '</td>' +
        '<td>' + esc(row.subject || '—') + '</td>' +
        '<td>' + chip(row.status) + (row.lastError ? '<br><span style="font-size:.66rem;color:var(--danger,#ef4444);">' + esc(row.lastError) + '</span>' : '') + '</td>' +
        '<td>' + esc(row.attempts || 0) + '</td>' +
        '<td>' + actions + '</td>' +
        '</tr>';
    }).join('');
    renderHealth(logs);
  }

  function loadLogs() {
    var status = ($('emailLogStatus') || {}).value || 'all';
    if ($('emailLogsBody')) {
      $('emailLogsBody').innerHTML = '<tr><td colspan="7"><div class="spinner" style="width:26px;height:26px;"></div></td></tr>';
    }
    return call('logs.list', { limit: 100, status: status })
      .then(function (result) { renderLogs(result.logs || []); return result.logs || []; })
      .catch(function (error) {
        if ($('emailLogsBody')) {
          $('emailLogsBody').innerHTML = '<tr><td colspan="7" style="color:var(--danger,#ef4444);">' + esc(error.message) + '</td></tr>';
        }
        renderHealth([]);
        return [];
      });
  }

  window.loadEmailAdmin = function () {
    if (!bridge()) return Promise.resolve(false);
    return Promise.all([
      call('settings.get').then(function (result) {
        fillSettings(result.settings || {});
        renderCategories(result.categories || {});
        return true;
      }).catch(function (error) { toast(error.message, 'error'); return false; }),
      call('templates.list').then(function (result) {
        state.templates = result.templates || [];
        renderTemplates();
        return true;
      }).catch(function () { return false; })
    ]).then(function () {
      state.loaded = true;
      return loadLogs();
    });
  };

  window.loadEmailLogs = loadLogs;
  window.loadEmailTemplate = loadTemplate;

  window.saveEmailSettings = function () {
    var senderEmail = (($('emailSenderEmail') || {}).value || '').trim();
    if (!senderEmail) return toast('Enter the verified sender email address.', 'error');
    var categories = {};
    document.querySelectorAll('[data-email-category]').forEach(function (input) {
      categories[input.getAttribute('data-email-category')] = !!input.checked;
    });
    var button = document.querySelector('#view-email .btn-primary');
    if (button) button.disabled = true;
    return call('settings.save', {
      enabled: !!($('emailEnabled') || {}).checked,
      senderName: (($('emailSenderName') || {}).value || '').trim(),
      senderEmail: senderEmail,
      replyTo: (($('emailReplyTo') || {}).value || '').trim(),
      categories: categories
    }).then(function (result) {
      fillSettings(result.settings || {});
      renderCategories(state.categories);
      toast('Email settings saved. New events use these settings.');
    }).catch(function (error) {
      toast('Settings were not saved: ' + error.message, 'error');
    }).then(function () {
      if (button) button.disabled = false;
    });
  };

  window.saveEmailTemplate = function () {
    var event = ($('emailTemplateEvent') || {}).value;
    if (!event) return toast('Choose an event first.', 'error');
    var subject = (($('emailTemplateSubject') || {}).value || '').trim();
    var heading = (($('emailTemplateHeading') || {}).value || '').trim();
    var message = (($('emailTemplateMessage') || {}).value || '').trim();
    if (!subject || !heading || !message) return toast('Subject, heading and message are required.', 'error');
    return call('templates.save', {
      event: event,
      subject: subject,
      heading: heading,
      message: message,
      actionLabel: (($('emailTemplateActionLabel') || {}).value || '').trim(),
      actionPath: (($('emailTemplateActionPath') || {}).value || '').trim()
    }).then(function () {
      toast('Template saved. Future emails for this event use it.');
      return call('templates.list');
    }).then(function (result) {
      state.templates = result.templates || [];
      renderTemplates();
    }).catch(function (error) {
      toast('Template was not saved: ' + error.message, 'error');
    });
  };

  window.sendEmailTest = function () {
    var to = (($('emailTestTo') || {}).value || '').trim();
    if (!to) return toast('Enter a recipient address for the test.', 'error');
    var button = $('emailTestBtn');
    var stateEl = $('emailTestState');
    if (button) button.disabled = true;
    if (stateEl) stateEl.textContent = 'Sending through Brevo…';
    return call('test', { to: to }).then(function (result) {
      if (stateEl) stateEl.textContent = result && result.sent === false
        ? 'The provider did not accept the test. Check the delivery log.'
        : 'Test accepted by the provider. Check ' + to + ' (and the spam folder).';
      toast('Test email sent. It is in the delivery log.', 'success');
      return loadLogs();
    }).catch(function (error) {
      if (stateEl) stateEl.textContent = 'Test failed: ' + error.message;
      toast('Test email failed: ' + error.message, 'error');
    }).then(function () {
      if (button) button.disabled = false;
    });
  };

  window.retryEmailDelivery = function (id) {
    if (!id) return;
    return call('retry', { id: id }).then(function (result) {
      if (result && result.sent) toast('Email delivered on retry.', 'success');
      else toast('Retry checked: ' + (result && result.reason ? String(result.reason).replace(/_/g, ' ') : 'still not delivered') + '.', 'info');
      return loadLogs();
    }).catch(function (error) {
      toast('Retry failed: ' + error.message, 'error');
    });
  };

  function maybeLoad() {
    var section = $('view-email');
    if (!section) return;
    if (section.classList.contains('active') || window.location.hash === '#email') {
      if (!state.loaded) window.loadEmailAdmin();
    }
  }

  function boot() {
    if (!bridge()) {
      clearTimeout(bootTimer);
      bootTimer = setTimeout(boot, 300);
      return;
    }
    maybeLoad();
    var nav = document.querySelector('.nav-item[data-view="email"]');
    if (nav) nav.addEventListener('click', function () { setTimeout(maybeLoad, 200); });
    window.addEventListener('hashchange', maybeLoad);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
