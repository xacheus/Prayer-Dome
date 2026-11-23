/*!
 * Prayer Dome — support plans, subscriptions and money helpers
 * ---------------------------------------------------------------------------
 * One catalogue and one set of rules for the member-facing support page and
 * the administrator console. This file is deliberately dependency-free so it
 * can run before Firebase has loaded.
 *
 * Money rules enforced by the server (functions/billing.js):
 *   catalogue -> pending payment -> evidence submitted -> administrator
 *   verification -> active subscription / wallet credit.
 *
 * The browser never activates a plan and never moves a wallet balance. This
 * module only renders what Firestore already says and prepares checkout calls.
 */
(function (global) {
  'use strict';

  var ORGANIZATION = {
    name: 'PRAYER DOME',
    legalName: 'PRAYER DOME',
    tagline: 'House of Prayer for All Nations',
    website: 'prayerdome.net',
    email: 'info@prayerdome.net',
    phone: '+268 7658 1804'
  };

  var FOUNDER = {
    name: 'S.K. MASUKU',
    title: 'Founder and President',
    organization: 'PRAYER DOME'
  };

  /* Membership cards must never publish the internal role "admin" as a
     department. Permissions stay exactly as they are; only the printed label
     changes. */
  var DEPARTMENT_LABELS = {
    admin: 'TEAM MANAGEMENT',
    finance: 'FINANCE',
    leader: 'LEADERSHIP',
    pastor: 'PASTORAL TEAM',
    member: 'MEMBERSHIP'
  };

  var PAYMENT_METHODS = [
    { id: 'mobile-money', label: 'Mobile Money', hint: 'MTN Mobile Money · PRAYER DOME GROUP' }
  ];

  var PAYMENT_INSTRUCTIONS = 'Send the exact amount by MTN Mobile Money to +268 7658 1804 ' +
    '(PRAYER DOME GROUP). Put the payment reference in the mobile-money reference field, then ' +
    'upload a clear receipt. A plan is activated only after the finance team checks the payment ' +
    'against the ministry account.';

  /* Prices are USD per month. Every plan is a monthly subscription inside a
     12-month support programme. Keep these values in step with
     functions/billing-catalog.js — tests/billing.test.js compares the two. */
  var PLANS = [
    {
      id: 'education-bronze', program: 'Education', claimType: 'Education', tier: 'Bronze',
      name: 'Education Support · Bronze', price: 5, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 10, active: true, theme: 'education',
      summary: 'School fees and everyday learning needs for one child.',
      benefits: ['School fees and exam contributions', 'Books, uniforms and stationery', '12-month education fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'education-gold', program: 'Education', claimType: 'Education', tier: 'Gold',
      name: 'Education Support · Gold', price: 50, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 20, active: true, theme: 'education',
      summary: 'Secondary-school tuition and the costs around a full school term.',
      benefits: ['Secondary-school tuition', 'Books, uniforms, exam and transport costs', '12-month education fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'education-platinum', program: 'Education', claimType: 'Education', tier: 'Platinum',
      name: 'Education Support · Platinum', price: 100, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 30, active: true, theme: 'education',
      summary: 'Tertiary and college tuition support.',
      benefits: ['College and university tuition', 'Registration, books and examination fees', '12-month education fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'education-diamond', program: 'Education', claimType: 'Education', tier: 'Diamond',
      name: 'Education Support · Diamond', price: 500, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 40, active: true, theme: 'education',
      summary: 'University and international study support.',
      benefits: ['University and international tuition', 'Accommodation, travel and study materials review', '12-month education fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'business-bronze', program: 'Business', claimType: 'Business', tier: 'Bronze',
      name: 'Business Seeding · Bronze', price: 5, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 50, active: true, theme: 'business',
      summary: 'Stock, tools and small equipment for a micro-business.',
      benefits: ['Stock and trading goods', 'Tools and small equipment', '12-month business fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'business-gold', program: 'Business', claimType: 'Business', tier: 'Gold',
      name: 'Business Seeding · Gold', price: 50, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 60, active: true, theme: 'business',
      summary: 'Equipment and working capital for a small enterprise.',
      benefits: ['Machinery and business equipment', 'Working capital for a small enterprise', '12-month business fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'business-platinum', program: 'Business', claimType: 'Business', tier: 'Platinum',
      name: 'Business Seeding · Platinum', price: 100, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 70, active: true, theme: 'business',
      summary: 'Expansion capital for an established small business.',
      benefits: ['Business expansion capital', 'Equipment upgrade and stock expansion', '12-month business fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'business-diamond', program: 'Business', claimType: 'Business', tier: 'Diamond',
      name: 'Business Seeding · Diamond', price: 500, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 80, active: true, theme: 'business',
      summary: 'Enterprise-scale capital and equipment support.',
      benefits: ['Enterprise capital and equipment', 'Premises, machinery and stock review', '12-month business fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'compassion-basic', program: 'Compassion', claimType: 'Funeral', tier: 'Basic',
      name: 'Compassion Cover · Basic', price: 2.5, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 90, active: true, theme: 'compassion',
      summary: 'Dignified funeral support for a member’s immediate household.',
      benefits: ['Funeral contribution for immediate family', 'Practical support for the household', '12-month compassion fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'compassion-standard', program: 'Compassion', claimType: 'Funeral', tier: 'Standard',
      name: 'Compassion Cover · Standard', price: 25, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 100, active: true, theme: 'compassion',
      summary: 'Extended-family funeral and bereavement support.',
      benefits: ['Extended-family funeral contribution', 'Transport and bereavement costs review', '12-month compassion fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'compassion-premium', program: 'Compassion', claimType: 'Funeral', tier: 'Premium',
      name: 'Compassion Cover · Premium', price: 50, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 110, active: true, theme: 'compassion',
      summary: 'Full funeral support for a wider family circle.',
      benefits: ['Full funeral and memorial contribution', 'Wider family and travel costs review', '12-month compassion fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    }
  ];

  var PROGRAM_ORDER = ['Education', 'Business', 'Compassion'];

  var PROGRAM_THEMES = {
    Education: { color: '#0A4D9B', icon: 'pd-i-graduation-cap' },
    Business: { color: '#1e3a5f', icon: 'pd-i-briefcase' },
    Compassion: { color: '#7c2d12', icon: 'pd-i-hand-heart' }
  };

  var STATUS_LABELS = {
    draft: 'Draft',
    pending_payment: 'Pending payment',
    pending_verification: 'Awaiting verification',
    approved: 'Approved',
    active: 'Active',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    expired: 'Expired',
    suspended: 'Suspended',
    revoked: 'Revoked'
  };

  function money(amount, currency) {
    var value = Number(amount);
    if (!isFinite(value)) value = 0;
    var code = String(currency || 'USD').toUpperCase();
    if (code === 'SZL') return 'E' + value.toFixed(2);
    if (code === 'USD') return '$' + value.toFixed(2);
    return code + ' ' + value.toFixed(2);
  }

  function planById(id) {
    var wanted = String(id || '').toLowerCase();
    for (var index = 0; index < PLANS.length; index += 1) {
      if (PLANS[index].id === wanted) return PLANS[index];
    }
    return null;
  }

  function plansByProgram() {
    var grouped = {};
    PROGRAM_ORDER.forEach(function (program) { grouped[program] = []; });
    PLANS.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (plan) {
      if (!grouped[plan.program]) grouped[plan.program] = [];
      grouped[plan.program].push(plan);
    });
    return grouped;
  }

  function toDate(value) {
    if (!value) return null;
    try {
      if (typeof value.toDate === 'function') return value.toDate();
      if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
      var parsed = value instanceof Date ? value : new Date(value);
      return isNaN(parsed.getTime()) ? null : parsed;
    } catch (error) { return null; }
  }

  function formatDate(value) {
    var date = toDate(value);
    if (!date) return '';
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function addMonths(value, months) {
    var date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (isNaN(date.getTime())) date = new Date();
    var targetMonth = date.getMonth() + Number(months || 0);
    var day = date.getDate();
    date.setDate(1);
    date.setMonth(targetMonth);
    var lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
    return date;
  }

  /* An expired record is never displayed as active even if a scheduled job has
     not caught up yet. Expiry is evaluated from the stored expiry date. */
  function effectiveStatus(record, now) {
    var row = record || {};
    var status = String(row.status || 'pending_payment');
    var expiry = toDate(row.expiresAt || row.expiryDate || row.validUntil);
    if (expiry && (status === 'active' || status === 'approved') && expiry.getTime() < (now || new Date()).getTime()) {
      return 'expired';
    }
    return status;
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || String(status || '').replace(/_/g, ' ');
  }

  function statusTone(status) {
    if (status === 'active' || status === 'approved') return 'ok';
    if (status === 'rejected' || status === 'revoked' || status === 'expired' || status === 'suspended' || status === 'cancelled') return 'bad';
    return 'warn';
  }

  function departmentLabel(roleOrDepartment) {
    var value = String(roleOrDepartment || '').trim();
    if (!value) return 'MEMBERSHIP';
    var key = value.toLowerCase();
    if (DEPARTMENT_LABELS[key]) return DEPARTMENT_LABELS[key];
    return value.toUpperCase();
  }

  function newReference(kind) {
    var prefix = kind === 'wallet_deposit' ? 'PD-WAL' : 'PD-SUB';
    var date = new Date();
    var stamp = String(date.getUTCFullYear()) +
      String(date.getUTCMonth() + 1).padStart(2, '0') +
      String(date.getUTCDate()).padStart(2, '0');
    var bytes = [];
    try {
      if (global.crypto && global.crypto.getRandomValues) {
        var buffer = new Uint8Array(5);
        global.crypto.getRandomValues(buffer);
        bytes = Array.prototype.slice.call(buffer);
      }
    } catch (error) { /* fall through */ }
    if (!bytes.length) {
      for (var index = 0; index < 5; index += 1) bytes.push(Math.floor(Math.random() * 256));
    }
    return prefix + '-' + stamp + '-' + bytes.map(function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('').toUpperCase();
  }

  function idempotencyKey() {
    try {
      if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    } catch (error) { /* fall through */ }
    return 'checkout-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function planPeriodLabel(plan) {
    var row = plan || {};
    if (row.billingPeriod === 'monthly') return 'per month';
    if (row.billingPeriod === 'annual') return 'per year';
    return row.billingPeriod ? 'per ' + row.billingPeriod : 'per month';
  }

  function normalizePlan(value, id) {
    var row = Object.assign({}, value || {});
    row.id = String(row.id || id || '').toLowerCase();
    row.price = Number(row.price != null ? row.price : row.monthlyAmount) || 0;
    row.currency = String(row.currency || 'USD').toUpperCase();
    row.billingPeriod = row.billingPeriod || 'monthly';
    row.durationMonths = Number(row.durationMonths) || 1;
    row.programMonths = Number(row.programMonths) || 12;
    row.active = row.active !== false;
    row.order = Number.isFinite(Number(row.order)) ? Number(row.order) : 1000;
    row.benefits = Array.isArray(row.benefits) ? row.benefits.filter(Boolean) : [];
    row.paymentInstructions = row.paymentInstructions || PAYMENT_INSTRUCTIONS;
    row.name = row.name || row.title || row.id;
    row.program = row.program || 'Support';
    row.tier = row.tier || '';
    row.summary = row.summary || '';
    return row;
  }

  global.PDBilling = {
    ORGANIZATION: ORGANIZATION,
    FOUNDER: FOUNDER,
    DEPARTMENT_LABELS: DEPARTMENT_LABELS,
    PAYMENT_METHODS: PAYMENT_METHODS,
    PAYMENT_INSTRUCTIONS: PAYMENT_INSTRUCTIONS,
    PLANS: PLANS,
    PROGRAM_ORDER: PROGRAM_ORDER,
    PROGRAM_THEMES: PROGRAM_THEMES,
    STATUS_LABELS: STATUS_LABELS,
    money: money,
    planById: planById,
    plansByProgram: plansByProgram,
    toDate: toDate,
    formatDate: formatDate,
    addMonths: addMonths,
    effectiveStatus: effectiveStatus,
    statusLabel: statusLabel,
    statusTone: statusTone,
    departmentLabel: departmentLabel,
    newReference: newReference,
    idempotencyKey: idempotencyKey,
    planPeriodLabel: planPeriodLabel,
    normalizePlan: normalizePlan
  };
})(typeof window !== 'undefined' ? window : globalThis);
