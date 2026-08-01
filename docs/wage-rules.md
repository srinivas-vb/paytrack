# Wage rules — the precise spec

**This file is the source of truth for the rule engine.** `server/src/rules/fixtures.js`
encodes every rule here as a hand-computed test case. If a rule is wrong, fix it
*here first*, then the fixture, then the code.

Scope: **hourly non-exempt workers, single employer, no tips, no commissions, no
nondiscretionary bonuses.** Those exclusions are stated in the UI, not just here —
they change the "regular rate" (29 C.F.R. § 778) and are out of scope.

---

## 1. The workweek is the unit of computation

A **workweek** is a fixed, recurring period of 168 hours — seven consecutive
24-hour periods. It does not have to align to a calendar week, and FLSA lets the
employer designate when it starts. PayTrack defaults to **Sunday 00:00 local**
and lets the worker change it.

**Overtime is computed per workweek and never averages across weeks.** This is
the single most important rule in this file, and the easiest to get wrong.

> A biweekly paystub covering 45h and 35h owes **5 hours of overtime**, not zero.
> Computing on the 80-hour pay-period total averages to 40/week and reports
> nothing owed. See fixture `federal-biweekly-45-35`.

A **workday** is a fixed, recurring 24-hour period. PayTrack uses local midnight.
A shift crossing midnight is split across two workdays for daily-OT purposes.

---

## 2. Federal — FLSA

29 U.S.C. § 207(a)(1). The floor; every state must at least match it.

```
hours in workweek > 40  →  1.5 × regular rate on the excess
```

There is **no daily overtime under federal law.** A 13-hour day followed by four
3-hour days is 25 hours — no overtime at all.

---

## 3. California — Labor Code § 510

Richer, and the demo jurisdiction because it produces three violation types
instead of one.

| Condition | Multiplier |
|---|---|
| > 8 hours in a workday | 1.5× |
| > 12 hours in a workday | 2.0× |
| > 40 **straight-time** hours in a workweek | 1.5× |
| 7th consecutive day worked in a workweek — first 8 hours | 1.5× |
| 7th consecutive day worked in a workweek — beyond 8 hours | 2.0× |

### The interaction rule (where implementations go wrong)

California does **not** pyramid overtime. An hour is paid at one premium rate,
never two stacked. Compute in this order:

1. **Per workday**, split hours into: straight time (first 8), 1.5× (hours 8–12),
   2.0× (beyond 12).
2. **Per workweek**, sum only the *straight-time* hours from step 1. Any amount
   over 40 converts from 1.0× to 1.5×.
3. Hours already promoted in step 1 are never re-counted in step 2.

> Five 9-hour days is 45 hours. Step 1 gives 5 hours at 1.5× and 40 straight-time
> hours. Step 2 finds 40 straight-time hours — not over 40 — so **no additional
> weekly overtime**. The naive implementation counts 5 daily OT *plus* 5 weekly OT
> and overstates by 5 hours. See fixture `ca-nine-hour-days`.

### 7th consecutive day

Applies when the worker works **all seven days** of a single workweek. The
seventh day's hours are promoted directly (1.5× for the first 8, 2.0× beyond),
and those hours do not also count toward the step-2 straight-time total.

---

## 4. Meal and rest premiums — Labor Code § 226.7

| Entitlement | Trigger |
|---|---|
| 30-min unpaid meal break | Work > 5 hours (waivable by mutual consent if ≤ 6 hours) |
| Second 30-min meal break | Work > 10 hours (waivable if ≤ 12 and the first was not waived) |
| 10-min paid rest break | Per 4 hours worked "or major fraction thereof" |

A violation owes **one additional hour of pay at the regular rate**, per workday,
capped at one meal premium and one rest premium per workday.

### What PayTrack can and cannot know

PayTrack sees clock-in and clock-out. **It does not know whether a break was
taken.** A single unbroken 9-hour entry is *consistent with* a missed meal break
and is also *consistent with* a worker who took a break and didn't log it.

So these are surfaced as **potential** premiums, flagged and explained, never
asserted as owed. They are excluded from the headline discrepancy figure and
reported separately.

Overclaiming here would be the fastest way to destroy the credibility of the
whole record. A worker who walks into a labor commissioner's office with an
inflated number has a worse case than one who walks in with a conservative one.

---

## 5. Wage statement compliance — Labor Code § 226(a)

Every itemized wage statement must show nine things:

1. Gross wages earned
2. Total hours worked
3. Piece-rate units and rate, if applicable
4. All deductions
5. Net wages earned
6. Inclusive dates of the pay period
7. Employee name and last four of SSN or an employee ID
8. Employer name and address
9. All applicable hourly rates and the hours worked at each rate

A missing element is an independent violation, separate from any unpaid wages.
PayTrack flags which are absent from what the worker supplied — and states
plainly that absence from the *photo or the form* is not proof of absence from
the *original statement*.

---

## 6. Regular rate

For this scope, **regular rate = hourly rate**.

In reality the regular rate must also include nondiscretionary bonuses, shift
differentials, and certain other compensation (29 C.F.R. § 778) — which is
exactly why those are excluded from scope. A worker paid a production bonus has
a higher regular rate than their stated hourly rate, and every overtime figure
computed from the stated rate would be too low.

State this. A judge who knows wage law will ask, and "we scoped it deliberately"
is a much better answer than not having noticed.

---

## 7. The discrepancy

```
owed  = Σ (hours at each multiplier × regular rate × multiplier), per workweek
paid  = what the paystub says
discrepancy = owed − paid
```

Computed per workweek and then summed — never on a pay-period total.

A **negative or zero** discrepancy means nothing is owed. That is a normal,
correct result and must be reported as plainly as a positive one. An app that
only ever finds violations is not evidence, it's an accusation generator.
