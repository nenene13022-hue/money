/* Pure household-merge helpers. No Firebase. Used by the browser and by node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KaspitCloudMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function isFirebaseConfigured(config) {
    if (!config || typeof config !== 'object') return false;
    const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
    return required.every(key => {
      const value = config[key];
      if (typeof value !== 'string') return false;
      const trimmed = value.trim();
      if (!trimmed) return false;
      if (/^PASTE_/i.test(trimmed)) return false;
      if (/YOUR_|PLACEHOLDER|xxx+/i.test(trimmed)) return false;
      return true;
    });
  }

  function makeInviteCode(rng) {
    const random = rng || Math.random;
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
    return code;
  }

  function cents(amount) {
    const n = Number(amount);
    if (!isFinite(n)) return 0;
    return Math.round(n * 100);
  }

  function txFingerprint(t) {
    if (!t) return '';
    return [
      t.date || '',
      t.type === 'income' ? 'income' : 'expense',
      String(cents(t.amount)),
      String(t.category || '').trim(),
      String(t.note || '').trim(),
      t.accountId || 'default'
    ].join('|');
  }

  function recurringFingerprint(r) {
    if (!r) return '';
    return [
      String(r.name || '').trim(),
      r.type === 'income' ? 'income' : 'expense',
      String(cents(r.amount)),
      r.frequency || 'monthly',
      r.startDate || '',
      String(r.category || '').trim()
    ].join('|');
  }

  function receiptFields(t) {
    const out = {};
    if (!t) return out;
    if (t.receiptId) out.receiptId = t.receiptId;
    if (typeof t.receipt === 'string' && t.receipt.indexOf('data:') === 0) out.receipt = t.receipt;
    return out;
  }

  function txForCloud(t, user) {
    const now = Date.now();
    return {
      id: t.id,
      type: t.type === 'income' ? 'income' : 'expense',
      amount: Number(t.amount) || 0,
      category: t.category || '',
      date: t.date || '',
      note: t.note || '',
      accountId: t.accountId || 'default',
      recurringId: t.recurringId || null,
      createdBy: t.createdBy || (user && user.uid) || null,
      createdByName: t.createdByName || (user && user.displayName) || '',
      createdByPhoto: t.createdByPhoto || (user && user.photoURL) || '',
      updatedAt: t.updatedAt || now,
      updatedBy: t.updatedBy || (user && user.uid) || null
    };
  }

  function reconcileTransactions(opts) {
    const local = opts.local || [];
    const remote = opts.remote || [];
    const pendingIds = opts.pendingIds || new Set();
    const pendingDeletes = opts.pendingDeletes || new Set();
    const privateIds = opts.privateIds || new Set();
    const localById = new Map(local.map(t => [t.id, t]));
    const remoteById = new Map(remote.map(t => [t.id, t]));
    const ids = new Set([...localById.keys(), ...remoteById.keys()]);
    const out = [];
    ids.forEach(id => {
      if (pendingDeletes.has(id)) return;
      const left = localById.get(id);
      const right = remoteById.get(id);
      if (left && right) {
        const localNewer = (left.updatedAt || 0) > (right.updatedAt || 0);
        const picked = localNewer ? left : right;
        const base = localNewer ? right : left;
        out.push(Object.assign({}, base, picked, receiptFields(left)));
      } else if (right) {
        out.push(Object.assign({}, right));
      } else if (left && (pendingIds.has(id) || privateIds.has(id))) {
        out.push(left);
      }
    });
    return out;
  }

  function mergeInitialTransactions(local, remote) {
    const pending = new Set((local || []).map(t => t.id));
    const union = reconcileTransactions({
      local: local || [],
      remote: remote || [],
      pendingIds: pending,
      pendingDeletes: new Set(),
      privateIds: new Set()
    });
    const remoteIds = new Set((remote || []).map(t => t.id));
    const remoteFps = new Set((remote || []).map(txFingerprint));
    const localByFp = new Map();
    (local || []).forEach(t => {
      const fp = txFingerprint(t);
      if (!localByFp.has(fp)) localByFp.set(fp, t);
    });
    return union
      .filter(t => remoteIds.has(t.id) || !remoteFps.has(txFingerprint(t)))
      .map(t => {
        const localDup = localByFp.get(txFingerprint(t));
        if (!localDup || localDup.id === t.id) return t;
        return Object.assign({}, t, receiptFields(localDup));
      });
  }

  function replaceTransactions(local, remote) {
    const localById = new Map((local || []).map(t => [t.id, t]));
    return (remote || []).map(t => Object.assign({}, t, receiptFields(localById.get(t.id))));
  }

  function mergeById(localList, remoteList, fingerprintFn) {
    const local = localList || [];
    const remote = remoteList || [];
    const localById = new Map(local.map(item => [item.id, item]));
    const usedFps = new Set();
    const usedIds = new Set();
    const out = [];
    remote.forEach(item => {
      const localItem = localById.get(item.id);
      const picked = localItem && (localItem.updatedAt || 0) > (item.updatedAt || 0)
        ? Object.assign({}, item, localItem)
        : item;
      out.push(picked);
      usedIds.add(picked.id);
      if (fingerprintFn) usedFps.add(fingerprintFn(picked));
    });
    local.forEach(item => {
      if (usedIds.has(item.id)) return;
      if (fingerprintFn && usedFps.has(fingerprintFn(item))) return;
      out.push(item);
      usedIds.add(item.id);
      if (fingerprintFn) usedFps.add(fingerprintFn(item));
    });
    return out;
  }

  function unionNames(primary, extra) {
    const out = [];
    const seen = new Set();
    (primary || []).concat(extra || []).forEach(name => {
      const value = String(name || '').trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      out.push(value);
    });
    return out;
  }

  function mergeBudgets(local, remote) {
    const out = Object.assign({}, local || {});
    Object.keys(remote || {}).forEach(key => { out[key] = remote[key]; });
    return out;
  }

  function mergeEnvelope(local, remote) {
    const out = JSON.parse(JSON.stringify(local || {}));
    Object.keys(remote || {}).forEach(month => {
      out[month] = Object.assign({}, out[month] || {}, remote[month] || {});
    });
    return out;
  }

  function mergeShared(localState, remoteShared) {
    const remote = remoteShared || {};
    const localCats = (localState && localState.categories) || { income: [], expense: [] };
    const remoteCats = remote.categories || { income: [], expense: [] };
    return {
      categories: {
        income: unionNames(remoteCats.income, localCats.income),
        expense: unionNames(remoteCats.expense, localCats.expense)
      },
      budgets: mergeBudgets(localState && localState.budgets, remote.budgets),
      accounts: mergeById(localState && localState.accounts, remote.accounts),
      savingsGoals: mergeById(localState && localState.savingsGoals, remote.savingsGoals),
      quickAdds: mergeById(localState && localState.quickAdds, remote.quickAdds),
      balanceCheckins: mergeById(localState && localState.balanceCheckins, remote.balanceCheckins),
      assistantSuggestions: mergeById(
        localState && localState.assistantSuggestions,
        remote.assistantSuggestions,
        item => String(item && item.text || '').trim()
      ),
      envelopeAdjustments: mergeEnvelope(localState && localState.envelopeAdjustments, remote.envelopeAdjustments)
    };
  }

  function sharedFromState(state, user) {
    return {
      categories: state.categories,
      budgets: state.budgets || {},
      accounts: state.accounts || [],
      savingsGoals: state.savingsGoals || [],
      quickAdds: state.quickAdds || [],
      balanceCheckins: state.balanceCheckins || [],
      assistantSuggestions: state.assistantSuggestions || [],
      envelopeAdjustments: state.envelopeAdjustments || {},
      updatedAt: Date.now(),
      updatedBy: (user && user.uid) || null
    };
  }

  function recurringForCloud(item, user) {
    return {
      id: item.id,
      name: item.name || '',
      type: item.type === 'income' ? 'income' : 'expense',
      amount: Number(item.amount) || 0,
      category: item.category || '',
      frequency: item.frequency === 'weekly' ? 'weekly' : 'monthly',
      startDate: item.startDate || '',
      active: item.active !== false,
      lastGenerated: item.lastGenerated || null,
      accountId: item.accountId || 'default',
      updatedAt: item.updatedAt || Date.now(),
      updatedBy: item.updatedBy || (user && user.uid) || null
    };
  }

  return {
    CODE_ALPHABET,
    isFirebaseConfigured,
    makeInviteCode,
    txFingerprint,
    recurringFingerprint,
    receiptFields,
    txForCloud,
    reconcileTransactions,
    mergeInitialTransactions,
    replaceTransactions,
    mergeById,
    mergeShared,
    sharedFromState,
    recurringForCloud
  };
});
