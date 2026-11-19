import { createRequire } from 'module';
import assert from 'assert';

const require = createRequire(import.meta.url);
const b = require('../balance-math.js');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('ok', name); }
  catch (err) { failed++; console.error('FAIL', name, err.message); }
}

const today = '2026-11-19';

check('no anchor: balance is income minus expenses up to today, with agorot', () => {
  const result = b.currentBalance({
    today,
    accountId: 'all',
    checkins: [],
    transactions: [
      { id: 'a', type: 'income', amount: 100.5, date: '2026-11-01', accountId: 'default' },
      { id: 'b', type: 'expense', amount: 40.2, date: '2026-11-18', accountId: 'default' },
      { id: 'c', type: 'expense', amount: 999, date: '2026-11-20', accountId: 'default' }
    ]
  });
  assert.strictEqual(result.amount, 60.3);
});

check('transactions before the anchor are not counted again', () => {
  const result = b.currentBalance({
    today,
    accountId: 'all',
    checkins: [{ id: 'c1', date: '2026-11-18', amount: 1000, createdAt: 200, accountId: 'all' }],
    transactions: [
      { id: 'old', type: 'expense', amount: 500, date: '2026-11-01', createdAt: 1 },
      { id: 'after', type: 'expense', amount: 25.5, date: '2026-11-19', createdAt: 300 }
    ]
  });
  assert.strictEqual(result.amount, 974.5);
  assert.strictEqual(result.expenseSince, 25.5);
});

check('a same-day transaction added after the check-in moves the balance', () => {
  const result = b.currentBalance({
    today,
    accountId: 'all',
    checkins: [{ id: 'c1', date: today, amount: 500, createdAt: 1000, accountId: 'all' }],
    transactions: [
      { id: 'already', type: 'expense', amount: 80, date: today, createdAt: 500 },
      { id: 'new', type: 'expense', amount: 20.4, date: today, createdAt: 1500 },
      { id: 'pay', type: 'income', amount: 10, date: today, createdAt: 1600 }
    ]
  });
  assert.strictEqual(result.amount, 489.6);
});

check('editing the amount of a later transaction changes the balance', () => {
  const base = {
    today,
    accountId: 'all',
    checkins: [{ id: 'c1', date: '2026-11-10', amount: 200, createdAt: 1, accountId: 'all' }],
    transactions: [{ id: 'e', type: 'expense', amount: 30, date: '2026-11-12', createdAt: 2 }]
  };
  assert.strictEqual(b.currentBalance(base).amount, 170);
  base.transactions[0].amount = 45.25;
  assert.strictEqual(b.currentBalance(base).amount, 154.75);
});

check('deleting a later transaction restores the balance', () => {
  const txs = [
    { id: 'e', type: 'expense', amount: 30, date: '2026-11-12', createdAt: 2 },
    { id: 'i', type: 'income', amount: 5.5, date: '2026-11-13', createdAt: 3 }
  ];
  const opts = {
    today, accountId: 'all',
    checkins: [{ id: 'c1', date: '2026-11-10', amount: 200, createdAt: 1, accountId: 'all' }],
    transactions: txs
  };
  assert.strictEqual(b.currentBalance(opts).amount, 175.5);
  opts.transactions = txs.filter(t => t.id !== 'e');
  assert.strictEqual(b.currentBalance(opts).amount, 205.5);
});

check('a later check-in replaces the old starting point', () => {
  const result = b.currentBalance({
    today,
    accountId: 'all',
    checkins: [
      { id: 'old', date: '2026-11-01', amount: 50, createdAt: 1, accountId: 'all' },
      { id: 'new', date: '2026-11-18', amount: 800.1, createdAt: 50, accountId: 'all' }
    ],
    transactions: [
      { id: 'between', type: 'expense', amount: 100, date: '2026-11-10', createdAt: 20 },
      { id: 'after', type: 'expense', amount: 10.1, date: '2026-11-19', createdAt: 60 }
    ]
  });
  assert.strictEqual(result.amount, 790);
  assert.strictEqual(result.anchor.id, 'new');
});

check('month cutoff does not change today, and the chart ends on the same number', () => {
  const opts = {
    today,
    accountId: 'all',
    checkins: [{ id: 'c1', date: '2026-11-15', amount: 300, createdAt: 10, accountId: 'all' }],
    transactions: [
      { id: 'a', type: 'income', amount: 1000, date: '2026-10-01', createdAt: 1 },
      { id: 'b', type: 'expense', amount: 40, date: '2026-11-19', createdAt: 20 }
    ]
  };
  const now = b.currentBalance(opts).amount;
  const end = b.balanceAtCutoff(Object.assign({}, opts, { cutoff: today }));
  const october = b.balanceAtCutoff(Object.assign({}, opts, { cutoff: '2026-10-31' }));
  assert.strictEqual(now, 260);
  assert.strictEqual(end, 260);
  assert.notStrictEqual(october, now);
});

check('all-accounts anchor is not applied to a single account that has its own', () => {
  const shared = {
    today,
    checkins: [
      { id: 'all', date: '2026-11-01', amount: 5000, createdAt: 1, accountId: 'all' },
      { id: 'cash', date: '2026-11-18', amount: 120.5, createdAt: 2, accountId: 'cash' }
    ],
    transactions: [
      { id: 't1', type: 'expense', amount: 20.5, date: '2026-11-19', createdAt: 3, accountId: 'cash' },
      { id: 't2', type: 'expense', amount: 400, date: '2026-11-19', createdAt: 3, accountId: 'bank' }
    ]
  };
  assert.strictEqual(b.currentBalance(Object.assign({ accountId: 'cash' }, shared)).amount, 100);
  assert.strictEqual(b.currentBalance(Object.assign({ accountId: 'all' }, shared)).amount, 4579.5);
});

check('a deleted starting balance is ignored', () => {
  const result = b.currentBalance({
    today,
    accountId: 'all',
    checkins: [
      { id: 'old', date: '2026-11-19', amount: 1000, createdAt: 1000, accountId: 'all', deleted: true },
      { id: 'keep', date: '2026-11-18', amount: 400.5, createdAt: 10, updatedAt: 10, accountId: 'all' }
    ],
    transactions: [{ id: 'e', type: 'expense', amount: 20, date: '2026-11-19', createdAt: 50 }]
  });
  assert.strictEqual(result.anchor.id, 'keep');
  assert.strictEqual(result.amount, 380.5);
});

check('money typed with a comma still keeps agorot', () => {
  assert.strictEqual(b.parseMoney('1,500.50'), 1500.5);
  assert.strictEqual(b.parseMoney('1500,50'), 1500.5);
  assert.strictEqual(b.parseMoney('1.500,50'), 1500.5);
  assert.strictEqual(b.parseMoney('₪45.90'), 45.9);
  assert.ok(Number.isNaN(b.parseMoney('')));
});

check('an account without its own anchor uses only that account\'s transactions', () => {
  const result = b.currentBalance({
    today,
    accountId: 'bank',
    checkins: [{ id: 'all', date: '2026-11-01', amount: 5000, createdAt: 1, accountId: 'all' }],
    transactions: [
      { id: 't1', type: 'income', amount: 80.25, date: '2026-11-02', accountId: 'bank' },
      { id: 't2', type: 'expense', amount: 30, date: '2026-11-03', accountId: 'cash' }
    ]
  });
  assert.strictEqual(result.anchor, null);
  assert.strictEqual(result.amount, 80.25);
});

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all balance tests passed');
