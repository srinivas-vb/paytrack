/**
 * Vision paystub extraction -- the provider behind POST /api/extract.
 *
 * This module reads a photograph of a wage statement and returns what it can
 * SEE on it. It is the one place in PayTrack where a machine produces numbers
 * that a human did not type, so two rules govern everything below:
 *
 *   1. It never invents a value. Illegible or absent -> null, plus a warning
 *      naming the field. A plausible fabricated paystub inside a record someone
 *      may hand to a labor commissioner is far worse than an honest "couldn't
 *      read it".
 *   2. It never persists. Extraction returns values for the worker to REVIEW;
 *      saving happens through the existing POST /api/paystubs, by hand, after
 *      they have checked every field against the document in front of them.
 *
 * ANTHROPIC_API_KEY is deliberately unset in this deployment. When it is unset
 * `extractPaystub` throws a tagged ExtractionError that the route turns into a
 * 503 with `fallback: "manual"` -- it does NOT return a stub, a placeholder, or
 * a "sample" result. Enabling the real call later is setting an env var (and
 * running `npm install`), not writing code.
 */

import { REQUIRED_ELEMENTS } from '../routes/paystubs.js';

// The § 226(a) element vocabulary, imported rather than retyped so `presentFields`
// can never drift from the keys POST /api/paystubs validates against.
const ELEMENT_KEYS = REQUIRED_ELEMENTS.map((e) => e.key);
const ELEMENT_KEY_SET = new Set(ELEMENT_KEYS);

export const MODEL = 'claude-opus-5';

/**
 * Output budget. Thinking is ON (adaptive, the default on claude-opus-5) and
 * shares this budget with the response, so it is sized for both rather than
 * for the JSON alone. The schema below is a fixed handful of fields, so the
 * response itself is a few hundred tokens; the rest is headroom for reading a
 * dense pay-stub table.
 *
 * Do NOT reintroduce `thinking: { type: 'disabled' }` here to shrink this.
 * Disabling thinking on claude-opus-5 has two documented failure modes -- it
 * can emit tool calls as plain text, and it can leak internal <thinking> tags
 * into the visible response. The supported way to control cost on this model
 * is a lower `output_config.effort`, which is what the call uses.
 */
const MAX_TOKENS = 8000;

/** Per-request ceiling. The SDK's `timeout` option is in MILLISECONDS. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Largest image the vision API accepts per base64 block. The route enforces a
 * larger, cruder limit first (a 20 MB body is a client bug, not a photo); this
 * one exists so an oversized-but-plausible image is reported as a fixable input
 * problem rather than surfacing as a mysterious upstream 502.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Image formats the vision API can decode. */
const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const CONFIDENCE_LEVELS = ['high', 'low', 'none'];

// Bounds mirrored from POST /api/paystubs. A value outside them is dropped to
// null with a warning rather than returned: the extraction must never pre-fill
// the review form with something the save endpoint would then reject.
const PAID_HOURS_MAX = 1000;
const MAX_WARNINGS = 20;
const MAX_WARNING_LENGTH = 300;

// ---------------------------------------------------------------------------
// Typed failure
// ---------------------------------------------------------------------------

/**
 * A tagged provider failure. `code` is the contract with the route; the message
 * is user-facing prose the route may pass straight through.
 *
 *   not_configured    -- no API key. Route -> 503, fallback: manual.
 *   dependency_missing-- key set but @anthropic-ai/sdk not installed. Also 503:
 *                        from the worker's point of view the feature is simply
 *                        off, and manual entry is the same one-click answer.
 *   invalid_image     -- the input cannot be sent as-is. Route -> 400.
 *   provider_failure  -- network, upstream error, refusal, truncation, or an
 *                        unparseable body. Route -> 502, fallback: manual.
 */
export class ExtractionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ExtractionError';
    this.code = code;
  }
}

export const EXTRACTION_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  DEPENDENCY_MISSING: 'dependency_missing',
  INVALID_IMAGE: 'invalid_image',
  PROVIDER_FAILURE: 'provider_failure',
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Read at call time, not at module load: a process that gains the variable
 * (Render env change + restart, or a test setting it) must not need this module
 * re-imported to notice.
 */
export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// ---------------------------------------------------------------------------
// Data URL parsing
//
// Exported so the route validates with exactly the parser the provider will
// use. Two implementations of "is this a data URL" would eventually disagree,
// and the disagreement would show up as a 502 for something the route should
// have answered 400 to.
// ---------------------------------------------------------------------------

const DATA_URL_RE = /^data:([^;,]+)((?:;[^;,]*)*),([\s\S]*)$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parses `data:image/jpeg;base64,...`.
 *
 * Returns `{ mediaType, base64, byteLength }` or `{ error }` with a message
 * naming what is wrong. Never throws.
 *
 * `byteLength` is computed arithmetically rather than by decoding: allocating a
 * 15 MB Buffer just to measure it is work we can skip, and the base64 length is
 * an exact answer.
 */
export function parseImageDataUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { error: 'imageDataUrl is required' };
  }

  const m = DATA_URL_RE.exec(raw);
  if (!m) {
    return {
      error: 'imageDataUrl must be a data URL, e.g. "data:image/jpeg;base64,...". Remote URLs and raw base64 are not accepted.',
    };
  }

  const mediaType = m[1].trim().toLowerCase();
  const params = m[2].toLowerCase().split(';');
  const payload = m[3];

  // Only base64 data URLs. A percent-encoded one would decode to something we
  // have no reason to expect from an image capture pipeline.
  if (!params.includes('base64')) {
    return { error: 'imageDataUrl must be base64-encoded (data:<image type>;base64,...)' };
  }

  if (!mediaType.startsWith('image/')) {
    return { error: `imageDataUrl must be an image; got "${mediaType}"` };
  }

  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
    return {
      error: `unsupported image type "${mediaType}". Use one of: ${SUPPORTED_MEDIA_TYPES.join(', ')}`,
    };
  }

  // Canvas-produced data URLs carry no whitespace, but a hand-assembled one may.
  const base64 = payload.replace(/\s+/g, '');
  if (base64.length === 0) {
    return { error: 'imageDataUrl contains no image data' };
  }
  if (base64.length % 4 !== 0 || !BASE64_RE.test(base64)) {
    return { error: 'imageDataUrl payload is not valid base64' };
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const byteLength = (base64.length / 4) * 3 - padding;

  return { mediaType, base64, byteLength };
}

// ---------------------------------------------------------------------------
// Extraction schema
//
// Structured outputs, not "please reply with JSON". The schema is handed to the
// API as a grammar, which removes an entire class of failure -- prose preamble,
// a trailing apology, a stray code fence -- that would otherwise turn a good
// read into a parse error.
//
// Every field is a { value, confidence } pair rather than a bare value. The UI
// has to visually mark a low-confidence read before the worker signs off on it,
// and it cannot do that if a shaky "$1,600" and a crisp one arrive looking
// identical. `value: null` with `confidence: "none"` is the honest encoding of
// "this was not legible", and it is a first-class outcome, not an error.
// ---------------------------------------------------------------------------

function measured(valueSchema, description) {
  return {
    type: 'object',
    description,
    additionalProperties: false,
    required: ['value', 'confidence'],
    properties: {
      value: {
        anyOf: [valueSchema, { type: 'null' }],
        description: 'null if this is absent from the statement or not legible in the photo.',
      },
      confidence: {
        type: 'string',
        enum: CONFIDENCE_LEVELS,
        description:
          '"high" = printed clearly and unambiguously labelled. "low" = read, but obscured, cut off, or ambiguously labelled. "none" = not read; value must be null.',
      },
    },
  };
}

export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'periodStart',
    'periodEnd',
    'paidHours',
    'paidRate',
    'grossPay',
    'presentElements',
    'warnings',
  ],
  properties: {
    periodStart: measured(
      { type: 'string', format: 'date', description: 'Calendar date, YYYY-MM-DD.' },
      'First day of the pay period covered by this statement, as printed.'
    ),
    periodEnd: measured(
      { type: 'string', format: 'date', description: 'Calendar date, YYYY-MM-DD.' },
      'Last day of the pay period covered by this statement, as printed. Not the pay/check date -- if only a check date is shown, this is null.'
    ),
    paidHours: measured(
      { type: 'number', description: 'Hours, decimal.' },
      'Total hours the statement says were paid for THIS period. Not year-to-date. If hours are broken out by rate, the total of those lines.'
    ),
    paidRate: measured(
      { type: 'number', description: 'Dollars per hour, decimal.' },
      'The base/regular hourly rate printed on the statement. If several rates appear, the regular (non-premium) one -- and add a warning saying multiple rates were shown.'
    ),
    grossPay: measured(
      { type: 'number', description: 'Dollars, decimal.' },
      'Gross wages for THIS period, before deductions. Not net, not year-to-date. If only a YTD gross is visible, this is null with a warning.'
    ),
    presentElements: {
      type: 'array',
      description:
        'Which of the nine Cal. Lab. Code § 226(a) elements are actually VISIBLE on this statement. Include a key only if you can point at it in the image. Omitting a key means "not visible in this photo" -- it is NOT a claim that the employer left it off the original.',
      items: { type: 'string', enum: ELEMENT_KEYS },
    },
    warnings: {
      type: 'array',
      description:
        'Short plain-language notes about anything illegible, cut off, ambiguous, or unusual. One sentence each, lowercase, no trailing period. Name the field: "gross pay was not legible". Empty array if the statement read cleanly.',
      items: { type: 'string' },
    },
  },
};

const SYSTEM_PROMPT = `You transcribe photographs of United States itemized wage statements (paystubs) for the worker they belong to.

What you produce goes into that worker's own evidence record. They will review every field against the physical document before anything is saved, and the record may later be handed to a labor commissioner or an attorney. A wrong number that looks confident is the worst thing you can produce here -- far worse than an empty field.

Rules, in order of importance:

1. Transcribe. Do not compute, infer, or reconcile. If gross pay is not printed, it is null -- never multiply hours by rate to produce one. If a period end date is not printed, it is null -- never derive it from a check date or a pay frequency.
2. Anything you cannot read with confidence is null, with confidence "none", and a warning naming the field. Glare, a fold, a cropped edge, a thumb over the column: all of these mean null.
3. Use confidence "low" when you did read a value but something undermines it -- partial obstruction, an ambiguous or unfamiliar label, a digit you are not certain of, a column whose heading is cut off. Reserve "high" for values that are printed clearly under an unambiguous label.
4. Dates are YYYY-MM-DD. If the year is not printed anywhere on the statement, the date is null with a warning; do not assume the current year.
5. Report per-period figures, never year-to-date. If a column is YTD only, the per-period field is null with a warning saying so.
6. presentElements lists only what you can actually see. If you are unsure whether something counts as present, leave it out and add a warning.
7. Never state or imply an employer name, a worker name, or a figure that is not on the page. If the image is not a wage statement at all, return nulls throughout with a warning saying what you were shown.`;

const USER_INSTRUCTION =
  'This is a photo of one wage statement. Transcribe the fields defined by the schema, exactly as printed. Leave anything you cannot read clearly as null and say so in the warnings.';

// ---------------------------------------------------------------------------
// Response normalisation
//
// Structured outputs constrain the SHAPE, not the semantics: the grammar will
// happily return "2026-02-31" or a rate of -5. Everything below re-checks the
// model's answer against the same rules POST /api/paystubs enforces, and
// downgrades anything that fails to null-plus-warning. The review form must
// never be pre-filled with a value the save endpoint would reject, and the
// worker must be told when something was dropped.
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict YYYY-MM-DD -> true, including rejecting 2026-02-30. */
function isRealCalendarDate(raw) {
  const m = DATE_RE.exec(raw);
  if (!m) return false;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/** Pulls a { value, confidence } pair out of the raw object, defensively. */
function readMeasured(raw, name) {
  const cell = raw && typeof raw === 'object' ? raw[name] : null;
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
    return { value: null, confidence: 'none' };
  }
  const confidence = CONFIDENCE_LEVELS.includes(cell.confidence) ? cell.confidence : 'none';
  return { value: cell.value ?? null, confidence };
}

function normaliseDate(raw, name, label, warnings) {
  const { value, confidence } = readMeasured(raw, name);
  if (value === null) {
    if (confidence !== 'none') warnings.push(`${label} was not legible`);
    return { value: null, confidence: 'none' };
  }
  if (typeof value !== 'string' || !isRealCalendarDate(value)) {
    warnings.push(`${label} could not be read as a calendar date and was discarded`);
    return { value: null, confidence: 'none' };
  }
  return { value, confidence: confidence === 'none' ? 'low' : confidence };
}

function normaliseNumber(raw, name, label, { min, max, exclusiveMin = false }, warnings) {
  const { value, confidence } = readMeasured(raw, name);
  if (value === null) {
    if (confidence !== 'none') warnings.push(`${label} was not legible`);
    return { value: null, confidence: 'none' };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnings.push(`${label} could not be read as a number and was discarded`);
    return { value: null, confidence: 'none' };
  }
  const belowMin = exclusiveMin ? value <= min : value < min;
  if (belowMin || value > max) {
    warnings.push(`${label} read as ${value}, which is outside the plausible range, and was discarded`);
    return { value: null, confidence: 'none' };
  }
  return { value, confidence: confidence === 'none' ? 'low' : confidence };
}

/** Canonical statute order, deduplicated, unknown keys dropped. */
function normalisePresentElements(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item === 'string' && ELEMENT_KEY_SET.has(item)) seen.add(item);
  }
  return ELEMENT_KEYS.filter((k) => seen.has(k));
}

function normaliseWarnings(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, MAX_WARNING_LENGTH);
    if (text.length === 0) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_WARNINGS) break;
  }
  return out;
}

/**
 * Collapses the per-field confidences into the single value the contract's
 * `confidence` carries.
 *
 * Deliberately pessimistic: one shaky field makes the whole read "low". This
 * drives how loudly the UI asks the worker to check the numbers, and the cost
 * of over-warning is a few seconds of their attention. The cost of
 * under-warning is a wrong figure in a wage claim.
 */
function overallConfidence(fieldConfidence) {
  const levels = Object.values(fieldConfidence);
  if (levels.every((c) => c === 'none')) return 'none';
  if (levels.some((c) => c !== 'high')) return 'low';
  return 'high';
}

/**
 * Maps a raw schema-conforming model reply to an ExtractedPaystub.
 *
 * Pure -- no clock, no I/O, no network -- and exported for that reason: it is
 * the layer that decides which of the model's answers a worker is allowed to
 * see, so it should be checkable without a live vision call.
 */
export function normaliseExtraction(parsed) {
  const warnings = normaliseWarnings(Array.isArray(parsed?.warnings) ? parsed.warnings : []);

  const periodStart = normaliseDate(parsed, 'periodStart', 'the pay period start date', warnings);
  const periodEnd = normaliseDate(parsed, 'periodEnd', 'the pay period end date', warnings);
  const paidHours = normaliseNumber(parsed, 'paidHours', 'total hours', { min: 0, max: PAID_HOURS_MAX }, warnings);
  const paidRate = normaliseNumber(parsed, 'paidRate', 'the hourly rate', { min: 0, max: 10_000, exclusiveMin: true }, warnings);
  const grossPay = normaliseNumber(parsed, 'grossPay', 'gross pay', { min: 0, max: 10_000_000 }, warnings);

  // Ordering is a save-time rule (periodEnd must be after periodStart), so a
  // reversed pair is reported rather than silently swapped -- a swap would be
  // this module inventing a period the document does not show.
  if (periodStart.value && periodEnd.value && periodEnd.value <= periodStart.value) {
    warnings.push('the pay period dates read out of order; check them against the statement');
  }

  const fieldConfidence = {
    periodStart: periodStart.confidence,
    periodEnd: periodEnd.confidence,
    paidHours: paidHours.confidence,
    paidRate: paidRate.confidence,
    grossPay: grossPay.confidence,
  };

  return {
    source: 'llm',
    confidence: overallConfidence(fieldConfidence),
    fields: {
      periodStart: periodStart.value,
      periodEnd: periodEnd.value,
      paidHours: paidHours.value,
      paidRate: paidRate.value,
      grossPay: grossPay.value,
    },
    // Additive to the contract shape, and load-bearing: "low-confidence fields
    // must be visually marked" is unimplementable without per-field detail.
    fieldConfidence,
    presentFields: normalisePresentElements(parsed?.presentElements),
    warnings: normaliseWarnings(warnings),
    model: MODEL,
  };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

let clientPromise = null;

/**
 * Builds the SDK client on first use.
 *
 * The import is dynamic so that an unconfigured deployment -- which is this
 * one -- boots and serves 503s correctly whether or not @anthropic-ai/sdk has
 * been installed yet. A top-level import would make a missing node_modules
 * entry crash the entire API at startup over a feature nobody has enabled.
 */
async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      let Anthropic;
      try {
        ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
      } catch (err) {
        throw new ExtractionError(
          EXTRACTION_ERROR_CODES.DEPENDENCY_MISSING,
          'Automatic extraction is not available on this server: the vision client is not installed. Manual entry works and produces the same record.',
          { cause: err }
        );
      }
      return new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        timeout: REQUEST_TIMEOUT_MS,
        maxRetries: 2,
      });
    })().catch((err) => {
      // Don't cache a failed construction: installing the dependency and
      // retrying should work without a restart.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** Finds the JSON body in the response. */
function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * Extracts a paystub from an image data URL.
 *
 * Resolves with an ExtractedPaystub. Throws ExtractionError on every failure
 * path, including the unconfigured one. It has no success path that does not
 * involve the model actually having looked at the image.
 *
 * @param {{ imageDataUrl: string }} input
 */
export async function extractPaystub({ imageDataUrl } = {}) {
  if (!isConfigured()) {
    // The single most important branch in this file. No key means no result --
    // not an empty result, not a sample, not a "best guess".
    throw new ExtractionError(
      EXTRACTION_ERROR_CODES.NOT_CONFIGURED,
      'Automatic paystub extraction is not enabled on this server. Enter the paystub by hand -- manual entry is fully supported and produces exactly the same record.'
    );
  }

  const parsed = parseImageDataUrl(imageDataUrl);
  if (parsed.error) {
    throw new ExtractionError(EXTRACTION_ERROR_CODES.INVALID_IMAGE, parsed.error);
  }
  if (parsed.byteLength > MAX_IMAGE_BYTES) {
    throw new ExtractionError(
      EXTRACTION_ERROR_CODES.INVALID_IMAGE,
      `That image is ${(parsed.byteLength / (1024 * 1024)).toFixed(1)} MB; the reader accepts up to ${MAX_IMAGE_BYTES / (1024 * 1024)} MB. Retake it at a smaller size, or enter the paystub by hand.`
    );
  }

  const client = await getClient();

  let message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      // `thinking` is deliberately omitted: on claude-opus-5 that runs adaptive,
      // which is what we want for reading a dense table. Cost is controlled by
      // effort, not by disabling thinking -- see MAX_TOKENS for why disabling
      // it is the wrong lever on this model.
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
      },
      // No temperature / top_p / top_k: this model rejects them with a 400.
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: parsed.mediaType, data: parsed.base64 },
            },
            { type: 'text', text: USER_INSTRUCTION },
          ],
        },
      ],
    });
  } catch (err) {
    // Network failure, timeout, upstream 4xx/5xx. The caller gets a 502 and the
    // worker gets pointed at manual entry; the detail stays in the server log.
    throw new ExtractionError(
      EXTRACTION_ERROR_CODES.PROVIDER_FAILURE,
      'The paystub reader could not be reached. Enter the paystub by hand instead -- manual entry produces exactly the same record.',
      { cause: err }
    );
  }

  if (message?.stop_reason === 'refusal') {
    throw new ExtractionError(
      EXTRACTION_ERROR_CODES.PROVIDER_FAILURE,
      'The paystub reader declined to process that image. Enter the paystub by hand instead.'
    );
  }
  if (message?.stop_reason === 'max_tokens') {
    // A truncated structured response is a partial reading. Partial readings
    // are exactly the thing that must never reach the review form.
    throw new ExtractionError(
      EXTRACTION_ERROR_CODES.PROVIDER_FAILURE,
      'The paystub reader returned an incomplete result and it was discarded. Enter the paystub by hand instead.'
    );
  }

  const body = textOf(message);
  let parsedBody;
  try {
    parsedBody = JSON.parse(body);
  } catch (err) {
    throw new ExtractionError(
      EXTRACTION_ERROR_CODES.PROVIDER_FAILURE,
      'The paystub reader returned a result that could not be understood, so nothing was extracted. Enter the paystub by hand instead.',
      { cause: err }
    );
  }

  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    throw new ExtractionError(
      EXTRACTION_ERROR_CODES.PROVIDER_FAILURE,
      'The paystub reader returned a result that could not be understood, so nothing was extracted. Enter the paystub by hand instead.'
    );
  }

  return normaliseExtraction(parsedBody);
}
