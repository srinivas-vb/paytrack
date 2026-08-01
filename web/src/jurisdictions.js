/**
 * Where a worker actually takes this, and what protects them when they do.
 *
 * Two rules govern every string in this file.
 *
 *   1. **Nothing here is invented.** Every agency name, form number, URL,
 *      statute and dollar figure was read off the agency's own page or the
 *      statutory text. Where a detail could not be confirmed, the general
 *      guidance is written and the specific claim is left out — a wrong
 *      citation in a legal-adjacent product is worse than no citation.
 *   2. **Anti-retaliation is not a footnote.** Fear of being punished, not
 *      lack of evidence, is the main reason workers never file. It gets the
 *      same structural weight here as the filing steps do.
 *
 * Sources checked (August 2026):
 *   - dir.ca.gov/dlse/HowToFileWageClaim.htm — CA wage claim process
 *   - dir.ca.gov/dlse/dlse-forms-wage.htm — DLSE Form 1, DLSE Form 55
 *   - dir.ca.gov/dlse/HowToFileRetaliationComplaint.htm — RCI, one-year limit
 *   - dol.gov/agencies/whd/contact/complaints — WHD complaints
 *   - Cal. Lab. Code §§ 98.6, 98.7, 1019, 1171.5; 29 U.S.C. §§ 215(a)(3),
 *     216(b), 255(a); Cal. Code Civ. Proc. § 338
 */

/* ------------------------------------------------------------------ *
 * Filing routes
 * ------------------------------------------------------------------ */

const CALIFORNIA_ROUTE = {
  id: 'ca-dlse',
  agency: "California Labor Commissioner's Office (DLSE)",
  shortName: 'the California Labor Commissioner',
  formName: 'DLSE Form 1 — Initial Report or Claim',
  url: 'https://www.dir.ca.gov/dlse/HowToFileWageClaim.htm',
  formUrl: 'https://www.dir.ca.gov/dlse/Forms/Wage/English.pdf',
  phone: '833-526-4636',
  what:
    'A state wage claim. You describe what you worked and what you were paid. ' +
    'The Labor Commissioner looks into it and can order your employer to pay you.',
  cost:
    'It is free. You do not need a lawyer. You do not need to pay anyone to file for you.',
  languages:
    'The claim form is published in English, Spanish, Chinese, Korean, Vietnamese, Tagalog and Punjabi.',
  steps: [
    'File online, or download the claim form, print it and mail it, or bring it to a district office. All three count the same.',
    'Fill in one line for each pay period you are claiming. Say what you worked and what you were paid.',
    'Attach your paystubs and your own record of hours. Your PayTrack evidence packet is that record.',
    'If your hours or days changed week to week, also fill in DLSE Form 55 — the overtime worksheet the office asks for when hours are irregular.',
    'The office will contact you. There is normally a settlement conference first, and a hearing after it if the case does not settle.',
  ],
  bring: [
    "Your employer's legal name, address and phone number — and the name of the owner or the manager who sets the schedule, if you know it.",
    'The dates you started and (if it applies) stopped working there, your job title, and your hourly rate.',
    'Every paystub you have for the pay periods you are claiming.',
    'Your own record of hours, day by day: when you started, when you finished, and any breaks.',
    'Anything else that backs it up — schedules, texts about shifts, photos of a timesheet, names of co-workers who worked the same hours.',
  ],
  extras: [
    {
      name: 'DLSE Form 55 — overtime worksheet',
      url: 'https://www.dir.ca.gov/dlse/DLSE-55-overtime-sheet.xls',
      why: 'Attach this if your hours or days of work varied and you are claiming overtime or missed breaks.',
    },
  ],
}

const FEDERAL_ROUTE = {
  id: 'us-whd',
  agency: 'U.S. Department of Labor, Wage and Hour Division (WHD)',
  shortName: 'the federal Wage and Hour Division',
  // WHD does not publish a numbered claim form the way DLSE does — you start
  // the process by contacting them. Saying "form WH-something" here would be
  // inventing a form number, so it is deliberately described instead.
  formName: 'No form number — you start by contacting WHD',
  url: 'https://www.dol.gov/agencies/whd/contact/complaints',
  phone: '1-866-487-9243',
  what:
    'A federal complaint under the Fair Labor Standards Act — the law that ' +
    'requires 1.5× pay for hours over 40 in a week. WHD can investigate your ' +
    'employer and recover back wages for you.',
  cost:
    'It is free, and you do not need a lawyer. WHD treats complaints as confidential — ' +
    'it does not disclose who complained, or that a complaint exists.',
  languages:
    'WHD has staff who speak languages other than English. Ask when you call.',
  steps: [
    'Call WHD at 1-866-487-9243, or use the contact page to reach the office nearest you.',
    'Tell them who you worked for, what you did, when you worked, and what you were paid.',
    'Send them your paystubs and your own record of hours. Your PayTrack evidence packet is that record.',
    'An investigator decides whether to open an investigation, and will tell you what happens next.',
  ],
  bring: [
    "Your employer's name, address and phone number, and the kind of work the business does.",
    'The dates you worked there, your job, and your rate of pay.',
    'Your paystubs and your own day-by-day record of the hours you worked.',
    'How you were paid — cash, check, direct deposit — and how often.',
  ],
  extras: [],
}

/* ------------------------------------------------------------------ *
 * Deadlines
 * ------------------------------------------------------------------ */

const CA_STATUTORY_DEADLINE = {
  id: 'ca-statutory',
  claim: 'Unpaid overtime or minimum wage under California law',
  years: 3,
  statute: 'Cal. Code Civ. Proc. § 338',
  note:
    'Three years for a claim created by a statute — which is what unpaid overtime and unpaid minimum wage are.',
}

const FLSA_DEADLINE = {
  id: 'flsa',
  claim: 'Unpaid overtime under federal law (FLSA)',
  years: 2,
  statute: '29 U.S.C. § 255(a)',
  note:
    'Two years normally. Three years if the violation was willful — but plan around two, because whether it was willful is decided later, by someone else.',
}

/* ------------------------------------------------------------------ *
 * Anti-retaliation — the load-bearing content
 * ------------------------------------------------------------------ */

const FLSA_RETALIATION = {
  statute: '29 U.S.C. § 215(a)(3)',
  scope: 'Federal law — everywhere in the U.S.',
  summary:
    'It is against federal law for an employer to fire you, or to discriminate against you in any way, because you complained about your wages or took part in a wage case.',
  remedies: [
    'Getting your job back.',
    'The wages you lost — and under 29 U.S.C. § 216(b) a court can order the same amount again on top, as liquidated damages.',
  ],
}

const CA_RETALIATION = {
  statute: 'Cal. Lab. Code § 98.6',
  scope: 'California law — on top of the federal protection',
  summary:
    'It is against California law for an employer to fire you, threaten to fire you, demote you, suspend you, or punish you in any other way because you complained about your pay or filed a claim with the Labor Commissioner.',
  remedies: [
    'Your job back, plus the wages and work benefits you lost — Cal. Lab. Code § 98.6(b)(1).',
    'A civil penalty of up to $10,000 per employee for each violation, and the statute says it is awarded to the employee who suffered the violation — Cal. Lab. Code § 98.6(b)(3).',
  ],
  highlights: [
    {
      label: 'The first 90 days are on your side',
      body:
        'If your employer does any of this within 90 days of you speaking up or filing, the law starts from the presumption that it was retaliation. Your employer then has to prove it was not. That is called a rebuttable presumption, and it is written into Cal. Lab. Code § 98.6(b)(1).',
      why:
        'This is exactly why dates matter. Write down the day you filed and the day anything changed at work.',
    },
  ],
}

const CA_RETALIATION_ROUTE = {
  agency:
    "Labor Commissioner's Office — Retaliation Complaint Investigation Unit (RCI)",
  formName: 'Retaliation Complaint (DLSE Form RCI-1)',
  url: 'https://www.dir.ca.gov/dlse/HowToFileRetaliationComplaint.htm',
  formUrl: 'https://www.dir.ca.gov/dlse/DLSEFormRCI-1.pdf',
  deadline: 'Within one year of the thing your employer did to you.',
  deadlineStatute: 'Cal. Lab. Code § 98.7',
  note:
    'This is a separate complaint from your wage claim, on a separate form, with its own deadline. Filing one does not file the other.',
}

const FEDERAL_RETALIATION_ROUTE = {
  agency: 'U.S. Department of Labor, Wage and Hour Division (WHD)',
  formName: 'No separate form — tell WHD what happened',
  url: 'https://www.dol.gov/agencies/whd/contact/complaints',
  formUrl: null,
  deadline:
    'The FLSA time limits in 29 U.S.C. § 255(a) — two years, or three if the violation was willful — apply here too. Do not wait.',
  deadlineStatute: '29 U.S.C. § 255(a)',
  note:
    'Tell the investigator handling your wage complaint, or call WHD at 1-866-487-9243. If your state has its own labor agency, you may be able to file there as well.',
}

/** What to do the moment something changes at work. */
const DOCUMENT_STEPS = [
  'Write down the date and time it happened, who did it, exactly what they said or did, and who else was there.',
  'Write down the date you filed your claim, or the date you first asked about your pay. The gap between those two dates is the thing that matters most.',
  'Keep your notes somewhere your employer cannot reach — your own phone, your own email, a notebook at home. Not a work laptop or a work account.',
  'Keep anything in writing: texts, messages, a new schedule, a warning letter, a changed timesheet. Photograph paper before you hand it back.',
  'Do not quit to make it stop before you have talked to the agency or a lawyer. Quitting can change what you are able to claim.',
]

const CA_IMMIGRATION = {
  title: 'Your immigration status does not change what you are owed',
  points: [
    'Under Cal. Lab. Code § 1171.5, every protection, right and remedy under California law is available to all workers, whatever their immigration status.',
    'That same section says immigration status is irrelevant to whether an employer is liable, and that nobody may ask about it in a wage case unless a court first decides, by clear and convincing evidence, that federal immigration law requires it.',
    'If an employer threatens to report you to immigration because you asked about your pay or filed a claim, that is itself unlawful — Cal. Lab. Code § 1019 calls it an unfair immigration-related practice.',
  ],
  federalNote:
    'The federal Wage and Hour Division says it enforces these laws without regard to a worker’s immigration status, and it keeps complaints confidential.',
}

const FEDERAL_IMMIGRATION = {
  title: 'Immigration status and federal wage complaints',
  points: [
    'The federal Wage and Hour Division says it enforces these laws without regard to a worker’s immigration status.',
    'WHD treats complaints as confidential — it does not disclose the name of the person who complained, or that a complaint exists.',
  ],
  federalNote:
    'State law may protect you further. California, for example, makes every state wage protection available regardless of immigration status (Cal. Lab. Code § 1171.5).',
}

/* ------------------------------------------------------------------ *
 * getFilingInfo
 * ------------------------------------------------------------------ */

const NOT_LEGAL_ADVICE =
  'PayTrack is not a law firm and this is not legal advice. It cannot tell you ' +
  'whether you will win, and no record — including this one — guarantees an outcome. ' +
  'What it does give you is your own contemporaneous account of the hours you worked, ' +
  'which is the thing most workers walk in without.'

const INFO = {
  california: {
    jurisdiction: 'california',
    // Contract-shaped fields describe the PRIMARY route for this jurisdiction.
    agency: CALIFORNIA_ROUTE.agency,
    formName: CALIFORNIA_ROUTE.formName,
    url: CALIFORNIA_ROUTE.url,
    deadlines: [CA_STATUTORY_DEADLINE, FLSA_DEADLINE],
    antiRetaliation: [CA_RETALIATION, FLSA_RETALIATION],
    // Additive fields the panel uses.
    routes: [CALIFORNIA_ROUTE, FEDERAL_ROUTE],
    retaliationRoute: CA_RETALIATION_ROUTE,
    documentSteps: DOCUMENT_STEPS,
    immigration: CA_IMMIGRATION,
    otherClaimsNote:
      'Other kinds of claim run on different clocks. A promise in writing to pay you a higher rate can have a longer window; some penalties have a shorter one. The Labor Commissioner will tell you which apply to you.',
    notLegalAdvice: NOT_LEGAL_ADVICE,
  },
  federal: {
    jurisdiction: 'federal',
    agency: FEDERAL_ROUTE.agency,
    formName: FEDERAL_ROUTE.formName,
    url: FEDERAL_ROUTE.url,
    deadlines: [FLSA_DEADLINE],
    antiRetaliation: [FLSA_RETALIATION],
    routes: [FEDERAL_ROUTE],
    retaliationRoute: FEDERAL_RETALIATION_ROUTE,
    documentSteps: DOCUMENT_STEPS,
    immigration: FEDERAL_IMMIGRATION,
    otherClaimsNote:
      'Your state may have its own wage law with its own, sometimes longer, deadline, and its own labor agency to file with. Ask them as well as WHD.',
    notLegalAdvice: NOT_LEGAL_ADVICE,
  },
}

/**
 * Filing information for a jurisdiction.
 *
 * Falls back to federal rather than returning null: FLSA is the floor
 * everywhere in the U.S., so an unknown jurisdiction still gets a real,
 * correct route instead of an empty panel.
 */
export function getFilingInfo(jurisdiction) {
  return INFO[jurisdiction] ?? INFO.federal
}

/* ------------------------------------------------------------------ *
 * Deadlines as a remaining window
 * ------------------------------------------------------------------ */

/**
 * Parses a bare `YYYY-MM-DD` into a local Date.
 *
 * Deliberately not `new Date(str)` — the spec parses a date-only string as UTC
 * midnight, which prints the previous day anywhere west of UTC. Same reasoning
 * as `formatCalendarDate` in format.js.
 */
function parseCalendarDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''))
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * `date` plus `years`, clamped backwards when the day does not exist.
 *
 * 29 February plus one year is 1 March in JavaScript. Rolling FORWARD would
 * hand the worker a day they do not have, so it is clamped to 28 February —
 * every rounding in this file goes in the direction that makes them file
 * sooner, never later.
 */
function addYearsClamped(date, years) {
  const month = date.getMonth()
  const out = new Date(date.getFullYear() + years, month, date.getDate())
  if (out.getMonth() !== month) out.setDate(0)
  return out
}

/** Whole months from `from` to `to`, floored. Partial months never count. */
function wholeMonthsBetween(from, to) {
  let months =
    (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth())
  if (to.getDate() < from.getDate()) months -= 1
  return months
}

/**
 * Turns "3 years" into "you have until roughly July 2029".
 *
 * Anchored on the **start** of the pay period, not the end. California's own
 * guidance is that the clock runs from when each violation happened, not from
 * when the job ended — so the earliest violation in a pay period is the one
 * that expires first, and that is the date a worker needs to be planning
 * around. Anchoring on the end of the period would quietly grant them up to
 * two extra weeks they may not have.
 *
 * Returns `{ known: false }` when there is no pay period to count from, which
 * the panel renders as the plain rule instead of a fabricated date.
 */
export function computeFilingWindow(
  deadline,
  { periodStart, periodEnd, now = new Date() } = {},
) {
  const anchor = parseCalendarDate(periodStart) ?? parseCalendarDate(periodEnd)
  if (!anchor) return { ...deadline, known: false }

  const due = addYearsClamped(anchor, deadline.years)
  const today = startOfDay(now instanceof Date ? now : new Date(now))

  const daysLeft = Math.floor((due.getTime() - today.getTime()) / 86_400_000)
  const monthsLeft = Math.max(0, wholeMonthsBetween(today, due))

  return {
    ...deadline,
    known: true,
    anchor,
    anchorIso: `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-${String(anchor.getDate()).padStart(2, '0')}`,
    due,
    dueMonthLabel: due.toLocaleDateString([], { month: 'long', year: 'numeric' }),
    daysLeft,
    monthsLeft,
    expired: daysLeft < 0,
    // Six months is not a legal threshold — it is the point at which "get an
    // appointment, gather documents, file" stops being comfortably doable.
    urgent: daysLeft >= 0 && daysLeft <= 183,
  }
}

/** Every deadline for a jurisdiction, as remaining windows. */
export function getFilingWindows(info, options) {
  const deadlines = Array.isArray(info?.deadlines) ? info.deadlines : []
  return deadlines.map((d) => computeFilingWindow(d, options))
}

/** The soonest window that has not already closed — the one to lead with. */
export function soonestWindow(windows) {
  return (
    windows
      .filter((w) => w.known && !w.expired)
      .sort((a, b) => a.daysLeft - b.daysLeft)[0] ?? null
  )
}
