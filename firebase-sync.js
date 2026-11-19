/* Optional household sync. Loads the Firebase SDK only after firebase-config.js
   has real values. With placeholders this file does nothing and the app stays local. */
(function () {
  const merge = window.KaspitCloudMerge;
  const config = window.KASPIT_FIREBASE_CONFIG;
  const LINK_KEY = 'kaspit_cloud_link';
  const PRIVATE_KEY = 'kaspit_cloud_private_ids';
  const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

  const cloud = {
    enabled: false,
    applying: false,
    isApplying: function () { return cloud.applying; },
    linked: function () { return !!(cloud._hid && cloud._user); },
    ready: Promise.resolve(),
    start: function () {},
    render: function () {},
    onLocalSave: function () {}
  };
  window.kaspitCloud = cloud;

  if (!merge || !merge.isFirebaseConfigured(config)) return;

  cloud.ready = boot().catch(function (err) {
    console.error('Firebase sync failed to start', err);
    cloud.enabled = false;
  });

  async function boot() {
    const appMod = await import(SDK + '/firebase-app.js');
    const authMod = await import(SDK + '/firebase-auth.js');
    const fs = await import(SDK + '/firebase-firestore.js');

    const app = appMod.initializeApp(config);
    const persistenceOptions = [
      authMod.indexedDBLocalPersistence,
      authMod.browserLocalPersistence,
      authMod.browserSessionPersistence
    ].filter((item, index, list) => item && list.indexOf(item) === index);
    let auth;
    try {
      auth = authMod.initializeAuth(app, {
        persistence: persistenceOptions,
        popupRedirectResolver: authMod.browserPopupRedirectResolver
      });
    } catch (err) {
      auth = authMod.getAuth(app);
      try {
        await authMod.setPersistence(auth, authMod.indexedDBLocalPersistence || authMod.browserLocalPersistence);
      } catch (err2) {
        console.error(err2);
      }
    }
    auth.languageCode = 'he';
    const provider = new authMod.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    let db;
    try {
      db = fs.initializeFirestore(app, {
        localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() })
      });
    } catch (err) {
      try {
        db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache() });
      } catch (err2) {
        db = fs.getFirestore(app);
      }
    }

    let user = null;
    let householdId = null;
    let householdDoc = null;
    let unsubs = [];
    let pushTimer = null;
    let pushing = false;
    let pushAgain = false;
    const pendingIds = new Set();
    const pendingDeletes = new Set();
    const pendingRecIds = new Set();
    const pendingRecDeletes = new Set();
    let privateIds = loadPrivate();
    let remoteTx = new Map();
    let remoteRec = new Map();
    let remoteShared = null;
    let sawTx = false;
    let sawRec = false;
    let sawShared = false;
    let localSharedStamp = 0;
    let fromCache = false;
    let hasPendingWrites = false;
    let wired = false;
    let authError = '';
    const REDIRECT_FLAG = 'kaspit_auth_redirect_pending';

    cloud._user = null;
    cloud._hid = null;
    cloud.enabled = true;
    cloud.start = start;
    cloud.render = render;
    cloud.onLocalSave = onLocalSave;

    function loadPrivate() {
      try { return new Set(JSON.parse(localStorage.getItem(PRIVATE_KEY) || '[]')); }
      catch (e) { return new Set(); }
    }
    function savePrivate() {
      localStorage.setItem(PRIVATE_KEY, JSON.stringify([...privateIds]));
    }
    function readLink() {
      try { return JSON.parse(localStorage.getItem(LINK_KEY) || 'null'); }
      catch (e) { return null; }
    }
    function rememberLink(hid) {
      localStorage.setItem(LINK_KEY, JSON.stringify({ uid: user.uid, householdId: hid }));
    }
    function forgetLink() {
      localStorage.removeItem(LINK_KEY);
      householdId = null;
      cloud._hid = null;
      householdDoc = null;
    }
    function profile() {
      return {
        uid: user.uid,
        displayName: user.displayName || 'בן בית',
        photoURL: user.photoURL || '',
        email: user.email || ''
      };
    }
    function toast(msg) {
      if (typeof window.toast === 'function') window.toast(msg, 4200);
    }
    function readState() {
      return window.kaspitReadState();
    }

    function payloadKey(t) {
      return JSON.stringify({
        type: t.type === 'income' ? 'income' : 'expense',
        amount: Number(t.amount) || 0,
        category: t.category || '',
        date: t.date || '',
        note: t.note || '',
        accountId: t.accountId || 'default',
        recurringId: t.recurringId || null
      });
    }
    function recKey(r) {
      return JSON.stringify({
        name: r.name || '',
        type: r.type === 'income' ? 'income' : 'expense',
        amount: Number(r.amount) || 0,
        category: r.category || '',
        frequency: r.frequency === 'weekly' ? 'weekly' : 'monthly',
        startDate: r.startDate || '',
        active: r.active !== false,
        lastGenerated: r.lastGenerated || null,
        accountId: r.accountId || 'default'
      });
    }

    function setStatus() {
      const els = document.querySelectorAll('[data-cloud-indicator]');
      let kind = 'off';
      let label = '';
      const linked = !!(user && householdId);
      if (!linked) {
        els.forEach(el => { el.hidden = true; });
        return;
      }
      if (!navigator.onLine || fromCache) {
        kind = 'pending';
        label = 'לא מקוון, יסתנכרן אחר כך';
      } else if (hasPendingWrites || pushing) {
        kind = 'pending';
        label = 'מסנכרן…';
      } else {
        kind = 'ok';
        label = 'מסונכרן';
      }
      els.forEach(el => {
        el.hidden = false;
        el.classList.remove('ok', 'pending', 'off', 'err');
        el.classList.add(kind);
        const text = el.querySelector('.cloud-sync-label');
        if (text) text.textContent = label;
      });
    }

    function render() {
      const heading = document.getElementById('cloudSyncHeading');
      const card = document.getElementById('cloudSyncCard');
      const body = document.getElementById('cloudSyncBody');
      if (!card || !body) return;
      if (heading) heading.hidden = false;
      card.hidden = false;
      const me = user ? profile() : null;
      if (!user) {
        body.innerHTML = `
          <p class="hint">שני אנשים יכולים לנהל את אותו פנקס. כל תנועה שאחד מוסיף, עורך או מוחק מופיעה אצל השני. הכניסה היא עם חשבון Google.</p>
          <div class="btn-row">
            <button type="button" class="btn-primary" data-cloud-action="signin">כניסה עם Google</button>
          </div>
          ${authError ? `<p class="hint cloud-auth-error" role="alert">${esc(authError)}</p>` : ''}`;
        setStatus();
        return;
      }
      if (!householdId) {
        body.innerHTML = `
          <div class="cloud-member">${avatarHtml(me.photoURL, me.displayName)} <strong>${esc(me.displayName)}</strong></div>
          <p class="hint">אין עדיין בית משותף על החשבון הזה. אפשר ליצור אחד ולשלוח קוד, או להצטרף עם קוד שקיבלת.</p>
          <div class="btn-row">
            <button type="button" class="btn-primary" data-cloud-action="create">יצירת בית משותף</button>
            <button type="button" class="btn-secondary" data-cloud-action="signout">יציאה</button>
          </div>
          <div class="add-cat-row" style="margin-top:12px">
            <label class="visually-hidden" for="cloudJoinCode">קוד הצטרפות</label>
            <input type="text" id="cloudJoinCode" class="date-input" dir="ltr" maxlength="6" placeholder="קוד הצטרפות" autocomplete="off" style="text-transform:uppercase">
            <button type="button" class="btn-secondary small" data-cloud-action="join">הצטרפות</button>
          </div>`;
        setStatus();
        return;
      }
      const code = (householdDoc && householdDoc.inviteCode) || '';
      const members = (householdDoc && householdDoc.memberUids) || [];
      body.innerHTML = `
        <div class="cloud-member">${avatarHtml(me.photoURL, me.displayName)} <span>מחובר כ-<strong>${esc(me.displayName)}</strong></span></div>
        <p class="hint">קוד ההזמנה לבן או בת הזוג:</p>
        <div class="invite-code" dir="ltr">${esc(code)}</div>
        <div class="btn-row">
          <button type="button" class="btn-secondary" data-cloud-action="copy" data-code="${esc(code)}">העתקת הקוד</button>
          ${privateIds.size ? '<button type="button" class="btn-secondary" data-cloud-action="upload">העלאת הנתונים מהמכשיר</button>' : ''}
        </div>
        <p class="hint">בבית: ${members.length} ${members.length === 1 ? 'אדם' : 'אנשים'}.</p>
        <p class="hint">קבלות נשמרות רק במכשיר הזה ולא עוברות לבן או בת הזוג. נעילת PIN נועלת את המכשיר ומצפינה את העותק המקומי, אבל הפנקס המשותף בענן גלוי למי שנכנס לבית עם Google — גם בלי ה-PIN.</p>
        <div class="btn-row">
          <button type="button" class="btn-secondary" data-cloud-action="leave">יציאה מהבית</button>
          <button type="button" class="btn-secondary" data-cloud-action="signout">יציאה מהחשבון</button>
        </div>`;
      setStatus();
      if (typeof window.hydrateIcons === 'function') window.hydrateIcons(card);
    }

    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }
    function avatarHtml(photo, name) {
      const initial = esc((name || '?').trim().charAt(0));
      if (photo && /^https:\/\//.test(photo)) {
        return `<span class="tx-author"><img src="${esc(photo)}" alt=""></span>`;
      }
      return `<span class="tx-author"><span>${initial}</span></span>`;
    }

    function choose(opts) {
      return new Promise(resolve => {
        const overlay = document.getElementById('cloudChoiceOverlay');
        document.getElementById('cloudChoiceTitle').textContent = opts.title;
        document.getElementById('cloudChoiceText').textContent = opts.text;
        const primary = document.getElementById('cloudChoicePrimary');
        const secondary = document.getElementById('cloudChoiceSecondary');
        const closer = document.getElementById('cloudChoiceClose');
        primary.textContent = opts.primary;
        secondary.textContent = opts.secondary;
        let settled = false;
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          finish('secondary');
        };
        const finish = (value) => {
          if (settled) return;
          settled = true;
          primary.onclick = null;
          secondary.onclick = null;
          if (closer) closer.onclick = null;
          overlay.removeEventListener('keydown', onKey);
          overlay.removeEventListener('click', onBackdrop, true);
          if (typeof window.closeModalOverlay === 'function') window.closeModalOverlay(overlay);
          else overlay.classList.remove('active');
          resolve(value);
        };
        primary.onclick = () => finish('primary');
        secondary.onclick = () => finish('secondary');
        if (closer) closer.onclick = () => finish('secondary');
        const onBackdrop = (event) => {
          if (event.target !== overlay) return;
          event.stopPropagation();
          finish('secondary');
        };
        overlay.addEventListener('click', onBackdrop, true);
        overlay.addEventListener('keydown', onKey);
        if (typeof window.openModalOverlay === 'function') window.openModalOverlay(overlay);
        else overlay.classList.add('active');
      });
    }

    function showAuthError(message) {
      authError = message || '';
      if (authError) toast(authError);
      render();
    }

    function deviceExtras() {
      let iPadOS = false;
      try {
        iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
      } catch (e) { /* ignore */ }
      return { iPadOS };
    }

    async function signIn() {
      authError = '';
      try {
        await authMod.signInWithPopup(auth, provider);
        authError = '';
        render();
      } catch (err) {
        const code = err && err.code;
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
          showAuthError('חלון ההתחברות נסגר לפני שהחשבון חובר. נסו שוב.');
          return;
        }
        if (merge.shouldFallbackToRedirect(code, navigator.userAgent || '', deviceExtras())) {
          try {
            sessionStorage.setItem(REDIRECT_FLAG, '1');
            await authMod.signInWithRedirect(auth, provider);
            return;
          } catch (err2) {
            try { sessionStorage.removeItem(REDIRECT_FLAG); } catch (e) { /* ignore */ }
            console.error(err2);
            showAuthError(authMessage(err2));
            return;
          }
        }
        console.error(err);
        showAuthError(authMessage(err));
      }
    }

    function authMessage(err) {
      const code = err && err.code;
      if (code === 'auth/unauthorized-domain') return 'הדומיין הזה לא מורשה ב-Firebase. צריך להוסיף את nenene13022-hue.github.io.';
      if (code === 'auth/popup-blocked') return 'הדפדפן חסם את חלון ההתחברות. אפשרו חלונות קופצים לאתר ונסו שוב.';
      if (code === 'auth/operation-not-supported-in-this-environment') return 'הדפדפן הזה לא פותח חלון התחברות. נסו Safari או Chrome רגיל.';
      if (code === 'auth/web-storage-unsupported') return 'הדפדפן חוסם שמירת התחברות. בטלו חסימת עוגיות לאתר ונסו שוב.';
      return 'ההתחברות נכשלה. נסו שוב.';
    }

    async function uniqueCode() {
      for (let i = 0; i < 8; i++) {
        const code = merge.makeInviteCode();
        const snap = await fs.getDoc(fs.doc(db, 'inviteCodes', code));
        if (!snap.exists()) return code;
      }
      throw new Error('code');
    }

    async function createHousehold() {
      const s = readState();
      const hasData = (s.transactions && s.transactions.length) || (s.recurring && s.recurring.length) || Object.keys(s.budgets || {}).length;
      let upload = true;
      if (hasData) {
        const choice = await choose({
          title: 'יצירת בית משותף',
          text: 'להעלות לבית את התנועות, התקציבים והוראות הקבע שכבר שמורים במכשיר הזה? בלי העלאה הבית מתחיל בלי ההיסטוריה, והנתונים הקיימים נשארים רק כאן.',
          primary: 'העלאת הנתונים',
          secondary: 'בלי העלאה'
        });
        upload = choice === 'primary';
      }
      const code = await uniqueCode();
      const ref = fs.doc(fs.collection(db, 'households'));
      const hid = ref.id;
      const me = profile();
      await fs.setDoc(ref, {
        name: 'הבית שלנו',
        ownerUid: user.uid,
        inviteCode: code,
        memberUids: [user.uid],
        createdAt: Date.now()
      });
      await fs.setDoc(fs.doc(db, 'households', hid, 'members', user.uid), {
        uid: user.uid,
        name: me.displayName,
        photoURL: me.photoURL,
        email: me.email,
        joinedAt: Date.now()
      });
      await fs.setDoc(fs.doc(db, 'inviteCodes', code), { householdId: hid });
      householdId = hid;
      cloud._hid = hid;
      rememberLink(hid);
      if (upload) {
        privateIds = new Set();
        savePrivate();
        await pushEverything();
      } else {
        privateIds = new Set([].concat(
          (s.transactions || []).map(t => t.id),
          (s.recurring || []).map(r => r.id)
        ));
        savePrivate();
      }
      subscribe();
      toast(upload ? 'הבית נוצר והנתונים הועלו' : 'הבית נוצר. ההיסטוריה נשארה רק במכשיר הזה');
      render();
    }

    async function joinHousehold() {
      const input = document.getElementById('cloudJoinCode');
      const code = String((input && input.value) || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) { toast('הקוד צריך להיות 6 תווים'); return; }
      const codeSnap = await fs.getDoc(fs.doc(db, 'inviteCodes', code));
      if (!codeSnap.exists()) { toast('הקוד לא נמצא'); return; }
      const hid = codeSnap.data().householdId;
      const choice = await choose({
        title: 'הצטרפות לבית',
        text: 'מיזוג מוסיף את התנועות מהמכשיר לבית, בלי לשכפל תנועה שכבר קיימת. החלפה משאירה במכשיר רק את מה שכבר בבית.',
        primary: 'מיזוג',
        secondary: 'החלפה בנתוני הבית'
      });
      const me = profile();
      await fs.setDoc(fs.doc(db, 'households', hid, 'members', user.uid), {
        uid: user.uid,
        name: me.displayName,
        photoURL: me.photoURL,
        email: me.email,
        inviteCode: code,
        joinedAt: Date.now()
      });
      await fs.updateDoc(fs.doc(db, 'households', hid), { memberUids: fs.arrayUnion(user.uid) });
      const remoteTxs = await loadCollection(hid, 'transactions');
      const remoteRecs = await loadCollection(hid, 'recurring');
      const sharedSnap = await fs.getDoc(fs.doc(db, 'households', hid, 'meta', 'shared'));
      const shared = sharedSnap.exists() ? sharedSnap.data() : null;
      remoteTx = new Map(remoteTxs.map(t => [t.id, t]));
      remoteRec = new Map(remoteRecs.map(r => [r.id, r]));
      remoteShared = shared;
      const s = readState();
      if (choice === 'secondary') {
        s.transactions = merge.replaceTransactions(s.transactions, remoteTxs);
        s.recurring = remoteRecs;
        if (shared) applySharedFields(s, shared, true);
      } else {
        s.transactions = merge.mergeInitialTransactions(s.transactions, remoteTxs);
        s.recurring = merge.mergeById(s.recurring, remoteRecs, merge.recurringFingerprint);
        const mergedShared = merge.mergeShared(s, shared || {});
        applySharedFields(s, mergedShared, true);
      }
      privateIds = new Set();
      savePrivate();
      householdId = hid;
      cloud._hid = hid;
      rememberLink(hid);
      await persistLocal();
      await pushEverything();
      subscribe();
      toast('הצטרפתם לבית המשותף');
      render();
    }

    function applySharedFields(s, shared, force) {
      if (!shared) return;
      if (!force && localSharedStamp && (shared.updatedAt || 0) < localSharedStamp) return;
      if (shared.categories) s.categories = shared.categories;
      if ('budgets' in shared) s.budgets = shared.budgets || {};
      if (shared.accounts && shared.accounts.length) s.accounts = shared.accounts;
      if (shared.savingsGoals) s.savingsGoals = shared.savingsGoals;
      if (shared.quickAdds) s.quickAdds = shared.quickAdds;
      if (shared.balanceCheckins) s.balanceCheckins = shared.balanceCheckins;
      if (shared.assistantSuggestions && shared.assistantSuggestions.length) s.assistantSuggestions = shared.assistantSuggestions;
      if (shared.envelopeAdjustments) s.envelopeAdjustments = shared.envelopeAdjustments;
      localSharedStamp = shared.updatedAt || localSharedStamp;
    }

    async function loadCollection(hid, name) {
      const snap = await fs.getDocs(fs.collection(db, 'households', hid, name));
      return snap.docs.map(d => d.data());
    }

    async function persistLocal() {
      cloud.applying = true;
      try {
        if (typeof window.saveState === 'function') await window.saveState();
      } finally {
        cloud.applying = false;
      }
    }

    function onLocalSave() {
      if (cloud.applying || !householdId || !user) return;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(function () { pushEverything().catch(err => console.error(err)); }, 400);
    }

    async function pushEverything() {
      if (!householdId || !user) return;
      if (pushing) { pushAgain = true; return; }
      pushing = true;
      setStatus();
      try {
        const s = readState();
        const me = profile();
        const txWrites = [];
        const txDeletes = [];
        const localTxIds = new Set();
        (s.transactions || []).forEach(t => {
          if (privateIds.has(t.id)) return;
          localTxIds.add(t.id);
          const remote = remoteTx.get(t.id);
          const changed = !remote || payloadKey(remote) !== payloadKey(t);
          if (!changed) return;
          const stamped = Object.assign({}, t, {
            updatedAt: Date.now(),
            updatedBy: user.uid,
            createdBy: t.createdBy || user.uid,
            createdByName: t.createdByName || me.displayName,
            createdByPhoto: t.createdByPhoto || me.photoURL
          });
          t.updatedAt = stamped.updatedAt;
          t.updatedBy = stamped.updatedBy;
          t.createdBy = stamped.createdBy;
          t.createdByName = stamped.createdByName;
          t.createdByPhoto = stamped.createdByPhoto;
          pendingIds.add(t.id);
          txWrites.push(merge.txForCloud(stamped, me));
        });
        remoteTx.forEach((value, id) => {
          if (!localTxIds.has(id) && !privateIds.has(id)) {
            pendingDeletes.add(id);
            txDeletes.push(id);
          }
        });

        const recWrites = [];
        const recDeletes = [];
        const localRecIds = new Set();
        (s.recurring || []).forEach(r => {
          if (privateIds.has(r.id)) return;
          localRecIds.add(r.id);
          const remote = remoteRec.get(r.id);
          if (remote && recKey(remote) === recKey(r)) return;
          r.updatedAt = Date.now();
          r.updatedBy = user.uid;
          pendingRecIds.add(r.id);
          recWrites.push(merge.recurringForCloud(r, me));
        });
        remoteRec.forEach((value, id) => {
          if (!localRecIds.has(id) && !privateIds.has(id)) {
            pendingRecDeletes.add(id);
            recDeletes.push(id);
          }
        });

        const shared = merge.sharedFromState(s, me);
        const sharedChanged = !remoteShared || sharedKey(remoteShared) !== sharedKey(shared);
        if (sharedChanged) localSharedStamp = shared.updatedAt;

        const ops = [];
        txWrites.forEach(t => ops.push(batch => batch.set(fs.doc(db, 'households', householdId, 'transactions', t.id), t)));
        txDeletes.forEach(id => ops.push(batch => batch.delete(fs.doc(db, 'households', householdId, 'transactions', id))));
        recWrites.forEach(r => ops.push(batch => batch.set(fs.doc(db, 'households', householdId, 'recurring', r.id), r)));
        recDeletes.forEach(id => ops.push(batch => batch.delete(fs.doc(db, 'households', householdId, 'recurring', id))));
        if (sharedChanged) {
          ops.push(batch => batch.set(fs.doc(db, 'households', householdId, 'meta', 'shared'), shared));
        }
        for (let i = 0; i < ops.length; i += 400) {
          const batch = fs.writeBatch(db);
          ops.slice(i, i + 400).forEach(fn => fn(batch));
          await batch.commit();
        }
      } catch (err) {
        console.error(err);
        toast('הסנכרון לענן נכשל. הנתונים נשמרו במכשיר ויישלחו שוב כשיהיה חיבור.');
      } finally {
        pushing = false;
        setStatus();
        if (pushAgain) {
          pushAgain = false;
          await pushEverything();
        }
      }
    }

    function sharedKey(shared) {
      if (!shared) return '';
      const copy = Object.assign({}, shared);
      delete copy.updatedAt;
      delete copy.updatedBy;
      return JSON.stringify(copy);
    }

    function subscribe() {
      unsubAll();
      sawTx = false;
      sawRec = false;
      sawShared = false;
      const hid = householdId;
      unsubs.push(fs.onSnapshot(fs.doc(db, 'households', hid), snap => {
        householdDoc = snap.exists() ? snap.data() : null;
        fromCache = snap.metadata.fromCache;
        hasPendingWrites = snap.metadata.hasPendingWrites;
        render();
      }, onListenError));
      unsubs.push(fs.onSnapshot(fs.collection(db, 'households', hid, 'transactions'), snap => {
        remoteTx = new Map(snap.docs.map(d => [d.id, d.data()]));
        fromCache = snap.metadata.fromCache;
        hasPendingWrites = snap.metadata.hasPendingWrites;
        sawTx = true;
        applyRemote();
      }, onListenError));
      unsubs.push(fs.onSnapshot(fs.collection(db, 'households', hid, 'recurring'), snap => {
        remoteRec = new Map(snap.docs.map(d => [d.id, d.data()]));
        fromCache = snap.metadata.fromCache;
        hasPendingWrites = snap.metadata.hasPendingWrites;
        sawRec = true;
        applyRemote();
      }, onListenError));
      unsubs.push(fs.onSnapshot(fs.doc(db, 'households', hid, 'meta', 'shared'), snap => {
        remoteShared = snap.exists() ? snap.data() : null;
        fromCache = snap.metadata.fromCache;
        hasPendingWrites = snap.metadata.hasPendingWrites;
        sawShared = true;
        applyRemote();
      }, onListenError));
    }

    function unsubAll() {
      unsubs.forEach(fn => { try { fn(); } catch (e) {} });
      unsubs = [];
    }

    function onListenError(err) {
      console.error(err);
      if (err && err.code === 'permission-denied') {
        toast('אין גישה לבית המשותף. ייתכן שהחברות בוטלה.');
        unsubAll();
        forgetLink();
        render();
      } else {
        toast('החיבור לבית נקטע. הנתונים במכשיר נשארים, והסנכרון יחודש כשאפשר.');
      }
    }

    async function applyRemote() {
      if (!sawTx || !sawRec || !sawShared) return;
      if (pushing) return;
      const s = readState();
      const before = JSON.stringify({
        t: (s.transactions || []).map(t => [t.id, t.updatedAt, t.amount, t.note, t.category, t.date]),
        r: (s.recurring || []).map(r => [r.id, r.updatedAt, r.amount, r.lastGenerated, r.active]),
        b: s.budgets
      });
      s.transactions = merge.reconcileTransactions({
        local: s.transactions || [],
        remote: [...remoteTx.values()],
        pendingIds,
        pendingDeletes,
        privateIds
      });
      s.recurring = merge.reconcileTransactions({
        local: s.recurring || [],
        remote: [...remoteRec.values()],
        pendingIds: pendingRecIds,
        pendingDeletes: pendingRecDeletes,
        privateIds
      });
      pendingIds.forEach(id => { if (remoteTx.has(id)) pendingIds.delete(id); });
      pendingDeletes.forEach(id => { if (!remoteTx.has(id)) pendingDeletes.delete(id); });
      pendingRecIds.forEach(id => { if (remoteRec.has(id)) pendingRecIds.delete(id); });
      pendingRecDeletes.forEach(id => { if (!remoteRec.has(id)) pendingRecDeletes.delete(id); });
      if (remoteShared) applySharedFields(s, remoteShared, false);
      const after = JSON.stringify({
        t: (s.transactions || []).map(t => [t.id, t.updatedAt, t.amount, t.note, t.category, t.date]),
        r: (s.recurring || []).map(r => [r.id, r.updatedAt, r.amount, r.lastGenerated, r.active]),
        b: s.budgets
      });
      if (before === after) {
        setStatus();
        return;
      }
      await persistLocal();
      if (typeof window.renderAll === 'function') window.renderAll();
      setStatus();
    }

    async function leaveHousehold() {
      if (!householdId || !user) return;
      const ok = await choose({
        title: 'יציאה מהבית',
        text: 'הנתונים יישארו במכשיר הזה, אבל שינויים חדשים לא יגיעו יותר לבן או בת הזוג. אפשר להצטרף שוב עם הקוד.',
        primary: 'יציאה מהבית',
        secondary: 'ביטול'
      });
      if (ok !== 'primary') return;
      const hid = householdId;
      try {
        const snap = await fs.getDoc(fs.doc(db, 'households', hid));
        const uids = (snap.exists() && snap.data().memberUids) || [];
        await fs.updateDoc(fs.doc(db, 'households', hid), {
          memberUids: uids.filter(id => id !== user.uid)
        });
        await fs.deleteDoc(fs.doc(db, 'households', hid, 'members', user.uid));
      } catch (err) {
        console.error(err);
        toast('היציאה מהבית לא הושלמה');
        return;
      }
      unsubAll();
      forgetLink();
      privateIds = new Set();
      savePrivate();
      toast('יצאתם מהבית המשותף');
      render();
    }

    async function uploadPrivate() {
      privateIds = new Set();
      savePrivate();
      await pushEverything();
      toast('הנתונים מהמכשיר הועלו לבית');
      render();
    }

    async function onClick(event) {
      const btn = event.target.closest('[data-cloud-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-cloud-action');
      try {
        if (action === 'signin') await signIn();
        else if (action === 'signout') await authMod.signOut(auth);
        else if (action === 'create') await createHousehold();
        else if (action === 'join') await joinHousehold();
        else if (action === 'leave') await leaveHousehold();
        else if (action === 'upload') await uploadPrivate();
        else if (action === 'copy') {
          const code = btn.getAttribute('data-code') || '';
          try {
            await navigator.clipboard.writeText(code);
            toast('הקוד הועתק');
          } catch (e) {
            toast('הקוד להעתקה: ' + code);
          }
        }
      } catch (err) {
        console.error(err);
        toast('הפעולה נכשלה. נסו שוב.');
      }
    }

    function wire() {
      if (wired) return;
      wired = true;
      const card = document.getElementById('cloudSyncCard');
      if (card) card.addEventListener('click', onClick);
      window.addEventListener('online', setStatus);
      window.addEventListener('offline', setStatus);
    }

    async function start() {
      wire();
      let expectedRedirect = false;
      try { expectedRedirect = sessionStorage.getItem(REDIRECT_FLAG) === '1'; } catch (e) { /* ignore */ }
      try {
        const redirected = await authMod.getRedirectResult(auth);
        if (redirected && redirected.user) {
          try { sessionStorage.removeItem(REDIRECT_FLAG); } catch (e) { /* ignore */ }
          authError = '';
        } else if (expectedRedirect && !(auth.currentUser)) {
          try { sessionStorage.removeItem(REDIRECT_FLAG); } catch (e) { /* ignore */ }
          authError = 'ההתחברות לא הושלמה. הדפדפן חוסם שמירה בין האתר לבין Google. נסו שוב — הכניסה נפתחת בחלון.';
        }
      } catch (err) {
        try { sessionStorage.removeItem(REDIRECT_FLAG); } catch (e) { /* ignore */ }
        console.error(err);
        if (!err || err.code !== 'auth/no-auth-event') authError = authMessage(err);
      }
      authMod.onAuthStateChanged(auth, function (next) {
        user = next;
        cloud._user = next;
        if (next) authError = '';
        if (!next) {
          unsubAll();
          householdId = null;
          cloud._hid = null;
          render();
          return;
        }
        const link = readLink();
        if (link && link.uid === next.uid && link.householdId) {
          householdId = link.householdId;
          cloud._hid = householdId;
          subscribe();
        }
        render();
      });
      render();
    }

    cloud._debug = { merge: merge };
  }
})();
