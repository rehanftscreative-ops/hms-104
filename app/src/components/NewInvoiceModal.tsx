import React, { useState, useEffect } from 'react';
import { X, ReceiptText, Trash2, DollarSign, ShieldCheck, CheckCircle2, Stethoscope, RotateCcw, CalendarDays, Building2, UserRound, Ticket, CreditCard, IdCard, FileText, SlidersHorizontal } from 'lucide-react';
import { useHospital } from '../context/HospitalContext';
import { BillItem, InsuranceApproval, TokenPaymentScheme } from '../types';
import { PatientLookup } from './billing/PatientLookup';
import { applyApprovedInsuranceBreakdown, applyDiscountBreakdown, findApplicableInsuranceApproval, parseInsuranceDeductible, sumInvoiceItemField } from '../utils/insuranceInvoice';
import {
  aggregateTokenLineItemBilling,
  appendTokenLineItems,
  createDoctorOrderLineItems,
  createServiceLineItems,
  getTokenLineItemBillingBreakdown,
  getTokenLineItemsBillingBreakdowns,
} from '../utils/tokenStateMachine';

interface NewInvoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const formatInvoiceVisitDate = (date: string) => {
  const parsedDate = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsedDate.getTime())
    ? date
    : parsedDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

export const NewInvoiceModal: React.FC<NewInvoiceModalProps> = ({ isOpen, onClose }) => {
  const { patients, receptionTokens, insuranceApprovals, hospitalPriceCatalog, pharmacy, createInvoice, addNotification } = useHospital();

  const [patientId, setPatientId] = useState('');
  const [encounterType, setEncounterType] = useState<'OPD' | 'IPD'>('OPD');
  const [selectedTokenId, setSelectedTokenId] = useState('');
  const [recordTab, setRecordTab] = useState<'diagnoses' | 'profile-documents' | 'visit-documents' | 'approvals' | 'insurance-configuration'>('diagnoses');
  const [items, setItems] = useState<BillItem[]>([]);
  const [diagnoses, setDiagnoses] = useState<Array<{ code: string; description: string; doctorName: string; orderedAt: string }>>([]);
  const [invoiceReviewTab, setInvoiceReviewTab] = useState<'services' | 'approvals'>('services');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [dueRemarks, setDueRemarks] = useState('');
  const [formError, setFormError] = useState('');
  const selectedPatient = patients.find((patient) => patient.id === patientId);
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const patientForToken = (token: (typeof receptionTokens)[number]) =>
    patients.find((patient) => patient.id === token.patientId);
  const patientServicesForToken = (token: (typeof receptionTokens)[number]) => (patientForToken(token)?.services || []).filter((service) =>
    service.encounterTokenId === token.id ||
    token.pendingServiceIds?.includes(service.id)
  );
  const tokenServiceIds = (token: (typeof receptionTokens)[number]) => {
    const patientServices = patientServicesForToken(token);
    const doctorOrderIds = token.doctorOrders
      ? createDoctorOrderLineItems(token, token.doctorOrders).map((item) => item.id)
      : [];
    return new Set([
      ...(token.lineItems || []).map((item) => item.id),
      ...(token.serviceItems || []).map((item) => item.id),
      ...doctorOrderIds,
      ...patientServices.map((service) => service.id),
    ]);
  };
  const openInvoiceTokens = receptionTokens.filter((token) => {
    if (token.status === 'Cancelled') return false;
    const serviceIds = tokenServiceIds(token);
    if (serviceIds.size === 0) {
      return token.status !== 'Completed' && !token.billingSummary;
    }

    return [...serviceIds].some((serviceId) => {
      const patientService = patientServicesForToken(token).find((service) => service.id === serviceId);
      const billingStatus = patientService?.billingStatus ||
        token.serviceBillingStates?.find((state) => state.serviceId === serviceId)?.status;
      if (billingStatus === 'Billed' || billingStatus === 'Cancelled') return false;
      if (!billingStatus && ['Paid', 'SETTLED'].includes(token.billingSummary?.paymentStatus || '')) return false;
      return true;
    });
  });
  const patientTokens = openInvoiceTokens.filter((token) => token.patientId === patientId);
  const selectedToken = patientTokens.find((token) => token.id === selectedTokenId);
  const currentVisitDate = selectedToken?.visitDate || selectedToken?.createdDate || localToday;
  const previousVisit = [...(selectedPatient?.facilityVisits || [])]
    .filter((visit) => visit.visitType !== 'Billing & Claims' && visit.visitDate < currentVisitDate)
    .sort((first, second) => second.visitDate.localeCompare(first.visitDate))[0];
  const tokenLineItems = selectedToken
    ? selectedToken.lineItems?.length ? selectedToken.lineItems : appendTokenLineItems(
        createServiceLineItems(selectedToken, selectedToken.serviceItems || []),
        selectedToken.doctorOrders ? createDoctorOrderLineItems(selectedToken, selectedToken.doctorOrders) : []
      )
      : [];
  const registeredPaymentScheme: TokenPaymentScheme | undefined = selectedPatient
    ? selectedPatient.payMode === 'Insurance'
      ? {
          schemeType: 'Insurance',
          insuranceProvider: selectedPatient.insurance.provider,
          coveragePercent: selectedPatient.insurance.coveragePercentage ?? 80,
          copayPercent: 100 - (selectedPatient.insurance.coveragePercentage ?? 80),
          serviceCopay: selectedPatient.insurance.serviceCopay,
          deductibleAmount: selectedPatient.insurance.deductibleAmount ??
            parseInsuranceDeductible(selectedPatient.insuranceList?.find((record) => record.isPrimary)?.copayDeductible),
        }
      : selectedPatient.payMode === 'Discount Card'
      ? { schemeType: 'Discount Card', discountPercent: selectedPatient.discountPercent ?? 0 }
      : { schemeType: 'Self-Pay' }
    : undefined;
  const paymentScheme = selectedToken?.paymentScheme ?? registeredPaymentScheme;
  const isInsuranceInvoice = paymentScheme?.schemeType === 'Insurance';
  const deductibleConfigured = selectedPatient?.insurance.deductibleAmount ||
    parseInsuranceDeductible(selectedPatient?.insuranceList?.find((record) => record.isPrimary)?.copayDeductible);
  const findApprovalForItem = (item: BillItem, tokenId = selectedToken?.id, approvalPatientId = patientId) => {
    const linkedApproval = insuranceApprovals.find((approval) => approval.id === item.insuranceApprovalId);
    if (linkedApproval && findApplicableInsuranceApproval(item, [linkedApproval], approvalPatientId, tokenId)) {
      return linkedApproval;
    }
    return findApplicableInsuranceApproval(item, insuranceApprovals, approvalPatientId, tokenId);
  };
  const patientApprovals = insuranceApprovals.filter((approval) =>
    approval.patientId === patientId && (!selectedTokenId || !approval.encounterTokenId || approval.encounterTokenId === selectedTokenId)
  );
  const profileDocumentCount = Number(Boolean(selectedPatient?.insuranceCardImage)) + Number(Boolean(selectedPatient?.supportDocumentImage));
  const visitDocumentCount = selectedToken?.visitDocuments?.length || 0;
  const diagnosisCount = diagnoses.length || selectedPatient?.diagnoses?.length || 0;
  const insuranceConfiguration = selectedToken?.paymentScheme
    ? selectedToken.paymentScheme.schemeType === 'Insurance'
      ? selectedToken.paymentScheme
      : undefined
    : selectedPatient?.payMode === 'Insurance'
    ? {
        schemeType: 'Insurance' as const,
        insuranceProvider: selectedPatient.insurance.provider,
        policyNumber: selectedPatient.insurance.policyNumber,
        network: selectedPatient.insurance.network,
        coveragePercent: selectedPatient.insurance.coveragePercentage,
        copayPercent: 100 - selectedPatient.insurance.coveragePercentage,
        deductibleAmount: selectedPatient.insurance.deductibleAmount,
        serviceCopay: selectedPatient.insurance.serviceCopay,
      }
    : undefined;
  const registeredServiceCopay = insuranceConfiguration?.serviceCopay ?? selectedPatient?.insurance.serviceCopay;

  useEffect(() => {
    if (!isOpen) return;
    setPatientId('');
    setSelectedTokenId('');
    setItems([]);
    setDiagnoses([]);
    setDueRemarks('');
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleRemoveItem = (id: string) => {
    setItems((current) => current.map((item) => item.id === id
      ? { ...item, billingStatus: item.billingStatus === 'Deferred' ? 'Pending' : 'Deferred' }
      : item));
  };

  const addCatalogItem = (entry: { id: string; code: string; cptCode?: string; name: string; category: string; price: number }) => {
    if (items.some((item) => item.serviceCode === entry.code || (entry.cptCode && item.cptCode === entry.cptCode))) {
      setFormError(`${entry.name} is already on this invoice.`);
      return;
    }
    const category: BillItem['category'] = entry.category === 'Consultation' || entry.category === 'Emergency Care'
      ? 'Consultation'
      : entry.category === 'Diagnostic Lab'
      ? 'Lab Test'
      : entry.category === 'Radiology & Imaging'
      ? 'Radiology'
      : entry.category === 'Ward & Nursing'
      ? 'Room & Nursing'
      : entry.category === 'Medication'
      ? 'Pharmacy'
      : entry.category === 'Cardiology'
      ? 'Cardiology'
      : entry.category === 'Physiotherapy' || entry.category === 'Injection & Administration'
      ? 'Technician Service'
      : 'Surgical Procedure';
    setItems((current) => [...current, {
      id: `ITM-${Date.now()}`,
      serviceCode: entry.code,
      cptCode: entry.cptCode,
      description: entry.name,
      category,
      unitCost: entry.price,
      quantity: 1,
      amount: entry.price,
      totalPrice: entry.price,
      sourceType: 'Manual',
      billingStatus: 'Pending',
    }]);
    setCatalogSearch('');
    setFormError('');
  };

  const serviceCatalogEntries = [
    ...hospitalPriceCatalog.map((item) => ({
      id: item.id,
      code: item.code,
      cptCode: item.cptCode,
      name: item.name,
      category: item.category,
      price: item.standardPrice,
    })),
    ...pharmacy.map((item) => ({
      id: item.id,
      code: item.sku,
      cptCode: undefined,
      name: `${item.name} — ${item.genericName}`,
      category: 'Medication',
      price: item.unitPrice,
    })),
  ].filter((item) => `${item.code} ${item.cptCode || ''} ${item.name} ${item.category}`.toLowerCase().includes(catalogSearch.trim().toLowerCase()));

  const updateItem = (id: string, updates: Partial<BillItem>) => {
    setItems((current) => current.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item, ...updates };
      const amount = Math.max(0, Number(next.unitCost) || 0) * Math.max(1, Number(next.quantity) || 1);
      return { ...next, amount, totalPrice: amount };
    }));
  };

  const loadDoctorOrders = (tokenId: string, tokenOverride?: (typeof receptionTokens)[number]) => {
    setSelectedTokenId(tokenId);
    const token = tokenOverride || patientTokens.find((item) => item.id === tokenId);
    const orders = token?.doctorOrders;
    if (!token) {
      setItems([]);
      setDiagnoses([]);
      return;
    }
    const orderedItems: BillItem[] = [
      ...(orders && orders.consultationFee > 0 ? [{
        id: `${token.id}-consult`,
        serviceCode: orders.consultationServiceCode,
        cptCode: orders.consultationServiceCode,
        description: orders.consultationServiceName || `Consultation — ${orders.orderedByDoctorName}`,
        category: 'Consultation' as const,
        unitCost: orders.consultationFee,
        quantity: 1,
        amount: orders.consultationFee,
        totalPrice: orders.consultationFee,
      }] : []),
      ...(orders?.medicationRequests || []).map((order) => ({
        id: order.id,
        serviceCode: order.sku,
        description: `${order.medicationName} (${order.sku})`,
        category: 'Pharmacy' as const,
        unitCost: order.unitPrice,
        quantity: order.quantity,
        amount: order.price,
        totalPrice: order.price,
      })),
      ...(orders?.labRequests || []).filter((order) => order.price > 0).map((order) => ({
        id: order.id,
        serviceCode: order.cptCode,
        cptCode: order.cptCode,
        description: order.testName,
        category: 'Lab Test' as const,
        unitCost: order.price,
        quantity: 1,
        amount: order.price,
        totalPrice: order.price,
      })),
      ...(orders?.radiologyRequests || []).filter((order) => order.price > 0).map((order) => ({
        id: order.id,
        serviceCode: order.cptCode,
        cptCode: order.cptCode,
        description: order.studyName,
        category: 'Radiology' as const,
        unitCost: order.price,
        quantity: 1,
        amount: order.price,
        totalPrice: order.price,
      })),
      ...(orders?.procedureRequests || []).filter((order) => order.price > 0).map((order) => ({
        id: order.id,
        serviceCode: order.cptCode,
        cptCode: order.cptCode,
        description: order.procedureName,
        category: 'Surgical Procedure' as const,
        unitCost: order.price,
        quantity: 1,
        amount: order.price,
        totalPrice: order.price,
      })),
    ];
    const doctorOrderItems = orderedItems.map((item) => {
      const sourceItem = { ...item, sourceServiceId: item.id, sourceEncounterTokenId: token.id, sourceType: 'Doctor Order' as const };
      const priorState = token.serviceBillingStates?.find((state) => state.serviceId === item.id);
      const approval = findApprovalForItem(sourceItem, token.id, token.patientId);
      return {
        ...sourceItem,
        insuranceApprovalId: approval?.id,
        billingStatus: priorState?.status || 'Pending',
      };
    });
    const patientServiceItems: BillItem[] = (patientForToken(token)?.services || [])
      .filter((service) => service.encounterTokenId === token.id || token.pendingServiceIds?.includes(service.id))
      .map((service) => ({
        id: service.id,
        serviceCode: service.serviceCode,
        sourceServiceId: service.id,
        sourceEncounterTokenId: token.id,
        sourceType: 'Patient Service',
        insuranceApprovalId: service.insuranceApprovalId,
        description: service.name,
        category: service.category === 'Procedure' ? 'Surgical Procedure' : service.category === 'IPD Admission' ? 'Room & Nursing' : service.category,
        unitCost: service.estimatedCost,
        quantity: 1,
        amount: service.estimatedCost,
        totalPrice: service.estimatedCost,
        billingStatus: service.billingStatus || 'Pending',
      }));
    const nursingItems: BillItem[] = (token.serviceItems || []).map((service) => ({
      id: service.id,
      serviceCode: service.serviceCode,
      sourceServiceId: service.id,
      sourceEncounterTokenId: token.id,
      sourceType: 'Nursing Service',
      description: service.name,
      category: service.category === 'Test' ? 'Lab Test' : service.category === 'Procedure' ? 'Surgical Procedure' : 'Technician Service',
      unitCost: service.price,
      quantity: 1,
      amount: service.price,
      totalPrice: service.price,
      billingStatus: token.serviceBillingStates?.find((state) => state.serviceId === service.id)?.status || 'Pending',
    }));
    setItems([...doctorOrderItems, ...patientServiceItems, ...nursingItems]);
    setDiagnoses((orders?.diagnoses || []).map((diagnosis) => ({
      code: diagnosis.code,
      description: diagnosis.description,
      doctorName: orders?.orderedByDoctorName || token.doctorName || 'Attending Physician',
      orderedAt: orders?.orderedAt || token.visitDate || token.createdDate || '',
    })));
    setFormError('');
  };

  const selectPatient = (nextPatientId: string) => {
    const patient = patients.find((item) => item.id === nextPatientId);
    setPatientId(nextPatientId);
    setSelectedTokenId('');
    setItems([]);
    setDiagnoses([]);
    setDueRemarks('');
    if (!patient) return;
    setEncounterType(patient.status === 'Inpatient' ? 'IPD' : 'OPD');

    const visits = openInvoiceTokens.filter((token) => token.patientId === nextPatientId);
    if (visits.length === 1) loadDoctorOrders(visits[0].id, visits[0]);
  };

  const selectInvoiceToken = (patientId: string, token: (typeof receptionTokens)[number]) => {
    const patient = patients.find((item) => item.id === patientId);
    if (!patient) return;
    setPatientId(patientId);
    setEncounterType(patient.status === 'Inpatient' ? 'IPD' : 'OPD');
    setDueRemarks('');
    loadDoctorOrders(token.id, token);
  };

  const billableItems = items.filter((item) => !['Billed', 'Deferred', 'Cancelled'].includes(item.billingStatus || 'Pending'));
  const billableTokenLineItems = selectedToken
    ? tokenLineItems.filter((lineItem) =>
        billableItems.some((item) => lineItem.id === (item.sourceServiceId || item.id))
      )
    : [];
  const tokenBillingBreakdowns = getTokenLineItemsBillingBreakdowns(billableTokenLineItems, paymentScheme);
  const tokenBreakdownById = new Map(tokenBillingBreakdowns.map(({ item, breakdown }) => [item.id, breakdown]));
  const tokenBillingTotals = selectedToken
    ? aggregateTokenLineItemBilling(billableTokenLineItems, paymentScheme)
    : undefined;
  const deferredItems = items.filter((item) => item.billingStatus === 'Deferred');
  const totalAmount = billableItems.reduce((sum, item) => sum + (Number(item.amount ?? item.totalPrice) || 0), 0);
  const discountPercent = !isInsuranceInvoice && paymentScheme?.schemeType === 'Discount Card'
    ? Math.min(100, Math.max(0, Number(paymentScheme.discountPercent) || 0))
    : 0;
  const linkedItems = billableItems.map((item) => {
    const approval = findApprovalForItem(item);
    return { ...item, insuranceApprovalId: approval?.id };
  });
  const tokenLinkedItems = selectedToken
    ? linkedItems.map((item) => {
        const lineItem = tokenLineItems.find((line) => line.id === (item.sourceServiceId || item.id));
        if (!lineItem) return item;
        const breakdown = tokenBreakdownById.get(lineItem.id) || getTokenLineItemBillingBreakdown(lineItem, paymentScheme);
        return {
          ...item,
          amount: breakdown.total,
          totalPrice: breakdown.total,
          netAmount: breakdown.total - breakdown.discountAmount,
          discountAmount: breakdown.discountAmount,
          insuranceAmount: breakdown.insuranceCoveredAmount,
          copayAmount: breakdown.copayAmount,
        };
      })
    : linkedItems;
  const invoiceItems = selectedToken
    ? tokenLinkedItems
    : isInsuranceInvoice
    ? applyApprovedInsuranceBreakdown(
        linkedItems,
        insuranceApprovals.filter((approval) =>
          approval.patientId === patientId && (!approval.encounterTokenId || approval.encounterTokenId === selectedTokenId)
        ),
        paymentScheme?.deductibleAmount ?? deductibleConfigured,
        paymentScheme?.serviceCopay ?? selectedPatient?.insurance.serviceCopay,
        paymentScheme?.copayPercent ?? 100 - (paymentScheme?.coveragePercent ?? selectedPatient?.insurance.coveragePercentage ?? 80)
      )
    : discountPercent > 0
    ? applyDiscountBreakdown(linkedItems, discountPercent)
    : linkedItems;
  const invoiceInsuranceCovered = tokenBillingTotals
    ? tokenBillingTotals.insuranceCoveredAmount
    : isInsuranceInvoice
    ? sumInvoiceItemField(invoiceItems, 'insuranceAmount')
    : 0;
  const invoiceCopay = tokenBillingTotals
    ? tokenBillingTotals.copayAmount
    : isInsuranceInvoice
    ? sumInvoiceItemField(invoiceItems, 'copayAmount')
    : 0;
  const invoiceDeductible = tokenBillingTotals
    ? tokenBillingTotals.deductibleAmount
    : isInsuranceInvoice ? sumInvoiceItemField(invoiceItems, 'deductibleAmount') : 0;
  const invoiceDiscountAmount = tokenBillingTotals
    ? tokenBillingTotals.discountAmount
    : sumInvoiceItemField(invoiceItems, 'discountAmount');
  const invoiceNetAmount = tokenBillingTotals
    ? tokenBillingTotals.subtotal - tokenBillingTotals.discountAmount
    :
    invoiceItems.reduce((sum, item) => sum + Number(item.netAmount ?? item.amount ?? item.totalPrice ?? 0), 0);
  const hasPendingApproval = selectedToken
    ? Boolean(tokenBillingTotals?.pendingItemIds.length)
    : isInsuranceInvoice && invoiceItems.some((item) => {
        const approval = findApprovalForItem(item);
        return approval && approval.approvalStatus !== 'Approved';
      });
  const balanceDue = tokenBillingTotals
    ? tokenBillingTotals.patientShare
    : isInsuranceInvoice
    ? Math.max(0, invoiceNetAmount - invoiceInsuranceCovered)
    : Math.max(0, invoiceNetAmount);

  const getApprovalServiceMatch = (approval: InsuranceApproval) => {
    const matches = billableItems.filter((item) =>
      findApplicableInsuranceApproval(item, [approval], patientId, selectedTokenId) &&
      (!item.insuranceApprovalId || item.insuranceApprovalId === approval.id)
    );
    return matches.length === 1 ? matches[0] : undefined;
  };

  const applyApprovalToService = (approval: InsuranceApproval) => {
    const service = getApprovalServiceMatch(approval);
    if (!isInsuranceInvoice || approval.approvalStatus !== 'Approved' || !service) {
      addNotification(
        'Approval Not Applied',
        'Use an insurance invoice and apply only approved authorizations to one service with the same patient, service code, amount, and visit.',
        'warning',
        patientId
      );
      return;
    }

    setItems((current) => current.map((item) =>
      item.id === service.id ? { ...item, insuranceApprovalId: approval.id } : item
    ));
    setInvoiceReviewTab('services');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const selectedPatient = patients.find((p) => p.id === patientId);
    if (!selectedPatient) {
      setFormError('Select a patient before saving the invoice.');
      return;
    }
    if (billableItems.length === 0) {
      setFormError('Add at least one charge before saving the invoice.');
      return;
    }
    if (billableItems.some((item) => !item.description.trim() || !Number.isFinite(item.unitCost) || item.unitCost <= 0 || !Number.isInteger(item.quantity) || item.quantity < 1)) {
      setFormError('Each service needs a description, a positive unit price, and a whole-number quantity.');
      return;
    }
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    const saveDraft = submitter instanceof HTMLButtonElement && submitter.value === 'draft';
    const unmatchedTokenItems = selectedToken && billableItems.some((item) =>
      !tokenLineItems.some((lineItem) => lineItem.id === (item.sourceServiceId || item.id))
    );
    if (unmatchedTokenItems) {
      setFormError('Every charge on a token-linked invoice must exist as a line item on that visit token.');
      return;
    }
    if (!saveDraft && tokenBillingTotals?.pendingItemIds.length) {
      setFormError(`Resolve authorization for ${tokenBillingTotals.pendingItemIds.join(', ')} before issuing this invoice.`);
      return;
    }
    if (!saveDraft && balanceDue > 0 && !dueRemarks.trim()) {
      setFormError('Add a remark explaining the patient balance before issuing the invoice.');
      return;
    }

    const createdInvoice = createInvoice({
      patientId: selectedPatient.id,
      patientName: `${selectedPatient.firstName} ${selectedPatient.lastName}`,
      encounterType,
      encounterTokenId: selectedToken?.id,
      insuranceProvider: isInsuranceInvoice ? selectedPatient.insurance.provider : undefined,
      diagnoses,
      patientPhone: selectedPatient.phone,
      patientEmail: selectedPatient.email,
      issueDate: new Date().toISOString().split('T')[0],
      dueDate: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
      status: saveDraft ? 'Draft' : invoiceInsuranceCovered > 0 || hasPendingApproval ? 'Pending Insurance' : balanceDue === 0 ? 'Paid' : 'Pending',
      items: invoiceItems,
      deferredItems,
      discountAmount: invoiceDiscountAmount,
      insuranceCoveredAmount: invoiceInsuranceCovered,
      copayAmount: invoiceCopay,
      deductibleAmount: invoiceDeductible,
      dueRemarks: dueRemarks.trim() || undefined,
      tax: 0,
    });
    if (!createdInvoice) {
      setFormError('The invoice could not be created. Check token authorization and line-item details.');
      return;
    }

    addNotification(
      saveDraft ? 'Invoice Draft Saved' : 'Invoice Issued',
      `${saveDraft ? 'Draft saved' : 'Invoice issued'} for ${selectedPatient.firstName} ${selectedPatient.lastName} (${encounterType}; $${balanceDue.toFixed(2)} patient balance).`,
      saveDraft ? 'info' : 'success',
      selectedPatient.id
    );

    onClose();
  };

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-6xl w-full overflow-hidden flex flex-col max-h-[94vh]">
        {/* Header with Classification Badge */}
        <div className="p-4 bg-slate-900 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-600/30 border border-amber-500/40 text-amber-400 flex items-center justify-center font-bold">
              <ReceiptText className="w-4.5 h-4.5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold uppercase tracking-wider text-amber-400 bg-amber-950/60 px-1.5 py-0.5 rounded border border-amber-800">
                  Billing & Claims
                </span>
              </div>
              <h2 className="font-bold text-sm text-white mt-0.5">Generate Patient Invoice</h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 text-xs">
          {/* Classification Section 1: Patient Selection */}
          <div className="space-y-2 p-3 bg-slate-50 border border-slate-200/80 rounded-xl">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
              1. Patient & Insurance Profile
            </span>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_130px]">
              <PatientLookup
                patients={patients}
                tokens={openInvoiceTokens}
                selectedPatientId={patientId}
                onSelect={selectPatient}
                onSelectToken={selectInvoiceToken}
                allowAllPatients
              />
              <select value={encounterType} onChange={(event) => setEncounterType(event.target.value as 'OPD' | 'IPD')} aria-label="Encounter type" className="w-full bg-white border border-slate-300 rounded-lg p-2 text-xs font-medium">
                <option value="OPD">OPD encounter</option>
                <option value="IPD">IPD encounter</option>
              </select>
            </div>
            {selectedPatient && (
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-700">
                  Open visit / token
                  {patientTokens.length > 0 ? (
                    <select value={selectedTokenId} onChange={(event) => loadDoctorOrders(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs font-normal">
                      <option value="">Select a registered visit</option>
                      {patientTokens.map((token) => (
                        <option key={token.id} value={token.id}>
                          {token.tokenNumber} · {token.visitCode || (token.serviceType === 'Consultation' ? 'C' : token.serviceType === 'Physio Technician' ? 'TEC' : 'NC')} · {token.department} · {token.createdDate || token.visitDate || 'Visit'} · {tokenServiceIds(token).size ? 'Unbilled services' : 'Services not added yet'}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="mt-1 rounded-lg border border-dashed border-slate-300 bg-white p-2.5 text-xs font-normal text-slate-500">
                      No open or unbilled visits for this patient.
                    </p>
                  )}
                </label>
                <p className="text-[10px] text-slate-500">Includes active registered tokens awaiting services and visits with unbilled items.</p>
              </div>
            )}
          </div>

          {selectedPatient && (
            <section className="grid gap-3 md:grid-cols-2" aria-label="Patient visit summary">
              <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2 text-slate-700">
                  <CalendarDays className="h-4 w-4 text-slate-500" />
                  <h3 className="text-xs font-bold uppercase tracking-wide">Previous visit</h3>
                </div>
                {previousVisit ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    <div><p className="text-[9px] font-semibold uppercase text-slate-500">Date</p><p className="mt-0.5 text-xs font-semibold text-slate-900">{formatInvoiceVisitDate(previousVisit.visitDate)}</p></div>
                    <div><p className="text-[9px] font-semibold uppercase text-slate-500">Doctor</p><p className="mt-0.5 text-xs font-semibold text-slate-900">{previousVisit.doctorName || 'Not recorded'}</p></div>
                    <div><p className="text-[9px] font-semibold uppercase text-slate-500">Department</p><p className="mt-0.5 text-xs font-semibold text-slate-900">{previousVisit.department || previousVisit.doctorSpecialty || 'Not recorded'}</p></div>
                  </div>
                ) : <p className="mt-3 text-xs text-slate-500">No previous clinical visit recorded.</p>}
              </article>
              <article className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 shadow-sm">
                <div className="flex items-center gap-2 text-blue-900">
                  <Ticket className="h-4 w-4 text-blue-700" />
                  <h3 className="text-xs font-bold uppercase tracking-wide">Current visit</h3>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div><p className="text-[9px] font-semibold uppercase text-blue-700">Date</p><p className="mt-0.5 text-xs font-semibold text-slate-900">{formatInvoiceVisitDate(currentVisitDate)}</p></div>
                  <div><p className="text-[9px] font-semibold uppercase text-blue-700">Doctor / provider</p><p className="mt-0.5 text-xs font-semibold text-slate-900">{selectedToken?.doctorName || (selectedToken?.serviceType === 'Billing & Cashier' ? 'Not assigned' : selectedPatient.primaryPhysicianName || 'Not assigned')}</p></div>
                  <div><p className="text-[9px] font-semibold uppercase text-blue-700">Department</p><p className="mt-0.5 text-xs font-semibold text-slate-900">{selectedToken?.department || selectedPatient.department || 'Not assigned'}</p></div>
                  <div><p className="text-[9px] font-semibold uppercase text-blue-700">Token no.</p><p className="mt-0.5 font-mono text-xs font-bold text-slate-900">{selectedToken?.tokenNumber || 'Select a token'}</p></div>
                </div>
              </article>
            </section>
          )}

          {selectedToken && items.length === 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-900">
              This {selectedToken.serviceType.toLowerCase()} token is registered and open, but services have not been added yet. It remains available here until billable services are recorded.
            </div>
          )}

          {selectedPatient && (
            <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-bold text-slate-900">Patient profile & visit records</h3>
                  <p className="mt-0.5 text-[10px] text-slate-500">Review diagnoses, documents, approvals, and registered insurance copay settings before billing.</p>
                </div>
                <span className="text-[10px] text-slate-500">{selectedToken ? `Token ${selectedToken.tokenNumber}` : `MRN ${selectedPatient.rgNo || selectedPatient.id}`}</span>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" role="tablist" aria-label="Patient records">
                {([
                  { id: 'diagnoses', label: 'Diagnoses', count: diagnosisCount, icon: Stethoscope },
                  { id: 'profile-documents', label: 'Patient files', count: profileDocumentCount, icon: IdCard },
                  { id: 'visit-documents', label: 'Visit files', count: visitDocumentCount, icon: FileText },
                  { id: 'approvals', label: 'Approvals', count: patientApprovals.length, icon: ShieldCheck },
                  { id: 'insurance-configuration', label: 'Insurance setup', count: Object.values(registeredServiceCopay || {}).filter((rate) => rate !== undefined).length, icon: SlidersHorizontal },
                ] as const).map(({ id, label, count, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    id={`invoice-record-tab-${id}`}
                    aria-selected={recordTab === id}
                    aria-controls="invoice-record-panel"
                    onClick={() => setRecordTab(id)}
                    className={`flex min-h-16 items-center gap-2 rounded-lg border p-2 text-left transition-colors ${
                      recordTab === id ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-200' : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <span className="relative flex h-10 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-slate-100">
                      {id === 'profile-documents' && selectedPatient.insuranceCardImage ? (
                        <img src={selectedPatient.insuranceCardImage} alt="" className="h-full w-full object-cover" />
                      ) : id === 'visit-documents' && selectedToken?.visitDocuments?.[0]?.mimeType.startsWith('image/') ? (
                        <img src={selectedToken.visitDocuments[0].dataUrl} alt="" className="h-full w-full object-cover" />
                      ) : <Icon className="h-4 w-4 text-slate-600" />}
                      <span className="absolute bottom-0 right-0 rounded-tl bg-white/95 p-0.5"><Icon className="h-3 w-3 text-blue-700" /></span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[10px] font-bold text-slate-800">{label}</span>
                      <span className="mt-0.5 block text-[9px] text-slate-500">
                        {id === 'insurance-configuration'
                          ? insuranceConfiguration ? `${count} copay rates` : 'Not insured'
                          : `${count} item${count === 1 ? '' : 's'}`}
                      </span>
                    </span>
                  </button>
                ))}
              </div>

              <div
                id="invoice-record-panel"
                role="tabpanel"
                aria-labelledby={`invoice-record-tab-${recordTab}`}
                className="min-h-24 rounded-lg border border-slate-200 bg-slate-50 p-3"
              >
                {recordTab === 'diagnoses' && (
                  <div className="space-y-3">
                    <div>
                      <h4 className="text-[10px] font-bold uppercase tracking-wide text-slate-600">Doctor-added diagnoses</h4>
                      {selectedToken?.doctorOrders?.orderedByDoctorName && <p className="mt-0.5 text-[10px] text-slate-500">Entered by {selectedToken.doctorOrders.orderedByDoctorName}</p>}
                    </div>
                    {diagnoses.length ? (
                      <ul className="space-y-1.5">
                        {diagnoses.map((diagnosis, index) => <li key={`${diagnosis.code}-${index}`} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[10px] text-slate-700"><span className="mr-1.5 font-mono font-bold text-indigo-800">{diagnosis.code}</span>{diagnosis.description}</li>)}
                      </ul>
                    ) : selectedPatient.diagnoses?.length ? (
                      <ul className="space-y-1.5">
                        {selectedPatient.diagnoses.map((diagnosis) => <li key={diagnosis.id} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[10px] text-slate-700"><span className="mr-1.5 font-mono font-bold text-indigo-800">{diagnosis.icdCode}</span>{diagnosis.description} · {diagnosis.status}</li>)}
                      </ul>
                    ) : <p className="text-[10px] text-slate-500">No diagnoses are recorded in the patient profile or current visit.</p>}
                    <p className="text-[9px] text-slate-500">Doctor-entered diagnoses are read-only and included with the invoice.</p>
                  </div>
                )}

                {recordTab === 'profile-documents' && (
                  <div className="space-y-2">
                    <h4 className="text-[10px] font-bold uppercase tracking-wide text-slate-600">Patient profile documents</h4>
                    <div className="flex flex-wrap gap-2">
                      {selectedPatient.insuranceCardImage && (
                        <a href={selectedPatient.insuranceCardImage} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 text-[10px] font-semibold text-blue-700 hover:bg-blue-50">
                          <span className="relative flex h-10 w-12 shrink-0 overflow-hidden rounded-md bg-blue-50"><img src={selectedPatient.insuranceCardImage} alt="Insurance card screenshot" className="h-full w-full object-cover" /><CreditCard className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded bg-white/90 p-0.5 text-blue-700" /></span>
                          Insurance card
                        </a>
                      )}
                      {selectedPatient.supportDocumentImage && (
                        <a href={selectedPatient.supportDocumentImage} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 text-[10px] font-semibold text-blue-700 hover:bg-blue-50">
                          <span className="relative flex h-10 w-12 shrink-0 overflow-hidden rounded-md bg-slate-100"><img src={selectedPatient.supportDocumentImage} alt="Patient ID proof screenshot" className="h-full w-full object-cover" /><IdCard className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded bg-white/90 p-0.5 text-slate-700" /></span>
                          Patient ID
                        </a>
                      )}
                      {!profileDocumentCount && <p className="text-[10px] text-slate-500">No documents are attached to the patient profile.</p>}
                    </div>
                  </div>
                )}

                {recordTab === 'visit-documents' && (
                  <div className="space-y-2">
                    <h4 className="text-[10px] font-bold uppercase tracking-wide text-slate-600">Visit documents</h4>
                    {selectedToken?.visitDocuments?.length ? (
                      <ul className="space-y-1.5">
                        {selectedToken.visitDocuments.map((document) => <li key={document.id} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2"><span className="min-w-0 truncate text-[10px] text-slate-700">{document.fileName}</span><a href={document.dataUrl} download={document.fileName} target="_blank" rel="noreferrer" className="shrink-0 text-[10px] font-bold text-blue-700 underline">Open</a></li>)}
                      </ul>
                    ) : <p className="text-[10px] text-slate-500">No documents are attached to this visit.</p>}
                  </div>
                )}

                {recordTab === 'approvals' && (
                  <div className="space-y-2">
                    <h4 className="text-[10px] font-bold uppercase tracking-wide text-slate-600">Insurance approvals ({patientApprovals.length})</h4>
                    {patientApprovals.length ? (
                      <ul className="space-y-1.5">
                        {patientApprovals.map((approval) => <li key={approval.id} className="flex items-start justify-between gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2"><div className="min-w-0"><p className="truncate text-[10px] font-semibold text-slate-800">{approval.serviceName}</p><p className="text-[9px] text-slate-500">{approval.approvalNumber} · {approval.insuranceProvider}</p></div><span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${approval.approvalStatus === 'Approved' ? 'bg-emerald-100 text-emerald-800' : approval.approvalStatus === 'Rejected' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}`}>{approval.approvalStatus}</span></li>)}
                      </ul>
                    ) : <p className="text-[10px] text-slate-500">No insurance approvals are recorded for this patient or visit.</p>}
                  </div>
                )}

                {recordTab === 'insurance-configuration' && (
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h4 className="text-[10px] font-bold uppercase tracking-wide text-slate-600">Registered insurance configuration</h4>
                        <p className="mt-0.5 text-[9px] text-slate-500">
                          {selectedToken?.paymentScheme?.schemeType === 'Insurance'
                            ? 'Payment scheme saved with this visit at registration.'
                            : 'Insurance settings saved on the patient registration profile.'}
                        </p>
                      </div>
                      {insuranceConfiguration && <span className="rounded-full bg-emerald-100 px-2 py-1 text-[9px] font-bold text-emerald-800">Insurance</span>}
                    </div>
                    {insuranceConfiguration ? (
                      <>
                        <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          <div className="rounded-md border border-slate-200 bg-white p-2"><dt className="text-[9px] font-semibold uppercase text-slate-500">Provider</dt><dd className="mt-0.5 text-[10px] font-semibold text-slate-800">{insuranceConfiguration.insuranceProvider || selectedPatient.insurance.provider || 'Not recorded'}</dd></div>
                          <div className="rounded-md border border-slate-200 bg-white p-2"><dt className="text-[9px] font-semibold uppercase text-slate-500">Policy number</dt><dd className="mt-0.5 text-[10px] font-semibold text-slate-800">{insuranceConfiguration.policyNumber || selectedPatient.insurance.policyNumber || 'Not recorded'}</dd></div>
                          <div className="rounded-md border border-slate-200 bg-white p-2"><dt className="text-[9px] font-semibold uppercase text-slate-500">Network</dt><dd className="mt-0.5 text-[10px] font-semibold text-slate-800">{insuranceConfiguration.network || selectedPatient.insurance.network || 'Not recorded'}</dd></div>
                          <div className="rounded-md border border-slate-200 bg-white p-2"><dt className="text-[9px] font-semibold uppercase text-slate-500">Insurer coverage</dt><dd className="mt-0.5 text-[10px] font-semibold text-slate-800">{insuranceConfiguration.coveragePercent ?? selectedPatient.insurance.coveragePercentage}%</dd></div>
                          <div className="rounded-md border border-slate-200 bg-white p-2"><dt className="text-[9px] font-semibold uppercase text-slate-500">General patient copay</dt><dd className="mt-0.5 text-[10px] font-semibold text-slate-800">{insuranceConfiguration.copayPercent ?? 100 - selectedPatient.insurance.coveragePercentage}%</dd></div>
                          <div className="rounded-md border border-slate-200 bg-white p-2"><dt className="text-[9px] font-semibold uppercase text-slate-500">Deductible</dt><dd className="mt-0.5 text-[10px] font-semibold text-slate-800">${(insuranceConfiguration.deductibleAmount ?? deductibleConfigured ?? 0).toFixed(2)}</dd></div>
                        </dl>
                        <div>
                          <h5 className="mb-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-600">Service copay rates</h5>
                          <dl className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                            {([
                              ['Consultation', registeredServiceCopay?.consultation],
                              ['Dental', registeredServiceCopay?.dental],
                              ['Procedure', registeredServiceCopay?.surgicalProcedure ?? registeredServiceCopay?.procedures ?? registeredServiceCopay?.procedure],
                              ['Laboratory', registeredServiceCopay?.lab ?? registeredServiceCopay?.laboratory],
                              ['Radiology', registeredServiceCopay?.radiology],
                              ['Pharmacy', registeredServiceCopay?.pharmacy],
                              ['Emergency', registeredServiceCopay?.emergency],
                            ] as const).map(([label, rate]) => (
                              <div key={label} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5">
                                <dt className="text-[9px] text-slate-600">{label}</dt>
                                <dd className="text-[10px] font-bold text-slate-800">{rate === undefined ? 'Not set' : `${rate}%`}</dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      </>
                    ) : (
                      <p className="rounded-md border border-dashed border-slate-300 bg-white px-2.5 py-3 text-[10px] text-slate-500">
                        {selectedToken?.paymentScheme
                          ? `This visit was registered as ${selectedToken.paymentScheme.schemeType}; no insurance copay configuration applies.`
                          : 'No insurance copay configuration is saved for this patient.'}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Classification Section 2: Itemized Line Charges */}
          <div className="space-y-3 p-3 bg-slate-50 border border-slate-200/80 rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                2. Invoice Review
              </span>
              <span className="text-xs font-mono font-bold text-slate-700">
                Subtotal: ${totalAmount.toFixed(2)}
              </span>
            </div>

            <div className="flex border-b border-slate-200" role="tablist" aria-label="Invoice review">
              <button type="button" role="tab" aria-selected={invoiceReviewTab === 'services'} onClick={() => setInvoiceReviewTab('services')} className={`border-b-2 px-3 py-2 text-[10px] font-semibold ${invoiceReviewTab === 'services' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500'}`}>
                Services ({items.length})
              </button>
              <button type="button" role="tab" aria-selected={invoiceReviewTab === 'approvals'} onClick={() => setInvoiceReviewTab('approvals')} className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[10px] font-semibold ${invoiceReviewTab === 'approvals' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500'}`}>
                <ShieldCheck className="h-3.5 w-3.5" /> Approvals ({patientApprovals.length})
              </button>
            </div>

            {invoiceReviewTab === 'services' ? <div className="space-y-1.5 max-h-64 overflow-y-auto divide-y divide-slate-100 bg-white p-2.5 rounded-lg border border-slate-200">
              {!items.length && <p className="py-3 text-center text-[11px] text-slate-500">Select a visit to load ordered services or add a service below.</p>}
              {items.map((it) => {
                const serviceApproval = findApprovalForItem(it);
                return (
                  <div key={it.id} className={`grid grid-cols-1 gap-2 rounded-md border p-2 sm:grid-cols-[minmax(0,1fr)_65px_100px_auto] sm:items-center ${it.billingStatus === 'Deferred' || (!it.billingStatus || it.billingStatus === 'Pending') ? 'border-rose-200 bg-rose-50' : it.billingStatus === 'Billed' ? 'border-emerald-100 bg-emerald-50/50' : 'border-slate-200'}`}>
                  <div className="min-w-0">
                      <p className={`text-xs font-medium ${it.billingStatus === 'Deferred' ? 'text-rose-900' : 'text-slate-800'}`}>{it.description}</p>
                    <span className={`text-[9px] uppercase ${it.billingStatus === 'Deferred' ? 'font-bold text-rose-700' : it.billingStatus === 'Billed' ? 'text-emerald-700' : 'text-slate-400'}`}>
                      {it.sourceType || it.category}{(it.serviceCode || it.cptCode) ? ` · ${it.serviceCode || it.cptCode}` : ''}{it.billingStatus === 'Deferred' ? ' · Deferred, not billed' : it.billingStatus === 'Billed' ? ' · Already billed' : it.billingStatus === 'Cancelled' ? ' · Cancelled' : ' · Pending, not billed'}
                    </span>
                    {serviceApproval && <span className="mt-1 block text-[9px] font-semibold text-emerald-700">Authorization {serviceApproval.approvalNumber} applied</span>}
                  </div>
                  <label className="text-[9px] text-slate-500">Qty<input aria-label="Service quantity" type="number" min="1" step="1" value={it.quantity} onChange={(event) => updateItem(it.id, { quantity: Number(event.target.value) })} disabled={it.billingStatus === 'Billed'} className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-right font-mono text-xs" /></label>
                    <div className="text-right">
                      <span className="block text-[9px] text-slate-500">Unit price</span>
                      <span className="font-mono text-xs font-semibold text-slate-800">${it.unitCost.toFixed(2)}</span>
                    </div>
                  <div className="flex items-center justify-between gap-2 sm:justify-end">
                    <span className={`font-mono font-bold ${it.billingStatus === 'Deferred' ? 'text-rose-800 line-through' : 'text-slate-900'}`}>${(Number(it.totalPrice ?? it.amount) || 0).toFixed(2)}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveItem(it.id)}
                      disabled={it.billingStatus === 'Billed' || it.billingStatus === 'Cancelled'}
                      className="p-1 text-rose-600 transition hover:text-rose-800 disabled:cursor-not-allowed disabled:opacity-40"
                      title={it.billingStatus === 'Deferred' ? 'Restore service to invoice' : 'Defer service'}
                      aria-label={`${it.billingStatus === 'Deferred' ? 'Restore' : 'Defer'} ${it.description}`}
                    >
                      {it.billingStatus === 'Deferred' ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                );
              })}
            </div> : <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2.5">
              {!patientApprovals.length && <p className="py-3 text-center text-[11px] text-slate-500">No authorization records for this patient or selected encounter.</p>}
              {patientApprovals.map((approval) => {
                const matchingService = getApprovalServiceMatch(approval);
                const alreadyApplied = matchingService?.insuranceApprovalId === approval.id;
                const insurerShare = approval.approvalStatus === 'Approved'
                  ? Math.max(0, approval.approvedAmount - approval.copayAmount)
                  : 0;
                const patientShare = Math.max(0, approval.estimatedCost - insurerShare);
                return (
                <div key={approval.id} className="flex items-start justify-between gap-3 border-b border-slate-100 py-2 last:border-0">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-semibold text-slate-800">{approval.serviceName}</p>
                    <p className="mt-0.5 text-[9px] text-slate-500">{approval.approvalNumber} · {approval.insuranceProvider}{approval.serviceCode ? ` · ${approval.serviceCode}` : ''}</p>
                    {approval.remarks && <p className="mt-0.5 text-[9px] text-slate-500">{approval.remarks}</p>}
                    <p className="mt-1 text-[9px] text-slate-600">${insurerShare.toFixed(2)} insurer · ${patientShare.toFixed(2)} patient</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${approval.approvalStatus === 'Approved' ? 'bg-emerald-50 text-emerald-700' : approval.approvalStatus === 'Rejected' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-800'}`}>{approval.approvalStatus}</span>
                    <p className="font-mono text-[9px] text-slate-600">${approval.estimatedCost.toFixed(2)} authorized service amount</p>
                    <button
                      type="button"
                      onClick={() => applyApprovalToService(approval)}
                      disabled={!isInsuranceInvoice || approval.approvalStatus !== 'Approved' || !matchingService || alreadyApplied}
                      title={!matchingService ? 'No unique service matches this approval code and amount.' : alreadyApplied ? 'This authorization is already applied.' : undefined}
                      className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[9px] font-bold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
                    >
                      {alreadyApplied ? 'Applied' : 'Apply'}
                    </button>
                  </div>
                </div>
                );
              })}
            </div>}

            <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2.5">
              <label className="block text-[10px] font-semibold text-slate-600">
                Add service from hospital inventory
                <input
                  type="search"
                  value={catalogSearch}
                  onChange={(event) => setCatalogSearch(event.target.value)}
                  placeholder="Search service name, code, CPT, or medicine SKU..."
                  className="mt-1 w-full rounded border border-slate-300 bg-slate-50 px-2.5 py-2 text-xs font-normal"
                />
              </label>
              <div className="max-h-40 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-100">
                {serviceCatalogEntries.slice(0, 10).map((entry) => (
                  <button
                    key={`${entry.id}-${entry.code}`}
                    type="button"
                    onClick={() => addCatalogItem(entry)}
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left hover:bg-blue-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[10px] font-semibold text-slate-800">{entry.name}</span>
                      <span className="block truncate text-[9px] text-slate-500">{entry.code}{entry.cptCode ? ` · CPT ${entry.cptCode}` : ''} · {entry.category}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] font-bold text-slate-700">${entry.price.toFixed(2)}</span>
                  </button>
                ))}
                {!serviceCatalogEntries.length && <p className="px-3 py-2 text-[10px] text-slate-500">No matching service in inventory. Ask an administrator to add it.</p>}
              </div>
              {formError && <p role="alert" className="text-[10px] font-semibold text-rose-700">{formError}</p>}
            </div>
          </div>

          {/* Classification Section 3: Financial Settlement & Due Amount */}
          <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 border border-slate-200/80 rounded-xl items-center">
            {isInsuranceInvoice ? (
              <>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2.5">
                  <span className="block text-[9px] font-semibold uppercase text-emerald-800">Approved insurance share</span>
                  <span className="mt-1 block font-mono text-sm font-bold text-emerald-900">${invoiceInsuranceCovered.toFixed(2)}</span>
                  <span className="mt-1 block text-[9px] text-emerald-800">Only matched, approved authorizations are credited.</span>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5">
                  <span className="block text-[9px] font-semibold uppercase text-amber-800">Registered copay</span>
                  <span className="mt-1 block font-mono text-sm font-bold text-amber-900">${invoiceCopay.toFixed(2)}</span>
                  <span className="mt-1 block text-[9px] text-amber-800">Calculated from the patient’s registered service copay.</span>
                </div>
              </>
            ) : (
              <div className="col-span-2 rounded-lg border border-slate-200 bg-white p-2.5">
                <span className="block text-[9px] font-semibold uppercase text-slate-500">Registered payment mode</span>
                <span className="mt-1 block text-xs font-bold text-slate-800">
                  {paymentScheme?.schemeType === 'Discount Card' ? 'Discount Card' : 'Self-Pay'}
                </span>
              </div>
            )}
            {isInsuranceInvoice && (
              <div className="col-span-2 flex justify-between text-[10px] text-slate-600">
                <span>Patient deductible</span><span className="font-mono">${invoiceDeductible.toFixed(2)}</span>
              </div>
            )}
            {invoiceDiscountAmount > 0 && (
              <div className="col-span-2 flex justify-between text-[10px] text-emerald-700">
                <span>Discount ({discountPercent}%)</span><span className="font-mono">−${invoiceDiscountAmount.toFixed(2)}</span>
              </div>
            )}
            {isInsuranceInvoice && hasPendingApproval && (
              <div className="col-span-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] text-amber-900">
                Authorization is pending review. No pending amount has been deducted from the patient balance.
              </div>
            )}
            <div className="bg-blue-50/80 border border-blue-200 rounded-xl p-3 text-right">
              <span className="text-[10px] text-blue-700 uppercase font-semibold block tracking-wider">
                Patient Balance Due
              </span>
              <span className="text-lg font-bold font-mono text-blue-900">
                ${(Number(balanceDue) || 0).toFixed(2)}
              </span>
            </div>
          </div>
          {balanceDue > 0 && (
            <label className="block text-[10px] font-semibold text-slate-600">
              Patient due remark <span className="text-rose-600">* required to issue</span>
              <textarea
                value={dueRemarks}
                onChange={(event) => setDueRemarks(event.target.value)}
                rows={2}
                maxLength={500}
                placeholder="Reason or details for the balance due..."
                className="mt-1 w-full resize-y rounded-lg border border-slate-300 bg-white p-2 text-xs font-normal"
              />
            </label>
          )}

          {/* Footer Controls */}
          {formError && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs font-semibold text-rose-800">{formError}</p>}
          <div className="pt-3 border-t border-slate-200 flex items-center justify-between">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold text-xs cursor-pointer transition"
            >
              Cancel
            </button>
            <div className="flex gap-2">
              <button type="submit" name="invoiceAction" value="draft" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Save draft</button>
              <button type="submit" name="invoiceAction" value="issue" className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-semibold text-xs shadow-xs flex items-center gap-1.5 cursor-pointer transition">
                <CheckCircle2 className="w-4 h-4" />
                <span>Issue invoice</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
