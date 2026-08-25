/* save-target.js — File System Access API で、フォルダを選択して名簿を保存し、
 * 既存ファイルを自動的に old/ サブフォルダへタイムスタンプ付きで退避する。
 *
 * Edge/Chrome 限定。file:// で secure context として扱われるかは実機確認必須。
 * IndexedDB を使ってフォルダハンドルを保存しているため、localStorage は使わない。
 */
(function (root) {
  'use strict';

  const ORIGINAL_FILENAME = '学傷補・学賠補 活動届用 参加者名簿.xlsx';
  const DB_NAME = 'gakushouho-save-target';
  const STORE_NAME = 'folder-handle';

  /* ─────────────────────────────────────────────────────────────── */
  /* IndexedDB: フォルダハンドルの永続化 */
  /* ─────────────────────────────────────────────────────────────── */

  function getDB() {
    return new Promise(function (resolve, reject) {
      const req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (ev) {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function saveHandleToDb(handle) {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({ id: 'saved', handle: handle });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function loadHandleFromDb() {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get('saved');
        req.onsuccess = function () { resolve(req.result ? req.result.handle : null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────── */
  /* Public API */
  /* ─────────────────────────────────────────────────────────────── */

  function isSupported() {
    return typeof window.showDirectoryPicker === 'function';
  }

  async function pickFolder() {
    if (!isSupported()) return null;
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await saveHandleToDb(handle);
      return handle;
    } catch (e) {
      if (e.name === 'AbortError') return null;  // ユーザーがキャンセル
      throw e;
    }
  }

  async function getSavedFolderHandle() {
    if (!isSupported()) return null;
    try {
      const handle = await loadHandleFromDb();
      if (!handle) return null;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') return handle;
      const reqPerm = await handle.requestPermission({ mode: 'readwrite' });
      return reqPerm === 'granted' ? handle : null;
    } catch (e) {
      return null;  // ハンドルが無効になっている
    }
  }

  function padZero(n) {
    return String(n).padStart(2, '0');
  }

  function nowTimestamp() {
    const d = new Date();
    return d.getFullYear() +
      padZero(d.getMonth() + 1) +
      padZero(d.getDate()) + '_' +
      padZero(d.getHours()) +
      padZero(d.getMinutes()) +
      padZero(d.getSeconds());
  }

  async function saveRoster(bytes) {
    const dirHandle = await getSavedFolderHandle();
    if (!dirHandle) return null;  // フォルダ未選択 or 権限なし、呼び出し側でフォールバック

    try {
      // 既存ファイルをチェック
      let existingFile = null;
      try {
        const fileHandle = await dirHandle.getFileHandle(ORIGINAL_FILENAME, { create: false });
        existingFile = fileHandle;
      } catch (e) {
        if (e.name !== 'NotFoundError') throw e;
      }

      // 既存ファイルがあれば old/ に退避
      if (existingFile) {
        try {
          const oldDir = await dirHandle.getDirectoryHandle('old', { create: true });
          const backupName = nowTimestamp() + '_' + ORIGINAL_FILENAME;
          const backupHandle = await oldDir.getFileHandle(backupName, { create: true });
          const existing = await existingFile.getFile();
          const writable = await backupHandle.createWritable();
          await writable.write(await existing.arrayBuffer());
          await writable.close();
        } catch (e) {
          throw new Error('既存ファイルのバックアップに失敗しました: ' + (e && e.message || e));
        }
      }

      // 新しい名簿を保存
      const fileHandle = await dirHandle.getFileHandle(ORIGINAL_FILENAME, { create: true });
      const writable = await fileHandle.createWritable({ keepExistingData: false });
      await writable.write(bytes);
      await writable.close();

      return { filename: ORIGINAL_FILENAME, dirHandle: dirHandle };
    } catch (e) {
      throw new Error('名簿の保存に失敗しました: ' + (e && e.message || e));
    }
  }

  root.SaveTarget = {
    isSupported: isSupported,
    ORIGINAL_FILENAME: ORIGINAL_FILENAME,
    pickFolder: pickFolder,
    getSavedFolderHandle: getSavedFolderHandle,
    saveRoster: saveRoster
  };
})(window.GSH = window.GSH || {});
