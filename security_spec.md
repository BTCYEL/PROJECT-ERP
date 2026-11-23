# Maximus Barbecue ERP — Security Specification (Phase 0)

## 1. Data Invariants
1. **Authentication & Verified Email**: All reads and writes require `request.auth != null` and `request.auth.token.email_verified == true`.
2. **Workspace Ownership & Isolation**: Every ERP document must carry `ownerUid == request.auth.uid` on creation and preserve `ownerUid` and `createdAt` immutably on update.
3. **Path Variable Hardening**: Every document ID path parameter must pass `isValidId(id)` (`^[a-zA-Z0-9_-]{1,128}$`) on `get`, `create`, `update`, and `delete`.
4. **No Shadow Fields**: Every `isValid[Entity](data)` function enforces strict `data.keys().hasAll(...)` and `data.keys().hasOnly(...)` allowlists.
5. **Bounded Types & Sizes**: Every string enforces explicit `.size() <= MAX` limits; every array enforces `.size() <= MAX` and validates element types.
6. **Temporal Integrity**: `createdAt == request.time` on creation and `updatedAt == request.time` on mutable updates.
7. **PII & Role Escalation Prevention**: `/users/{uid}` restricts self-creation to `role == 'member'` and forbids self-updating `role`; PII collections (`erp_users`, `employees`, `customers`, `suppliers`) restrict `list` and `get` strictly to `resource.data.ownerUid == request.auth.uid || isBootstrapAdmin()`.
8. **Terminal State Locking**: Finalized `sales` (`REFUNDED`/`VOID`), `purchase_orders` (`RECEIVED`/`CANCELLED`), `supplier_invoices` (`PAID`), and `payroll_runs` (`PAID`) cannot transition further by non-admin callers.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read/Write**: Missing `request.auth` on `/products/prd_1` -> `PERMISSION_DENIED`.
2. **Unverified Email Write**: `email_verified: false` attempting `create` on `/categories/cat_1` -> `PERMISSION_DENIED`.
3. **Identity Spoofing on Create**: User `uid_attacker` creating `/products/prd_x` with `ownerUid: "uid_victim"` -> `PERMISSION_DENIED`.
4. **Privilege Escalation on Profile**: User `uid_user` creating `/users/uid_user` with `role: "admin"` -> `PERMISSION_DENIED`.
5. **Shadow Field Injection**: Creating `/products/prd_x` with extra field `isVerified: true` -> `PERMISSION_DENIED`.
6. **ID Poisoning Attack**: Writing `/categories/cat_..%2F..%2F` or a 300-char ID -> `PERMISSION_DENIED`.
7. **Timestamp Forgery**: Creating `/products/prd_x` with client-forged `createdAt: "2020-01-01T00:00:00Z"` instead of `request.time` -> `PERMISSION_DENIED`.
8. **Immortal Field Tampering**: Updating `/products/prd_1` while mutating `ownerUid` or `createdAt` -> `PERMISSION_DENIED`.
9. **Type & Value Poisoning**: Updating `/products/prd_1` with `basePrice: "free"` or 100KB `name` string -> `PERMISSION_DENIED`.
10. **Cross-Tenant List Scraping**: User `uid_attacker` running `list` on `/erp_users` without `ownerUid == request.auth.uid` -> `PERMISSION_DENIED`.
11. **Terminal State Bypass**: Non-admin updating `/sales/sale_1` after `status == 'REFUNDED'` -> `PERMISSION_DENIED`.
12. **Immutable Ledger Modification**: Attempting `update` on `/audit_logs/log_1` or `/journal_entries/je_1` -> `PERMISSION_DENIED`.
