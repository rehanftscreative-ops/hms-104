import { BillItem, InsuranceApproval, InsurancePolicy } from '../types';

export const parseInsuranceDeductible = (value?: string): number => {
  if (!value || /%/.test(value)) return 0;
  const match = value.replace(/,/g, '').match(/(?:AED|USD|[$])?\s*(\d+(?:\.\d{1,2})?)/i);
  return match ? Math.max(0, Number(match[1]) || 0) : 0;
};

export const isInsuranceApprovalApplicableToService = (
  approval: InsuranceApproval,
  service: {
    patientId: string;
    serviceCodes: Array<string | undefined>;
    amount: number;
    serviceRecordId?: string;
    encounterTokenId?: string;
  }
): boolean => {
  const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[.\s-]/g, '');
  const approvalCode = approval.serviceCode?.trim();
  const serviceCodes = service.serviceCodes.filter((code): code is string => Boolean(code?.trim()));
  const amount = Math.max(0, Number(service.amount) || 0);

  if (
    approval.patientId !== service.patientId ||
    !approvalCode ||
    !Number.isFinite(approval.estimatedCost) ||
    !serviceCodes.some((code) => normalizeCode(code) === normalizeCode(approvalCode)) ||
    Math.abs(Math.round(amount * 100) - Math.round(Number(approval.estimatedCost) * 100)) > 1 ||
    (approval.serviceRecordId && approval.serviceRecordId !== service.serviceRecordId) ||
    (approval.encounterTokenId && approval.encounterTokenId !== service.encounterTokenId) ||
    (approval.validUntil && approval.validUntil < new Date().toISOString().slice(0, 10))
  ) {
    return false;
  }

  return true;
};

export const findApplicableInsuranceApproval = (
  item: BillItem,
  approvals: InsuranceApproval[],
  patientId: string,
  encounterTokenId?: string
): InsuranceApproval | undefined => {
  const amount = Math.max(0, (Number(item.unitCost) || 0) * Math.max(1, Number(item.quantity) || 1));
  const matchingApprovals = approvals.filter((approval) => isInsuranceApprovalApplicableToService(approval, {
    patientId,
    serviceCodes: [item.serviceCode, item.cptCode],
    amount,
    serviceRecordId: item.sourceServiceId,
    encounterTokenId: item.sourceEncounterTokenId || encounterTokenId,
  }));
  const linkedMatches = matchingApprovals.filter((approval) => approval.serviceRecordId);
  const applicableMatches = linkedMatches.length ? linkedMatches : matchingApprovals;

  return applicableMatches.length === 1 ? applicableMatches[0] : undefined;
};

export const getInsuranceCopayPercentage = (
  category: BillItem['category'],
  serviceCopay: InsurancePolicy['serviceCopay'],
  fallbackCopayPercentage: number,
  description = ''
): number => {
  const categoryCopay = /emergency/i.test(description)
    ? serviceCopay?.emergency
    : category === 'Consultation'
    ? serviceCopay?.consultation
    : category === 'Lab Test'
    ? serviceCopay?.lab ?? serviceCopay?.laboratory
    : category === 'Radiology'
    ? serviceCopay?.radiology
    : category === 'Pharmacy'
    ? serviceCopay?.pharmacy
    : category === 'Surgical Procedure' || category === 'Technician Service'
    ? serviceCopay?.surgicalProcedure ?? serviceCopay?.procedures ?? serviceCopay?.procedure
    : undefined;

  return Math.min(100, Math.max(0, Number(categoryCopay ?? fallbackCopayPercentage) || 0));
};

export const applyInsuranceBreakdown = (
  items: BillItem[],
  serviceCopay: InsurancePolicy['serviceCopay'],
  fallbackCopayPercentage: number,
  deductibleAmount = 0
): BillItem[] => {
  let deductibleRemaining = Math.max(0, Number(deductibleAmount) || 0);

  return items.map((item) => {
    const gross = Math.max(0, (Number(item.unitCost) || 0) * Math.max(1, Number(item.quantity) || 1));
    const discount = Math.min(gross, Math.max(0, Number(item.discountAmount) || 0));
    const net = Math.max(0, gross - discount);
    const deductible = Math.min(net, deductibleRemaining);
    deductibleRemaining -= deductible;
    const copayPercentage = getInsuranceCopayPercentage(item.category, serviceCopay, fallbackCopayPercentage, item.description);
    const afterDeductible = Math.max(0, net - deductible);
    const copay = Math.round(afterDeductible * copayPercentage) / 100;

    return {
      ...item,
      amount: gross,
      totalPrice: gross,
      discountAmount: discount,
      netAmount: net,
      deductibleAmount: deductible,
      copayPercentage,
      copayAmount: copay,
      insuranceAmount: Math.max(0, afterDeductible - copay),
    };
  });
};

export const applyApprovedInsuranceBreakdown = (
  items: BillItem[],
  approvals: InsuranceApproval[],
  deductibleAmount = 0,
  serviceCopay?: InsurancePolicy['serviceCopay'],
  fallbackCopayPercentage = 0
): BillItem[] => {
  let deductibleRemaining = Math.max(0, Number(deductibleAmount) || 0);
  const remainingApprovedAmounts = new Map(approvals.map((approval) => [approval.id, Math.max(0, Number(approval.approvedAmount) || 0)]));
  const remainingCopayAmounts = new Map(approvals.map((approval) => [approval.id, Math.max(0, Number(approval.copayAmount) || 0)]));

  return items.map((item) => {
    const gross = Math.max(0, (Number(item.unitCost) || 0) * Math.max(1, Number(item.quantity) || 1));
    const approval = approvals.find((record) => record.id === item.insuranceApprovalId);
    const canApplyApproval = approval?.approvalStatus === 'Approved' && isInsuranceApprovalApplicableToService(approval, {
      patientId: approval.patientId,
      serviceCodes: [item.serviceCode, item.cptCode],
      amount: gross,
      serviceRecordId: item.sourceServiceId,
      encounterTokenId: item.sourceEncounterTokenId || approval.encounterTokenId,
    });
    const deductible = canApplyApproval ? Math.min(gross, deductibleRemaining) : 0;
    deductibleRemaining -= deductible;
    const afterDeductible = Math.max(0, gross - deductible);
    const copayPercentage = getInsuranceCopayPercentage(item.category, serviceCopay, fallbackCopayPercentage, item.description);
    const registeredCopay = Math.round(afterDeductible * copayPercentage) / 100;
    const remainingApproved = canApplyApproval ? remainingApprovedAmounts.get(approval.id) || 0 : 0;
    const approvedTotal = canApplyApproval
      ? Math.min(afterDeductible, remainingApproved)
      : 0;
    if (canApplyApproval) remainingApprovedAmounts.set(approval.id, remainingApproved - approvedTotal);
    const remainingCopay = canApplyApproval ? remainingCopayAmounts.get(approval.id) || 0 : 0;
    const approvedCopay = canApplyApproval
      ? Math.min(approvedTotal, remainingCopay)
      : 0;
    if (canApplyApproval) remainingCopayAmounts.set(approval.id, remainingCopay - approvedCopay);
    const copay = canApplyApproval
      ? Math.min(afterDeductible, Math.max(registeredCopay, approvedCopay))
      : 0;
    const approvedInsurance = canApplyApproval
      ? Math.min(approvedTotal - approvedCopay, Math.max(0, afterDeductible - registeredCopay))
      : 0;

    return {
      ...item,
      amount: gross,
      totalPrice: gross,
      discountAmount: 0,
      netAmount: gross,
      deductibleAmount: deductible,
      copayPercentage: canApplyApproval ? copayPercentage : undefined,
      copayAmount: copay,
      insuranceAmount: approvedInsurance,
    };
  });
};

export const applyDiscountBreakdown = (items: BillItem[], discountPercentage: number): BillItem[] => {
  const discountRate = Math.min(100, Math.max(0, Number(discountPercentage) || 0));
  return items.map((item) => {
    const gross = Math.max(0, (Number(item.unitCost) || 0) * Math.max(1, Number(item.quantity) || 1));
    const discount = Math.round(gross * discountRate) / 100;
    return {
      ...item,
      amount: gross,
      totalPrice: gross,
      discountAmount: discount,
      netAmount: gross - discount,
      insuranceAmount: 0,
      copayAmount: 0,
    };
  });
};

export const sumInvoiceItemField = (items: BillItem[], field: 'discountAmount' | 'netAmount' | 'deductibleAmount' | 'copayAmount' | 'insuranceAmount'): number =>
  items.reduce((sum, item) => sum + (Number(item[field]) || 0), 0);
