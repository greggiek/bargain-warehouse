const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'api', 'cycle-count-review.js'), 'utf8');
const dailyApi = fs.readFileSync(path.join(root, 'api', 'daily-cycle-count.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'cycle-count-review.js'), 'utf8');
const dailyUi = fs.readFileSync(path.join(root, 'daily-cycle-count.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const forwardPath = path.join(root, '..', 'supabase', 'migrations', '20260905113000_cycle_count_pass_2b.sql');
const rollbackPath = path.join(root, '..', 'supabase', 'rollback', '20260905113000_cycle_count_pass_2b_rollback.sql');
const forward = fs.readFileSync(forwardPath, 'utf8');
const rollback = fs.readFileSync(rollbackPath, 'utf8');

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('review uses only transactional Pass 2B RPCs', () => {
  assert.match(api, /request_v2_cycle_count_recount/);
  assert.match(api, /dismiss_v2_cycle_count_variance/);
  assert.match(api, /approve_v2_cycle_count_variance/);
  assert.doesNotMatch(api, /method: 'PATCH'/);
});

test('Daily Count submission uses immutable-attempt RPC', () => {
  assert.match(dailyApi, /submit_v2_cycle_count_attempt/);
  assert.doesNotMatch(dailyApi, /method: 'PATCH'/);
});

test('all writes carry stable client-generated idempotency keys', () => {
  assert.match(dailyUi, /idempotencyKey.*crypto\.randomUUID/);
  assert.match(ui, /idempotencyKey.*crypto\.randomUUID/);
  assert.match(api + dailyApi, /p_idempotency_key/);
});

test('recount and dismiss require reasons in API and dialog', () => {
  assert.match(api, /A recount reason is required/);
  assert.match(api, /A dismissal reason is required/);
  assert.match(ui, /note\.required = action !== 'approve'/);
});

test('database actor identity is authoritative', () => {
  assert.match(forward, /p_actor_name is compatibility-only/);
  assert.match(forward, /v_actor:=private\.require_cycle_count_actor/);
});

test('all database functions use parent-before-line lock order', () => {
  const publicBodies = forward.split('create or replace function public.').slice(1);
  for (const body of publicBodies) {
    const run = body.indexOf('cycle_count_runs where id=v_run_id for update');
    const line = body.indexOf('cycle_count_lines where id=p_line_id and run_id=v_run.id for update');
    assert.ok(run >= 0 && line > run);
  }
});

test('only approval contains an inventory mutation', () => {
  const beforeApproval = forward.split('create or replace function public.approve_v2_cycle_count_variance')[0];
  assert.doesNotMatch(beforeApproval, /update public\.inventory_balances/);
  assert.match(forward, /update public\.inventory_balances set quantity=v_after/);
});

test('reconciliation encodes exact open, ready, and reviewed states', () => {
  assert.match(forward, /set status='open'/);
  assert.match(forward, /set status='ready_for_review'/);
  assert.match(forward, /set status='reviewed'/);
  assert.match(forward, /status='variance' and review_status='pending'/);
});

test('attempt history and operation data are private and immutable', () => {
  assert.match(forward, /create table private\.cycle_count_attempts/);
  assert.match(forward, /create table private\.cycle_count_operations/);
  assert.match(forward, /on delete restrict/);
  assert.doesNotMatch(forward, /grant .*authenticated/);
});

test('Review exposes structured Approve, Recount, Dismiss, and History controls', () => {
  assert.match(ui, /Approve adjustment/);
  assert.match(ui, /Request recount/);
  assert.match(ui, /Dismiss variance/);
  assert.match(ui, /showHistory/);
  assert.match(page, /id="cycleReviewHistoryDialog"/);
});

test('Review action lifecycle supports timeout, retry, cancellation, and locking', () => {
  assert.match(ui, /TIMEOUT = 12000/);
  assert.match(ui, /cycleReviewActionRetry/);
  assert.match(ui, /actionRequest\?\.abort/);
  assert.match(ui, /if \(state\.action\) return/);
});

test('Daily Count retains timeout, stale protection, cancellation, and locking', () => {
  assert.match(dailyUi, /TIMEOUT = 12000/);
  assert.match(dailyUi, /sequence !== state\.sequence/);
  assert.match(dailyUi, /cancelActive/);
  assert.match(dailyUi, /if \(state\.saving\) return/);
});

test('forward migration hash is pinned', () => {
  assert.equal(sha(forwardPath), 'f041187903ffb0b22ead92c08898de43c95c306fe7fa942050232c0a599b736a');
});

test('rollback migration hash is pinned', () => {
  assert.equal(sha(rollbackPath), 'c113ec278bb27fd8033015f83438c850b072450e944223bd6228798667cda353');
});

test('rollback restores legacy approval before disabling new RPCs', () => {
  const restore = rollback.indexOf('create or replace function public.approve_v2_cycle_count_variance');
  const revoke = rollback.indexOf('revoke all on function public.submit_v2_cycle_count_attempt');
  assert.ok(restore >= 0 && revoke > restore);
  assert.match(rollback, /grant execute on function public\.approve_v2_cycle_count_variance\(bigint,bigint,text,text\) to service_role/);
});
