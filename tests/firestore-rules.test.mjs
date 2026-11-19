import { readFileSync } from 'fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';

const tx = (id, uid, extra = {}) => Object.assign({
  id,
  type: 'expense',
  amount: 10,
  category: 'מזון',
  date: '2026-11-14',
  note: 'סופר',
  accountId: 'default',
  recurringId: null,
  createdBy: uid,
  createdByName: uid,
  createdByPhoto: '',
  updatedAt: 1,
  updatedBy: uid
}, extra);

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-kaspit',
  firestore: {
    rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
  }
});

try {
  await testEnv.clearFirestore();
  const alice = testEnv.authenticatedContext('alice');
  const bob = testEnv.authenticatedContext('bob');
  const stranger = testEnv.authenticatedContext('stranger');
  const anon = testEnv.unauthenticatedContext();
  const adb = alice.firestore();
  const bdb = bob.firestore();
  const sdb = stranger.firestore();

  await assertSucceeds(setDoc(doc(adb, 'households/h1'), {
    name: 'הבית שלנו',
    ownerUid: 'alice',
    inviteCode: 'ABC234',
    memberUids: ['alice'],
    createdAt: 1
  }));
  await assertSucceeds(setDoc(doc(adb, 'households/h1/members/alice'), {
    uid: 'alice', name: 'אליס', photoURL: '', email: 'a@example.com', joinedAt: 1
  }));
  await assertSucceeds(setDoc(doc(adb, 'inviteCodes/ABC234'), { householdId: 'h1' }));

  await assertFails(getDoc(doc(bdb, 'households/h1')));
  await assertFails(getDoc(doc(anon.firestore(), 'inviteCodes/ABC234')));
  await assertSucceeds(getDoc(doc(bdb, 'inviteCodes/ABC234')));
  await assertFails(getDocs(collection(bdb, 'inviteCodes')));

  await assertFails(setDoc(doc(bdb, 'households/h1/members/bob'), {
    uid: 'bob', name: 'בוב', photoURL: '', email: '', inviteCode: 'WRONG1', joinedAt: 2
  }));
  await assertSucceeds(setDoc(doc(bdb, 'households/h1/members/bob'), {
    uid: 'bob', name: 'בוב', photoURL: '', email: 'b@example.com', inviteCode: 'ABC234', joinedAt: 2
  }));
  await assertSucceeds(updateDoc(doc(bdb, 'households/h1'), { memberUids: ['alice', 'bob'] }));
  await assertSucceeds(getDoc(doc(bdb, 'households/h1')));

  await assertSucceeds(setDoc(doc(bdb, 'households/h1/transactions/t1'), tx('t1', 'bob')));
  await assertFails(setDoc(doc(bdb, 'households/h1/transactions/t2'), tx('t2', 'alice')));
  await assertFails(setDoc(doc(sdb, 'households/h1/transactions/t3'), tx('t3', 'stranger')));
  await assertSucceeds(getDoc(doc(adb, 'households/h1/transactions/t1')));

  await assertSucceeds(updateDoc(doc(adb, 'households/h1/transactions/t1'), tx('t1', 'bob', {
    amount: 12, updatedAt: 4, updatedBy: 'alice', createdBy: 'bob'
  })));
  await assertFails(updateDoc(doc(adb, 'households/h1/transactions/t1'), tx('t1', 'alice', {
    amount: 99, updatedAt: 5, updatedBy: 'alice', createdBy: 'alice'
  })));

  await assertSucceeds(setDoc(doc(bdb, 'households/h1/meta/shared'), {
    categories: { income: ['משכורת'], expense: ['מזון'] },
    budgets: { מזון: 200 },
    balanceCheckins: [{
      id: 'now', date: '2026-11-19', amount: 5000.5, createdAt: 10, updatedAt: 10,
      accountId: 'all', deleted: false
    }],
    updatedAt: 6,
    updatedBy: 'bob'
  }));
  await assertSucceeds(setDoc(doc(adb, 'households/h1/transactions/tCreated'), tx('tCreated', 'alice', {
    createdAt: 1500
  })));
  await assertFails(getDoc(doc(sdb, 'households/h1/meta/shared')));

  await assertFails(setDoc(doc(bdb, 'inviteCodes/ZZZZZZ'), { householdId: 'h1' }));
  await assertSucceeds(deleteDoc(doc(bdb, 'households/h1/transactions/t1')));
  await assertFails(getDoc(doc(sdb, 'households/h1/transactions/t1')));

  console.log('firestore rules tests passed');
} finally {
  await testEnv.cleanup();
}
