'use strict';
/*
 * Server-side support-plan catalogue.
 *
 * The browser catalogue lives in assets/pd-billing.js. tests/billing.test.js
 * compares both files so a price can never drift between the page a member
 * reads and the amount the server writes to a payment request.
 *
 * Prices are USD per month. Each payment covers one monthly billing period;
 * the support programme itself matures after 12 months.
 */

// The official Mobile Money number is NEVER stored in code. The finance team
// keeps it in settings/payments, and the billing API writes the exact
// number it used onto every payment request. This text is only a fallback for
// catalogue display; checkout refuses to open until finance has configured the
// number (see functions/billing.js → loadPaymentSettings()).
const PAYMENT_INSTRUCTIONS = 'Send the exact amount by Mobile Money to the official PRAYER DOME ' +
  'number shown at checkout. Put the payment reference in the mobile-money reference field, then ' +
  'upload a clear receipt. A plan is activated only after the finance team checks the payment ' +
  'against the ministry account.';

const PLANS = [
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

const BY_ID = PLANS.reduce((map, plan) => {
  map[plan.id] = plan;
  return map;
}, {});

function normalizePlan(value, id) {
  const row = Object.assign({}, value || {});
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

module.exports = {
  PLANS,
  BY_ID,
  PAYMENT_INSTRUCTIONS,
  normalizePlan,
  get(id) { return BY_ID[String(id || '').toLowerCase()] || null; }
};
