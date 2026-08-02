/**
 * The plain-language explainer -- the provider behind POST /api/explain.
 *
 * The rule engine already says WHAT is owed. This says WHY, in language a
 * worker can read out loud to a labor commissioner.
 *
 * ---------------------------------------------------------------------------
 * The constraint everything else follows from: the model never produces a
 * figure.
 * ---------------------------------------------------------------------------
 *
 * It receives the computed analysis and explains it. Every number the worker
 * sees -- here and on the panel above -- comes from lib/analysis.js, which is
 * the same code that produced the figures already on screen.
 *
 * An explainer that derives its own arithmetic can disagree with the page above
 * it. A worker holding two different amounts for one pay period has a record
 * they cannot use: the first thing an opposing party does with an inconsistent
 * claim is point at the inconsistency. No explanation is strictly better than a
 * wrong one, so:
 *
 *   1. The prompt forbids restating, recomputing, or rounding any figure.
 *   2. The response is VALIDATED. Every number-like token in the generated text
 *      is checked against the analysis. One that is not traceable is a
 *      REJECTION -- this module throws, it does not return the text with a
 *      warning attached. A warning would still put the wrong number in front of
 *      the worker, which is the entire failure being guarded against.
 *   3. Potential meal/rest premiums described as money owed are also a
 *      rejection. PayTrack sees clock-in and clock-out, never breaks (see
 *      docs/wage-rules.md s4), so those are flags it cannot verify. Overclaiming
 *      there is the fastest way to destroy the credibility of the whole record.
 *
 * On rejection the route returns 502 and the UI keeps the analysis it already
 * has. The explanation is an ADDITION to the figures, never a replacement, so
 * losing it costs the worker nothing they had.
 *
 * GEMINI_API_KEY unset means no explanation at all -- not a canned one, not a
 * template. `explain` throws a tagged ExplanationError the route turns into a
 * 503 with `fallback: "analysis"`, exactly as /api/extract does for manual entry.
 */

/**
 * Same alias, and for the same reason as extractProvider: a pinned version was
 * already dead on arrival here (gemini-2.5-flash 404s for new keys), and a
 * hackathon project will not be around to notice the next deprecation.
 * GEMINI_MODEL overrides it if a specific version matters.
 */
export const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Output budget. Thinking is on by default and shares this budget with the
 * response, so it is sized for both. The explanation itself is four short
 * fields -- a few hundred tokens -- and the rest is headroom for working out
 * which rules actually applied before writing about them.
 *
 * Do not trim this to "what the JSON needs". A California analysis with two
 * workweeks, ten flagged workdays and two statement flags was reproducibly
 * truncated at 4000, and a truncated answer is discarded rather than shown --
 * so a budget that is too small does not save money, it just turns working
 * explanations into 502s.
 */
const MAX_TOKENS = 8000;

/** Per-request ceiling, in MILLISECONDS. */
const REQUEST_TIMEOUT_MS = 45_000;

// Structural bounds on the reply. Deliberately generous: they exist to catch a
// model that has gone off the rails, not to shape ordinary output. Exceeding
// them is a rejection rather than a truncation -- truncating a string can slice
// a number in half ("$1,900" -> "$1,9") and manufacture a figure that was never
// written, which is precisely the failure this file exists to prevent.
const MAX_HEADLINE_CHARS = 400;
const MAX_ITEM_CHARS = 1200;
const MAX_ITEMS = 8;

// ---------------------------------------------------------------------------
// Typed failure
// ---------------------------------------------------------------------------

/**
 * A tagged provider failure. `code` is the contract with the route.
 *
 *   not_configured   -- no API key. Route -> 503, fallback: analysis.
 *   provider_failure -- network, upstream error, refusal, truncation, or an
 *                       unparseable body. Route -> 502, fallback: analysis.
 *   rejected         -- the model answered, and the answer failed validation.
 *                       Route -> 502, same as a failure, because from the
 *                       worker's side it is one: there is no explanation. The
 *                       code is separate so an operator can tell "upstream is
 *                       down" from "upstream invented a number", which are very
 *                       different problems.
 */
export class ExplanationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ExplanationError';
    this.code = code;
  }
}

export const EXPLANATION_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  PROVIDER_FAILURE: 'provider_failure',
  REJECTED: 'rejected',
});

/**
 * Read at call time, not at module load: a process that gains the variable
 * (a Render env change plus restart, or a test setting it) must not need this
 * module re-imported to notice.
 */
export function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// ---------------------------------------------------------------------------
// Number traceability
//
// The core of the file. Everything else is plumbing around it.
// ---------------------------------------------------------------------------

/**
 * A number-like token. Matches "1,900.00", "300", "226.7", "2026", "1.5", and
 * the digit runs inside "s 226(a)(8)" ("226", "8") and "2026-07-05" ("2026",
 * "07", "05").
 *
 * The trailing fraction requires digits after the point, so a sentence-final
 * "$300." yields "300" rather than a malformed "300.".
 */
const NUMBER_TOKEN_RE = /\d[\d,]*(?:\.\d+)?/g;

/**
 * The same token, but only where it is marked as money: "$1,900.00", "$300".
 * Capturing group 1 is the number without the sign.
 *
 * Money is checked against a STRICTER set than everything else -- see
 * `collectAllowedMoney`. Without this, `RULE_CONSTANTS` is a hole: 40 is in
 * that set because "over 40 hours in a workweek" is a fact of the statute, but
 * that also silently licences the sentence "you are owed $40.00", which is an
 * invented amount of money. The traceability check reads digits and cannot see
 * units, so the units have to be read here instead.
 */
const MONEY_TOKEN_RE = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;

/** "1,900.00" -> 1900. Comparison is numeric, so formatting is free. */
function tokenToNumber(token) {
  return Number(token.replace(/,/g, ''));
}

/**
 * Thresholds and multipliers that are facts of the statute rather than facts
 * about this worker -- docs/wage-rules.md ss2, 3 and 4.
 *
 * These are here because of the zero-discrepancy case. When nothing was
 * underpaid the analysis contains almost no numbers, and the genuinely useful
 * explanation is about the line the worker did NOT cross: "California pays
 * 1.5x over 8 hours in a workday, and no day here went past that." Without this
 * set that sentence is unciteable and the correct-employer result -- which the
 * contract insists must be a real explanation, not an apology -- would reject
 * on every attempt.
 *
 * Note what is NOT in here, and cannot be: money. No dollar amount, no hours
 * total, no rate, and no discrepancy is a statutory constant, so every figure
 * of that kind still has to trace to lib/analysis.js. This set can let through
 * a mis-stated hour count (a worker who did 45 hours described as working 40);
 * it can never let through an invented amount of money, which is the figure a
 * claim actually turns on.
 */
const RULE_CONSTANTS = Object.freeze([
  0, 1, 2, // 2.0x double time; 0 and 1 are unavoidable in ordinary prose
  1.5, // 1.5x overtime
  4, // one rest period per 4 hours worked
  5, 6, // meal period over 5 hours, waivable at 6
  7, // 7th consecutive day
  8, 12, // daily overtime thresholds
  10, // second meal period over 10 hours
  24, // the workday
  30, // a 30-minute meal period
  40, // the weekly overtime threshold
  168, // the workweek
]);

/**
 * Every number the explanation is allowed to contain, as a Set of JS numbers.
 *
 * Built by deep-walking the analysis: numeric leaves go in directly, and string
 * leaves are mined for digit runs so that statute citations ("Cal. Lab. Code
 * s 510" -> 510, "s 226.7" -> 226.7, "s 226(a)(8)" -> 226 and 8) and dates
 * ("2026-07-05" -> 2026, 7, 5) are traceable too. Both are legitimately in the
 * prose an explanation needs to write, and both originate in the analysis.
 *
 * Absolute values are added alongside signed ones so a negative discrepancy
 * described as "paid $50 more than the rules require" still validates.
 *
 * Exported for tests: this predicate decides what a worker is allowed to read,
 * so it should be checkable without a live model call.
 */
export function collectAllowedNumbers(analysis) {
  return collectNumbers(analysis, RULE_CONSTANTS);
}

/**
 * The set a DOLLAR amount must trace to: the money-valued fields of the
 * analysis, named one by one.
 *
 * Deliberately not a deep walk. A walk returns every number anywhere in the
 * object, and the analysis is full of small integers that are not money -- 40
 * straight-time hours, 5 overtime hours, the 8 mined out of "s 226(a)(8)". Any
 * of those would licence "you are owed $8.00", which is an invented amount
 * wearing a traceable number's clothes. The looser walk is right for prose in
 * general and wrong for money specifically, because money is the figure a wage
 * claim actually turns on.
 *
 * So this is an allow-list of fields rather than a filter over values, and it
 * has to be extended by hand if analysis.js grows a new money field. That is
 * the safe direction to fail: a new field omitted here rejects a true sentence
 * (recoverable -- the worker asks again, or we add the field), where a walk
 * that swept it up would accept a false one.
 */
export function collectAllowedMoney(analysis) {
  const money = [
    analysis?.hourlyRate,
    analysis?.totalOwed,
    analysis?.totalPaid,
    analysis?.discrepancy,
    ...(analysis?.workweeks ?? []).map((w) => w?.owed),
    ...(analysis?.potentialPremiums ?? []).map((p) => p?.amount),
  ];

  const allowed = new Set();
  for (const value of money) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      allowed.add(n);
      allowed.add(Math.abs(n));
    }
  }
  return allowed;
}

function collectNumbers(analysis, seed) {
  const allowed = new Set(seed);

  const add = (n) => {
    if (Number.isFinite(n)) {
      allowed.add(n);
      allowed.add(Math.abs(n));
    }
  };

  const walk = (node) => {
    if (node === null || node === undefined) return;

    // Dates arrive from pg as Date instances. Object.values() on one is empty,
    // so without this branch the pay-period dates would vanish from the allowed
    // set and every explanation that named the period would be rejected.
    if (node instanceof Date) {
      walk(node.toISOString());
      return;
    }
    if (typeof node === 'number') return add(node);
    if (typeof node === 'string') {
      for (const token of node.match(NUMBER_TOKEN_RE) ?? []) add(tokenToNumber(token));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'object') {
      for (const value of Object.values(node)) walk(value);
    }
  };

  walk(analysis);
  return allowed;
}

/**
 * Returns the raw tokens in `text` that do not trace to `allowed`.
 *
 * Empty array means every figure in the text came from the analysis (or is a
 * statutory constant). Anything else is a rejection.
 *
 * Known limit, stated rather than hidden: this reads DIGITS. A figure spelled
 * out in words -- "nineteen hundred dollars" -- would pass. The prompt forbids
 * spelling figures out, and in practice a model asked for a dollar amount emits
 * digits, but the check is not a proof and should not be described as one.
 */
export function findUntraceableNumbers(text, allowed, allowedMoney) {
  const source = String(text);
  const offenders = [];

  for (const token of source.match(NUMBER_TOKEN_RE) ?? []) {
    if (!allowed.has(tokenToNumber(token))) offenders.push(token);
  }

  // Second, stricter pass over anything marked with a currency sign. A token
  // can clear the pass above by matching a statutory constant and still be an
  // invented amount of money, so money is re-checked against the analysis
  // alone. Optional so the looser predicate stays usable on its own.
  if (allowedMoney) {
    for (const match of source.matchAll(MONEY_TOKEN_RE)) {
      const token = match[1];
      if (!allowedMoney.has(tokenToNumber(token))) offenders.push(`$${token}`);
    }
  }

  return offenders;
}

// ---------------------------------------------------------------------------
// Potential premiums must never be described as owed
//
// docs/wage-rules.md s4: PayTrack sees clock-in and clock-out. It does not know
// whether a break was taken. A single unbroken 9-hour entry is consistent with
// a missed meal break AND with a worker who took one and did not log it.
//
// So a premium is a flag, never an amount owed, and it is excluded from the
// headline discrepancy. A worker who walks into a labor commissioner's office
// with an inflated number has a worse case than one who walks in with a
// conservative one.
// ---------------------------------------------------------------------------

const PREMIUM_TERM_RE = /\b(?:meal|rest\s+(?:break|period)s?|premiums?|226\.7)\b/i;

/**
 * Assertive "this is money you get" phrasing.
 *
 * Up to two words are allowed between the verb and its object, because that gap
 * is exactly where an overclaim hides: "you are ALSO owed", "you are POTENTIALLY
 * owed". A hedge or a connective does not change what the sentence asserts, and
 * a pattern that only matched the adjacent form would wave both of those
 * through. Genuine denials ("are NOT owed") match too and are cleared by
 * NEGATION_RE below, which is the right division of labour: match the claim
 * broadly, then check whether it is being made or disclaimed.
 */
const OWED_CLAIM_RE = new RegExp(
  [
    /you (?:are|were|'re)(?:\s+\w+){0,2}\s+(?:owed|due|entitled)/,
    /(?:owes?|owed)\s+(?:to\s+)?you/,
    /(?:is|are|was|were|be)(?:\s+\w+){0,2}\s+owed/,
    /(?:add(?:s|ed|ing)?|includ(?:e|es|ed|ing)|count(?:s|ed|ing)?)\s+(?:in|to|toward|towards|into)/,
    /part of (?:the|your|this) (?:total|amount|claim|figure)/,
    /(?:can|may|could|should)\s+claim/,
    /you (?:can|will|should)\s+(?:get|receive|recover|collect)/,
  ]
    .map((r) => r.source)
    .join('|'),
  'i'
);

/**
 * Words that turn an owed-claim into a denial or a condition -- "these are NOT
 * owed", "EXCLUDED from the total", "owed ONLY IF a break was actually missed".
 *
 * Hedges of degree ("potentially", "possibly") are deliberately absent: they
 * soften the sentence without changing what it asserts.
 */
const NEGATION_RE = /\b(?:not|n't|never|no|cannot|exclude[sd]?|excluding|excluded|separate|apart|if|whether|unless|only)\b/i;

/**
 * Abbreviations whose full stop does not end a sentence. Without this, every
 * legal citation the explanation is REQUIRED to make -- "Cal. Lab. Code s 226.7"
 * -- shatters into three fragments, and a denial can end up in a different
 * fragment from the claim it denies ("This is not a claim under Cal." /
 * "Code s 226.7 that you are owed money"), turning a correct sentence into a
 * rejection.
 */
const ABBREVIATION_RE = /\b(?:Cal|Lab|Civ|Proc|Code|Reg|Stat|U\.S\.C|C\.F\.R|U\.S|No|Inc|Co|v|e\.g|i\.e|approx)\./gi;

/** Sentence split that survives statute citations. */
function splitSentences(text) {
  // The stops inside citations are masked with a character that cannot occur in
  // model output, split on what remains, then restored -- so the returned
  // sentences are the original text, unmodified.
  const MASK = '\u0001';
  return String(text)
    .replace(ABBREVIATION_RE, (m) => m.replace(/\./g, MASK))
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.split(MASK).join('.').trim())
    .filter(Boolean);
}

/**
 * Returns the sentences that describe a potential premium as money owed.
 *
 * Sentence-scoped rather than document-scoped so "Meal premiums are flagged
 * separately." followed by "You are owed $300 in overtime." does not trip on
 * the adjacency of the two.
 *
 * Conservative by design. A false positive costs the worker an explanation
 * they can re-request; a false negative puts an unverifiable claim in a legal
 * record. Those are not symmetric.
 */
export function findPremiumOwedClaims(text) {
  const sentences = splitSentences(text);

  return sentences.filter(
    (s) => PREMIUM_TERM_RE.test(s) && OWED_CLAIM_RE.test(s) && !NEGATION_RE.test(s)
  );
}

// ---------------------------------------------------------------------------
// Schema
//
// Structured outputs, not "please reply with JSON". The schema is handed to the
// API as a grammar, which removes an entire class of failure -- a prose
// preamble, a trailing apology, a stray code fence -- that would otherwise turn
// a good explanation into a parse error.
// ---------------------------------------------------------------------------

export const EXPLANATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'why', 'whatThisIsNot', 'nextStep'],
  properties: {
    headline: {
      type: 'string',
      description:
        'ONE sentence saying what the record shows for this pay period. Plain words. If the figures show the employer paid correctly, say that plainly and without apology -- it is a real, useful result.',
    },
    why: {
      type: 'array',
      description:
        'Two to four short paragraphs. Each explains ONE rule that applied (or one rule that did not apply and why), in plain words, and names the statute it comes from. Say what the rule is before you say what it did here.',
      items: { type: 'string' },
    },
    whatThisIsNot: {
      type: 'array',
      description:
        'Two to four short paragraphs on the limits of this record: what it is not, and what PayTrack cannot see. Must state that tips, commissions and bonuses are outside the calculation and that if the worker receives any of them every figure here is too LOW. Must state that potential meal and rest break flags are not part of the amount and are not established violations.',
      items: { type: 'string' },
    },
    nextStep: {
      type: 'string',
      description:
        'ONE sentence pointing the worker at the filing panel below this explanation. Not advice about whether to file -- just where to look next.',
    },
  },
};

const SYSTEM_PROMPT = `You explain a wage-and-hour calculation to the worker it belongs to. The calculation has already been done by a rule engine. Your only job is to put it into words.

WHO IS READING THIS
Someone who is tired, probably worried about money, and may not read English as a first language. They may read this out loud in a government office. Write short sentences. Use ordinary words. Never say "pursuant to", "aforementioned", "shall", or "entitlement". Do not open with sympathy or apology -- open with what the record shows.

Speak to them directly as "you", in every field, every time. Never refer to them as "the worker", "the employee", or "the user" -- they are the person reading this, not a third party being discussed.

THE ONE ABSOLUTE RULE: YOU NEVER PRODUCE A FIGURE
Every number a worker sees comes from the rule engine, never from you.
- You may repeat a figure ONLY if it appears exactly, character for character, in the FIGURES YOU MAY USE block below.
- Do not add, subtract, multiply, divide, total, average, convert, or compare figures to produce a new one.
- Do not round. Do not drop cents. Do not turn 1900 into "about 2000" or "nearly two thousand".
- Do not spell figures out as words to get around this. No "nineteen hundred dollars".
- If you want to say something and the figure for it is not in that block, say it without the figure or do not say it. Fewer numbers is always safer. Words like "more", "less", "some", "several" are fine.
- You may cite ONLY the statutes listed under CITABLE STATUTES. Do not cite any other statute, regulation, case, or court decision.

An explanation that disagrees by one dollar with the figures printed above it makes the worker's whole record unusable. That is the failure this rule exists to prevent.

MEAL AND REST BREAK FLAGS ARE NOT MONEY
This system sees clock-in and clock-out times. It cannot see whether a break was taken. A long unbroken entry is equally consistent with a missed meal break and with a break the worker took but never logged.
- Never write that the worker is owed, due, entitled to, or can claim a meal or rest premium.
- Never add them to any total, and never suggest a total would be higher with them.
- Describe them as: days the record flags for a closer look, which this system cannot confirm either way, and which are deliberately left out of the amount.
Claiming an unverifiable premium as money owed damages the credibility of the entire record, including the parts that are solid.

NO LEGAL ADVICE
- Do not say whether to file, sue, settle, negotiate, or hire anyone.
- Do not predict what will happen, what a claim is worth, what someone might win or recover, or how strong the case is.
- Do not say the employer broke the law, cheated, or stole. Say what the record shows and which rule it is measured against.
- You explain a record. You are not anyone's lawyer.

WHEN THE DIFFERENCE IS ZERO OR NEGATIVE
This is a real, useful result and it gets a real explanation. Say plainly that for this period the pay matches what the rules require. Then explain which rules were checked and why they came out even -- that is the informative part. Do not apologise, do not sound disappointed, do not imply the worker wasted their time, and do not hunt for something to be wrong. A record showing correct payment is worth having.

SCOPE
The calculation covers hourly pay only. Tips, commissions and non-discretionary bonuses are excluded, and under the federal regular-rate rules they would raise the rate every overtime figure is built on. You must state clearly that if the worker gets any of those, every figure here is too LOW -- not wrong in an unknown direction, too low. Never imply the figures are complete for someone who earns tips or bonuses.

ALSO STATE, IN whatThisIsNot
- These figures come from the worker's own logged hours compared against the pay statement they entered.
- A wage statement element flagged as missing is missing from what was supplied here, which is not proof it was missing from the employer's original statement.

Return only the fields in the schema.`;

// ---------------------------------------------------------------------------
// Rendering the analysis for the prompt
// ---------------------------------------------------------------------------

const money = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : String(n));

const hours = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  // Trailing zeros are dropped so the model is never shown "5.00 hours" and
  // tempted to write "5.0" somewhere the analysis says 5.
  return String(Number(v.toFixed(2)));
};

function dateText(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value.slice(0, 10);
  return String(value ?? '');
}

/**
 * The exact figures the model is permitted to repeat, rendered as a flat list.
 *
 * Handed over alongside the raw analysis JSON rather than instead of it: the
 * JSON carries the structure and the premium prose, this carries the licence.
 * Making the permitted set explicit is what turns "do not invent numbers" from
 * an instruction the model has to interpret into a list it can copy from.
 */
function renderFigures(analysis) {
  const lines = [];

  lines.push(`pay period: ${dateText(analysis.periodStart)} to ${dateText(analysis.periodEnd)}`);
  lines.push(`hourly rate on the pay statement: ${money(analysis.hourlyRate)} per hour`);
  lines.push(`number of shifts logged in this period: ${analysis.shiftCount}`);
  lines.push(`total the rules require for this period: ${money(analysis.totalOwed)}`);
  lines.push(`total the pay statement says was paid: ${money(analysis.totalPaid)}`);
  lines.push(
    `difference (required minus paid): ${money(analysis.discrepancy)}` +
      (analysis.discrepancy > 0
        ? ' -- the pay statement is short by this much'
        : analysis.discrepancy === 0
          ? ' -- the pay statement matches what the rules require'
          : ' -- the pay statement is higher than what the rules require')
  );

  for (const [i, week] of (analysis.workweeks ?? []).entries()) {
    const b = week.breakdown ?? {};
    lines.push(
      `workweek ${i + 1} (${dateText(week.start)} to ${dateText(week.end)}): ` +
        `${hours(week.totalHours)} hours worked; ` +
        `${hours(b.straightHours)} at straight time; ` +
        `${hours(b.overtimeHours)} at 1.5x; ` +
        `${hours(b.doubleTimeHours)} at 2x; ` +
        `${money(week.owed)} required for the week`
    );
    for (const reason of b.reasons ?? []) {
      lines.push(
        `  - ${hours(reason.hours)} hours at ${reason.multiplier}x because of ${reason.basis} (${reason.statute})`
      );
    }
  }

  const premiums = analysis.potentialPremiums ?? [];
  if (premiums.length > 0) {
    lines.push(
      `POTENTIAL break flags (NOT money owed, NOT part of any total above): ${premiums.length} workday(s) flagged. ` +
        `These are days long enough that a break was due. This system cannot see whether one was taken.`
    );
  }

  const flags = analysis.complianceFlags ?? [];
  if (flags.length > 0) {
    lines.push(
      `wage statement elements not accounted for in what the worker supplied: ` +
        flags.map((f) => `${f.label} (${f.statute})`).join('; ')
    );
  }

  lines.push(`excluded from this calculation entirely: ${(analysis.scopeExclusions ?? []).join(', ')}`);

  return lines.join('\n');
}

/**
 * Statutes the explanation may cite -- exactly the ones the analysis actually
 * used, gathered from it rather than restated here.
 *
 * A hard-coded citation list in this file would be a second source of truth for
 * the law and would drift from server/src/rules/. Gathering them means the model
 * can only cite a rule that genuinely fired, which is also the honest constraint:
 * if s 510 produced nothing for this worker, there is nothing about s 510 to
 * explain to them.
 */
function citableStatutes(analysis) {
  const seen = new Set();
  for (const week of analysis.workweeks ?? []) {
    for (const reason of week.breakdown?.reasons ?? []) {
      if (reason?.statute) seen.add(reason.statute);
    }
  }
  for (const premium of analysis.potentialPremiums ?? []) {
    if (premium?.statute) seen.add(premium.statute);
  }
  for (const flag of analysis.complianceFlags ?? []) {
    if (flag?.statute) seen.add(flag.statute);
  }
  return [...seen];
}

function buildUserPrompt(analysis) {
  const statutes = citableStatutes(analysis);

  return [
    `JURISDICTION: ${analysis.jurisdiction}`,
    '',
    'FIGURES YOU MAY USE (repeat these exactly, or leave them out; never make a new one):',
    renderFigures(analysis),
    '',
    'CITABLE STATUTES (cite only these; if the list is empty, cite nothing):',
    statutes.length > 0 ? statutes.map((s) => `- ${s}`).join('\n') : '- (none)',
    '',
    'THE FULL ANALYSIS, for context only. Same rule: no figure leaves this block unless it is in FIGURES YOU MAY USE.',
    JSON.stringify(analysis, null, 2),
    '',
    'Explain this pay period to the worker whose record it is.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter((s) => s.length > 0);
}

function reject(reason, detail) {
  throw new ExplanationError(
    EXPLANATION_ERROR_CODES.REJECTED,
    'The explanation could not be verified against the calculated figures, so it was discarded. The analysis above is unchanged and complete.',
    { cause: new Error(`${reason}${detail ? `: ${detail}` : ''}`) }
  );
}

/**
 * Turns a raw model reply into the contract's `explanation`, or throws.
 *
 * Pure: no clock, no network. Exported for that reason -- it is the layer that
 * decides what a worker is allowed to read, so it must be testable by feeding
 * it a deliberately wrong pairing of text and analysis and watching it refuse.
 *
 * @param {object} parsed raw, schema-shaped model output
 * @param {object} analysis the analysis it was supposed to be explaining
 */
export function validateExplanation(parsed, analysis) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reject('reply was not an object');
  }

  const headline = cleanString(parsed.headline);
  const why = cleanList(parsed.why);
  const whatThisIsNot = cleanList(parsed.whatThisIsNot);
  const nextStep = cleanString(parsed.nextStep);

  if (!headline) reject('headline is empty');
  if (why.length === 0) reject('why is empty');
  if (whatThisIsNot.length === 0) reject('whatThisIsNot is empty');
  if (!nextStep) reject('nextStep is empty');

  if (headline.length > MAX_HEADLINE_CHARS) reject('headline is too long');
  if (nextStep.length > MAX_HEADLINE_CHARS) reject('nextStep is too long');
  if (why.length > MAX_ITEMS || whatThisIsNot.length > MAX_ITEMS) reject('too many paragraphs');
  if ([...why, ...whatThisIsNot].some((s) => s.length > MAX_ITEM_CHARS)) {
    reject('a paragraph is too long');
  }

  const text = [headline, ...why, ...whatThisIsNot, nextStep].join('\n');

  // 1. Every figure must trace to the analysis. This is the check the whole
  //    feature is built around.
  //    Amounts of money are held to the stricter set: a statutory threshold is
  //    a count of hours, never a dollar figure.
  const untraceable = findUntraceableNumbers(
    text,
    collectAllowedNumbers(analysis),
    collectAllowedMoney(analysis)
  );
  if (untraceable.length > 0) {
    reject('untraceable figures in explanation', untraceable.join(', '));
  }

  // 2. Potential premiums are flags, not money. docs/wage-rules.md s4.
  const premiumClaims = findPremiumOwedClaims(text);
  if (premiumClaims.length > 0) {
    reject('potential premiums described as money owed', premiumClaims.join(' | '));
  }

  // 3. Scope exclusions must be stated, not merely known. A figure that is too
  //    low for a tipped worker, presented as complete, is a wrong number told
  //    by omission -- and it fails the same way an invented one does.
  if (!/\b(tips?|commissions?|bonus(?:es)?)\b/i.test(text)) {
    reject('scope exclusions (tips/commissions/bonuses) were not stated');
  }

  return { headline, why, whatThisIsNot, nextStep };
}

// ---------------------------------------------------------------------------
// JSON Schema -> Gemini's responseSchema dialect
//
// Mirrors extractProvider's converter (Gemini takes a restricted OpenAPI subset:
// upper-case types, no additionalProperties, no unknown formats). Kept as a
// local copy rather than reaching into that module, so neither file's schema can
// be broken by a change made for the other.
// ---------------------------------------------------------------------------

function toGeminiSchema(node) {
  if (!node || typeof node !== 'object') return node;

  const out = {};
  if (node.type) out.type = String(node.type).toUpperCase();
  if (node.description) out.description = node.description;
  if (node.enum) out.enum = node.enum;
  if (node.items) out.items = toGeminiSchema(node.items);
  if (node.required) out.required = node.required;
  if (node.properties) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([k, v]) => [k, toGeminiSchema(v)])
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

const PROVIDER_FAILURE_MESSAGE =
  'The explainer is unavailable right now. The analysis above is complete and unchanged -- it does not depend on this.';

/**
 * Explains a computed analysis.
 *
 * Resolves with the contract's `explanation` object. Throws ExplanationError on
 * every failure path, including the unconfigured one and the rejected one. It
 * has no success path in which a number reached the worker without being
 * checked against the analysis first.
 *
 * @param {object} analysis the `analysis` from lib/analysis.js -- NOT a paystub
 *   id, and not anything this module re-derives. It does no arithmetic.
 */
export async function explain(analysis) {
  if (!isConfigured()) {
    // No key means no explanation -- not a template, not a canned paragraph,
    // not a "sample". The figures on screen already stand on their own.
    throw new ExplanationError(
      EXPLANATION_ERROR_CODES.NOT_CONFIGURED,
      'The plain-language explainer is not enabled on this server. The analysis above is complete on its own.'
    );
  }

  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
    throw new ExplanationError(
      EXPLANATION_ERROR_CODES.PROVIDER_FAILURE,
      PROVIDER_FAILURE_MESSAGE,
      { cause: new Error('explain() requires the analysis object from computeAnalysis') }
    );
  }

  // Raw fetch rather than an SDK, matching extractProvider: the REST surface is
  // small, it is one fewer dependency on a free-tier box, and a missing
  // node_modules entry cannot take the API down over a feature nobody enabled.
  const url = `${API_BASE}/${encodeURIComponent(MODEL)}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // Header rather than ?key= so the key cannot end up in a proxy log or
        // in an error message that echoes the request URL.
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(analysis) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(EXPLANATION_SCHEMA),
          maxOutputTokens: MAX_TOKENS,
          // Zero, not because the prose needs to be identical every time, but
          // because sampling is how a model talks itself into an extra digit.
          temperature: 0,
        },
      }),
    });
  } catch (err) {
    throw new ExplanationError(EXPLANATION_ERROR_CODES.PROVIDER_FAILURE, PROVIDER_FAILURE_MESSAGE, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ExplanationError(EXPLANATION_ERROR_CODES.PROVIDER_FAILURE, PROVIDER_FAILURE_MESSAGE, {
      cause: new Error(`${res.status} ${detail.slice(0, 400)}`),
    });
  }

  const message = await res.json().catch(() => null);
  const candidate = message?.candidates?.[0];
  const finish = candidate?.finishReason;

  if (!candidate || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') {
    throw new ExplanationError(
      EXPLANATION_ERROR_CODES.PROVIDER_FAILURE,
      'The explainer declined to answer. The analysis above is complete and unchanged.'
    );
  }
  if (finish === 'MAX_TOKENS') {
    // A truncated explanation is a half-explained rule, and half an explanation
    // of a wage rule is worse than none.
    throw new ExplanationError(
      EXPLANATION_ERROR_CODES.PROVIDER_FAILURE,
      'The explainer returned an incomplete answer and it was discarded. The analysis above is complete and unchanged.'
    );
  }

  const body = (candidate.content?.parts ?? [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new ExplanationError(
      EXPLANATION_ERROR_CODES.PROVIDER_FAILURE,
      'The explainer returned an answer that could not be read, so it was discarded. The analysis above is complete and unchanged.',
      { cause: err }
    );
  }

  // Throws ExplanationError('rejected') rather than returning anything the
  // caller could choose to show anyway.
  return validateExplanation(parsed, analysis);
}
