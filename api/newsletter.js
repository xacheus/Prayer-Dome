'use strict';

/*
 * Vercel entrypoint for the Brevo newsletter form on the support page.
 * The handler lives in functions/brevo.js so the same code is exposed by
 * Firebase Hosting as `/api/newsletter` (see firebase.json) without a second
 * implementation. BREVO_API_KEY is read from the environment, server-side only.
 */
module.exports = require('../functions/brevo').newsletterHandler;
