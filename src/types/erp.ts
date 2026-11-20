export type RoleCode =
  | 'SUPER_ADMIN'
  | 'BUSINESS_OWNER'
  | 'OPERATIONS_MANAGER'
  | 'FINANCE_MANAGER'
  | 'INVENTORY_MANAGER'
  | 'PURCHASING_OFFICER'
  | 'FOOD_TRUCK_MANAGER'
  | 'CASHIER'
  | 'KITCHEN_STAFF'
  | 'HR_MANAGER';

export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard:view',
  POS_SELL: 'pos:sell',
  POS_REFUND: 'pos:refund',
  KDS_MANAGE: 'kds:manage',
  PRODUCT_MANAGE: 'product:manage',
  INVENTORY_VIEW: 'inventory:view',
  INVENTORY_ADJUST: 'inventory:adjust',
  PO_CREATE: 'po:create',
  PO_APPROVE: 'po:approve',
  GRN_RECEIVE: 'grn:receive',
  FINANCE_VIEW: 'finance:view',
  JOURNAL_POST: 'journal:post',
  DAILY_CLOSE: 'daily:close',
  HR_MANAGE: 'hr:manage',
  PAYROLL_RUN: 'payroll:run',
  FLEET_MANAGE: 'fleet:manage',
  CRM_MANAGE: 'crm:manage',
  REPORTS_VIEW: 'reports:view',
  SETTINGS_ADMIN: 'settings:admin',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  roleCode: RoleCode;
  roleName: string;
  permissions: string[];
  assignedLocationId?: string | null;
  avatarUrl?: string | null;
}

export interface LocationRow {
  id: string;
  code: string;
  name: string;
  type: 'COMMISSARY' | 'WAREHOUSE' | 'FOOD_TRUCK' | 'POPUP_SITE';
  address: string;
  is_active: number;
}
