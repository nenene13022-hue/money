import { createRequire } from 'module';
import assert from 'assert';

const require = createRequire(import.meta.url);
const merge = require('../cloud-merge.js');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('ok', name);
  } catch (err) {
    failed++;
    console.error('FAIL', name, err.message);
  }
}

check('placeholders are not configured', () => {
  assert.strictEqual(merge.isFirebaseConfigured({
    apiKey: 'PASTE_API_KEY', authDomain: 'PASTE_PROJECT_ID.firebaseapp.com',
    projectId: 'PASTE_PROJECT_ID', appId: 'PASTE_APP_ID'
  }), false);
  assert.strictEqual(merge.isFirebaseConfigured(null), false);
  assert.strictEqual(merge.isFirebaseConfigured({
    apiKey: 'AIzaReal', authDomain: 'app.firebaseapp.com', projectId: 'app', appId: '1:2:web:abc'
  }), true);
});

check('invite code is 6 unambiguous characters', () => {
  const code = merge.makeInviteCode(() => 0);
  assert.strictEqual(code, 'AAAAAA');
  assert.strictEqual(merge.makeInviteCode().length, 6);
  assert.ok(!/[01IO]/.test(merge.CODE_ALPHABET));
});

check('merge keeps both unique transactions and drops fingerprint duplicates', () => {
  const local = [
    { id: 'l1', type: 'expense', amount: 45.9, category: 'מזון', date: '2026-11-14', note: 'סופר', accountId: 'default', updatedAt: 1, receiptId: 'r1' },
    { id: 'l2', type: 'expense', amount: 20, category: 'קפה', date: '2026-11-15', note: '', accountId: 'default', updatedAt: 2 }
  ];
  const remote = [
    { id: 'c1', type: 'expense', amount: 45.90, category: 'מזון', date: '2026-11-14', note: 'סופר', accountId: 'default', updatedAt: 5, createdByName: 'נועה' }
  ];
  const merged = merge.mergeInitialTransactions(local, remote);
  const ids = merged.map(t => t.id).sort();
  assert.deepStrictEqual(ids, ['c1', 'l2']);
  const kept = merged.find(t => t.id === 'c1');
  assert.strictEqual(kept.receiptId, 'r1');
  assert.strictEqual(kept.createdByName, 'נועה');
});

check('same id keeps the newer edit and the local receipt', () => {
  const local = [{ id: 't1', type: 'expense', amount: 10, category: 'מזון', date: '2026-11-01', note: 'ישן', accountId: 'default', updatedAt: 1, receiptId: 'rc' }];
  const remote = [{ id: 't1', type: 'expense', amount: 12, category: 'מזון', date: '2026-11-01', note: 'חדש', accountId: 'default', updatedAt: 9, createdByName: 'דן' }];
  const merged = merge.mergeInitialTransactions(local, remote);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].amount, 12);
  assert.strictEqual(merged[0].note, 'חדש');
  assert.strictEqual(merged[0].receiptId, 'rc');
  assert.strictEqual(merged[0].createdByName, 'דן');
});

check('local newer edit wins the same id', () => {
  const out = merge.reconcileTransactions({
    local: [{ id: 't1', amount: 8, updatedAt: 20, receiptId: 'rc', note: 'מקומי' }],
    remote: [{ id: 't1', amount: 5, updatedAt: 10, note: 'ענן' }],
    pendingIds: new Set(),
    pendingDeletes: new Set(),
    privateIds: new Set()
  });
  assert.strictEqual(out[0].amount, 8);
  assert.strictEqual(out[0].receiptId, 'rc');
});

check('a remote delete drops a local transaction that is not pending or private', () => {
  const out = merge.reconcileTransactions({
    local: [{ id: 'gone', amount: 1, updatedAt: 1 }, { id: 'stay', amount: 2, updatedAt: 1 }],
    remote: [{ id: 'stay', amount: 2, updatedAt: 1 }],
    pendingIds: new Set(),
    pendingDeletes: new Set(),
    privateIds: new Set()
  });
  assert.deepStrictEqual(out.map(t => t.id), ['stay']);
});

check('pending and private local transactions survive an empty cloud snapshot', () => {
  const out = merge.reconcileTransactions({
    local: [{ id: 'new', amount: 3 }, { id: 'old', amount: 4 }],
    remote: [],
    pendingIds: new Set(['new']),
    pendingDeletes: new Set(),
    privateIds: new Set(['old'])
  });
  assert.deepStrictEqual(out.map(t => t.id).sort(), ['new', 'old']);
});

check('pending delete hides a transaction that is still in the snapshot', () => {
  const out = merge.reconcileTransactions({
    local: [],
    remote: [{ id: 't1', amount: 1, updatedAt: 1 }],
    pendingIds: new Set(),
    pendingDeletes: new Set(['t1']),
    privateIds: new Set()
  });
  assert.strictEqual(out.length, 0);
});

check('partner transaction arrives', () => {
  const out = merge.reconcileTransactions({
    local: [{ id: 'mine', amount: 1, updatedAt: 1 }],
    remote: [
      { id: 'mine', amount: 1, updatedAt: 1 },
      { id: 'theirs', amount: 50, updatedAt: 2, createdByName: 'שותפה' }
    ],
    pendingIds: new Set(),
    pendingDeletes: new Set(),
    privateIds: new Set()
  });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out.find(t => t.id === 'theirs').createdByName, 'שותפה');
});

check('shared merge unions categories, cloud wins overlapping budgets, local fills gaps', () => {
  const merged = merge.mergeShared({
    categories: { income: ['משכורת'], expense: ['מזון', 'דיור'] },
    budgets: { מזון: 100, דיור: 4500 },
    accounts: [{ id: 'default', name: 'ראשי' }],
    savingsGoals: [],
    quickAdds: [],
    balanceCheckins: [{ id: 'c1', date: '2026-11-01', amount: 10 }],
    assistantSuggestions: [{ id: 'a', text: 'מה היתרה?' }],
    envelopeAdjustments: { '2026-11': { מזון: 5 } }
  }, {
    categories: { income: ['פרילנס'], expense: ['מזון'] },
    budgets: { מזון: 200, קפה: 30 },
    accounts: [{ id: 'card', name: 'אשראי' }],
    savingsGoals: [{ id: 'g1', name: 'חופשה', target: 1000 }],
    quickAdds: [],
    balanceCheckins: [{ id: 'c2', date: '2026-11-02', amount: 20 }],
    assistantSuggestions: [{ id: 'b', text: 'מה היתרה?' }, { id: 'c', text: 'חדש' }],
    envelopeAdjustments: { '2026-11': { דיור: 1 } }
  });
  assert.deepStrictEqual(merged.categories.income, ['פרילנס', 'משכורת']);
  assert.deepStrictEqual(merged.categories.expense, ['מזון', 'דיור']);
  assert.strictEqual(merged.budgets['מזון'], 200);
  assert.strictEqual(merged.budgets['דיור'], 4500);
  assert.strictEqual(merged.budgets['קפה'], 30);
  assert.strictEqual(merged.accounts.length, 2);
  assert.strictEqual(merged.balanceCheckins.length, 2);
  assert.strictEqual(merged.assistantSuggestions.length, 2);
  assert.strictEqual(merged.envelopeAdjustments['2026-11']['מזון'], 5);
  assert.strictEqual(merged.envelopeAdjustments['2026-11']['דיור'], 1);
});

check('recurring duplicates with a different id are not uploaded twice', () => {
  const merged = merge.mergeById(
    [{ id: 'local', name: 'שכירות', type: 'expense', amount: 4500, frequency: 'monthly', startDate: '2026-01-01', category: 'דיור' }],
    [{ id: 'cloud', name: 'שכירות', type: 'expense', amount: 4500, frequency: 'monthly', startDate: '2026-01-01', category: 'דיור' }],
    merge.recurringFingerprint
  );
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].id, 'cloud');
});

check('replace keeps receipts for transactions that exist on both sides', () => {
  const out = merge.replaceTransactions(
    [{ id: 't1', receiptId: 'pic' }, { id: 'local-only', receiptId: 'nope' }],
    [{ id: 't1', amount: 5, createdByName: 'נועה' }, { id: 't2', amount: 7 }]
  );
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].receiptId, 'pic');
  assert.strictEqual(out[0].createdByName, 'נועה');
  assert.strictEqual(out.find(t => t.id === 'local-only'), undefined);
});

check('iPhone Safari and Chrome do not fall back to redirect sign-in', () => {
  const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const crios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1';
  assert.strictEqual(merge.browserBlocksRedirectSignIn(safari), true);
  assert.strictEqual(merge.shouldFallbackToRedirect('auth/popup-blocked', safari), false);
  assert.strictEqual(merge.shouldFallbackToRedirect('auth/operation-not-supported-in-this-environment', crios), false);
  assert.strictEqual(merge.shouldFallbackToRedirect('auth/popup-blocked', crios), false);
});

check('desktop Safari and Firefox do not use the broken redirect either', () => {
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
  assert.strictEqual(merge.shouldFallbackToRedirect('auth/operation-not-supported-in-this-environment', safari), false);
  assert.strictEqual(merge.shouldFallbackToRedirect('auth/popup-blocked', firefox), false);
});

check('redirect is only a fallback when the popup API itself is missing', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  assert.strictEqual(merge.shouldFallbackToRedirect('auth/popup-blocked', chrome), false);
  assert.strictEqual(merge.shouldFallbackToRedirect('auth/operation-not-supported-in-this-environment', chrome), true);
  assert.strictEqual(merge.shouldFallbackToRedirect('auth/operation-not-supported-in-this-environment', chrome, { iPadOS: true }), false);
});

check('a stale snapshot does not drop a balance that was just saved', () => {
  const local = {
    categories: { income: ['משכורת'], expense: ['מזון'] },
    budgets: { מזון: 100 },
    accounts: [{ id: 'default', name: 'ראשי' }],
    balanceCheckins: [{ id: 'now', date: '2026-11-19', amount: 5000.5, createdAt: 300, updatedAt: 300, accountId: 'all' }]
  };
  const remote = {
    categories: { income: ['משכורת'], expense: ['מזון'] },
    budgets: { מזון: 100 },
    accounts: [{ id: 'default', name: 'ראשי' }],
    balanceCheckins: [],
    updatedAt: 100,
    updatedBy: 'partner'
  };
  const decision = merge.reconcileShared({ local, remote, dirty: true, localStamp: 300, force: false });
  assert.strictEqual(decision.shared.balanceCheckins.length, 1);
  assert.strictEqual(decision.shared.balanceCheckins[0].amount, 5000.5);
  assert.strictEqual(decision.dirty, true);
  assert.strictEqual(decision.shared.budgets['מזון'], 100);
});

check('a newer household snapshot delivers the balance and asks for a redraw', () => {
  const local = {
    categories: { income: ['משכורת'], expense: ['מזון'] },
    budgets: {},
    balanceCheckins: []
  };
  const remote = {
    categories: { income: ['משכורת'], expense: ['מזון'] },
    budgets: {},
    balanceCheckins: [{ id: 'now', date: '2026-11-19', amount: 8200.4, createdAt: 400, updatedAt: 400, accountId: 'all' }],
    updatedAt: 400
  };
  const decision = merge.reconcileShared({ local, remote, dirty: false, localStamp: 100, force: false });
  assert.strictEqual(decision.changed, true);
  assert.strictEqual(decision.dirty, false);
  assert.strictEqual(decision.shared.balanceCheckins[0].amount, 8200.4);
});

check('an older cloud copy does not erase a newer local starting balance', () => {
  const local = {
    balanceCheckins: [{ id: 'now', date: '2026-11-19', amount: 1500.25, createdAt: 500, updatedAt: 500, accountId: 'all' }]
  };
  const remote = {
    balanceCheckins: [],
    categories: { income: [], expense: ['מזון'] },
    budgets: {},
    updatedAt: 100
  };
  const decision = merge.reconcileShared({ local, remote, dirty: false, localStamp: 0, force: false });
  assert.strictEqual(decision.shared.balanceCheckins[0].amount, 1500.25);
  assert.strictEqual(decision.dirty, true);
});

check('a delete tombstone beats an older copy of the same balance', () => {
  const merged = merge.mergeCheckins(
    [{ id: 'now', date: '2026-11-19', amount: 10, updatedAt: 8, deleted: true }],
    [{ id: 'now', date: '2026-11-19', amount: 10, updatedAt: 4 }]
  );
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].deleted, true);
});

check('cloud transaction keeps createdAt so a same-day expense moves both balances', () => {
  const cloud = merge.txForCloud({
    id: 't', type: 'expense', amount: 20.4, category: 'מזון', date: '2026-11-19', note: '',
    createdAt: 1500
  }, { uid: 'u1', displayName: 'דן' });
  assert.strictEqual(cloud.createdAt, 1500);
  const without = merge.txForCloud({
    id: 't2', type: 'expense', amount: 1, category: 'מזון', date: '2026-11-01', note: ''
  }, { uid: 'u1' });
  assert.strictEqual(without.createdAt, undefined);
});

check('cloud transaction does not include the receipt payload', () => {
  const cloud = merge.txForCloud({
    id: 't', type: 'expense', amount: 1, category: 'מזון', date: '2026-11-01', note: '',
    receipt: 'data:image/jpeg;base64,AAAA', receiptId: 'r'
  }, { uid: 'u1', displayName: 'דן', photoURL: 'https://example.com/a.png' });
  assert.strictEqual(cloud.receipt, undefined);
  assert.strictEqual(cloud.receiptId, undefined);
  assert.strictEqual(cloud.createdBy, 'u1');
  assert.strictEqual(cloud.createdByName, 'דן');
});

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all cloud-merge tests passed');
