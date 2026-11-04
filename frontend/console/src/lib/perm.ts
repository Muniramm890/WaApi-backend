import type { StaffRole } from '../api/types';
// Mirrors the backend role checks (super_admin passes everything).
export const can = {
  manageTenants: (r?: StaffRole) => r === 'super_admin' || r === 'support',
  deleteTenant: (r?: StaffRole) => r === 'super_admin',
  billing: (r?: StaffRole) => r === 'super_admin' || r === 'finance',
  admin: (r?: StaffRole) => r === 'super_admin',
};
