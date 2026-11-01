// Unit tests for the permission matrix and department scoping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, departmentScope, hasPermission, type Principal } from '../src/authz.ts';

const A = 'dept-a';
const B = 'dept-b';
const admin: Principal = { id: '1', role: 'SYSTEM_ADMIN', departmentId: null, grants: [] };
const manager: Principal = { id: '2', role: 'ASSET_MANAGER', departmentId: null, grants: [] };
const staffA: Principal = { id: '3', role: 'DEPARTMENT_STAFF', departmentId: A, grants: [] };

test('system admin can do everything in every department', () => {
  assert.equal(can(admin, 'users.manage'), true);
  assert.equal(can(admin, 'assets.register', B), true);
  assert.equal(can(admin, 'settings.manage'), true);
});

test('asset manager oversees all departments but cannot administer or do fieldwork', () => {
  assert.equal(can(manager, 'assets.read', A), true);
  assert.equal(can(manager, 'assets.review', B), true);
  assert.equal(can(manager, 'reports.generate', B), true);
  assert.equal(can(manager, 'users.manage'), false);
  assert.equal(can(manager, 'settings.manage'), false);
  assert.equal(can(manager, 'access_requests.review'), false);
  assert.equal(can(manager, 'assets.register', A), false);
  assert.equal(can(manager, 'maintenance.manage', A), false);
});

test('department staff are limited to their own department', () => {
  assert.equal(can(staffA, 'assets.register', A), true);
  assert.equal(can(staffA, 'assets.register', B), false);
  assert.equal(can(staffA, 'assets.read', B), false);
  assert.equal(can(staffA, 'maintenance.manage', A), true);
  assert.equal(can(staffA, 'assets.review', A), false);
  assert.equal(can(staffA, 'users.manage'), false);
  assert.equal(can(staffA, 'audit.read'), false);
  assert.deepEqual(departmentScope(staffA, 'assets.read'), [A]);
});

test('records with no department are never in a staff member’s scope', () => {
  assert.equal(can(staffA, 'assets.read', null), false);
});

test('read grant extends only read-type permissions to another department', () => {
  const p: Principal = { ...staffA, grants: [{ departmentId: B, level: 'read' }] };
  assert.equal(can(p, 'assets.read', B), true);
  assert.equal(can(p, 'reports.generate', B), true);
  assert.equal(can(p, 'assets.register', B), false);
  assert.equal(can(p, 'maintenance.manage', B), false);
  assert.equal(can(p, 'assets.read_financial', B), false);
});

test('operate grant extends department operations but never admin powers', () => {
  const p: Principal = { ...staffA, grants: [{ departmentId: B, level: 'operate' }] };
  assert.equal(can(p, 'assets.register', B), true);
  assert.equal(can(p, 'verification.record', B), true);
  assert.equal(can(p, 'users.manage'), false);
  assert.equal(can(p, 'assets.review', B), false);
});

test('there is no department head role', () => {
  assert.equal(hasPermission({ ...staffA, role: 'DEPARTMENT_HEAD' as any }, 'assets.read'), false);
});
