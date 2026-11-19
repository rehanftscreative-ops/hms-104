import {
  ReceptionToken,
  TokenDoctorOrder,
  TokenLineItem,
  TokenLineItemInsuranceStatus,
  TokenPaymentScheme,
  TokenServiceItem,
  UserRole,
} from '../types';

const defaultAuthorizationStatus = (token: ReceptionToken): TokenLineItemInsuranceStatus =>
  token.paymentScheme?.schemeType === 'Insurance' || token.payMode === 'Insurance'
    ? 'Pending_Auth'
    : 'Cash_Only';

export const isSelfPayToken = (token: ReceptionToken): boolean =>
  token.paymentScheme
    ? token.paymentScheme.schemeType === 'Self-Pay'
    : token.payMode === 'Self';

const createLineItem = (
  token: ReceptionToken,
  item: Omit<TokenLineItem, 'insuranceStatus' | 'fulfillmentStatus'>,
  prior?: TokenLineItem
): TokenLineItem => ({
  ...item,
  insuranceStatus: prior?.insuranceStatus || defaultAuthorizationStatus(token),
  insuranceApprovalId: prior?.insuranceApprovalId,
  insuranceApprovedAmount: prior?.insuranceApprovedAmount,
  copayAmount: prior?.copayAmount,
  paymentOverride: prior?.paymentOverride || (isSelfPayToken(token)
    ? {
        mode: 'Self_Pay',
        reason: 'Visit registered under a self-pay payment scheme.',
        overriddenBy: 'Reception',
        overriddenAt: item.orderedAt,
      }
    : undefined),
  fulfillmentStatus: prior?.fulfillmentStatus || 'Ordered',
  executionStatus: prior?.executionStatus || (
    ['Lab', 'Radiology', 'Procedure', 'Service', 'Medication'].includes(item.kind)
      ? 'PENDING_SETTLEMENT'
      : undefined
  ),
});

export const createDoctorOrderLineItems = (
  token: ReceptionToken,
  orders: TokenDoctorOrder
): TokenLineItem[] => {
  const orderedBy = orders.orderedByDoctorName;
  const orderedAt = orders.orderedAt;
  const lineItems: Array<Omit<TokenLineItem, 'insuranceStatus' | 'fulfillmentStatus'>> = [];

  if (orders.consultationFee > 0) {
    lineItems.push({
      id: `${token.id}-consult`,
      kind: 'Consultation',
      name: orders.consultationServiceName || `Consultation — ${orderedBy}`,
      department: token.department,
      code: orders.consultationServiceCode,
      quantity: 1,
      unitPrice: orders.consultationFee,
      totalPrice: orders.consultationFee,
      orderedBy,
      orderedAt,
    });
  }

  for (const item of orders.labRequests) {
    lineItems.push({
      id: item.id,
      kind: 'Lab',
      name: item.testName,
      department: 'Laboratory',
      code: item.cptCode,
      quantity: 1,
      unitPrice: item.price,
      totalPrice: item.price,
      orderedBy,
      orderedAt,
    });
  }

  for (const item of orders.radiologyRequests) {
    lineItems.push({
      id: item.id,
      kind: 'Radiology',
      name: item.studyName,
      department: 'Radiology',
      code: item.cptCode,
      quantity: 1,
      unitPrice: item.price,
      totalPrice: item.price,
      orderedBy,
      orderedAt,
    });
  }

  for (const item of orders.procedureRequests) {
    lineItems.push({
      id: item.id,
      kind: 'Procedure',
      name: item.procedureName,
      department: 'Procedures',
      code: item.cptCode,
      quantity: 1,
      unitPrice: item.price,
      totalPrice: item.price,
      orderedBy,
      orderedAt,
    });
  }

  for (const item of orders.medicationRequests || []) {
    lineItems.push({
      id: item.id,
      kind: 'Medication',
      name: item.medicationName,
      department: 'Pharmacy',
      code: item.sku,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.price,
      medicationDetails: {
        ddcCode: item.sku,
        dosage: item.dosage,
        duration: item.duration,
        instructions: item.instructions,
      },
      orderedBy,
      orderedAt,
    });
  }

  return lineItems.map((item) => createLineItem(
    token,
    item,
    token.lineItems?.find((existing) => existing.id === item.id)
  ));
};

export const createServiceLineItems = (
  token: ReceptionToken,
  services: TokenServiceItem[]
): TokenLineItem[] => services.map((service) => createLineItem(token, {
  id: service.id,
  kind: 'Service',
  name: service.name,
  department: service.category === 'Test' ? 'Laboratory' : service.category,
  code: service.serviceCode,
  quantity: 1,
  unitPrice: service.price,
  totalPrice: service.price,
  orderedBy: service.addedBy,
  orderedAt: service.addedAt,
}, token.lineItems?.find((existing) => existing.id === service.id)));

export const appendTokenLineItems = (
  existing: TokenLineItem[] = [],
  incoming: TokenLineItem[]
): TokenLineItem[] => {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    const prior = byId.get(item.id);
    byId.set(item.id, prior ? { ...item, ...prior, name: item.name, totalPrice: item.totalPrice } : item);
  }
  return [...byId.values()];
};

export const getEffectiveLineItemStatus = (
  item: TokenLineItem
): TokenLineItemInsuranceStatus | 'Self_Pay' =>
  item.paymentOverride?.mode === 'Self_Pay' ? 'Self_Pay' : item.insuranceStatus;

export const canExecuteDiagnosticLineItem = (item: TokenLineItem | undefined): boolean =>
  Boolean(item && (
    getEffectiveLineItemStatus(item) === 'Approved' ||
    getEffectiveLineItemStatus(item) === 'Partially_Approved' ||
    getEffectiveLineItemStatus(item) === 'Cash_Only' ||
    getEffectiveLineItemStatus(item) === 'Self_Pay'
  ));

export const canExecuteSettledService = (item: TokenLineItem | undefined): boolean =>
  Boolean(
    item &&
    ['Lab', 'Radiology', 'Procedure', 'Service'].includes(item.kind) &&
    item.executionStatus === 'READY_FOR_EXECUTION' &&
    canExecuteDiagnosticLineItem(item)
  );

export const isOutpatientTreatmentReady = (
  token: ReceptionToken,
  item: TokenLineItem | undefined
): boolean => {
  if (!item || !['Procedure', 'Service'].includes(item.kind) || item.executionStatus !== 'READY_FOR_EXECUTION') {
    return false;
  }
  if (item.insuranceStatus === 'Approved') return true;
  const cashSettled = token.billingSummary?.paymentStatus === 'SETTLED';
  return Boolean(cashSettled && (
    item.insuranceStatus === 'Cash_Only' ||
    item.paymentOverride?.mode === 'Self_Pay'
  ));
};

export const canExecuteOutpatientTreatment = (
  token: ReceptionToken,
  item: TokenLineItem | undefined
): boolean => token.status === 'Ready for Treatment' && isOutpatientTreatmentReady(token, item);

export const canRoleExecuteServiceLineItem = (item: TokenLineItem | undefined, role: UserRole): boolean =>
  Boolean(
    item &&
    canExecuteSettledService(item) &&
    (
      role === 'admin' ||
      (role === 'nurse' && ['Procedure', 'Service'].includes(item.kind)) ||
      (role === 'lab' && /lab|laboratory/i.test(item.department)) ||
      (role === 'radiology' && /radiolog|imaging/i.test(item.department))
    )
  );

export const settleServiceLineItems = (lineItems: TokenLineItem[]): TokenLineItem[] =>
  lineItems.map((item) => item.executionStatus === 'PENDING_SETTLEMENT' && canExecuteDiagnosticLineItem(item)
    ? { ...item, executionStatus: 'READY_FOR_EXECUTION' }
    : item);

export const canDispenseMedicationLineItem = (item: TokenLineItem | undefined): boolean =>
  Boolean(item && (
    item.executionStatus === 'READY_FOR_EXECUTION' &&
    (getEffectiveLineItemStatus(item) === 'Approved' ||
      getEffectiveLineItemStatus(item) === 'Self_Pay')
  ));

const tokenLineItemCategory = (item: TokenLineItem): 'consultation' | 'lab' | 'radiology' | 'pharmacy' | 'procedure' | undefined =>
  item.kind === 'Consultation'
    ? 'consultation'
    : item.kind === 'Lab'
    ? 'lab'
    : item.kind === 'Radiology'
    ? 'radiology'
    : item.kind === 'Medication'
    ? 'pharmacy'
    : item.kind === 'Procedure' || item.kind === 'Service'
    ? 'procedure'
    : undefined;

const getTokenLineItemCopayPercent = (item: TokenLineItem, scheme: TokenPaymentScheme): number => {
  const serviceCopay = scheme.serviceCopay;
  const category = tokenLineItemCategory(item);
  const categoryPercent = /emergency/i.test(item.name)
    ? serviceCopay?.emergency
    : category === 'consultation'
    ? serviceCopay?.consultation
    : category === 'lab'
    ? serviceCopay?.lab ?? serviceCopay?.laboratory
    : category === 'radiology'
    ? serviceCopay?.radiology
    : category === 'pharmacy'
    ? serviceCopay?.pharmacy
    : category === 'procedure'
    ? serviceCopay?.surgicalProcedure ?? serviceCopay?.procedures ?? serviceCopay?.procedure
    : undefined;
  const fallbackPercent = scheme.copayPercent ?? Math.max(0, 100 - (scheme.coveragePercent ?? 100));
  return Math.min(100, Math.max(0, Number(categoryPercent ?? fallbackPercent) || 0));
};

export const getTokenLineItemBillingBreakdown = (
  item: TokenLineItem,
  scheme?: TokenPaymentScheme,
  deductibleRemaining = 0
) => {
  const status = getEffectiveLineItemStatus(item);
  const lineTotal = Math.max(0, item.totalPrice);
  if (status === 'Denied') {
    return {
      total: 0,
      insuranceCoveredAmount: 0,
      copayAmount: 0,
      patientShare: 0,
      deductibleAmount: 0,
      discountAmount: 0,
    };
  }
  const total = lineTotal;
  if (scheme?.schemeType === 'Discount Card') {
    const discountAmount = Math.round(total * Math.min(100, Math.max(0, Number(scheme.discountPercent) || 0))) / 100;
    return {
      total,
      insuranceCoveredAmount: 0,
      copayAmount: 0,
      patientShare: Math.max(0, total - discountAmount),
      deductibleAmount: 0,
      discountAmount,
    };
  }
  if (status === 'Approved' || status === 'Partially_Approved') {
    const deductibleAmount = scheme?.schemeType === 'Insurance'
      ? Math.min(total, Math.max(0, deductibleRemaining))
      : 0;
    const afterDeductible = Math.max(0, total - deductibleAmount);
    const approvedAmount = Math.min(
      afterDeductible,
      item.insuranceApprovedAmount ?? (status === 'Approved' ? total : 0)
    );
    const registeredCopay = scheme?.schemeType === 'Insurance'
      ? Math.round(afterDeductible * getTokenLineItemCopayPercent(item, scheme)) / 100
      : 0;
    const approvedCopay = Math.min(approvedAmount, Math.max(0, item.copayAmount ?? 0));
    const copayAmount = Math.min(afterDeductible, Math.max(registeredCopay, approvedCopay));
    const insuranceCoveredAmount = Math.min(
      Math.max(0, approvedAmount - approvedCopay),
      Math.max(0, afterDeductible - registeredCopay)
    );
    return {
      total,
      insuranceCoveredAmount,
      copayAmount,
      patientShare: total - insuranceCoveredAmount,
      deductibleAmount,
      discountAmount: 0,
    };
  }
  return {
    total,
    insuranceCoveredAmount: 0,
    copayAmount: 0,
    patientShare: total,
    deductibleAmount: 0,
    discountAmount: 0,
  };
};

export const aggregateTokenLineItemBilling = (lineItems: TokenLineItem[], scheme?: TokenPaymentScheme) => {
  const pendingItems = lineItems.filter((item) => getEffectiveLineItemStatus(item) === 'Pending_Auth');
  const breakdowns = getTokenLineItemsBillingBreakdowns(lineItems, scheme);
  const totals = breakdowns.reduce((result, { breakdown }) => {
    result.insuranceCoveredAmount += breakdown.insuranceCoveredAmount;
    result.patientShare += breakdown.patientShare;
    result.subtotal += breakdown.total;
    result.copayAmount += breakdown.copayAmount;
    result.deductibleAmount += breakdown.deductibleAmount;
    result.discountAmount += breakdown.discountAmount;
    return result;
  }, { subtotal: 0, insuranceCoveredAmount: 0, patientShare: 0, copayAmount: 0, deductibleAmount: 0, discountAmount: 0 });

  return { ...totals, pendingItemIds: pendingItems.map((item) => item.id) };
};

export const getTokenLineItemsBillingBreakdowns = (lineItems: TokenLineItem[], scheme?: TokenPaymentScheme) => {
  let deductibleRemaining = scheme?.schemeType === 'Insurance'
    ? Math.max(0, Number(scheme.deductibleAmount) || 0)
    : 0;
  return lineItems.map((item) => {
    const breakdown = getTokenLineItemBillingBreakdown(item, scheme, deductibleRemaining);
    deductibleRemaining = Math.max(0, deductibleRemaining - breakdown.deductibleAmount);
    return { item, breakdown };
  });
};
