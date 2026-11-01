// Human wording for status codes, shared by the app and the server's report exports so both say the same thing.

export const VERIFICATION_LABELS = {
  not_applicable: 'Not registered yet',
  not_yet_verified: 'Not yet verified',
  verified: 'Verified',
  due: 'Verification due',
  overdue: 'Verification overdue',
} as const;

export const MISSING_LABELS = {
  none: 'Not missing',
  reported_missing: 'Reported missing',
  confirmed_missing: 'Confirmed missing',
} as const;

export const FLAG_LABELS = {
  location_discrepancy: 'Found in a different location',
  cross_department_move: 'Moved to another department',
  reported_missing: 'Reported missing',
  found_after_missing: 'Found after being missing',
  late_event: 'Recorded late (possibly offline)',
} as const;

export const MAINTENANCE_STATUS_LABELS = {
  submitted: 'Submitted',
  under_review: 'Under review',
  approved: 'Approved',
  in_progress: 'In progress',
  awaiting_parts: 'Awaiting parts',
  awaiting_external: 'Awaiting external service',
  completed: 'Completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
} as const;

export const PRIORITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' } as const;

export const OUTCOME_LABELS = {
  repaired: 'Repaired',
  partially_repaired: 'Partially repaired',
  replaced_part: 'Part replaced',
  no_fault_found: 'No fault found',
  not_repairable: 'Not repairable',
} as const;

export const COST_KIND_LABELS: Record<string, string> = {
  parts: 'Parts',
  labour: 'Labour',
  external_service: 'External service',
  other: 'Other',
};

export const REVIEW_STATUS_LABELS = {
  not_reviewed: 'Not reviewed yet',
  approved: 'Review approved',
  returned_for_correction: 'Returned for correction',
  corrected_awaiting_rereview: 'Corrected — awaiting re-review',
} as const;

/** Plain names for asset fields (review requests and corrections). */
export const FIELD_LABELS: Record<string, string> = {
  name: 'Name', description: 'Description', categoryId: 'Category', manufacturer: 'Manufacturer', model: 'Model',
  serialNumber: 'Serial number', manufacturerBarcode: 'Manufacturer barcode', departmentId: 'Department', locationId: 'Location',
  acquisitionDate: 'Acquisition date', acquisitionMethod: 'Acquisition method', acquisitionCost: 'Acquisition cost', currency: 'Currency',
  costStatus: 'Cost status', costExceptionReason: 'Unknown-cost reason', supplier: 'Supplier', purchaseOrderRef: 'Purchase order',
  warrantyExpiry: 'Warranty expiry', condition: 'Condition', notes: 'Notes',
  assignedTo: 'Assigned staff member', usageStatus: 'Asset status',
};
