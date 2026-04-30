'use strict';

/**
 * Curated list of well-known thought leaders / opinion newsletters that the
 * user can one-click subscribe to from the admin-only Settings accordion.
 *
 * Each entry includes:
 *   - name:  display + Gmail-search alias used by lib/gmail.js
 *   - email: best-known sender address (used as a hint for matching)
 *   - url:   public homepage / Substack URL
 *   - desc:  one-liner so the user knows what they're adding
 *
 * The "name" field is what gets stored on the source record and used to match
 * incoming emails (case-insensitive substring on From / Subject FW: lines).
 */

const SUGGESTED_TL = [
  {
    name:  'Stratechery',
    email: 'email@stratechery.com',
    url:   'https://stratechery.com',
    desc:  'Ben Thompson — strategy & business of tech',
  },
  {
    name:  'Benedict Evans',
    email: 'list@ben-evans.com',
    url:   'https://www.ben-evans.com/newsletter',
    desc:  'Weekly tech & media briefing',
  },
  {
    name:  'Money Stuff',
    email: 'noreply@mail.bloombergbusiness.com',
    url:   'https://www.bloomberg.com/account/newsletters/money-stuff',
    desc:  "Matt Levine — Wall Street's daily must-read",
  },
  {
    name:  'Not Boring',
    email: 'packy@notboring.co',
    url:   'https://www.notboring.co',
    desc:  'Packy McCormick — business strategy deep dives',
  },
  {
    name:  "Lenny's Newsletter",
    email: 'lenny@substack.com',
    url:   'https://www.lennysnewsletter.com',
    desc:  'Lenny Rachitsky — product, growth, careers',
  },
  {
    name:  'a16z',
    email: 'newsletter@a16z.com',
    url:   'https://a16z.com/newsletters',
    desc:  'Andreessen Horowitz — venture & tech essays',
  },
  {
    name:  'Exponential View',
    email: 'azeem@exponentialview.co',
    url:   'https://www.exponentialview.co',
    desc:  'Azeem Azhar — AI, geopolitics, exponential tech',
  },
  {
    name:  'The Diff',
    email: 'byrne@thediff.co',
    url:   'https://www.thediff.co',
    desc:  'Byrne Hobart — finance, tech & strategy',
  },
];

module.exports = { SUGGESTED_TL };
