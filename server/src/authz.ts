// Role + department-scope authorisation. This is the single source of truth; see docs/access-control.md.

export const ROLES = ['SYSTEM_ADMIN', 'ASSET_MANAGER', 'DEPARTMENT_STAFF'] as const;
export type Role = (typeof ROLES)[number];

type Scope = 'all' | 'own';

const MATRIX = {
  'users.manage': { SYSTEM_ADMIN: 'all' },
  'access_requests.review': { SYSTEM_ADMIN: 'all' },
  'departments.manage': { SYSTEM_ADMIN: 'all' },
  'settings.manage': { SYSTEM_ADMIN: 'all' },
  'scope_grants.manage': { SYSTEM_ADMIN: 'all' },
  'audit.read': { SYSTEM_ADMIN: 'all' },
  'departments.read': { SYSTEM_ADMIN: 'all', ASSET_MANAGER: 'all', DEPARTMENT_STAFF: 'all' },
  'assets.read': { SYSTEM_ADMIN: 'all', ASSET_MANAGER: 'all', DEPARTMENT_STAFF: 'own' },
  'assets.read_financial': { SYSTEM_ADMIN: 'all', ASSET_MANAGER: 'all', DEPARTMENT_STAFF: 'own' },
  'assets.register': { SYSTEM_ADMIN: 'all', DEPARTMENT_STAFF: 'own' },
  'assets.edit': { SYSTEM_ADMIN: 'all', DEPARTMENT_STAFF: 'own' },
  // Archive ("delete") a record that has not completed registration (e.g. entered by mistake).
  'assets.archive': { SYSTEM_ADMIN: 'all', DEPARTMENT_STAFF: 'own' },
  // Archive a fully registered asset, or restore any archived asset: administrators only.
  'assets.archive_registered': { SYSTEM_ADMIN: 'all' },
  'assets.restore': { SYSTEM_ADMIN: 'all' },
  'labels.print': { SYSTEM_ADMIN: 'all', DEPARTMENT_STAFF: 'own' },
  'locations.manage': { SYSTEM_ADMIN: 'all', DEPARTMENT_STAFF: 'own' },
  'categories.manage': { SYSTEM_ADMIN: 'all' },
  'assets.review': { SYSTEM_ADMIN: 'all', ASSET_MANAGER: 'all' },
  'verification.record': { SYSTEM_ADMIN: 'all', DEPARTMENT_STAFF: 'own' },
  'movement.record': { SYSTEM_ADMIN: 'all', DEPARTMENT_STAFF: 'own' },
  'condition.record': { SYSTEM_ADMIN: 'all', DEPARTMENT_STAFF: 'own' },
  // Phase 4 — maintenance is managed by each department (no central maintenance team).
  // Approval (only where a department turns it on) may not be given by the person who reported the request.
  'maintenance.approve': { SYSTEM_ADMIN: 'all', DEPARTMENT_STAFF: 'own' },
  // Phase 3
  'missing.report': { SYSTEM_ADMIN: 'all', DEPARTMENT_STAFF: 'own' },
  'missing.confirm': { SYSTEM_ADMIN: 'all', ASSET_MANAGER: 'all' },
  'flags.read': { SYSTEM_ADMIN: 'all', ASSET_MANAGER: 'all', DEPARTMENT_STAFF: 'own' },
  'flags.review': { SYSTEM_ADMIN: 'all', ASSET_MANAGER: 'all' },
  'schedules.manage': { SYSTEM_ADMIN: 'all' },
  'maintenance.manage': { SYSTEM_ADMIN: 'all', DEPARTMENT_STAFF: 'own' },
  'maintenance.read': { SYSTEM_ADMIN: 'all', ASSET_MANAGER: 'all', DEPARTMENT_STAFF: 'own' },
  'dashboard.read': { SYSTEM_ADMIN: 'all', ASSET_MANAGER: 'all', DEPARTMENT_STAFF: 'own' },
  'reports.generate': { SYSTEM_ADMIN: 'all', ASSET_MANAGER: 'all', DEPARTMENT_STAFF: 'own' },
} as const satisfies Record<string, Partial<Record<Role, Scope>>>;

export type Permission = keyof typeof MATRIX;
export const PERMISSIONS = Object.keys(MATRIX) as Permission[];

/** Permissions that a 'read' scope grant extends to another department. 'operate' grants extend all 'own' permissions. */
const READ_GRANT_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'assets.read',
  'maintenance.read',
  'dashboard.read',
  'reports.generate',
  'flags.read',
]);

export type Grant = { departmentId: string; level: 'read' | 'operate' };

export type Principal = {
  id: string;
  role: Role;
  departmentId: string | null;
  grants: Grant[];
};

function scopeOf(p: Principal, perm: Permission): Scope | undefined {
  return (MATRIX[perm] as Partial<Record<Role, Scope>>)[p.role];
}

/** True if the principal holds the permission for at least one department (or globally). */
export function hasPermission(p: Principal, perm: Permission): boolean {
  return scopeOf(p, perm) !== undefined;
}

/** Departments the principal may act on for this permission: 'all', or an explicit list (possibly empty). */
export function departmentScope(p: Principal, perm: Permission): 'all' | string[] {
  const scope = scopeOf(p, perm);
  if (scope === 'all') return 'all';
  if (scope !== 'own') return [];
  const ids = new Set<string>();
  if (p.departmentId) ids.add(p.departmentId);
  for (const g of p.grants) {
    if (g.level === 'operate' || READ_GRANT_PERMISSIONS.has(perm)) ids.add(g.departmentId);
  }
  return [...ids];
}

/** True if the principal may perform `perm` on a record owned by `departmentId`. */
export function can(p: Principal, perm: Permission, departmentId?: string | null): boolean {
  const scope = departmentScope(p, perm);
  if (scope === 'all') return true;
  if (departmentId === undefined) return scope.length > 0;
  if (departmentId === null) return false;
  return scope.includes(departmentId);
}

/** List of permissions with their scope, for the client to adapt its UI (display only; server re-checks). */
export function describePermissions(p: Principal): Record<string, 'all' | string[]> {
  const out: Record<string, 'all' | string[]> = {};
  for (const perm of PERMISSIONS) {
    const s = departmentScope(p, perm);
    if (s === 'all' || s.length > 0) out[perm] = s;
  }
  return out;
}
