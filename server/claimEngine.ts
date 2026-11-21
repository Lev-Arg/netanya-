import type {
  ClaimStatus,
  InsurancePlan,
  NcpdpRejectionCode,
} from '../src/types.ts';

export interface AdjudicationInput {
  ucPriceCents: number;
  daysSupply: number;
  formularyTier: 1 | 2 | 3;
  dawCode: '0' | '1' | '2';
  deductibleRemainingCents: number;
  overrideCode: string;
  daysSinceLastFill?: number;
  priorFillDaysSupply?: number;
  plan: InsurancePlan;
}

export interface AdjudicationResult {
  allowedAmountCents: number;
  deductibleAppliedCents: number;
  insurerPaidCents: number;
  patientCopayCents: number;
  rejectionCode: NcpdpRejectionCode;
  rejectionMessage: string;
  claimStatus: ClaimStatus;
}

export const NCPDP_REJECTION_CATALOG: Record<
  Exclude<NcpdpRejectionCode, 'none'>,
  { title: string; requiredOverrideHint: string; description: string }
> = {
  '70': {
    title: 'Brand Not on Standard Scheme List',
    requiredOverrideHint: 'SCC-02',
    description:
      'This health scheme covers the generic option unless approved. Enter SCC-02 if the prescriber approved an exception, or switch to standard generic.',
  },
  '75': {
    title: 'Prior Approval Needed',
    requiredOverrideHint: 'PA-xxxx',
    description:
      'Tier 3 specialist medicines need an approval code (starting with PA-, e.g. PA-4821) from the doctor or health scheme.',
  },
  '79': {
    title: 'Too Early to Refill',
    requiredOverrideHint: '03 or 07',
    description:
      'Fewer than 75% of the days from the last pack have passed. Enter 03 (Travel) or 07 (Dose Change) to override.',
  },
  '88': {
    title: 'Supply Over 90 Days',
    requiredOverrideHint: 'M0-1B',
    description:
      'Packs over 90 days need a pharmacist check. Confirm with the doctor and enter M0-1B to continue.',
  },
};

export function adjudicateClaim(input: AdjudicationInput): AdjudicationResult {
  const override = input.overrideCode.trim().toUpperCase();
  let rejectionCode: NcpdpRejectionCode = 'none';
  let rejectionMessage = 'Claim approved against scheme rates.';

  // 1. Check Refill Too Soon rule (< 75% of prior daysSupply elapsed)
  if (
    typeof input.daysSinceLastFill === 'number' &&
    typeof input.priorFillDaysSupply === 'number' &&
    input.priorFillDaysSupply > 0 &&
    input.daysSinceLastFill < Math.floor(input.priorFillDaysSupply * 0.75)
  ) {
    if (override !== '03' && override !== '07') {
      rejectionCode = '79';
      rejectionMessage = `${NCPDP_REJECTION_CATALOG['79'].title}: Only ${input.daysSinceLastFill} of ${input.priorFillDaysSupply} days have passed since the last fill.`;
    }
  }

  // 2. Check Brand Requested on NHIS standard scheme without formulary exception
  if (
    rejectionCode === 'none' &&
    input.dawCode === '2' &&
    (input.plan.id === 'plan_bcbs' || input.plan.payerName.toUpperCase().includes('NHIS')) &&
    override !== 'SCC-02'
  ) {
    rejectionCode = '70';
    rejectionMessage = `${NCPDP_REJECTION_CATALOG['70'].title}: ${NCPDP_REJECTION_CATALOG['70'].description}`;
  }

  // 3. Check Tier 3 Specialist Prior Approval rule
  if (rejectionCode === 'none' && input.formularyTier === 3) {
    if (!override.startsWith('PA-') || override.length < 6) {
      rejectionCode = '75';
      rejectionMessage = `${NCPDP_REJECTION_CATALOG['75'].title}: ${NCPDP_REJECTION_CATALOG['75'].description}`;
    }
  }

  // 4. Check DUR rule for supply > 90 days
  if (rejectionCode === 'none' && input.daysSupply > 90 && override !== 'M0-1B') {
    rejectionCode = '88';
    rejectionMessage = `${NCPDP_REJECTION_CATALOG['88'].title}: ${NCPDP_REJECTION_CATALOG['88'].description}`;
  }

  // Allowed amount calculation based on payer contract rate + DAW modifier
  const dawModifier = input.dawCode === '1' ? 0.94 : 1.0;
  const allowedAmountCents = Math.max(
    500,
    Math.round(input.ucPriceCents * input.plan.reimbursementRate * dawModifier)
  );

  if (rejectionCode !== 'none') {
    return {
      allowedAmountCents,
      deductibleAppliedCents: 0,
      insurerPaidCents: 0,
      patientCopayCents: input.ucPriceCents,
      rejectionCode,
      rejectionMessage,
      claimStatus: 'rejected',
    };
  }

  // Tier copay lookup scaled gently for 90-day supply
  const supplyMultiplier = input.daysSupply >= 60 ? 2 : 1;
  const baseTierCopay =
    input.formularyTier === 1
      ? input.plan.tier1CopayCents
      : input.formularyTier === 2
        ? input.plan.tier2CopayCents
        : input.plan.tier3CopayCents;

  const tierCopay = baseTierCopay * supplyMultiplier;
  const dawPenaltyCents = input.dawCode === '2' ? 1500 : 0;

  const deductibleAppliedCents = Math.min(
    Math.max(0, input.deductibleRemainingCents),
    allowedAmountCents
  );
  const remainingAfterDeductible = Math.max(0, allowedAmountCents - deductibleAppliedCents);
  const standardCopay = Math.min(remainingAfterDeductible, tierCopay + dawPenaltyCents);

  const patientCopayCents = deductibleAppliedCents + standardCopay;
  const insurerPaidCents = Math.max(0, allowedAmountCents - patientCopayCents);

  return {
    allowedAmountCents,
    deductibleAppliedCents,
    insurerPaidCents,
    patientCopayCents,
    rejectionCode: 'none',
    rejectionMessage,
    claimStatus: 'adjudicated',
  };
}
