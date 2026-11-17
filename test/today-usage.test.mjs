import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../index.mjs';

const { createPlugin, usageOf, queryWindow, BALANCE_URL } = _internal;
const wallet = { quota: 123.45, used_quota: 67.89 };
const dailyOf = usage => usage.windows.find(window => window.name === '今日用量');
const lifetimeOf = usage => usage.windows.find(window => window.name === '累计使用');

test('today spend uses statistics_quota without changing balance or lifetime totals', () => {
  const usage = usageOf({ ...wallet, statistics_quota: 4.56, statistics_count: 10, used_token: 2000 });
  assert.equal(usage.balance, '123.45');
  assert.deepEqual(dailyOf(usage), {
    name: '今日用量', amount: 4.56, unit: '额度', display: '今日已用 4.56 额度', aside: true,
  });
  assert.equal(lifetimeOf(usage).amount, 67.89);
  assert.match(lifetimeOf(usage).display, /191\.34/);
  assert.equal(dailyOf(usage).used, undefined);
  assert.equal(dailyOf(usage).limit, undefined);
  assert.equal(dailyOf(usage).resetsAt, undefined);
});

test('known zero and numeric strings remain valid daily amounts', () => {
  for (const value of [0, '0', '4.56']) {
    const daily = dailyOf(usageOf({ ...wallet, statistics_quota: value }));
    assert.equal(daily.amount, Number(value));
    assert.equal(daily.display, `今日已用 ${Number(value).toFixed(2)} 额度`);
  }
});

test('missing or invalid daily statistics stay unknown without hiding the wallet', () => {
  const invalid = [undefined, null, '', ' ', true, {}, [], 'NaN', 'Infinity', NaN, Infinity, -1, '-1'];
  for (const statistics_quota of invalid) {
    const usage = usageOf({ ...wallet, statistics_quota });
    const daily = dailyOf(usage);
    assert.equal(usage.balance, '123.45');
    assert.equal(usage.signIn, 'kept');
    assert.equal(usage.error, undefined);
    assert.equal(lifetimeOf(usage).amount, 67.89);
    assert.equal(Object.hasOwn(daily, 'amount'), false);
    assert.equal(daily.display, '今日用量暂不可用');
  }
});

function testAuth(now) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'HS256' })}.${encode({ account_type: 'app_admin', account_id: '123', exp: now / 1000 + 3 * 86400 })}.fake-signature`;
  return async () => ({ type: 'api', key: 'sk-test-only', metadata: { webToken: token, webUserId: '123' } });
}

test('today spend shares the existing Shanghai-day wallet request', async () => {
  const now = Date.parse('2026-11-17T06:00:00Z');
  const calls = [];
  const plugin = createPlugin({ now: () => now, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return Response.json({ status: 0, data: { ...wallet, statistics_quota: 4.56 } });
  } });
  const usage = await plugin.auth.usage(testAuth(now));
  assert.equal(dailyOf(usage).amount, 4.56);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BALANCE_URL);
  assert.deepEqual(JSON.parse(calls[0].init.body), queryWindow(now));
  assert.deepEqual(queryWindow(now), {
    start_time: Date.parse('2026-11-17T00:00:00+08:00') / 1000,
    end_time: Date.parse('2026-11-17T23:59:59+08:00') / 1000,
    default_time: 'day',
  });
});

test('refresh after Shanghai midnight requests the next day rather than retaining yesterday', async () => {
  let now = Date.parse('2026-11-30T15:59:59Z');
  const getAuth = testAuth(now);
  const queries = [];
  const plugin = createPlugin({ now: () => now, fetchImpl: async (_url, init) => {
    queries.push(JSON.parse(init.body));
    return Response.json({ status: 0, data: { ...wallet, statistics_quota: queries.length === 1 ? 4.56 : 0 } });
  } });
  assert.equal(dailyOf(await plugin.auth.usage(getAuth)).amount, 4.56);
  now += 1000;
  assert.equal(dailyOf(await plugin.auth.usage(getAuth)).amount, 0);
  assert.equal(queries.length, 2);
  assert.equal(queries[0].start_time, Date.parse('2026-11-30T00:00:00+08:00') / 1000);
  assert.equal(queries[1].start_time, Date.parse('2026-12-01T00:00:00+08:00') / 1000);
  assert.equal(queries[0].end_time + 1, queries[1].start_time);
});
