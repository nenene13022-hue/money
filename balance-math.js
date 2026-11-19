/* How much money is in the household right now.
   A check-in is the real balance at a moment. Transactions dated before that
   day are already inside it. Transactions later, and ones added after the
   check-in on the same day, move the number up and down. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KaspitBalance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function signed(t) {
    const n = Number(t && t.amount) || 0;
    return t && t.type === 'income' ? n : -n;
  }

  function forAccount(transactions, accountId) {
    const list = transactions || [];
    if (!accountId || accountId === 'all') return list;
    return list.filter(t => (t.accountId || 'default') === accountId);
  }

  function anchorMatches(checkin, accountId) {
    const acc = (checkin && checkin.accountId) || 'all';
    if (!accountId || accountId === 'all') return acc === 'all';
    return acc === accountId;
  }

  function latestAnchor(checkins, accountId) {
    const list = (checkins || []).filter(c => anchorMatches(c, accountId));
    list.sort((a, b) => {
      const byDate = String(b.date).localeCompare(String(a.date));
      if (byDate) return byDate;
      const byCreated = (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
      if (byCreated) return byCreated;
      return String(b.id).localeCompare(String(a.id));
    });
    return list[0] || null;
  }

  // True when this transaction is not already baked into the anchor amount.
  function isAfterAnchor(t, anchor) {
    if (!anchor) return true;
    if (t.date < anchor.date) return false;
    if (t.date > anchor.date) return true;
    const anchorMs = Number(anchor.createdAt) || 0;
    const txMs = Number(t.createdAt) || 0;
    if (!anchorMs || !txMs) return false;
    return txMs > anchorMs;
  }

  function currentBalance(opts) {
    const today = opts.today;
    const txs = forAccount(opts.transactions, opts.accountId);
    const anchor = latestAnchor(opts.checkins, opts.accountId);
    const relevant = txs.filter(t => t.date <= today && isAfterAnchor(t, anchor));
    const net = round2(relevant.reduce((s, t) => s + signed(t), 0));
    const income = round2(relevant.filter(t => t.type === 'income').reduce((s, t) => s + (Number(t.amount) || 0), 0));
    const expense = round2(relevant.filter(t => t.type !== 'income').reduce((s, t) => s + (Number(t.amount) || 0), 0));
    if (!anchor) {
      return { amount: net, anchor: null, netSince: net, incomeSince: income, expenseSince: expense };
    }
    return {
      amount: round2(Number(anchor.amount) + net),
      anchor,
      netSince: net,
      incomeSince: income,
      expenseSince: expense
    };
  }

  function balanceAtCutoff(opts) {
    const cutoff = opts.cutoff;
    const txs = forAccount(opts.transactions, opts.accountId);
    const anchor = latestAnchor(opts.checkins, opts.accountId);
    if (!anchor) {
      return round2(txs.filter(t => t.date <= cutoff).reduce((s, t) => s + signed(t), 0));
    }
    if (cutoff < anchor.date) {
      const alreadyInside = txs.filter(t => !isAfterAnchor(t, anchor));
      const afterCutoff = alreadyInside.filter(t => t.date > cutoff).reduce((s, t) => s + signed(t), 0);
      return round2(Number(anchor.amount) - afterCutoff);
    }
    const net = txs.filter(t => isAfterAnchor(t, anchor) && t.date <= cutoff).reduce((s, t) => s + signed(t), 0);
    return round2(Number(anchor.amount) + net);
  }

  return {
    round2,
    signed,
    latestAnchor,
    isAfterAnchor,
    currentBalance,
    balanceAtCutoff
  };
});
