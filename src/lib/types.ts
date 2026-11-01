import type {
  AcquisitionMethod,
  Condition,
  CostStatus,
  RegistrationStatus,
  UsageStatus,
} from '@shared/asset-codes';

export type Role = 'SYSTEM_ADMIN' | 'ASSET_MANAGER' | 'DEPARTMENT_STAFF';

export const ROLE_LABELS: Record<Role, string> = {
  SYSTEM_ADMIN: 'System Administrator',
  ASSET_MANAGER: 'Asset Management Team',
  DEPARTMENT_STAFF: 'Department Staff',
};

export type DepartmentRef = { id: string; name: string; code?: string };

export type FacultyRef = { id: string; name: string };

export type Faculty = FacultyRef & { code: string; isActive: boolean; sortOrder: number };

/** A school or unit. `faculty: null` = a central administrative unit (e.g. the Library). */
export type Department = DepartmentRef & {
  code: string;
  defaultCurrency: string;
  isActive: boolean;
  maintenanceRequiresApproval?: boolean;
  faculty: FacultyRef | null;
};

export type Me = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  department: DepartmentRef | null;
  grants: { departmentId: string; departmentName: string; level: 'read' | 'operate'; expiresAt: string | null }[];
  /** Permission → 'all' or list of department ids. For UI only; the server re-checks everything. */
  permissions: Record<string, 'all' | string[]>;
};

export type Paged<T> = { page: number; pageSize: number; total: number; items: T[] };

export type AccessRequest = {
  id: string;
  fullName: string;
  email: string;
  department: DepartmentRef;
  requestedRole: Role;
  justification: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  decisionNote: string | null;
};

export type UserSummary = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  department: DepartmentRef | null;
  status: 'active' | 'deactivated';
  passwordSet: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  deactivatedAt: string | null;
  deactivationReason: string | null;
};

export type Grant = {
  id: string;
  department: DepartmentRef;
  accessLevel: 'read' | 'operate';
  reason: string;
  grantedAt: string;
  grantedBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
};

// ----- Phase 2: assets -----

export type Category = { id: string; name: string; description: string | null; isActive: boolean };

export type Location = { id: string; departmentId: string; building: string; room: string; description: string | null; isActive: boolean };

export type Asset = {
  id: string;
  institutionalId: string;
  qrPayload: string;
  name: string;
  description: string | null;
  category: { id: string; name: string };
  manufacturer: string | null;
  model: string | null;
  /** Older records only: no longer asked for at registration. */
  serialNumber: string | null;
  manufacturerBarcode: string | null;
  department: { id: string; name: string; code: string };
  /** From the owning school; null = a central administrative unit. */
  faculty: FacultyRef | null;
  location: { id: string; building: string; room: string };
  assignedTo: string | null;
  usageStatus: UsageStatus;
  acquisitionDate: string;
  acquisitionMethod: AcquisitionMethod;
  /** null when the user may not see financial details for this department. */
  financial: {
    acquisitionCost: string | null;
    currency: string;
    costStatus: CostStatus;
    costExceptionReason: string | null;
    supplier: string | null;
    purchaseOrderRef: string | null;
  } | null;
  warrantyExpiry: string | null;
  notes: string | null;
  condition: Condition;
  registrationStatus: RegistrationStatus;
  registeredAt: string | null;
  registeredBy: string | null;
  labelPrintCount: number;
  lastPrintedAt: string | null;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  archived: { at: string; by: string; reason: string } | null;
  verification: {
    status: VerificationStatus;
    dueDate: string | null;
    overdueDays: number | null;
    intervalDays: number | null;
    dueWindowDays: number | null;
    lastVerifiedAt: string | null;
    lastVerifiedBy: string | null;
    lastVerifiedLocation: { id: string; building: string; room: string } | null;
  };
  missing: {
    status: MissingStatus;
    reportedAt: string | null;
    reportedBy: string | null;
    reason: string | null;
    confirmedAt: string | null;
    confirmedBy: string | null;
  };
  openFlags: number;
  openMaintenance: number;
  review: {
    status: ReviewStatus;
    last: { action: 'approved' | 'returned' | 'corrections_submitted'; note: string | null; fields: string[]; by: string; at: string } | null;
  };
  can: {
    edit: boolean;
    review: boolean;
    submitCorrections: boolean;
    printLabel: boolean;
    confirmLabel: boolean;
    archive: boolean;
    restore: boolean;
    verify: boolean;
    move: boolean;
    reportMissing: boolean;
    confirmMissing: boolean;
    clearMissing: boolean;
    recordCondition: boolean;
    requestMaintenance: boolean;
  };
};

export type ReviewStatus = 'not_reviewed' | 'approved' | 'returned_for_correction' | 'corrected_awaiting_rereview';
export type ReviewEntry = {
  id: string;
  action: 'approved' | 'returned' | 'corrections_submitted';
  note: string | null;
  fields: string[];
  changes: Record<string, { before: unknown; after: unknown }> | null;
  at: string;
  by: string;
};

// ----- Phase 3: verification and movement -----

export type VerificationStatus = 'not_applicable' | 'not_yet_verified' | 'verified' | 'due' | 'overdue';
export type MissingStatus = 'none' | 'reported_missing' | 'confirmed_missing';

type Place = { building: string; room: string; department: string };

export type Verification = {
  id: string;
  eventTime: string;
  receivedAt: string;
  outcome: 'verified' | 'location_discrepancy';
  method: 'scan' | 'manual';
  notes: string | null;
  verifiedBy: string;
  observedLocation: Place;
  expectedLocation: { building: string; room: string };
};

export type Movement = {
  id: string;
  eventTime: string;
  receivedAt: string;
  reason: string | null;
  source: 'relocation' | 'verification';
  movedBy: string;
  from: Place;
  to: Place;
};

export type FlagKind = 'location_discrepancy' | 'cross_department_move' | 'reported_missing' | 'found_after_missing' | 'late_event';

export type Flag = {
  id: string;
  kind: FlagKind;
  status: 'open' | 'resolved';
  details: Record<string, unknown>;
  createdAt: string;
  createdBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  asset: { id: string; institutionalId: string; name: string; department: string };
  canResolve: boolean;
};

export type Schedule = {
  id: string;
  department: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  intervalDays: number;
  dueWindowDays: number;
  notes: string | null;
  isActive: boolean;
  updatedAt: string;
};

export type AssetHistory = {
  events: {
    id: string;
    occurredAt: string;
    action: string;
    outcome: string;
    actor: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    context: Record<string, unknown> | null;
  }[];
  labelPrints: { printedAt: string; printedBy: string; copies: number; layout: string; isReprint: boolean; reason: string | null }[];
};

// ----- Phase 4: condition and maintenance -----

export type Attachment = { id: string; ownerId: string; fileName: string; contentType: string; sizeBytes: number; uploadedAt: string; uploadedBy: string };

export type ConditionEvent = {
  id: string;
  eventTime: string;
  receivedAt: string;
  previousCondition: Condition;
  newCondition: Condition;
  source: 'condition_update' | 'damage_report' | 'maintenance_confirmation';
  damageDescription: string | null;
  notes: string | null;
  recordedBy: string;
  maintenance: { id: string; reference: string } | null;
  attachments: Attachment[];
};

export type MaintenanceStatus =
  | 'submitted' | 'under_review' | 'approved' | 'in_progress' | 'awaiting_parts' | 'awaiting_external' | 'completed' | 'rejected' | 'cancelled';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type Outcome = 'repaired' | 'partially_repaired' | 'not_repairable' | 'no_fault_found' | 'replaced_part';

export type MaintenanceRequest = {
  id: string;
  reference: string;
  asset: { id: string; institutionalId: string; name: string; condition: Condition };
  department: { id: string; name: string };
  reportedBy: string;
  reportedAt: string;
  problem: string;
  conditionAtReport: Condition;
  priority: Priority;
  status: MaintenanceStatus;
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  provider: { type: 'internal' | 'external'; name: string; contact: string | null } | null;
  workPerformed: string | null;
  outcome: Outcome | null;
  completedAt: string | null;
  completedBy: string | null;
  closingReason: string | null;
  resultingCondition: Condition | null;
  conditionConfirmedBy: string | null;
  conditionConfirmedAt: string | null;
  version: number;
  can: {
    changeStatus: boolean;
    nextStatuses: MaintenanceStatus[];
    approve: boolean;
    complete: boolean;
    confirmCondition: boolean;
    addCost: boolean;
    attach: boolean;
  };
};

export type MaintenanceDetail = MaintenanceRequest & {
  history: { from: MaintenanceStatus | null; to: MaintenanceStatus; at: string; by: string; note: string | null }[];
  /** null when the viewer may not see financial details. */
  costs: { id: string; kind: string; description: string; amount: string; currency: string; invoiceRef: string | null; recordedAt: string; recordedBy: string }[] | null;
  costTotals: { currency: string; amount: string }[] | null;
  attachments: Attachment[];
};

// ----- Phase 5 -----

export type CurrencyTotal = { currency: string; total: string };

export type Dashboard = {
  generatedAt: string;
  timeZone: string;
  filters: { departmentId?: string; categoryId?: string; condition?: string; periodDays: number };
  totals: {
    assets: number;
    registered: number;
    awaitingLabel: number;
    draft: number;
    value: (CurrencyTotal & { recorded: number; verifiedZero: number; unknownCost: number })[];
    valueRestricted: number;
  };
  verification: {
    registered: number;
    verified: number;
    notYetVerified: number;
    due: number;
    overdue: number;
    noSchedule: number;
    reportedMissing: number;
    confirmedMissing: number;
    verifiedInPeriod: number;
    periodDays: number;
  };
  condition: {
    byCondition: Record<string, number>;
    maintenance: null | {
      open: number;
      byStatus: Record<string, number>;
      byPriority: Record<Priority, number>;
      awaitingConfirmation: number;
      damagedWithoutRequest: number;
      openCosts: CurrencyTotal[];
      openCostsRestricted: boolean;
    };
  };
  /** One row per faculty, plus "Central administration" (id null) for units without a faculty. */
  faculties: {
    id: string | null;
    name: string;
    departments: number;
    assets: number;
    registered: number;
    damaged: number;
    overdue: number;
    missing: number;
    byCondition: Record<Condition, number>;
    value: CurrencyTotal[];
    /** Some departments in this faculty were left out of `value` (no financial access). */
    valuePartial: boolean;
  }[];
  departments: {
    id: string;
    code: string;
    name: string;
    faculty: FacultyRef | null;
    assets: number;
    registered: number;
    verified: number;
    notYetVerified: number;
    due: number;
    overdue: number;
    missing: number;
    damaged: number;
    openMaintenance: number | null;
    value: CurrencyTotal[] | null;
  }[];
  accessRequests: { restricted: true } | { restricted: false; pending: number; oldestAt: string | null };
};

export type ReportKind = 'asset-register' | 'department-summary' | 'verification' | 'maintenance';
export type ReportColumn = { label: string; kind?: 'text' | 'int' | 'money' | 'date' | 'datetime'; width?: number };
export type ReportTable = { title: string; columns: ReportColumn[]; rows: (string | number | null)[][]; totalRows: number; emptyText?: string };
export type Report = {
  kind: ReportKind;
  title: string;
  generatedAt: string;
  generatedBy: string;
  timeZone: string;
  filters: [string, string][];
  notes: string[];
  tables: ReportTable[];
};
