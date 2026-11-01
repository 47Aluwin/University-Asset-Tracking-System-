import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { DateField } from '@/components/date-field';
import { ProductBarcodeScanner } from '@/components/product-barcode-scanner';
import { Body, Button, Card, Choice, Field, Heading, Loading, Notice, Row, SearchableChoice } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Asset, Category, Location } from '@/lib/types';
import { useDepartments } from '@/lib/use-departments';
import { useFaculties } from '@/lib/use-faculties';
import { useQuery } from '@/lib/use-query';
import {
  ACQUISITION_METHOD_LABELS,
  ACQUISITION_METHODS,
  CONDITION_LABELS,
  CONDITIONS,
  COST_STATUS_LABELS,
  COST_STATUSES,
  USAGE_STATUS_LABELS,
  USAGE_STATUSES,
  type AcquisitionMethod,
  type Condition,
  type CostStatus,
  type UsageStatus,
} from '@shared/asset-codes';

/** Faculty picker value for schools/units that belong to no faculty. */
const CENTRAL = 'central';
const CENTRAL_LABEL = 'Central administration (no faculty)';

type FormState = {
  name: string;
  description: string;
  categoryId: string | null;
  manufacturer: string;
  model: string;
  manufacturerBarcode: string;
  departmentId: string | null;
  locationId: string | null;
  acquisitionDate: string;
  acquisitionMethod: AcquisitionMethod;
  costStatus: CostStatus;
  acquisitionCost: string;
  currency: string;
  costExceptionReason: string;
  supplier: string;
  purchaseOrderRef: string;
  warrantyExpiry: string;
  notes: string;
  condition: Condition | null;
  /** Only used to filter the school list; the asset's faculty always comes from its school. */
  facultyId: string | null;
  assignedTo: string;
  usageStatus: UsageStatus;
};

type Duplicate = { matches: { id: string; institutionalId: string; name: string | null; department: string; reason: string }[]; sameBarcodeCount: number };

function fromAsset(a?: Asset): FormState {
  return {
    name: a?.name ?? '',
    description: a?.description ?? '',
    categoryId: a?.category.id ?? null,
    manufacturer: a?.manufacturer ?? '',
    model: a?.model ?? '',
    manufacturerBarcode: a?.manufacturerBarcode ?? '',
    departmentId: a?.department.id ?? null,
    locationId: a?.location.id ?? null,
    acquisitionDate: a?.acquisitionDate ?? '',
    acquisitionMethod: a?.acquisitionMethod ?? 'purchase',
    costStatus: a?.financial?.costStatus ?? 'recorded',
    acquisitionCost: a?.financial?.acquisitionCost ?? '',
    currency: a?.financial?.currency ?? '',
    costExceptionReason: a?.financial?.costExceptionReason ?? '',
    supplier: a?.financial?.supplier ?? '',
    purchaseOrderRef: a?.financial?.purchaseOrderRef ?? '',
    warrantyExpiry: a?.warrantyExpiry ?? '',
    notes: a?.notes ?? '',
    condition: a?.condition ?? null,
    facultyId: a ? (a.faculty?.id ?? CENTRAL) : null,
    assignedTo: a?.assignedTo ?? '',
    usageStatus: a?.usageStatus ?? 'in_use',
  };
}

/** Converts the form into the API body: trims text, sends empty optional fields as null. */
function toBody(f: FormState, includeFinancial: boolean): Record<string, unknown> {
  const opt = (s: string) => (s.trim() === '' ? null : s.trim());
  const body: Record<string, unknown> = {
    name: f.name.trim(),
    description: opt(f.description),
    categoryId: f.categoryId,
    manufacturer: opt(f.manufacturer),
    model: opt(f.model),
    manufacturerBarcode: opt(f.manufacturerBarcode),
    departmentId: f.departmentId,
    locationId: f.locationId,
    acquisitionDate: f.acquisitionDate.trim(),
    acquisitionMethod: f.acquisitionMethod,
    warrantyExpiry: opt(f.warrantyExpiry),
    notes: opt(f.notes),
    condition: f.condition,
    assignedTo: opt(f.assignedTo),
    usageStatus: f.usageStatus,
  };
  if (includeFinancial) {
    Object.assign(body, {
      costStatus: f.costStatus,
      acquisitionCost: f.costStatus === 'recorded' ? opt(f.acquisitionCost) : f.costStatus === 'verified_zero' ? '0' : null,
      currency: f.currency.trim().toUpperCase(),
      costExceptionReason: f.costStatus === 'unknown_exception' ? opt(f.costExceptionReason) : null,
      supplier: opt(f.supplier),
      purchaseOrderRef: opt(f.purchaseOrderRef),
    });
  }
  return body;
}

export function AssetForm({
  initial,
  startWithScan,
  submitLabel,
  onSubmit,
}: {
  initial?: Asset;
  /** Open the camera straight away to read the item's own barcode ("Scan & Generate QR"). */
  startWithScan?: boolean;
  submitLabel: string;
  /** Receives the API body. Throw an ApiError to show errors on the form. */
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const { can } = useSession();
  const departments = useDepartments();
  const faculties = useFaculties();
  const [f, setF] = useState<FormState>(() => fromAsset(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
  const [busy, setBusy] = useState(false);
  const [newBuilding, setNewBuilding] = useState('');
  const [newRoom, setNewRoom] = useState('');
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const [scanning, setScanning] = useState(!!startWithScan && !initial);

  const isEdit = !!initial;
  const locked = initial?.registrationStatus === 'registered'; // department, location, condition use their own workflows
  const showFinancial = !isEdit || !!initial?.financial;

  const categories = useQuery('categories', () => api<{ items: Category[] }>('/categories'));
  const locations = useQuery(`locations:${f.departmentId ?? 'none'}`, () =>
    f.departmentId ? api<{ items: Location[] }>('/locations', { query: { departmentId: f.departmentId } }) : Promise.resolve({ items: [] as Location[] }),
  );
  const registrable = useMemo(() => departments.active.filter((d) => can('assets.register', d.id)), [departments.active, can]);
  // Faculty first, then only that faculty's schools. Only faculties with a school this user may register in are offered.
  const facultyOptions = useMemo(() => {
    const has = new Set(registrable.map((d) => d.faculty?.id ?? CENTRAL));
    const opts = (faculties.items ?? []).filter((x) => has.has(x.id)).map((x) => ({ value: x.id, label: x.name }));
    // Faculties not loaded (e.g. offline before they were ever fetched): fall back to the names on the departments.
    for (const d of registrable) if (d.faculty && !opts.some((o) => o.value === d.faculty!.id)) opts.push({ value: d.faculty.id, label: d.faculty.name });
    if (has.has(CENTRAL)) opts.push({ value: CENTRAL, label: CENTRAL_LABEL });
    return opts;
  }, [registrable, faculties.items]);
  // Someone who can register in only one faculty (or only central units) does not have to pick it.
  const facultyId = f.facultyId ?? (!isEdit && facultyOptions.length === 1 ? facultyOptions[0].value : null);
  const schoolOptions = useMemo(
    () => registrable.filter((d) => (d.faculty?.id ?? CENTRAL) === facultyId).map((d) => ({ value: d.id, label: d.name })),
    [registrable, facultyId],
  );

  // Editing a field clears its old error message, so fixed fields no longer look wrong.
  const set = <K extends keyof FormState>(k: K) => (v: FormState[K]) => {
    setF((s) => ({ ...s, [k]: v }));
    setErrors((e) => (e[k] ? { ...e, [k]: '' } : e));
  };

  // Changing the faculty clears the school (and its rooms); a faculty with a single school/unit selects it.
  const chooseFaculty = (id: string) => {
    setErrors((e) => ({ ...e, facultyId: '', departmentId: '' }));
    if (id === facultyId) return;
    const only = registrable.filter((d) => (d.faculty?.id ?? CENTRAL) === id);
    setF((s) => ({ ...s, facultyId: id, departmentId: null, locationId: null }));
    if (only.length === 1) chooseDepartment(only[0].id);
  };

  const chooseDepartment = (id: string) => {
    const d = departments.items?.find((x) => x.id === id);
    setErrors((e) => ({ ...e, departmentId: '', currency: '' }));
    setF((s) => ({
      ...s,
      departmentId: id,
      locationId: s.departmentId === id ? s.locationId : null,
      // Suggest the department's default currency until the user types their own.
      currency: !s.currency || s.currency === departments.items?.find((x) => x.id === s.departmentId)?.defaultCurrency ? d?.defaultCurrency ?? '' : s.currency,
    }));
  };

  const addLocation = async () => {
    setLocMsg(null);
    if (!f.departmentId || !newBuilding.trim() || !newRoom.trim()) return setLocMsg('Enter a building and a room.');
    try {
      const loc = await api<Location>('/locations', { body: { departmentId: f.departmentId, building: newBuilding.trim(), room: newRoom.trim() } });
      setNewBuilding('');
      setNewRoom('');
      locations.reload();
      setF((s) => ({ ...s, locationId: loc.id }));
    } catch (e) {
      setLocMsg(errorMessage(e));
    }
  };

  const submit = async (confirmNotDuplicate = false) => {
    setError(null);
    const errs: Record<string, string> = {};
    if (f.name.trim().length < 2) errs.name = 'Enter a name (at least 2 characters).';
    if (!f.categoryId) errs.categoryId = 'Choose a category.';
    if (!locked && !facultyId) errs.facultyId = 'Choose a faculty, or Central administration for units outside the faculties.';
    if (!f.departmentId) errs.departmentId = facultyId ? 'Choose the school or department.' : 'Choose a faculty first, then the school or department.';
    if (!f.locationId) errs.locationId = 'Choose a location.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.acquisitionDate.trim())) errs.acquisitionDate = 'Use YYYY-MM-DD, e.g. 2026-03-14.';
    if (!f.condition) errs.condition = 'Choose the condition.';
    if (showFinancial && !/^[A-Za-z]{3}$/.test(f.currency.trim())) errs.currency = 'Use a 3-letter code such as PGK (kina).';
    if (showFinancial && f.costStatus === 'recorded' && !f.acquisitionCost.trim()) errs.acquisitionCost = 'Enter the acquisition cost.';
    setErrors(errs);
    if (Object.keys(errs).length) {
      setError('Please correct the highlighted fields.');
      return;
    }
    let body = toBody(f, showFinancial);
    if (isEdit && initial) {
      // Send only what changed, plus the version this form was loaded from.
      const before = toBody(fromAsset(initial), showFinancial);
      body = Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k])));
      if (locked) for (const k of ['departmentId', 'locationId', 'condition']) delete body[k];
      // What this form showed before the change: lets the server tell a real clash from unrelated changes
      // when an edit made offline arrives late.
      body.baseValues = Object.fromEntries(Object.keys(body).map((k) => [k, before[k] ?? null]));
      body.version = initial.version;
    }
    if (confirmNotDuplicate) body.confirmNotDuplicate = true;
    setBusy(true);
    try {
      await onSubmit(body);
      setDuplicate(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE') {
        setDuplicate(e.details as Duplicate);
        setError(null);
      } else {
        if (e instanceof ApiError) setErrors(e.fieldErrors);
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const deptName = departments.items?.find((d) => d.id === f.departmentId)?.name;
  const locationName = locations.data?.items.find((l) => l.id === f.locationId);

  return (
    <View style={{ gap: 16 }}>
      {error ? <Notice kind="error">{error}</Notice> : null}

      {!isEdit ? (
        <Card>
          <Heading level={2}>1. Scan the item’s barcode</Heading>
          {scanning ? (
            <ProductBarcodeScanner
              onBarcode={(code) => {
                setScanning(false);
                set('manufacturerBarcode')(code);
              }}
              onCancel={() => setScanning(false)}
            />
          ) : f.manufacturerBarcode ? (
            <>
              <Notice kind="success">Barcode captured: {f.manufacturerBarcode}. Now check the details below and save.</Notice>
              <Row>
                <Button title="Scan again" variant="secondary" onPress={() => setScanning(true)} />
              </Row>
            </>
          ) : (
            <>
              <Body muted>Scan the barcode already on the item with the camera, or skip this if it has none.</Body>
              <Row>
                <Button title="Scan item barcode with camera" onPress={() => setScanning(true)} />
              </Row>
            </>
          )}
        </Card>
      ) : null}

      <Card>
        <Heading level={2}>{isEdit ? 'What is it?' : '2. Confirm what it is'}</Heading>
        <View style={{ gap: 2 }}>
          <Body muted>Asset ID / tag number</Body>
          <Body>
            {initial
              ? initial.institutionalId
              : 'Assigned automatically when you save (e.g. UAT-2026-000123). It is printed on the QR label and never changes.'}
          </Body>
        </View>
        <Field label="Asset name" value={f.name} onChangeText={set('name')} error={errors.name} placeholder="e.g. Dell Latitude 5440 laptop" />
        {categories.data ? (
          categories.data.items.length ? (
            <Choice
              label="Category"
              value={f.categoryId}
              options={categories.data.items.filter((c) => c.isActive || c.id === f.categoryId).map((c) => ({ value: c.id, label: c.name }))}
              onChange={set('categoryId')}
              error={errors.categoryId}
            />
          ) : (
            <Notice kind="warning">No asset categories exist yet. A system administrator must add them (Administration → Categories).</Notice>
          )
        ) : categories.error ? (
          <Notice kind="error">{categories.error}</Notice>
        ) : null}
        <Field label="Asset description (optional)" value={f.description} onChangeText={set('description')} error={errors.description} multiline style={{ minHeight: 64, textAlignVertical: 'top' }} />
        <Row>
          <View style={{ flexGrow: 1, flexBasis: 200 }}>
            <Field label="Manufacturer (optional)" value={f.manufacturer} onChangeText={set('manufacturer')} error={errors.manufacturer} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: 200 }}>
            <Field label="Model (optional)" value={f.model} onChangeText={set('model')} error={errors.model} />
          </View>
        </Row>
        <Field
          label="Manufacturer barcode (optional)"
          value={f.manufacturerBarcode}
          onChangeText={set('manufacturerBarcode')}
          error={errors.manufacturerBarcode}
          hint="Filled in when you scan it above. Identical models share it; it is not the asset's own ID (that is created for you when you save)."
          autoCapitalize="none"
        />
      </Card>

      <Card>
        <Heading level={2}>Where is it?</Heading>
        {locked ? (
          <Notice kind="info">
            {initial?.faculty?.name ?? CENTRAL_LABEL} · {deptName} · {initial?.location.building}, room {initial?.location.room}. To move a registered
            asset to another school, building or room, use Relocate on the asset page, so its movement history is kept.
          </Notice>
        ) : (
          <>
            {registrable.length ? (
              <>
                <SearchableChoice
                  label="Faculty"
                  value={facultyId}
                  options={facultyOptions}
                  onChange={chooseFaculty}
                  error={errors.facultyId}
                  searchFrom={3}
                />
                {facultyId ? (
                  <SearchableChoice
                    label="School / department"
                    value={f.departmentId}
                    options={schoolOptions}
                    onChange={chooseDepartment}
                    error={errors.departmentId}
                    searchFrom={3}
                  />
                ) : errors.departmentId ? (
                  <Notice kind="error">{errors.departmentId}</Notice>
                ) : (
                  <Body muted>Choose the faculty first; its schools and departments will then be listed.</Body>
                )}
              </>
            ) : departments.items ? (
              <Notice kind="warning">You are not allowed to register assets in any department.</Notice>
            ) : null}
            {f.departmentId ? (
              locations.data ? (
                <>
                  {locations.data.items.length ? (
                    <SearchableChoice
                      label="Building / location and room number"
                      value={f.locationId}
                      options={locations.data.items.map((l) => ({ value: l.id, label: `${l.building} · ${l.room}` }))}
                      onChange={set('locationId')}
                      error={errors.locationId}
                    />
                  ) : (
                    <Body muted>No locations in this department yet.</Body>
                  )}
                  {can('locations.manage', f.departmentId) ? (
                    <View style={{ gap: 8 }}>
                      <Body muted>Location not listed? Add it:</Body>
                      <Row>
                        <View style={{ flexGrow: 1, flexBasis: 160 }}>
                          <Field label="New building" value={newBuilding} onChangeText={setNewBuilding} />
                        </View>
                        <View style={{ flexGrow: 1, flexBasis: 120 }}>
                          <Field label="New room number" value={newRoom} onChangeText={setNewRoom} />
                        </View>
                      </Row>
                      {locMsg ? <Notice kind="error">{locMsg}</Notice> : null}
                      <Row>
                        <Button title="Add location" variant="secondary" onPress={addLocation} />
                      </Row>
                    </View>
                  ) : null}
                </>
              ) : locations.error ? (
                <Notice kind="error">{locations.error}</Notice>
              ) : (
                <Loading label="Loading locations…" />
              )
            ) : null}
          </>
        )}
      </Card>

      <Card>
        <Heading level={2}>Acquisition</Heading>
        <DateField
          label="Purchase / acquisition date"
          value={f.acquisitionDate}
          onChangeText={set('acquisitionDate')}
          error={errors.acquisitionDate}
          hint="Date it was purchased (or donated / transferred). Older dates are fine."
          max={new Date().toLocaleDateString('en-CA')}
        />
        <Choice
          label="How was it acquired?"
          value={f.acquisitionMethod}
          options={ACQUISITION_METHODS.map((m) => ({ value: m, label: ACQUISITION_METHOD_LABELS[m] }))}
          onChange={set('acquisitionMethod')}
        />
        {showFinancial ? (
          <>
            <Choice
              label="Purchase cost recorded?"
              value={f.costStatus}
              options={COST_STATUSES.map((c) => ({ value: c, label: COST_STATUS_LABELS[c] }))}
              onChange={set('costStatus')}
              error={errors.costStatus}
            />
            <Row>
              {f.costStatus === 'recorded' ? (
                <View style={{ flexGrow: 1, flexBasis: 160 }}>
                  <Field
                    label="Purchase cost"
                    value={f.acquisitionCost}
                    onChangeText={set('acquisitionCost')}
                    error={errors.acquisitionCost}
                    placeholder="1250.00"
                    keyboardType="decimal-pad"
                  />
                </View>
              ) : null}
              <View style={{ flexGrow: 1, flexBasis: 120 }}>
                <Field
                  label="Currency"
                  value={f.currency}
                  onChangeText={(v) => set('currency')(v.toUpperCase())}
                  error={errors.currency}
                  placeholder="PGK"
                  autoCapitalize="characters"
                  maxLength={3}
                />
              </View>
            </Row>
            {f.costStatus === 'verified_zero' ? <Body muted>Recorded as 0.00 — use only when the item is confirmed to have cost nothing.</Body> : null}
            {f.costStatus === 'unknown_exception' ? (
              <Field
                label="Why is the cost unknown?"
                value={f.costExceptionReason}
                onChangeText={set('costExceptionReason')}
                error={errors.costExceptionReason}
                hint="Recorded in the audit log. Unknown costs are reported separately and never counted as zero."
              />
            ) : null}
            <Row>
              <View style={{ flexGrow: 1, flexBasis: 200 }}>
                <Field label="Supplier (optional)" value={f.supplier} onChangeText={set('supplier')} error={errors.supplier} />
              </View>
              <View style={{ flexGrow: 1, flexBasis: 200 }}>
                <Field label="Purchase order / invoice no. (optional)" value={f.purchaseOrderRef} onChangeText={set('purchaseOrderRef')} error={errors.purchaseOrderRef} />
              </View>
            </Row>
          </>
        ) : (
          <Notice kind="info">Financial details are not shown to you for this department.</Notice>
        )}
        <DateField label="Warranty expiry (optional)" value={f.warrantyExpiry} onChangeText={set('warrantyExpiry')} error={errors.warrantyExpiry} />
      </Card>

      <Card>
        <Heading level={2}>Condition, status and custodian</Heading>
        {locked ? (
          <Notice kind="info">Condition: {initial ? CONDITION_LABELS[initial.condition] : ''}. Condition changes for registered assets will be recorded through condition updates (Phase 4).</Notice>
        ) : (
          <Choice
            label="Condition"
            value={f.condition}
            options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))}
            onChange={set('condition')}
            error={errors.condition}
          />
        )}
        <Choice
          label="Asset status"
          value={f.usageStatus}
          options={USAGE_STATUSES.map((u) => ({ value: u, label: USAGE_STATUS_LABELS[u] }))}
          onChange={set('usageStatus')}
          error={errors.usageStatus}
        />
        <Field
          label="Assigned staff member (optional)"
          value={f.assignedTo}
          onChangeText={set('assignedTo')}
          error={errors.assignedTo}
          placeholder="e.g. Dr. Jane Kila"
          hint="The person responsible for this asset. They do not need an account in this system."
          autoCapitalize="words"
        />
        <Field label="Notes (optional)" value={f.notes} onChangeText={set('notes')} error={errors.notes} multiline style={{ minHeight: 64, textAlignVertical: 'top' }} />
      </Card>

      {duplicate ? (
        <Card>
          <Notice kind="warning">An asset with this serial number already exists. Check whether you are registering the same physical item twice.</Notice>
          {duplicate.matches.map((m) => (
            <Body key={m.id}>
              {m.institutionalId} — {m.name ?? 'details not shown (another department)'} ({m.department}). {m.reason}.
            </Body>
          ))}
          <Body muted>If this is a different physical item, you can continue. Your confirmation is recorded in the audit log.</Body>
          <Row>
            <Button title="It is a different item — continue" variant="danger" onPress={() => submit(true)} loading={busy} />
            <Button title="Go back and check" variant="secondary" onPress={() => setDuplicate(null)} />
          </Row>
        </Card>
      ) : (
        <Button title={submitLabel} onPress={() => submit(false)} loading={busy} />
      )}
      {!isEdit && f.locationId && locationName ? (
        <Body muted>
          Will be registered to {deptName}
          {facultyId && facultyId !== CENTRAL ? ` (${facultyOptions.find((o) => o.value === facultyId)?.label ?? ''})` : ''}, {locationName.building} · Room{' '}
          {locationName.room}.
        </Body>
      ) : null}
    </View>
  );
}
