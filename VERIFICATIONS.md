# VERIFICATIONS

Every **VERIFY** item from SPEC.md, checked 2026-08-12 via a parallel research pass against
primary sources. Values live in `data-defaults/assumptions/` (copied to
`~/finance-planner-data/assumptions/` on first run). Nothing below was silently guessed;
items that could not be fully confirmed are marked ⚠️.

## Federal TY2026 (post-OBBBA) — `tax/federal-2026.json`

| Item | Value | Source |
|---|---|---|
| MFJ brackets | 10% ≤ $24,800 · 12% ≤ $100,800 · 22% ≤ $211,400 · 24% ≤ $403,550 · 32% ≤ $512,450 · 35% ≤ $768,700 · 37% above | [IRS newsroom (Rev. Proc. 2025-32)](https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2026-including-amendments-from-the-one-big-beautiful-bill); [Tax Foundation](https://taxfoundation.org/data/all/federal/2026-tax-brackets/) |
| Standard deduction MFJ | $32,200 | same |
| Additional std deduction 65+ | $1,650 per married spouse | [Kiplinger citing Rev. Proc. 2025-32 §3.18](https://www.kiplinger.com/taxes/extra-standard-deduction-age-65-and-older) |
| LTCG breakpoints MFJ | 0% ≤ $98,900 · 15% ≤ $613,700 · 20% above | [ustax.tools](https://ustax.tools/capital-gains-tax-rates-2026/) + 2 corroborating; Rev. Proc. 2025-32 |
| NIIT | 3.8% over $250,000 MAGI MFJ, statutory/unindexed | [irs.gov/individuals/net-investment-income-tax](https://www.irs.gov/individuals/net-investment-income-tax) |
| SS taxation thresholds MFJ | $32,000 / $44,000, statutory/unindexed | IRC §86 (statutory) |
| SALT cap | $40,400 (2026); 40,000/40,400/40,804/41,212/41,624 for 2025–29; $10,000 from 2030. Phase-down: cap − 30%×(MAGI − $505k), floor $10k | [The Tax Adviser](https://www.thetaxadviser.com/issues/2026/mar/cap-raised-strings-attached-the-2025-salt-shake-up/) |
| §121 exclusion | $500,000 MFJ (statutory) | IRC §121 |
| OBBBA senior deduction | $6,000/person 65+, **2025–2028 only** → NOT modeled at all: the provision expires after 2028, so it can only ever reach a profile whose people are already 65 within that window | [IRS OBBBA page](https://www.irs.gov/newsroom/one-big-beautiful-bill-act-tax-deductions-for-working-americans-and-seniors) |
| 401(k) limits 2026 (informational) | $24,500 deferral; $8,000 catch-up 50+; $11,250 ages 60–63 | [IRS Notice 2025-67](https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500) |
| OBBBA charitable (`charitable`) | Non-itemizer $2,000 MFJ (statutory, unindexed, reduces **taxable income** only); itemizer 0.5%-of-AGI floor; 60%-of-AGI cash ceiling — all permanent, TY2026+ | see **[Charitable](#charitable-obbba-ty2026--taxfederal-2026json--charitable)** section below |

## Charitable (OBBBA, TY2026+) — `tax/federal-2026.json` → `charitable`

Verified **2026-08-12**. All three provisions are **permanent** (no sunset) and first apply to
tax years beginning after 2025.

| Item | Value | Source |
|---|---|---|
| Non-itemizer deduction, MFJ | **$2,000** ($1,000 single), **cash gifts only**, beginning TY2026 | [IRS Topic no. 506](https://www.irs.gov/taxtopics/tc506) — "Beginning with tax year 2026, if you do not itemize, you may deduct up to $1,000 ($2,000 if filing jointly) of your cash contributions to certain qualified organizations."; [Tax Foundation](https://taxfoundation.org/blog/charitable-deduction-big-beautiful-bill/) (permanent) |
| …reduces **taxable income**, not AGI | IRC **§63(b)(4)** lists "the deduction provided in section 170(p)" among the subtractions from AGI that produce taxable income for non-itemizers. IRC **§62(a)** has **no** §170(p) paragraph (the 2020-only §62(a)(22) above-the-line version was repealed effective 2021-01-01). §63(d)(2) further excludes anything in §63(b) from "itemized deductions". | [26 U.S.C. §63 (Cornell LII)](https://www.law.cornell.edu/uscode/text/26/63); [26 U.S.C. §62 (Cornell LII)](https://www.law.cornell.edu/uscode/text/26/62) |
| …inflation indexing | **None** — the $1,000/$2,000 amounts are statutory and fixed | [Fidelity Charitable](https://www.fidelitycharitable.org/articles/obbb-tax-reform.html) — "This provision is not indexed for future inflation" |
| …excluded donees | Donor-advised funds, supporting organizations, private non-operating foundations | [Fidelity Charitable](https://www.fidelitycharitable.org/articles/obbb-tax-reform.html) |
| Itemizer floor | **0.5% of AGI** (contribution base). IRC **§170(b)(1)(I)**: "Any charitable contribution otherwise allowable … shall be allowed only to the extent that the aggregate of such contributions exceeds 0.5 percent of the taxpayer's contribution base for the taxable year." | [26 U.S.C. §170 (Cornell LII)](https://www.law.cornell.edu/uscode/text/26/170); [Tax Foundation](https://taxfoundation.org/blog/charitable-deduction-big-beautiful-bill/) |
| Cash-gift ceiling | **60% of AGI**, made **permanent** by OBBBA. IRC **§170(b)(1)(G)(i)** now reads "For taxable years beginning after December 31, 2017 …" with the pre-2026 sunset struck. | [26 U.S.C. §170 (Cornell LII)](https://www.law.cornell.edu/uscode/text/26/170); [Fidelity Charitable](https://www.fidelitycharitable.org/articles/obbb-tax-reform.html) — "permanently extended the ability to deduct up to 60% of AGI for cash contributions to 501(c)(3) public charities" |
| Order of operations | **Ceiling first, floor second** | [The Tax Adviser, "Planning for new charitable contribution limits"](https://www.thetaxadviser.com/issues/2026/jul/planning-for-new-charitable-contribution-limits/) — "the donation is first limited to $60,000 by the 60% AGI limitation … Next, the 0.5% floor reduces the deductible amount of the contribution from $60,000 to $59,500." |

**As modeled** (`src/tax/federal.ts`):

- Itemizer component `= max(0, min(gifts, 0.60 × AGI) − 0.005 × AGI)`, added to mortgage
  interest + capped SALT. The gifts stream can therefore flip a filer from standard to
  itemized.
- Non-itemizer `= min(gifts, $2,000)`, subtracted **after** the standard deduction when the
  standard deduction is used: `taxableIncome = max(0, AGI − deduction − nonItemizer)`.
  **AGI, ACA MAGI, IRMAA MAGI and NIIT MAGI are untouched** — giving cannot be used to duck
  the 400%-FPL ACA cliff or an IRMAA tier. Asserted in `tests/tax/federal.test.ts`.

**Charitable giving does NOT flow into VA / SC / NC state tax in this model**, and that is
correct for all three: **VA** starts from federal AGI and substitutes its own standard
deduction (§58.1-322.03) — it never picks up a federal itemized charitable amount or the
§170(p) subtraction; **SC** (TY2026, H.4216) also starts from **federal AGI** and applies the
SCIAD in place of the federal standard deduction; **NC** starts from federal AGI with its own
$25,500 MFJ standard deduction. `computeYear` reinforces this structurally: the state module
is fed by a *preliminary* standard-deduction federal pass that carries no charitable amount.
Asserted for all three states in `tests/tax/computeYear.test.ts`.

**Documented simplifications:** (a) contributions disallowed by the 60% ceiling or the 0.5%
floor **carry forward** in real law (up to 5 years); carryforwards are not modeled. (b) The
deduction election is `max(standard, itemized)`; a filer whose itemized total exceeds the
standard deduction by less than the §170(p) amount would in reality elect the standard
deduction plus §170(p), and is modeled as itemizing. Both cost at most a few hundred dollars
in a narrow window. (c) Only **cash** giving is modeled — no appreciated-securities gifts,
QCDs, or DAFs (each has different limits).

## RMD — `rmd-table.json`

Uniform Lifetime Table (Treas. Reg. §1.401(a)(9)-9, effective 2022): age 75 → 24.6, etc.
SECURE 2.0: born 1960+ → RMDs start at **75** (a 1975 birth reaches that in 2050). Encoded from
statute/regulation; table values cross-checked against IRS Pub. 590-B.

**Single Life Expectancy Table** (`singleLifeTable`, ages 50–70) added 2026-08-12: IRS
**Pub. 590-B Appendix B Table I**, post-2022 values (Treas. Reg. §1.401(a)(9)-9(b), the 2020
final regulations effective for 2022 and later). Used only for the **72(t)/SEPP
fixed-amortization** payment calculation, not for RMDs. Spot values: 50 → 36.2, 55 → 31.6,
60 → 27.1, 65 → 22.9, 70 → 18.8.

## Social Security factors — `social-security.json`

Statutory formulas (ssa.gov): FRA 67 (born 1960+). Worker: −5/9%/mo first 36 months early,
−5/12%/mo beyond (70% at 62); +2/3%/mo delayed (124% at 70). Spousal: 50% of PIA at FRA,
−25/36%/mo first 36, −5/12%/mo beyond (32.5% at 62), no delayed credits, deemed filing.

## Medicare 2026 — `medicare-2026.json`

| Item | Value | Source |
|---|---|---|
| Part B standard | $202.90/mo (deductible $283 — not modeled) | [RRB news release mirroring CMS](https://www.rrb.gov/Newsroom/NewsReleases/MedicarePartBPremium); [CMS fact sheet](https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles) |
| IRMAA MFJ tiers (2024 MAGI) | >$218k: $284.10 · >$274k: $405.80 · >$342k: $527.50 · >$410k: $649.20 · >$750k: $689.90 (Part B total/mo); Part D add-ons $14.50/$37.50/$60.40/$83.30/$91.00 | same + [Kiplinger](https://www.kiplinger.com/retirement/medicare/medicare-premiums-2026-irmaa-brackets-and-surcharges-for-parts-b-and-d) |
| Part D base beneficiary premium | $38.99 | [CMS CY2026 Part C&D announcement PDF](https://www.cms.gov/files/document/july-28-2025-parts-c-d-announcement.pdf) |

Future tiers/premiums modeled as CPI-indexed (premiums additionally get the
`medicalInflationRealSpread` from `market.json`) per SPEC §5/§7.

## ACA 2026 — `aca-2026.json`

| Item | Value | Source |
|---|---|---|
| Enhanced credits | **Expired 2025-12-31; NOT extended as of 2026-08-12** (House passed extension Jan 2026; Senate did not) → cliff is back; `enhancedCreditsExtended` toggle ships `false` | [ASTHO](https://www.astho.org/communications/blog/2026/aca-enhanced-premium-tax-credits-legislative-developments-2025-2026/), Ballotpedia, Health Affairs |
| FPL, 2-person, 48 states | $21,150 (2025 HHS guideline, used for 2026 coverage) → 400% cliff = **$84,600** (matches SPEC) | [ASPE 2025 guidelines](https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines/prior-hhs-poverty-guidelines-federal-register-references/2025-poverty-guidelines-computations) |
| Applicable % table 2026 | 2.10% ≤133% FPL; 3.14→4.19% (133–150); 4.19→6.60% (150–200); 6.60→8.44% (200–250); 8.44→9.96% (250–300); 9.96% (300–400); none >400% | [Rev. Proc. 2025-25 PDF §3.01](https://www.irs.gov/pub/irs-drop/rp-25-25.pdf) (extracted verbatim) |
| Enhanced table (if extended) | 0% ≤150%; →2% at 200; →4% at 250; →6% at 300; →8.5% at 400+; no cliff | [2025 Form 8962 instructions](https://www.irs.gov/pub/irs-prior/i8962--2025.pdf) |
| Age curve | Federal default (VA uses it): 55→2.230 … 64→3.000 | [CMS age-curve guidance Appendix I](https://www.cms.gov/CCIIO/Resources/Regulations-and-Guidance/Downloads/Final-Guidance-Regarding-Age-Curves-and-State-Reporting-12-16-16.pdf) |
| Medicaid expansion | VA expanded 2019, NC expanded Dec 2023, SC never expanded → modeled as $0-premium Medicaid below 138% FPL in VA/NC; full-premium coverage gap below 100% FPL in SC | kff.org expansion tracker (widely documented state policy) |
| ⚠️ Benchmark premium | The shipped starter carries **$1,480/mo** household — an ILLUSTRATIVE second-lowest-cost Silver premium for two people in their early fifties, not a quote for any real place. For scale: KFF's statewide average for a 40-year-old runs ~$455/mo in a low-cost state, which the CMS age curve puts near ~$1,015/person in the mid-fifties. **Replace it with a real healthcare.gov (or state marketplace) quote for your own ages and ZIP** — it is a Profile input, and it drives both the premium tax credit and the 400%-FPL cliff. | [KFF benchmark data](https://www.kff.org/affordable-care-act/state-indicator/marketplace-average-benchmark-premiums/) |

## States — `tax/va-2026.json`, `tax/sc-2026.json`, `tax/nc-2026.json`

**Virginia** ([tax.virginia.gov](https://www.tax.virginia.gov/news/new-virginia-tax-laws), [§58.1-322.03](https://law.lis.virginia.gov/vacode/title58.1/chapter3/section58.1-322.03/)):
brackets 2%/$3k · 3%/$5k · 5%/$17k · 5.75% above (unindexed); standard deduction MFJ follows
the **enacted schedule** (2026 Appropriation Act, confirmed via tax.virginia.gov legislative
summary 26-82 during the adversarial audit): **$17,500 (2025–26) · $18,400 (2027) ·
$18,600 (2028–29) · statutory reversion to $6,000 from 2030** — encoded as a per-year
schedule with a $6,000 current-law fallback; VA has repeatedly extended the elevated
amount, so the fallback is a user-editable assumption. Age deduction $12,000/person 65+
reduced $1-for-$1 by combined AFAGI over $75,000 MFJ (AFAGI = federal AGI −
federally-taxed SS); personal exemptions $930 + $800 (65+); SS not taxed.

**South Carolina** — ⚠️ **restructured for TY2026** by H.4216 / Act 110, signed 2026-03-30
([SCDOR](https://dor.sc.gov/news/information-about-h-4216), [bill text](https://www.scstatehouse.gov/sess126_2025-2026/bills/4216.htm)):
two brackets — **1.99% ≤ $30,000, 5.21% above** (statutory form 5.21%×TI−$966, equivalent);
starting point now **federal AGI**; new **SCIAD** $30,000 MFJ replacing the federal standard
deduction, phased out proportionally over FAGI $80,000→$190,000; retirement-income deduction
($3,000 <65 / $10,000 65+) and 65+ $15,000 deduction (reduced by retirement deduction
claimed) retained; SS not taxed. 2027+ revenue-trigger rate cuts not assumed.

**North Carolina** ([ncdor.gov](https://www.ncdor.gov/taxes-forms/individual-income-tax/tax-rate-schedules)):
flat **3.99% for 2026** (4.25% 2025); standard deduction **$25,500 MFJ** (TY2025 amount,
unindexed, no 2026 change enacted as of Aug 2026); SS deducted; 2027 trigger cut to 3.49%
expected but not final — not assumed.

## Historical returns — `historical-returns.csv`

Source: [Damodaran histretSP.xls](https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xls)
(workbook, full precision; HTML page cross-checked), retrieved 2026-08-12. 98 rows,
**1928–2025**: S&P 500 total return, 10-yr Treasury total return, 3-mo T-bill, CPI
(Damodaran's own inflation sheet = FRED CPIAUCNS annual change). Sanity checks passed:
1931 stocks −43.84%, 2008 −36.55%, 1982 bonds +32.81%; geometric real returns: stocks
**6.78%**, bonds 1.45%, bills 0.33%; CPI geometric mean 3.04%. Known vintage quirk: 2025
stocks 17.72% (workbook) vs 17.78% (HTML) — workbook used.
