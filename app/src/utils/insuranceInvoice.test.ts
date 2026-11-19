import assert from 'node:assert/strict';
import test from 'node:test';
import { BillItem, InsuranceApproval } from '../types';
import { applyApprovedInsuranceBreakdown, applyDiscountBreakdown, findApplicableInsuranceApproval } from './insuranceInvoice';

const invoiceItem: BillItem = {
  id: 'line-1',
  serviceCode: 'CPT-1',
  sourceServiceId: 'service-1',
  sourceEncounterTokenId: 'token-1',
  description: 'Complete blood count',
  category: 'Lab Test',
  unitCost: 100,
  quantity: 1,
  amount: 100,
};

const approval: InsuranceApproval = {
  id: 'approval-1',
  patientId: 'patient-1',
  patientName: 'Example Patient',
  patientMrn: 'MRN-1',
  insuranceProvider: 'Example Health',
  policyNumber: 'POL-1',
  approvalNumber: 'AUTH-1',
  doctorId: 'doctor-1',
  doctorName: 'Dr. Example',
  department: 'Laboratory',
  serviceCategory: 'Lab Test',
  serviceName: invoiceItem.description,
  serviceCode: 'CPT-1',
  estimatedCost: 100,
  approvedAmount: 80,
  copayPercentage: 20,
  copayAmount: 20,
  approvalStatus: 'Approved',
  approvalDate: '2026-10-24',
  validUntil: '2026-11-24',
  authorisedBy: 'Reviewer',
  serviceRecordId: 'service-1',
};

test('approved authorization applies insurer and patient shares from the approved service amount', () => {
  const [item] = applyApprovedInsuranceBreakdown(
    [{ ...invoiceItem, insuranceApprovalId: approval.id }],
    [approval]
  );

  assert.equal(item.insuranceAmount, 60);
  assert.equal(item.copayAmount, 20);
  assert.equal(item.amount! - item.insuranceAmount!, 40);
  assert.equal(item.netAmount, 100);
});

test('registered deductible and service copay are applied before insurance coverage', () => {
  const [item] = applyApprovedInsuranceBreakdown(
    [{ ...invoiceItem, insuranceApprovalId: approval.id }],
    [{ ...approval, approvedAmount: 90, copayAmount: 5 }],
    20,
    { consultation: 0, lab: 10, radiology: 0, pharmacy: 0, surgicalProcedure: 0, emergency: 0 },
    20
  );

  assert.equal(item.deductibleAmount, 20);
  assert.equal(item.copayAmount, 8);
  assert.equal(item.insuranceAmount, 72);
});

test('pending authorization does not reduce the patient balance', () => {
  const [item] = applyApprovedInsuranceBreakdown(
    [{ ...invoiceItem, insuranceApprovalId: approval.id }],
    [{ ...approval, approvalStatus: 'Pending', approvedAmount: 0, copayAmount: 0 }]
  );

  assert.equal(item.insuranceAmount, 0);
  assert.equal(item.copayAmount, 0);
});

test('approved coverage and copay are capped at the line total', () => {
  const [item] = applyApprovedInsuranceBreakdown(
    [{ ...invoiceItem, insuranceApprovalId: approval.id }],
    [{ ...approval, approvedAmount: 120, copayAmount: 130 }]
  );

  assert.equal(item.insuranceAmount, 0);
  assert.equal(item.copayAmount, 100);
});

test('authorization only matches the same patient, service code, amount, and linked service', () => {
  const service = { ...invoiceItem, insuranceApprovalId: undefined };

  assert.equal(findApplicableInsuranceApproval(service, [approval], 'patient-1', 'token-1'), approval);
  assert.equal(findApplicableInsuranceApproval(service, [approval], 'another-patient', 'token-1'), undefined);
  assert.equal(findApplicableInsuranceApproval(service, [{ ...approval, serviceCode: 'CPT-2' }], 'patient-1', 'token-1'), undefined);
  assert.equal(findApplicableInsuranceApproval(service, [{ ...approval, estimatedCost: 101 }], 'patient-1', 'token-1'), undefined);
  assert.equal(findApplicableInsuranceApproval(service, [{ ...approval, serviceRecordId: 'another-service' }], 'patient-1', 'token-1'), undefined);
});

test('one authorization is not credited more than once across invoice lines', () => {
  const items = applyApprovedInsuranceBreakdown(
    [
      { ...invoiceItem, id: 'line-1', insuranceApprovalId: approval.id },
      { ...invoiceItem, id: 'line-2', insuranceApprovalId: approval.id },
    ],
    [approval]
  );

  assert.equal(items.reduce((sum, item) => sum + (item.insuranceAmount || 0), 0), 60);
  assert.equal(items.reduce((sum, item) => sum + (item.copayAmount || 0), 0), 20);
});

test('discount-card reduction is calculated per service line', () => {
  const [item] = applyDiscountBreakdown([invoiceItem], 15);

  assert.equal(item.amount, 100);
  assert.equal(item.discountAmount, 15);
  assert.equal(item.netAmount, 85);
  assert.equal(item.insuranceAmount, 0);
});