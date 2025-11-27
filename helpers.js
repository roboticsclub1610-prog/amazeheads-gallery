// helpers.js
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import {
  getFirestore, collection, addDoc, serverTimestamp, query, orderBy, onSnapshot,
  doc, getDoc, updateDoc, deleteDoc, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const db = getFirestore(app);

/* Auth */
export function onAuthChange(cb) { return onAuthStateChanged(auth, cb); }
export function loginEmail(email, password) { return signInWithEmailAndPassword(auth, email, password); }
export function logout() { return signOut(auth); }

/* Folders (collection: folders) */
export async function createFolder(name, createdBy=null) {
  const docRef = await addDoc(collection(db,'folders'), { name, createdBy, createdAt: serverTimestamp() });
  return docRef.id;
}
export async function renameFolder(id, newName) {
  await updateDoc(doc(db,'folders',id), { name: newName });
}
export async function deleteFolder(id) {
  const q = query(collection(db,'media'), where('folderId','==',id));
  const snap = await getDocs(q);
  if (!snap.empty) throw new Error('Folder not empty. Move or delete items first.');
  await deleteDoc(doc(db,'folders',id));
}
export function subscribeFolders(cb) {
  const q = query(collection(db,'folders'), orderBy('createdAt','asc'));
  return onSnapshot(q, s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))));
}

/* Media upload + metadata (collection: media) */
export function uploadMediaFile(file, folderId=null, uploaderEmail=null, onProgress = ()=>{}) {
  const path = `media/${folderId || 'root'}/${Date.now()}_${file.name.replace(/\s+/g,'_')}`;
  const sRef = storageRef(storage, path);
  const task = uploadBytesResumable(sRef, file);
  return new Promise((resolve, reject) => {
    task.on('state_changed',
      (snap) => { const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100); onProgress(pct); },
      (err) => reject(err),
      async () => {
        const url = await getDownloadURL(task.snapshot.ref);
        const docRef = await addDoc(collection(db,'media'), {
          name: file.name,
          url,
          storagePath: path,
          folderId: folderId || null,
          type: file.type.startsWith('video') ? 'video' : 'image',
          uploadedBy: uploaderEmail || null,
          createdAt: serverTimestamp()
        });
        resolve({ id: docRef.id, url, storagePath: path });
      }
    );
  });
}

export async function deleteMediaItem(item) {
  try { if (item.storagePath) await deleteObject(storageRef(storage, item.storagePath)); } catch(e){ console.warn('Storage delete failed', e); }
  await deleteDoc(doc(db,'media', item.id));
}

export async function renameMedia(itemId, newName) {
  const docRef = doc(db,'media', itemId);
  const snap = await getDoc(docRef);
  if (!snap.exists()) throw new Error('Item not found');
  const data = snap.data();
  const oldPath = data.storagePath;
  const folderSeg = data.folderId || 'root';
  const newPath = `media/${folderSeg}/${Date.now()}_${newName.replace(/\s+/g,'_')}`;
  const resp = await fetch(data.url);
  const blob = await resp.blob();
  const newRef = storageRef(storage, newPath);
  await uploadBytesResumable(newRef, blob);
  const newUrl = await getDownloadURL(newRef);
  await updateDoc(docRef, { name: newName, url: newUrl, storagePath: newPath });
  try { await deleteObject(storageRef(storage, oldPath)); } catch(e){ console.warn('old delete failed', e); }
}

export async function moveMedia(itemId, targetFolderId) {
  const docRef = doc(db,'media', itemId);
  const snap = await getDoc(docRef);
  if (!snap.exists()) throw new Error('Item not found');
  const data = snap.data();
  const oldPath = data.storagePath;
  const fileName = data.name || oldPath.split('/').pop();
  const newPath = `media/${targetFolderId || 'root'}/${Date.now()}_${fileName.replace(/\s+/g,'_')}`;
  const resp = await fetch(data.url);
  const blob = await resp.blob();
  const newRef = storageRef(storage, newPath);
  await uploadBytesResumable(newRef, blob);
  const newUrl = await getDownloadURL(newRef);
  await updateDoc(docRef, { folderId: targetFolderId || null, storagePath: newPath, url: newUrl });
  try { await deleteObject(storageRef(storage, oldPath)); } catch(e){ console.warn('old delete failed', e); }
}

/* Subscribe media in real-time (optional folderId filter) */
export function subscribeMedia(cb, folderId = null) {
  let q;
  if (folderId) q = query(collection(db,'media'), where('folderId','==', folderId), orderBy('createdAt','desc'));
  else q = query(collection(db,'media'), orderBy('createdAt','desc'));
  return onSnapshot(q, snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}
