/**
 * Dirty Dozen Security Rule Verification Spec for Maximus Barbecue ERP.
 * Documents expected PERMISSION_DENIED invariants verified against firestore.rules.
 */
export interface AdversarialTestCase {
  id: string;
  pillar: string;
  collection: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  payload: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_CASES: AdversarialTestCase[] = [
  {
    id: 'DD-01',
    pillar: 'Master Auth Gate',
    collection: 'products',
    operation: 'get',
    payload: { auth: null },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-02',
    pillar: 'Verified Email Enforcement',
    collection: 'categories',
    operation: 'create',
    payload: { email_verified: false, name: 'Spoof Category' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-03',
    pillar: 'Identity Integrity',
    collection: 'products',
    operation: 'create',
    payload: { ownerUid: 'victim_uid', name: 'Hijacked Item' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-04',
    pillar: 'Privilege Escalation Guard',
    collection: 'users',
    operation: 'create',
    payload: { uid: 'attacker_uid', role: 'admin' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-05',
    pillar: 'Anti-Shadow-Field Gate',
    collection: 'products',
    operation: 'create',
    payload: { ownerUid: 'attacker_uid', isVerified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-06',
    pillar: 'Path Variable Hardening',
    collection: 'categories',
    operation: 'create',
    payload: { docId: 'invalid/id$poison', name: 'Bad ID' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-07',
    pillar: 'Temporal Integrity',
    collection: 'products',
    operation: 'create',
    payload: { createdAt: '2020-01-01T00:00:00Z' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-08',
    pillar: 'Immortal Field Rule',
    collection: 'products',
    operation: 'update',
    payload: { ownerUid: 'different_uid' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-09',
    pillar: 'Value Poisoning Guard',
    collection: 'products',
    operation: 'update',
    payload: { basePrice: 'NaN_string' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-10',
    pillar: 'PII & Query Enforcer',
    collection: 'erp_users',
    operation: 'list',
    payload: { filterOwnerUid: 'other_uid' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-11',
    pillar: 'Terminal State Locking',
    collection: 'sales',
    operation: 'update',
    payload: { existingStatus: 'REFUNDED', kdsStatus: 'READY' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-12',
    pillar: 'Immutable Ledger Protection',
    collection: 'audit_logs',
    operation: 'update',
    payload: { action: 'TAMPERED_ACTION' },
    expectedResult: 'PERMISSION_DENIED',
  },
];
