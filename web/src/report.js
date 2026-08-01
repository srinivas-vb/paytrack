/**
 * The evidence packet.
 *
 * `buildEvidencePacket({ analysis, shifts, paystub, verification, workerId })`
 * returns a PDF `Blob` containing the seven sections listed in
 * docs/contracts.md ("Phase 5 — Evidence packet").
 *
 * Three rules govern everything below, and each one is a place a wage tool
 * could quietly start lying:
 *
 *   1. **Every number is traceable to a row.** No total appears without the
 *      rows that produce it. The week totals are followed by the per-bucket
 *      arithmetic; the arithmetic is followed by the shift log those hours came
 *      from, entry by entry. A labor commissioner should be able to re-add this
 *      document by hand and get the same answer.
 *
 *   2. **The headline figure renders identically whatever its sign.** There is
 *      exactly one code path for it — same box, same size, same weight, no
 *      colour. Only the sentence underneath changes. A packet that looks
 *      triumphant when it finds something and apologetic when it doesn't is an
 *      accusation generator, not evidence.
 *
 *   3. **What PayTrack cannot know is stated, not omitted.** Break premiums sit
 *      under a heading saying they are excluded from the amount claimed. The
 *      gap between when work was claimed and when the server recorded it is
 *      printed in its own column rather than hidden — under
 *      *Anderson v. Mt. Clemens Pottery Co.*, 328 U.S. 680 (1946), the
 *      contemporaneity of a worker's record is the whole point of having one.
 */

import { jsPDF } from 'jspdf'

import {
  formatCalendarDate,
  formatGap,
  formatHours,
  formatMoney,
  formatMultiplier,
  shiftDurationMs,
  shortHash,
  toDate,
} from './format.js'

/* ---- page geometry ------------------------------------------------- */

const PAGE_W = 612 // US Letter, points
const PAGE_H = 792
const MARGIN = 54
const CONTENT_W = PAGE_W - MARGIN * 2 // 504
const TOP_BASELINE = 70
const BOTTOM_BASELINE = PAGE_H - MARGIN - 24 // room for the stamped footer

const INK = 20 // near-black body text
const DIM = 110 // secondary text
const RULE = 200 // hairlines
const BOX = 150 // block borders

/* ---- text encoding -------------------------------------------------- */

/**
 * jsPDF's built-in fonts encode Latin-1 only. `format.js` emits real
 * typography — a U+2212 minus sign in negative money, en dashes in week
 * ranges, ellipses in truncated hashes — and a character the font cannot
 * encode comes out as a wrong glyph or nothing at all.
 *
 * On a document someone may file with a labor agency, a mangled minus sign in
 * front of a dollar figure is not a cosmetic bug. So everything is folded down
 * to characters the standard fonts are guaranteed to carry, and anything still
 * unencodable becomes a visible '?' rather than a silent hole.
 */
const REPLACEMENTS = [
  [/−/g, '-'], // minus sign — NOT in WinAnsi
  [/[–—]/g, '-'], // en / em dash
  [/[‘’‚‛]/g, "'"],
  [/[“”„]/g, '"'],
  [/…/g, '...'],
  [/[•·]/g, '-'],
  [/→/g, '->'],
  [/ /g, ' '],
]

function pdfText(value) {
  let s = String(value ?? '')
  for (const [re, to] of REPLACEMENTS) s = s.replace(re, to)
  return s.replace(/[^\t\n\x20-\x7e¡-ÿ]/g, '?')
}

/* ---- value formatting ----------------------------------------------- */

const pad2 = (n) => String(n).padStart(2, '0')

/** `2026-07-06` in the reader's own zone — fixed width, unambiguous, sortable. */
function localDate(iso) {
  const d = toDate(iso)
  if (!d) return '—'
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** `09:00` in the reader's own zone. */
function localTime(iso) {
  const d = toDate(iso)
  if (!d) return '—'
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** `2026-07-06 09:00` — used for the server's own timestamps. */
function localStamp(iso) {
  const d = toDate(iso)
  return d ? `${localDate(iso)} ${localTime(iso)}` : '—'
}

function timeZoneLabel() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'this device'
  } catch {
    return 'this device'
  }
}

/**
 * A pay-period boundary, which arrives either as a bare `YYYY-MM-DD` or as an
 * ISO instant depending on how the driver typed the column. Both name the same
 * calendar day; only the first ten characters are ever load-bearing.
 */
function calendarDate(value) {
  const s = typeof value === 'string' ? value : ''
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  if (m) return formatCalendarDate(m[1])
  const d = toDate(value)
  return d ? formatCalendarDate(localDate(d.toISOString())) : '—'
}

/** The ten characters of a pay-period boundary, for filenames and comparisons. */
function calendarKey(value) {
  const s = typeof value === 'string' ? value : ''
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  if (m) return m[1]
  const d = toDate(value)
  return d ? localDate(d.toISOString()) : null
}

/**
 * A workweek's label, taken from the UTC calendar dates of its boundaries.
 *
 * Deliberately NOT `formatWeekRange`, which renders those boundary instants in
 * the device's zone. The rule engine buckets at 00:00 UTC, so for any reader
 * west of Greenwich the local rendering of a Sunday-midnight boundary is the
 * *Saturday* before — and a week captioned "Sat 4 Jul" containing no Saturday
 * shift is exactly the kind of discrepancy that gets a document's arithmetic
 * doubted. The boundaries are printed in the zone they were computed in, and
 * section 3 says so.
 */
function weekLabel(startIso, endIso) {
  const start = toDate(startIso)
  if (!start) return '—'
  const end = toDate(endIso)
  const spanDays = end
    ? Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000))
    : 7
  const last = new Date(start.getTime() + (spanDays - 1) * 86_400_000)
  const day = (d) =>
    `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.toISOString().slice(0, 10)}`
  return `${day(start)} to ${day(last)}`
}

/** Money, in cents, so nothing accumulates float error across a loop. */
function cents(hours, rate, multiplier) {
  if (![hours, rate, multiplier].every((n) => Number.isFinite(n))) return null
  return Math.round(hours * rate * multiplier * 100)
}

const fromCents = (c) => (c === null ? null : c / 100)

const JURISDICTION_NAMES = {
  federal: 'federal law (FLSA)',
  california: 'California law',
}

function jurisdictionName(key) {
  return JURISDICTION_NAMES[key] || (key ? `${key} law` : 'the selected rules')
}

/* ---- the layout engine ---------------------------------------------- */

/**
 * A cursor over an arbitrary number of pages.
 *
 * Every write goes through `paragraph` or `row`, and both break to a new page
 * one *line* at a time rather than one block at a time. A worker with sixty
 * shifts gets a table that continues onto page four with its header repeated —
 * never a table that runs off the bottom of page three.
 */
function sheet(doc) {
  const L = {
    y: TOP_BASELINE,
    x: MARGIN,
    width: CONTENT_W,
  }

  // A table sets this so its column headings are redrawn at the top of every
  // page it spills onto. Without it a worker with sixty shifts gets four pages
  // of unlabelled columns — the data would all be there and none of it legible.
  let repeat = null
  let repeating = false

  L.newPage = () => {
    doc.addPage()
    L.y = TOP_BASELINE
    if (repeat && !repeating) {
      repeating = true
      try {
        repeat()
      } finally {
        repeating = false
      }
    }
  }

  /** Pass a header-drawing function while a table is open; pass null to close. */
  L.repeatOnBreak = (fn) => {
    repeat = fn
  }

  /** Break now if the next `h` points would cross the footer band. */
  L.reserve = (h) => {
    if (L.y + h > BOTTOM_BASELINE) L.newPage()
  }

  L.gap = (h) => {
    L.y += h
  }

  /** A hairline at the current baseline. No break check — safe inside headers. */
  L.hairline = (color = RULE, offset = -3, weight = 0.4) => {
    doc.setDrawColor(color)
    doc.setLineWidth(weight)
    doc.line(MARGIN, L.y + offset, MARGIN + CONTENT_W, L.y + offset)
  }

  L.rule = (color = RULE) => {
    L.reserve(6)
    L.hairline(color)
  }

  /**
   * Wrapped body text. Returns the number of lines drawn.
   *
   * `indent` and `width` let a paragraph sit inside a box without the caller
   * doing arithmetic.
   */
  L.paragraph = (
    text,
    {
      size = 9.5,
      style = 'normal',
      color = INK,
      indent = 0,
      width = CONTENT_W,
      leading = 1.38,
      after = 0,
    } = {},
  ) => {
    doc.setFont('helvetica', style)
    doc.setFontSize(size)
    doc.setTextColor(color)
    const advance = size * leading
    const lines = doc.splitTextToSize(pdfText(text), width - indent)
    for (const ln of lines) {
      L.reserve(advance)
      doc.text(ln, MARGIN + indent, L.y)
      L.y += advance
    }
    L.y += after
    return lines.length
  }

  /** Height `paragraph` would take, without drawing it — for box borders. */
  L.measure = (text, { size = 9.5, style = 'normal', indent = 0, width = CONTENT_W, leading = 1.38 } = {}) => {
    doc.setFont('helvetica', style)
    doc.setFontSize(size)
    return doc.splitTextToSize(pdfText(text), width - indent).length * size * leading
  }

  /** A single unwrapped line at an absolute x. Used for table cells. */
  L.cell = (text, x, { size = 7.6, style = 'normal', color = INK, align = 'left', width = 0 } = {}) => {
    doc.setFont('helvetica', style)
    doc.setFontSize(size)
    doc.setTextColor(color)
    const s = pdfText(text)
    if (align === 'right') doc.text(s, x + width, L.y, { align: 'right' })
    else doc.text(s, x, L.y)
  }

  L.sectionHeading = (number, title) => {
    // Keep a heading with at least a few lines of what follows it.
    L.reserve(58)
    L.gap(10)
    L.paragraph(`${number}. ${title}`, { size: 13, style: 'bold' })
    L.gap(2)
    L.rule(BOX)
    L.gap(8)
  }

  L.subHeading = (title, { size = 10.5 } = {}) => {
    L.reserve(40)
    L.gap(6)
    L.paragraph(title, { size, style: 'bold' })
    L.gap(1)
  }

  /** Label / value pairs in two columns, wrapping the value. */
  L.pairs = (rows, { labelW = 168, size = 9, width = CONTENT_W } = {}) => {
    for (const [label, value] of rows) {
      if (value === null || value === undefined) continue
      const advance = size * 1.42
      const valueLines = doc.splitTextToSize(pdfText(String(value)), width - labelW - 8)
      L.reserve(advance * valueLines.length)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(size)
      doc.setTextColor(DIM)
      doc.text(pdfText(label), MARGIN, L.y)
      doc.setTextColor(INK)
      let first = true
      for (const ln of valueLines) {
        if (!first) L.reserve(advance)
        doc.text(ln, MARGIN + labelW, L.y)
        L.y += advance
        first = false
      }
    }
  }

  L.bullets = (items, { size = 9.5, indent = 14 } = {}) => {
    for (const item of items) {
      const advance = size * 1.38
      // Keep the dash with at least the first two lines of its own bullet, so
      // a break never strands a lone hyphen at the foot of a page.
      L.reserve(Math.min(L.measure(item, { size, indent }), advance * 2))
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(size)
      doc.setTextColor(INK)
      doc.text('-', MARGIN, L.y)
      L.paragraph(item, { size, indent })
      L.gap(1)
    }
  }

  return L
}

/* ---- section 1 ------------------------------------------------------ */

function titleBlock(doc, L, { analysis, paystub, workerId, generatedAt }) {
  L.paragraph('PayTrack — evidence packet', { size: 21, style: 'bold' })
  L.gap(2)
  L.paragraph("A worker's own record of hours worked, and what it is worth.", {
    size: 10.5,
    color: DIM,
  })
  L.gap(10)
  L.rule(BOX)
  L.gap(10)

  const start = analysis?.periodStart ?? paystub?.periodStart
  const end = analysis?.periodEnd ?? paystub?.periodEnd

  L.pairs([
    ['Pay period', start || end ? `${calendarDate(start)} to ${calendarDate(end)}` : 'not stated'],
    ['Rules applied', jurisdictionName(analysis?.jurisdiction)],
    ['Worker id', workerId || 'not supplied'],
    ['Packet generated', `${localStamp(generatedAt.toISOString())} (${timeZoneLabel()})`],
  ])
  L.gap(4)
  L.paragraph(
    `All times in this document are shown in ${timeZoneLabel()}, the time zone of the device that generated it.`,
    { size: 8.5, color: DIM },
  )
}

function whatThisIs(doc, L) {
  L.sectionHeading(1, 'What this is')

  L.paragraph(
    "This is a worker's own contemporaneous record of the hours they worked, produced by " +
      'PayTrack, together with an arithmetic comparison against one paystub the worker supplied. ' +
      'Each entry was timestamped by a third-party server at the moment it was received, and each ' +
      'is cryptographically linked to the entry before it, so an alteration to any past entry ' +
      'breaks every link after it.',
    { after: 6 },
  )

  L.paragraph(
    'Why a worker-kept record matters. Under Anderson v. Mt. Clemens Pottery Co., 328 U.S. 680 ' +
      '(1946), where an employer has not kept the records the Fair Labor Standards Act requires of ' +
      'it (29 U.S.C. § 211(c)), an employee may carry their burden by producing sufficient evidence ' +
      'to show the amount of work as a matter of just and reasonable inference — and the burden then ' +
      'shifts to the employer to come forward with evidence rebutting it. Such a record does not have ' +
      'to be unforgeable. It has to be reasonable and contemporaneous. That is what this document is ' +
      'intended to be, and it is why section 4 prints when each entry was recorded alongside when the ' +
      'work is claimed to have happened.',
    { after: 6 },
  )

  L.subHeading('What this document is not')
  L.bullets([
    'It is not legal advice, and PayTrack is not a lawyer. Nothing here creates an ' +
      'attorney-client relationship or tells anyone what to do.',
    'It is not a finding by any court, agency, or labor commissioner. It is one side of a ' +
      'dispute, showing its workings so the other side can check them.',
    'It is not a payroll record. The employer holds that. This exists precisely because the ' +
      'worker normally does not.',
    'It is not proof of anything on its own. It is evidence, offered with its limits stated in ' +
      'section 7.',
  ])
}

/* ---- section 2 ------------------------------------------------------ */

/**
 * The headline figure.
 *
 * One box, one type size, one ink, whatever the sign. There is deliberately no
 * branch here that changes how the number *looks* — only the sentence beneath
 * it changes, and "nothing is owed" gets the same 30-point figure that "$50 is
 * owed" gets. See rule 2 at the top of this file.
 */
function headline(doc, L, { analysis, paystub }) {
  L.sectionHeading(2, 'The amount claimed')

  const discrepancy = Number(analysis?.discrepancy)
  const known = Number.isFinite(discrepancy)
  const law = jurisdictionName(analysis?.jurisdiction)

  let sentence
  if (!known) {
    sentence = 'The difference could not be worked out from the records supplied.'
  } else if (discrepancy > 0) {
    sentence = `The hours in section 4 are worth more, under ${law}, than this paystub paid.`
  } else if (discrepancy === 0) {
    sentence = `The hours in section 4 and this paystub agree under ${law}. Nothing is owed for this pay period.`
  } else {
    sentence = `This paystub paid more than the hours in section 4 are worth under ${law}. Nothing is owed for this pay period.`
  }

  const label = `DIFFERENCE FOR THIS PAY PERIOD, UNDER ${law.toUpperCase()}`
  const inner = CONTENT_W - 24

  const boxHeight =
    12 + L.measure(label, { size: 8.5, style: 'bold', width: inner }) + 34 + L.measure(sentence, { size: 10, width: inner }) + 14
  // Clear of the section rule, so the box edge does not double it.
  L.gap(6)
  L.reserve(boxHeight + 6)

  const pageBefore = doc.getCurrentPageInfo().pageNumber
  const top = L.y - 11

  L.gap(4)
  L.paragraph(label, { size: 8.5, style: 'bold', color: DIM, indent: 12, width: CONTENT_W - 12 })
  L.gap(6)
  L.paragraph(known ? formatMoney(discrepancy) : '—', {
    size: 30,
    style: 'bold',
    indent: 12,
    width: CONTENT_W - 12,
    leading: 1.15,
  })
  L.gap(2)
  L.paragraph(sentence, { size: 10, indent: 12, width: CONTENT_W - 12 })
  L.gap(6)

  if (doc.getCurrentPageInfo().pageNumber === pageBefore) {
    doc.setDrawColor(BOX)
    doc.setLineWidth(0.7)
    doc.rect(MARGIN, top, CONTENT_W, L.y - top - 4)
  }
  L.gap(10)

  L.subHeading('How that figure is reached')
  L.pairs([
    ['Hours recorded are worth', formatMoney(Number(analysis?.totalOwed))],
    ['This paystub paid (gross)', formatMoney(Number(analysis?.totalPaid))],
    ['Difference (owed - paid)', known ? formatMoney(discrepancy) : '—'],
  ])
  L.gap(2)
  L.paragraph(
    'The first line is the sum of the per-workweek figures in section 3, each of which is itemised ' +
      'down to hours at each multiplier. The second line is the gross pay printed on the paystub ' +
      'below. Overtime is computed one workweek at a time and never averaged across weeks.',
    { size: 8.5, color: DIM },
  )

  L.subHeading('The paystub this is compared against')
  if (!paystub) {
    L.paragraph(
      'The paystub row itself was not available when this packet was generated. The gross figure ' +
        'above came from the analysis, which read it from the same record.',
      { size: 9, color: DIM },
    )
    return
  }
  L.pairs([
    ['Pay period', `${calendarDate(paystub.periodStart)} to ${calendarDate(paystub.periodEnd)}`],
    ['Hours it says were paid', formatHours(Number(paystub.paidHours))],
    ['Hourly rate it states', `${formatMoney(Number(paystub.paidRate))} per hour`],
    ['Gross pay it states', formatMoney(Number(paystub.grossPay))],
    ['Entered into PayTrack', paystub.createdAt ? localStamp(paystub.createdAt) : 'not recorded'],
  ])
  L.gap(2)
  L.paragraph(
    'These figures were transcribed by the worker from the statement their employer issued. ' +
      'PayTrack does not guess or infer any of them.',
    { size: 8.5, color: DIM },
  )
}

/* ---- section 3 ------------------------------------------------------ */

function workweeks(doc, L, { analysis }) {
  L.sectionHeading(3, 'Week by week')

  const rate = Number(analysis?.hourlyRate)
  const weeks = Array.isArray(analysis?.workweeks) ? analysis.workweeks : []

  L.paragraph(
    'A workweek is a fixed, recurring period of 168 hours. Overtime is computed inside one ' +
      'workweek and never averaged across two: a fortnight of 45 hours then 35 hours owes five ' +
      'hours of overtime, not none. Each week below shows every hour placed in exactly one ' +
      'bucket, the multiplier applied to it, the statute that promotes it, and the arithmetic ' +
      `at ${formatMoney(rate)} an hour.`,
    { after: 4 },
  )
  L.paragraph(
    'Workweek boundaries are printed as UTC calendar dates, because UTC is the zone the buckets ' +
      'were computed in. Clock-in and clock-out times in section 4 are shown in ' +
      `${timeZoneLabel()}, the zone of the device that generated this packet.`,
    { size: 8.5, color: DIM, after: 4 },
  )

  if (weeks.length === 0) {
    L.paragraph(
      'No completed shifts fall inside this pay period, so there is nothing to compute. The ' +
        'shift log in section 4 lists everything on record.',
      { style: 'bold' },
    )
    return
  }

  let checkedTotalCents = 0

  for (const week of weeks) {
    const b = week?.breakdown ?? {}
    const straight = Number(b.straightHours) || 0
    const overtime = Number(b.overtimeHours) || 0
    const doubleTime = Number(b.doubleTimeHours) || 0
    const bucketSum = straight + overtime + doubleTime
    const total = Number(week?.totalHours)
    const reasons = Array.isArray(b.reasons) ? b.reasons : []

    // Keep a week's caption with its whole four-line arithmetic block.
    L.reserve(96)
    L.gap(8)
    L.paragraph(`Workweek ${weekLabel(week?.start, week?.end)} — ${formatHours(total)} recorded`, {
      size: 10.5,
      style: 'bold',
    })
    L.gap(3)

    const lines = [
      ['Regular (1×)', straight, 1],
      ['Overtime (1.5×)', overtime, 1.5],
      ['Double time (2×)', doubleTime, 2],
    ]

    // Column stops inside the content width: label / hours / arithmetic / money.
    const cx = { label: MARGIN, hours: MARGIN + 132, math: MARGIN + 196, money: MARGIN + 404 }
    let weekCents = 0

    L.cell('Bucket', cx.label, { size: 8, style: 'bold', color: DIM })
    L.cell('Hours', cx.hours, { size: 8, style: 'bold', color: DIM, align: 'right', width: 48 })
    L.cell('How it is worked out', cx.math, { size: 8, style: 'bold', color: DIM })
    L.cell('Value', cx.money, { size: 8, style: 'bold', color: DIM, align: 'right', width: 100 })
    L.y += 11
    L.hairline()
    L.gap(5)

    for (const [label, hours, multiplier] of lines) {
      const c = cents(hours, rate, multiplier)
      if (c !== null) weekCents += c
      L.reserve(13)
      L.cell(label, cx.label, { size: 8.5 })
      L.cell(formatHours(hours), cx.hours, { size: 8.5, align: 'right', width: 48 })
      L.cell(
        `${formatHours(hours)} × ${formatMoney(rate)} × ${multiplier}`,
        cx.math,
        { size: 8.5, color: DIM },
      )
      L.cell(formatMoney(fromCents(c)), cx.money, { size: 8.5, align: 'right', width: 100 })
      L.y += 12.5
    }
    L.rule()
    L.gap(4)

    const balances = !Number.isFinite(total) || Math.abs(bucketSum - total) < 0.005
    L.paragraph(
      balances
        ? `Every hour counted once: ${formatHours(straight)} + ${formatHours(overtime)} + ${formatHours(doubleTime)} = ${formatHours(bucketSum)}, matching the ${formatHours(total)} recorded.`
        : `WARNING: these buckets add up to ${formatHours(bucketSum)} but the week totals ${formatHours(total)}. Do not rely on this week's figure.`,
      { size: 8.5, style: balances ? 'normal' : 'bold', color: balances ? DIM : INK },
    )

    const reported = Number(week?.owed)
    const computed = fromCents(weekCents)
    checkedTotalCents += weekCents
    L.gap(3)
    L.paragraph(`This week's hours are worth ${formatMoney(reported)}.`, {
      size: 9.5,
      style: 'bold',
    })
    if (Number.isFinite(reported) && Number.isFinite(computed) && Math.abs(reported - computed) > 0.011) {
      L.paragraph(
        `NOTE: the itemised lines above add to ${formatMoney(computed)}, which differs from the ` +
          `${formatMoney(reported)} reported for this week. Check both before relying on either.`,
        { size: 8.5, style: 'bold' },
      )
    }

    if (reasons.length > 0) {
      L.gap(4)
      L.paragraph('Why hours were promoted above the regular rate', { size: 8.5, style: 'bold', color: DIM })
      L.gap(2)
      for (const reason of reasons) {
        L.reserve(24)
        L.paragraph(
          `${formatHours(Number(reason?.hours))} at ${formatMultiplier(Number(reason?.multiplier))} — ${reason?.basis ?? 'reason not stated'}`,
          { size: 9, indent: 12 },
        )
        if (reason?.statute) {
          L.paragraph(reason.statute, { size: 8, color: DIM, indent: 12 })
        }
        L.gap(2)
      }
    } else {
      L.gap(3)
      L.paragraph('No hours in this week were promoted above the regular rate.', {
        size: 8.5,
        color: DIM,
      })
    }
    L.gap(6)
  }

  L.gap(4)
  L.rule(BOX)
  L.gap(6)
  const reportedTotal = Number(analysis?.totalOwed)
  L.paragraph(
    `Across ${weeks.length} workweek${weeks.length === 1 ? '' : 's'}, the recorded hours are worth ${formatMoney(reportedTotal)}. ` +
      `That is the first line of section 2.`,
    { size: 9.5, style: 'bold' },
  )
  const checkedTotal = fromCents(checkedTotalCents)
  if (Number.isFinite(reportedTotal) && Math.abs(reportedTotal - checkedTotal) > 0.011) {
    L.paragraph(
      `NOTE: adding the itemised week lines above gives ${formatMoney(checkedTotal)}, which differs ` +
        `from the ${formatMoney(reportedTotal)} reported. Check both before relying on either.`,
      { size: 8.5, style: 'bold' },
    )
  }
}

/* ---- section 4 ------------------------------------------------------ */

const SHIFT_COLUMNS = [
  { key: 'id', head: '#', x: 0, w: 26 },
  { key: 'date', head: 'Date claimed', x: 32, w: 58 },
  { key: 'in', head: 'In', x: 94, w: 28 },
  { key: 'out', head: 'Out', x: 126, w: 32 },
  { key: 'hours', head: 'Hours', x: 162, w: 38, align: 'right' },
  { key: 'recorded', head: 'Recorded by server', x: 208, w: 90 },
  { key: 'gap', head: 'Gap', x: 304, w: 72 },
  { key: 'entry', head: 'Entry', x: 382, w: 44 },
  { key: 'period', head: 'In period', x: 430, w: 42 },
  { key: 'site', head: 'Site', x: 476, w: 28 },
]

/** Drawn once where the table opens, and again at the top of every page it
 *  spills onto. Must not itself request a page break. */
function shiftTableHeader(L) {
  for (const c of SHIFT_COLUMNS) {
    L.cell(c.head, MARGIN + c.x, {
      size: 7.2,
      style: 'bold',
      color: DIM,
      align: c.align,
      width: c.w,
    })
  }
  L.y += 10
  L.hairline(BOX)
  L.gap(3)
}

/**
 * Every entry on record, with the server's own timestamp beside the claimed
 * one.
 *
 * The `Recorded by server` and `Gap` columns are not decoration and are not an
 * admission. A record entered three weeks after the shift is weaker evidence
 * than one entered the same minute, and a reader is entitled to know which
 * they are looking at. Hiding the gap would make the whole document less
 * credible, not more — so it gets a column, and retroactive entries are
 * labelled in a second one.
 */
function shiftLog(doc, L, { shifts, analysis, paystub }) {
  L.sectionHeading(4, 'The shift log')

  const list = Array.isArray(shifts) ? shifts.slice() : []
  // Oldest first: a record reads as a chronology, not as a feed.
  list.sort((a, b) => {
    const x = toDate(a?.clockIn)?.getTime() ?? 0
    const y = toDate(b?.clockIn)?.getTime() ?? 0
    return x - y || (Number(a?.id) || 0) - (Number(b?.id) || 0)
  })

  const periodStart = calendarKey(analysis?.periodStart ?? paystub?.periodStart)
  const periodEnd = calendarKey(analysis?.periodEnd ?? paystub?.periodEnd)
  const inPeriod = (shift) => {
    if (!periodStart || !periodEnd) return null
    const key = calendarKey(shift?.clockIn)
    return key ? key >= periodStart && key <= periodEnd : null
  }

  L.paragraph(
    'Every entry PayTrack holds for this worker, oldest first. "Date claimed", "In" and "Out" are ' +
      'what the worker reported. "Recorded by server" is when a third-party server received the ' +
      'entry, and "Gap" is the distance between the two. An entry marked Later was added after the ' +
      'fact rather than clocked live; that is a normal and permitted way to record past work, and ' +
      'it is labelled rather than hidden so its weight can be judged.',
    { after: 4 },
  )
  if (periodStart && periodEnd) {
    L.paragraph(
      `"In period" marks the entries whose claimed clock-in falls, by UTC calendar date, between ` +
        `${calendarDate(periodStart)} and ${calendarDate(periodEnd)}. That is the same selection the ` +
        'figures in sections 2 and 3 are built from, so it is assessed in UTC to match. Where an ' +
        "entry's UTC date differs from the local date in the column above, both are shown.",
      { size: 8.5, color: DIM, after: 4 },
    )
  }

  if (list.length === 0) {
    L.paragraph('There are no entries on record for this worker.', { style: 'bold' })
    return
  }

  L.gap(4)
  // Never open a table header that has no room for its first row under it.
  L.reserve(16 + 25)
  shiftTableHeader(L)
  L.repeatOnBreak(() => shiftTableHeader(L))

  let inHours = 0
  let outHours = 0
  let inCount = 0
  let openCount = 0
  let retroCount = 0

  for (const shift of list) {
    const open = !shift?.clockOut
    const ms = shiftDurationMs(shift)
    const hours = Number.isFinite(ms) ? ms / 3_600_000 : null
    const within = inPeriod(shift)

    if (open) openCount += 1
    if (shift?.isRetroactive) retroCount += 1
    if (hours !== null) {
      if (within === true) {
        inHours += hours
        inCount += 1
      } else if (within === false) {
        outHours += hours
      }
    }

    // Two physical lines per entry: the figures, then the fingerprint the
    // figures are anchored to.
    L.reserve(23)

    L.cell(String(shift?.id ?? '—'), MARGIN + SHIFT_COLUMNS[0].x, { size: 7.6, color: DIM })
    L.cell(localDate(shift?.clockIn), MARGIN + SHIFT_COLUMNS[1].x, { size: 7.6 })
    L.cell(localTime(shift?.clockIn), MARGIN + SHIFT_COLUMNS[2].x, { size: 7.6 })
    L.cell(open ? 'open' : localTime(shift?.clockOut), MARGIN + SHIFT_COLUMNS[3].x, { size: 7.6 })
    L.cell(hours === null ? '—' : formatHours(hours), MARGIN + SHIFT_COLUMNS[4].x, {
      size: 7.6,
      align: 'right',
      width: SHIFT_COLUMNS[4].w,
    })
    L.cell(localStamp(shift?.createdAt), MARGIN + SHIFT_COLUMNS[5].x, { size: 7.6 })
    L.cell(formatGap(shift?.clockIn, shift?.createdAt) ?? '—', MARGIN + SHIFT_COLUMNS[6].x, {
      size: 7.6,
    })
    L.cell(shift?.isRetroactive ? 'Later' : 'Live', MARGIN + SHIFT_COLUMNS[7].x, {
      size: 7.6,
      style: shift?.isRetroactive ? 'bold' : 'normal',
    })
    L.cell(within === null ? '—' : within ? 'yes' : 'no', MARGIN + SHIFT_COLUMNS[8].x, { size: 7.6 })
    L.cell(shift?.offsiteFlag ? 'away' : shift?.workplaceLabel ? 'at' : '—', MARGIN + SHIFT_COLUMNS[9].x, {
      size: 7.6,
      color: DIM,
    })
    L.y += 9.5

    const where = shift?.workplaceLabel
      ? `${shift.workplaceLabel}${Number.isFinite(shift?.distanceM) ? ` (${Math.round(shift.distanceM)} m away)` : ''}`
      : Number.isFinite(shift?.gpsLat)
        ? 'location recorded, no saved workplace matched'
        : 'no location attached'
    // "In period" is assessed on the UTC date, matching how the figures were
    // computed. Where that differs from the local date in the column above, the
    // UTC one is printed too rather than left to be inferred.
    const utcKey = calendarKey(shift?.clockIn)
    const drift = utcKey && utcKey !== localDate(shift?.clockIn) ? `   UTC date ${utcKey}` : ''
    L.cell(
      `entry ${shortHash(shift?.entryHash, 16)}   links to ${shortHash(shift?.prevHash, 16)}   ${where}${drift}`,
      MARGIN + SHIFT_COLUMNS[1].x,
      { size: 6.6, color: DIM },
    )
    L.y += 4
    doc.setDrawColor(RULE)
    doc.setLineWidth(0.3)
    doc.line(MARGIN, L.y - 2, MARGIN + CONTENT_W, L.y - 2)
    L.y += 7
  }
  L.repeatOnBreak(null)

  L.gap(4)
  L.subHeading('What this log adds up to')
  L.pairs([
    ['Entries on record', String(list.length)],
    ['Still open (not clocked out)', String(openCount)],
    ['Entered after the fact', String(retroCount)],
    periodStart && periodEnd
      ? ['Completed shifts in this pay period', `${inCount}, totalling ${formatHours(inHours)}`]
      : null,
    periodStart && periodEnd
      ? ['Completed hours outside this period', formatHours(outHours)]
      : null,
  ].filter(Boolean))
  if (periodStart && periodEnd) {
    L.gap(2)
    L.paragraph(
      `The ${formatHours(inHours)} inside the pay period is the total the week-by-week figures in ` +
        'section 3 are built from. Hours outside the period are on record but are not part of the ' +
        'amount claimed in section 2.',
      { size: 8.5, color: DIM },
    )
  }
}

/* ---- section 5 ------------------------------------------------------ */

function chainVerification(doc, L, { verification }) {
  L.sectionHeading(5, 'Record check')

  if (!verification) {
    L.paragraph(
      'The chain check was not available when this packet was generated. That does not mean the ' +
        'record failed the check — only that it was not run. It can be re-run in PayTrack at any ' +
        'time.',
      { style: 'bold' },
    )
    return
  }

  const valid = verification.valid === true
  L.paragraph(
    valid
      ? 'The record checks out. Every entry links to the one before it, unbroken.'
      : 'This record does NOT check out. One entry no longer matches the entry before it, and everything after that point is in question.',
    { size: 11, style: 'bold', after: 4 },
  )

  L.pairs([
    ['Status', valid ? 'unbroken' : 'broken'],
    ['Entries checked', String(verification.entryCount ?? 0)],
    ['Latest fingerprint', verification.latestHash || 'none recorded'],
    valid ? null : ['First break at', `entry ${verification.brokenAt ?? 'unknown'}`],
    valid ? null : ['Reason', verification.reason || 'not reported'],
  ].filter(Boolean))

  L.gap(4)
  L.paragraph(
    'Each entry carries a fingerprint (a SHA-256 hash) of the entry before it. Changing any past ' +
      'entry changes its fingerprint, which breaks every link after it. That makes tampering ' +
      'evident.',
    { after: 4 },
  )
  L.paragraph(
    'It does not make tampering impossible, and this packet does not claim that it does. This is a ' +
      'record held by a third party that shows when it has been disturbed, not a vault. The ' +
      "database refuses UPDATE and DELETE on the log at the storage layer, so the application's own " +
      'credentials cannot rewrite history — which is a meaningful control, and a different claim ' +
      'from physical immutability.',
  )
}

/* ---- section 6 ------------------------------------------------------ */

/**
 * Break premiums — under a heading that says, in the heading, that they are not
 * in the amount claimed.
 *
 * PayTrack sees a clock-in and a clock-out. It cannot see whether a break was
 * taken, so an unbroken nine-hour entry is equally consistent with a missed
 * meal period and with a worker who took one and did not log it. There is
 * deliberately no total here: a column of these amounts summed would look like
 * money owed, and a worker who walks into a labor commissioner's office with an
 * inflated number has a worse case than one who walks in with a conservative
 * one.
 */
function potentialPremiums(doc, L, { analysis }) {
  L.sectionHeading(6, 'Possible break premiums — NOT included in the amount claimed')

  const premiums = Array.isArray(analysis?.potentialPremiums) ? analysis.potentialPremiums : []

  L.paragraph(
    'These are flags to check, not money claimed. They are excluded from every figure in ' +
      'sections 2 and 3, and they are deliberately not totalled here.',
    { style: 'bold', after: 4 },
  )
  L.paragraph(
    'California requires a 30-minute unpaid meal period for work over 5 hours, a second for work ' +
      'over 10 hours, and a paid 10-minute rest period per 4 hours worked or major fraction ' +
      'thereof; a violation owes one additional hour of pay at the regular rate, capped at one ' +
      'meal premium and one rest premium per workday (Cal. Lab. Code § 226.7). PayTrack records ' +
      'only clock-in and clock-out. It has no way to know whether a break was taken, so each item ' +
      'below is a shift long enough that a break was owed — not a finding that one was missed.',
    { after: 4 },
  )

  if (premiums.length === 0) {
    L.paragraph(
      'Nothing was flagged in this pay period. That does not prove breaks were given. It means ' +
        'nothing in the recorded hours pointed at a problem.',
      { style: 'bold' },
    )
    return
  }

  const cx = { day: MARGIN, type: MARGIN + 96, amount: MARGIN + 250 }
  const header = () => {
    L.cell('Workday', cx.day, { size: 8, style: 'bold', color: DIM })
    L.cell('Flag', cx.type, { size: 8, style: 'bold', color: DIM })
    L.cell('If it applies', cx.amount, {
      size: 8,
      style: 'bold',
      color: DIM,
      align: 'right',
      width: 90,
    })
    L.y += 10
    L.hairline(BOX)
    L.gap(4)
  }

  L.gap(4)
  L.reserve(16 + 24)
  header()
  L.repeatOnBreak(header)

  for (const premium of premiums) {
    L.reserve(22)
    const kind =
      premium?.type === 'meal'
        ? 'Possible missed meal break'
        : premium?.type === 'rest'
          ? 'Possible missed rest break'
          : 'Possible missed break'
    L.cell(premium?.workday ? calendarDate(premium.workday) : '—', cx.day, { size: 8.5 })
    L.cell(kind, cx.type, { size: 8.5 })
    L.cell(formatMoney(Number(premium?.amount)), cx.amount, {
      size: 8.5,
      align: 'right',
      width: 90,
    })
    L.y += 11
    if (premium?.explanation) {
      L.paragraph(premium.explanation, { size: 8, color: DIM, indent: 8 })
    }
    if (premium?.statute) {
      L.paragraph(premium.statute, { size: 7.6, color: DIM, indent: 8 })
    }
    L.gap(4)
  }
  L.repeatOnBreak(null)

  L.gap(2)
  L.paragraph(
    'No total is given for this table on purpose. Each amount is what one premium would be worth ' +
      'if a violation is established for that workday, which is a question this record cannot ' +
      'answer.',
    { size: 8.5, color: DIM },
  )
}

/* ---- section 7 ------------------------------------------------------ */

function limitations(doc, L, { analysis }) {
  L.sectionHeading(7, 'Scope, exclusions and limitations')

  const exclusions =
    Array.isArray(analysis?.scopeExclusions) && analysis.scopeExclusions.length > 0
      ? analysis.scopeExclusions
      : ['tips', 'commissions', 'nondiscretionary bonuses']
  const rate = Number(analysis?.hourlyRate)

  L.subHeading('Pay excluded from every figure in this packet')
  L.bullets(exclusions)
  L.gap(2)
  L.paragraph(
    `Every figure here treats the regular rate as exactly the stated hourly rate` +
      `${Number.isFinite(rate) ? ` of ${formatMoney(rate)}` : ''}. Under 29 C.F.R. part 778 the regular ` +
      'rate must also include nondiscretionary bonuses, shift differentials and certain other ' +
      'compensation. If any of the above apply to this worker, the real regular rate is HIGHER and ' +
      'every amount in this packet is too LOW, not too high. That is the direction that protects ' +
      'the worker, and it is a deliberate scope cut rather than an oversight.',
    { after: 4 },
  )

  L.subHeading('What this record cannot show')
  L.bullets([
    'Breaks. PayTrack records clock-in and clock-out and nothing between them. It cannot ' +
      'establish that a meal or rest period was missed — see section 6.',
    'Location, as proof. Where GPS is attached it is corroboration, not proof: it can be ' +
      'spoofed, and it draws its weight from being consistent across many entries rather than ' +
      'from any single reading. Entries with no location are not thereby doubtful.',
    "The employer's own records. This is one side of the account. The employer holds the " +
      'payroll records the law requires it to keep, and those may show more, or different, hours.',
    'Whether an entry is accurate. The server can prove when it received a claim and that the ' +
      'claim has not been altered since. It cannot prove the claim was true when it was made.',
  ])

  L.subHeading('Scope of the rules applied')
  L.bullets([
    'Hourly, non-exempt work for a single employer. Exempt classifications, multiple employers ' +
      'and piece-rate work are out of scope.',
    "Federal FLSA and California only. No other state's daily-overtime or premium rules are " +
      'applied.',
    'Weekly or biweekly pay periods aligned to workweek boundaries. Semi-monthly periods are out ' +
      'of scope.',
    'The workweek is treated as starting Sunday at 00:00. An employer may lawfully designate a ' +
      'different start, which would move hours between weeks and could change the figures.',
  ])

  const flags = Array.isArray(analysis?.complianceFlags) ? analysis.complianceFlags : []
  L.subHeading('Wage statement elements (Cal. Lab. Code § 226(a))')
  L.paragraph(
    'California requires nine elements on every itemized wage statement. A missing element is an ' +
      'independent violation, separate from any unpaid wages.',
    { size: 9, after: 3 },
  )
  if (flags.length === 0) {
    L.paragraph(
      'Nothing is flagged. Either every element was recorded as present, or the worker did not go ' +
        'through the checklist for this paystub. Those two are not the same, and this packet does ' +
        'not distinguish them.',
      { size: 9, color: DIM },
    )
  } else {
    for (const flag of flags) {
      L.reserve(20)
      L.paragraph(flag?.label || flag?.element || 'unnamed element', { size: 9, indent: 12 })
      if (flag?.statute) L.paragraph(flag.statute, { size: 8, color: DIM, indent: 12 })
      L.gap(2)
    }
    L.gap(2)
    L.paragraph(
      'IMPORTANT: these flags describe the form the worker filled in, not the statement the ' +
        'employer issued. If an element actually was printed on the original, it is not a ' +
        'violation and this list is wrong about it.',
      { size: 8.5, style: 'bold' },
    )
  }

  L.gap(8)
  L.rule(BOX)
  L.gap(6)
  L.paragraph(
    'PayTrack is a prototype. This document is not legal advice and is not a substitute for a ' +
      'lawyer or a state labor agency.',
    { size: 9, style: 'bold' },
  )
}

/* ---- running header and footer -------------------------------------- */

/**
 * Stamped after all content, when the page count is finally known — so "Page 3
 * of 7" is honest on every page, including the ones the shift table pushed
 * into existence.
 */
function stampPages(doc, { workerId, generatedAt }) {
  const total = doc.getNumberOfPages()
  const stamp = localStamp(generatedAt.toISOString())
  const who = workerId ? `worker ${workerId}` : 'worker id not supplied'

  for (let i = 1; i <= total; i += 1) {
    doc.setPage(i)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(DIM)

    if (i > 1) {
      doc.setFontSize(7.5)
      doc.text(pdfText(`PayTrack evidence packet - ${who}`), MARGIN, MARGIN - 16)
      doc.setDrawColor(RULE)
      doc.setLineWidth(0.3)
      doc.line(MARGIN, MARGIN - 11, MARGIN + CONTENT_W, MARGIN - 11)
    }

    doc.setDrawColor(RULE)
    doc.setLineWidth(0.3)
    doc.line(MARGIN, PAGE_H - MARGIN - 14, MARGIN + CONTENT_W, PAGE_H - MARGIN - 14)
    doc.setFontSize(7.5)
    doc.text(pdfText(`Generated ${stamp} - ${who}`), MARGIN, PAGE_H - MARGIN - 4)
    doc.text(pdfText(`Page ${i} of ${total}`), MARGIN + CONTENT_W, PAGE_H - MARGIN - 4, {
      align: 'right',
    })
  }
}

/* ---- the entry point ------------------------------------------------ */

/**
 * Builds the packet.
 *
 * @param {object}  input
 * @param {object}  input.analysis      `GET /api/analysis` response. Required.
 * @param {Array}   [input.shifts]      `GET /api/shifts` -> `shifts`.
 * @param {object}  [input.paystub]     the paystub row being compared against.
 * @param {object}  [input.verification] `GET /api/shifts/verify` response.
 * @param {string}  [input.workerId]    the id the record is held under.
 * @returns {Blob} an `application/pdf` blob.
 */
export function buildEvidencePacket({
  analysis,
  shifts = [],
  paystub = null,
  verification = null,
  workerId = null,
} = {}) {
  if (!analysis || typeof analysis !== 'object') {
    throw new Error(
      'An evidence packet needs the analysis for one paystub. Pick a paystub and let the ' +
        'comparison finish, then try again.',
    )
  }

  const generatedAt = new Date()
  const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true })

  doc.setProperties({
    title: 'PayTrack evidence packet',
    subject: "A worker's own record of hours worked, and what it is worth",
    creator: 'PayTrack',
    author: workerId ? `PayTrack worker ${workerId}` : 'PayTrack',
  })

  const L = sheet(doc)
  const ctx = { analysis, shifts, paystub, verification, workerId, generatedAt }

  titleBlock(doc, L, ctx)
  whatThisIs(doc, L, ctx)
  headline(doc, L, ctx)
  workweeks(doc, L, ctx)
  shiftLog(doc, L, ctx)
  chainVerification(doc, L, ctx)
  potentialPremiums(doc, L, ctx)
  limitations(doc, L, ctx)

  stampPages(doc, ctx)

  return doc.output('blob')
}

/** `paytrack-evidence-2026-07-05-to-2026-07-18.pdf` — a name a lawyer can file. */
export function evidencePacketFilename({ analysis, paystub } = {}) {
  const start = calendarKey(analysis?.periodStart ?? paystub?.periodStart)
  const end = calendarKey(analysis?.periodEnd ?? paystub?.periodEnd)
  if (start && end) return `paytrack-evidence-${start}-to-${end}.pdf`
  const now = new Date()
  return `paytrack-evidence-${localDate(now.toISOString())}.pdf`
}

export default buildEvidencePacket
