// helpers.js (UPGRADED)
// ------------------------------------------------------
// Firebase Imports
// ------------------------------------------------------
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  onSnapshot,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ------------------------------------------------------
// Initialize Firebase
// ------------------------------------------------------
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const db = getFirestore(app);

// ------------------------------------------------------
// AUTH HELPERS
// ------------------------------------------------------
export function onAuthChange(cb) { return onAuthStateChanged(auth, cb); }
export function loginEmail(email, password) { return signInWithEmailAndPassword(auth, email, password); }
export function logout() { return signOut(auth); }

// ------------------------------------------------------
// FOLDER FUNCTIONS
// ------------------------------------------------------
export async function createFolder(name, createdBy = null) {
  const docRef = await addDoc(collection(db, 'folders'), {
    name,
    createdBy,
    createdAt: serverTimestamp()
  });
  return docRef.id;
}

export async function renameFolder(id, newName) {
  await updateDoc(doc(db, 'folders', id), { name: newName });
}

export async function deleteFolder(id) {
  const q = query(collection(db, 'media'), where('folderId', '==', id));
  const snap = await getDocs(q);

  if (!snap.empty)
    throw new Error('Folder not empty — delete or move all media first.');

  await deleteDoc(doc(db, 'folders', id));
}

export function subscribeFolders(cb) {
  const q = query(collection(db, 'folders'), orderBy('createdAt', 'asc'));
  return onSnapshot(q, s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))));
}

// ------------------------------------------------------
// MEDIA UPLOAD (FIXED + LOGGING + METADATA)
// ------------------------------------------------------
export function uploadMediaFile(file, folderId = null, uploaderEmail = null, onProgress = () => { }) {
  console.log("📤 Upload started:", file?.name);

  if (!file) return Promise.reject(new Error("NO FILE PROVIDED"));

  const safeName = file.name.replace(/\s+/g, '_');
  const path = `media/${folderId || 'root'}/${Date.now()}_${safeName}`;
  const sRef = storageRef(storage, path);

  const metadata = {
    contentType: file.type || "application/octet-stream",
    customMetadata: {
      uploadedBy: uploaderEmail || auth.currentUser?.email || "unknown"
    }
  };

  const task = uploadBytesResumable(sRef, file, metadata);

  return new Promise((resolve, reject) => {
    task.on(
      "state_changed",
      snap => {
        const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
        console.log(`📶 Upload: ${pct}%`);
        onProgress(pct);
      },
      err => {
        console.error("❌ Upload failed:", err.code, err.message);
        reject(err);
      },
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          console.log("✅ Upload complete. URL:", url);

          const docRef = await addDoc(collection(db, 'media'), {
            name: file.name,
            url,
            storagePath: path,
            folderId: folderId || null,
            type: file.type.startsWith('video') ? 'video' : 'image',
            uploadedBy: uploaderEmail || auth.currentUser?.email || null,
            createdAt: serverTimestamp()
          });

          resolve({ id: docRef.id, url, storagePath: path });
        } catch (e) {
          console.error("🔥 Firestore save failed:", e);
          reject(e);
        }
      }
    );
  });
}

// ------------------------------------------------------
// DELETE MEDIA
// ------------------------------------------------------
export async function deleteMediaItem(item) {
  console.log("🗑 Deleting media:", item.id);

  try {
    if (item.storagePath)
      await deleteObject(storageRef(storage, item.storagePath));
  } catch (e) {
    console.warn("⚠ Storage delete failed:", e);
  }

  await deleteDoc(doc(db, 'media', item.id));
}

// ------------------------------------------------------
// RENAME MEDIA (WITH REUPLOAD)
// ------------------------------------------------------
export async function renameMedia(itemId, newName) {
  const docRef = doc(db, 'media', itemId);
  const snap = await getDoc(docRef);
  if (!snap.exists()) throw new Error("Media not found");

  const data = snap.data();
  const oldPath = data.storagePath;
  const folderSegment = data.folderId || "root";

  const newPath = `media/${folderSegment}/${Date.now()}_${newName.replace(/\s+/g, "_")}`;

  const resp = await fetch(data.url);
  const blob = await resp.blob();

  const newRef = storageRef(storage, newPath);
  await uploadBytesResumable(newRef, blob);

  const newUrl = await getDownloadURL(newRef);

  await updateDoc(docRef, {
    name: newName,
    url: newUrl,
    storagePath: newPath
  });

  try {
    await deleteObject(storageRef(storage, oldPath));
  } catch (e) {
    console.warn("⚠ Old file delete failed:", e);
  }
}

// ------------------------------------------------------
// MOVE MEDIA (WITH REUPLOAD FIXED)
// ------------------------------------------------------
export async function moveMedia(itemId, targetFolderId) {
  const docRef = doc(db, 'media', itemId);
  const snap = await getDoc(docRef);
  if (!snap.exists()) throw new Error("Media not found");

  const data = snap.data();
  const oldPath = data.storagePath;

  const safeName = data.name.replace(/\s+/g, "_");
  const newPath = `media/${targetFolderId || 'root'}/${Date.now()}_${safeName}`;

  const resp = await fetch(data.url);
  const blob = await resp.blob();

  const newRef = storageRef(storage, newPath);
  await uploadBytesResumable(newRef, blob);

  const newUrl = await getDownloadURL(newRef);

  await updateDoc(docRef, {
    folderId: targetFolderId || null,
    storagePath: newPath,
    url: newUrl
  });

  try {
    await deleteObject(storageRef(storage, oldPath));
  } catch (e) {
    console.warn("⚠ Old file delete failed:", e);
  }
}

// ------------------------------------------------------
// REALTIME MEDIA SUBSCRIBE
// ------------------------------------------------------
export function subscribeMedia(cb, folderId = null) {
  let q;
  if (folderId)
    q = query(
      collection(db, 'media'),
      where('folderId', '==', folderId),
      orderBy('createdAt', 'desc')
    );
  else
    q = query(collection(db, 'media'), orderBy('createdAt', 'desc'));

  return onSnapshot(q, snap =>
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}
