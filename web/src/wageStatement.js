/**
 * The nine elements every itemized wage statement must show under
 * Cal. Lab. Code § 226(a). Listed in docs/wage-rules.md §5.
 *
 * The `key` values are the wire vocabulary: they are exactly what
 * `POST /api/paystubs` accepts in `presentFields` and exactly what the analysis
 * endpoint names in `complianceFlags[].element`. Keep them in sync with
 * `REQUIRED_ELEMENTS` in server/src/routes/paystubs.js — that export is the
 * source of truth; this is its plain-language mirror for the UI.
 *
 * `label` is what the worker reads while holding the statement, so it is phrased
 * as the thing they are looking for, not as the statutory wording.
 */
export const REQUIRED_ELEMENTS = [
  {
    key: 'gross_wages',
    statute: 'Cal. Lab. Code § 226(a)(1)',
    label: 'Gross pay (before anything is taken out)',
  },
  {
    key: 'total_hours',
    statute: 'Cal. Lab. Code § 226(a)(2)',
    label: 'Total hours worked',
  },
  {
    key: 'piece_rate_units',
    statute: 'Cal. Lab. Code § 226(a)(3)',
    label: 'Piece-rate units and the rate — only if you are paid per piece',
  },
  {
    key: 'deductions',
    statute: 'Cal. Lab. Code § 226(a)(4)',
    label: 'Every deduction, listed out',
  },
  {
    key: 'net_wages',
    statute: 'Cal. Lab. Code § 226(a)(5)',
    label: 'Net pay (what you actually took home)',
  },
  {
    key: 'pay_period_dates',
    statute: 'Cal. Lab. Code § 226(a)(6)',
    label: 'The dates the pay period covers',
  },
  {
    key: 'employee_name_and_id',
    statute: 'Cal. Lab. Code § 226(a)(7)',
    label: 'Your name, and the last 4 of your SSN or an employee ID',
  },
  {
    key: 'employer_name_and_address',
    statute: 'Cal. Lab. Code § 226(a)(8)',
    label: "Your employer's name and address",
  },
  {
    key: 'hourly_rates',
    statute: 'Cal. Lab. Code § 226(a)(9)',
    label: 'Every hourly rate, and the hours worked at each one',
  },
]

const BY_KEY = new Map(REQUIRED_ELEMENTS.map((e) => [e.key, e]))

/**
 * Looks up an element the analysis endpoint named.
 *
 * Falls back to the raw key rather than dropping the flag: if the server ever
 * names an element this build has not heard of, showing it awkwardly is far
 * better than silently hiding a compliance finding.
 */
export function describeElement(key) {
  return BY_KEY.get(key) ?? { key, statute: null, label: key }
}
