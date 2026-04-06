/**
 * 豚解剖記録カルテ - app.js v3.0
 * IndexedDBを使ったオフライン対応Webアプリ
 * 外部サービス不使用・個体別管理・ドラッグ&ドロップ対応
 * + Google Drive連携（Apps Script経由）
 */

'use strict';

// ===================================================
// 定数・設定
// ===================================================

const DB_NAME = 'PigVetRecordDB';
const DB_VERSION = 1;
const STORE_RECORDS = 'records';

// ===================================================
// Googleドライブ同期設定
// ===================================================

const DRIVE_URL_KEY = 'driveScriptUrl';
const DRIVE_API_KEY_KEY = 'driveApiKey';
const DRIVE_LAST_SYNC_KEY = 'driveLastSync';
const MAX_TOTAL_SIZE_MB = 50; // JSONの上限警告サイズ（MB）

/** localStorageからApps Script URLを取得 */
function getDriveUrl() {
  return localStorage.getItem(DRIVE_URL_KEY) || '';
}

/** localStorageからAPIキーを取得（未設定時はデフォルト値） */
function getDriveApiKey() {
  return localStorage.getItem(DRIVE_API_KEY_KEY) || 'vet-record-2026';
}

/** 同期ステータスを更新（ヘッダーアイコン） */
function updateSyncStatus(status) {
  const el = document.getElementById('syncStatus');
  if (!el) return;

  if (status === 'synced') {
    const lastSync = localStorage.getItem(DRIVE_LAST_SYNC_KEY);
    const timeStr = lastSync ? formatDateShort(lastSync) : '';
    el.innerHTML = `<span class="sync-icon synced" title="同期済み: ${timeStr}">☁️</span>`;
    el.title = `最終同期: ${timeStr}`;
  } else if (status === 'syncing') {
    el.innerHTML = `<span class="sync-icon syncing" title="同期中...">🔄</span>`;
  } else if (status === 'offline') {
    el.innerHTML = `<span class="sync-icon offline" title="オフライン">⚠️</span>`;
  } else {
    // 未設定
    el.innerHTML = `<span class="sync-icon unset" title="ドライブ未接続">📵</span>`;
  }
}

/**
 * ドライブからデータを取得してIndexedDBとマージ
 * 新しいupdatedAtを持つレコードを優先
 */
async function syncFromDrive() {
  const url = getDriveUrl();
  if (!url) return;

  updateSyncStatus('syncing');
  try {
    const apiKey = getDriveApiKey();
    const fetchUrl = `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(fetchUrl, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success || !json.data?.records) throw new Error('レスポンス形式が不正です');

    const driveRecords = json.data.records;
    let merged = 0;

    for (const driveRec of driveRecords) {
      const local = state.records.find(r => r.id === driveRec.id);
      // ローカルにない、またはドライブの方が新しい場合は上書き
      if (!local || new Date(driveRec.updatedAt) > new Date(local.updatedAt)) {
        await saveRecord(driveRec);
        merged++;
      }
    }

    if (merged > 0) {
      state.records = await getAllRecords();
      updateFarmFilter();
      renderList();
    }

    localStorage.setItem(DRIVE_LAST_SYNC_KEY, new Date().toISOString());
    updateSyncStatus('synced');
    if (merged > 0) showToast(`ドライブから${merged}件を取得しました ☁️`, 'success');

  } catch (e) {
    console.warn('ドライブからの取得に失敗:', e);
    updateSyncStatus('offline');
    // 起動時エラーは静かに失敗（オフライン時を考慮）
  }
}

/**
 * ドライブにデータをアップロード
 * @param {boolean} showToastOnSuccess - 成功時にトーストを表示するか
 */
async function syncToDrive(showToastOnSuccess = false) {
  const url = getDriveUrl();
  if (!url) return;

  updateSyncStatus('syncing');

  // サイズチェック
  const dataSize = JSON.stringify(state.records).length / (1024 * 1024);
  if (dataSize > MAX_TOTAL_SIZE_MB) {
    showToast(`データが${MAX_TOTAL_SIZE_MB}MBを超えています。写真を減らすことを検討してください。`, 'warning', 5000);
  }

  try {
    const apiKey = getDriveApiKey();
    const payload = {
      records: state.records,
      version: 2,
    };
    // フォーム形式で送信（CORS制限を回避）
    const formData = new URLSearchParams();
    formData.append('key', apiKey);
    formData.append('data', JSON.stringify(payload));
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || '保存失敗');

    localStorage.setItem(DRIVE_LAST_SYNC_KEY, new Date().toISOString());
    updateSyncStatus('synced');
    if (showToastOnSuccess) showToast('ドライブに保存しました ☁️', 'success');

  } catch (e) {
    console.warn('ドライブへのアップロードに失敗:', e);
    updateSyncStatus('offline');
    showToast('ドライブへの保存に失敗しました（オフライン？）', 'warning');
  }
}

/**
 * 設定画面：Apps Script URLの接続テスト
 */
async function testDriveConnection() {
  const input = document.getElementById('driveUrlInput');
  if (!input) return;
  const url = input.value.trim();
  if (!url) {
    showToast('URLを入力してください', 'warning');
    return;
  }

  const apiKeyInput = document.getElementById('driveApiKeyInput');
  const apiKey = apiKeyInput ? apiKeyInput.value.trim() : getDriveApiKey();
  if (!apiKey) {
    showToast('APIキーを入力してください', 'warning');
    return;
  }

  const btn = document.getElementById('driveTestBtn');
  if (btn) { btn.disabled = true; btn.textContent = '接続確認中...'; }

  try {
    const testUrl = `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(testUrl, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error === 'Unauthorized') {
      throw new Error('APIキーが正しくありません (401 Unauthorized)');
    }
    if (json.success !== undefined) {
      showToast('接続成功です！URLとAPIキーを保存します ✓', 'success');
      localStorage.setItem(DRIVE_URL_KEY, url);
      localStorage.setItem(DRIVE_API_KEY_KEY, apiKey);
      updateSyncStatus('synced');
      renderDriveSettings();
    } else {
      throw new Error('不正なレスポンス形式');
    }
  } catch (e) {
    showToast(`接続に失敗しました: ${e.message}`, 'error', 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '接続テスト'; }
  }
}

/** 設定画面のドライブ設定セクションを描画 */
function renderDriveSettings() {
  const el = document.getElementById('driveSettingsArea');
  if (!el) return;
  const url = getDriveUrl();
  const apiKey = getDriveApiKey();
  const lastSync = localStorage.getItem(DRIVE_LAST_SYNC_KEY);

  el.innerHTML = `
    <div class="drive-settings-inner">
      <div class="form-group">
        <label class="form-label">Apps Script Web App URL</label>
        <input type="url" class="form-control" id="driveUrlInput"
          value="${escHtml(url)}"
          placeholder="https://script.google.com/macros/s/.../exec">
      </div>
      <div class="form-group" style="margin-top:10px">
        <label class="form-label">APIキー</label>
        <input type="text" class="form-control" id="driveApiKeyInput"
          value="${escHtml(apiKey)}"
          placeholder="管理者から受け取ったAPIキーを入力"
          autocomplete="off">
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="btn btn-primary btn-sm" id="driveTestBtn" onclick="testDriveConnection()">
          接続テスト
        </button>
        ${url ? `
        <button class="btn btn-secondary btn-sm" onclick="syncToDrive(true)">
          ☁️ 今すぐ同期
        </button>
        <button class="btn btn-ghost btn-sm" onclick="clearDriveUrl()">
          接続を解除
        </button>` : ''}
      </div>
      ${url ? `
      <div style="font-size:0.8rem;color:var(--text-muted);margin-top:8px">
        ${lastSync ? `最終同期：${formatDate(lastSync)}` : '未同期'}
      </div>` : `
      <div style="font-size:0.8rem;color:var(--text-muted);margin-top:8px;line-height:1.7">
        ⓘ Apps ScriptのURLとAPIキーを入力して「接続テスト」を押してください。<br>
        設定手順はアプリのREADMEまたはこん先生の報告書をご確認ください。
      </div>`}
    </div>`;
}

/** ドライブ接続を解除 */
function clearDriveUrl() {
  showConfirm(
    'ドライブ接続を解除しますか？',
    'URLとAPIキーの設定を削除します。ローカルデータは残ります。',
    () => {
      localStorage.removeItem(DRIVE_URL_KEY);
      localStorage.removeItem(DRIVE_API_KEY_KEY);
      localStorage.removeItem(DRIVE_LAST_SYNC_KEY);
      updateSyncStatus('unset');
      renderDriveSettings();
      showToast('接続を解除しました', 'success');
    }
  );
}

/** 臓器セクション定義 */
const ORGAN_SECTIONS = [
  { id: 'appearance',     label: '外貌',                         icon: '🐷' },
  { id: 'lung',           label: '肺・胸腔・肺門リンパ節',       icon: '🫁' },
  { id: 'heart',          label: '心臓・心膜腔',                 icon: '❤️' },
  { id: 'digestive',      label: '胃・腸管・腸間膜リンパ節・腹腔', icon: '🫀' },
  { id: 'abdominal',      label: '脾臓・腎臓・肝臓',             icon: '🫘' },
  { id: 'lymph',          label: 'リンパ節（その他）',            icon: '🔬' },
];

// ===================================================
// アプリ状態管理
// ===================================================

const state = {
  db: null,
  records: [],
  currentPage: 'list',
  editingId: null,
  viewingId: null,
  searchQuery: '',
  filterFarm: '',
  formPhotos: {},      // pigIndex -> organId -> [base64, ...]
  activePigTab: 0,     // フォーム上のアクティブ個体タブ
  activeDetailPigTab: 0,
};

// ===================================================
// IndexedDB 操作
// ===================================================

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = db.createObjectStore(STORE_RECORDS, {
          keyPath: 'id', autoIncrement: false,
        });
        store.createIndex('farmName', 'farmName', { unique: false });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function getAllRecords() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_RECORDS, 'readonly');
    const req = tx.objectStore(STORE_RECORDS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

function getRecord(id) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_RECORDS, 'readonly');
    const req = tx.objectStore(STORE_RECORDS).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function saveRecord(record) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_RECORDS, 'readwrite');
    const req = tx.objectStore(STORE_RECORDS).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function deleteRecord(id) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_RECORDS, 'readwrite');
    const req = tx.objectStore(STORE_RECORDS).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

function clearAllRecords() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_RECORDS, 'readwrite');
    const req = tx.objectStore(STORE_RECORDS).clear();
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

// ===================================================
// ユーティリティ
// ===================================================

function generateId() {
  return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '日付不明';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showToast(message, type = 'default', duration = 3000) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'none';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function showConfirm(title, body, onConfirm) {
  const overlay = document.getElementById('confirmModal');
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalBody').textContent = body;
  overlay.classList.add('open');

  const confirmBtn = document.getElementById('confirmModalOk');
  const cancelBtn = document.getElementById('confirmModalCancel');

  const cleanup = () => {
    overlay.classList.remove('open');
    confirmBtn.replaceWith(confirmBtn.cloneNode(true));
    cancelBtn.replaceWith(cancelBtn.cloneNode(true));
  };

  document.getElementById('confirmModalOk').addEventListener('click', () => {
    cleanup();
    onConfirm();
  }, { once: true });

  document.getElementById('confirmModalCancel').addEventListener('click', () => {
    cleanup();
  }, { once: true });
}

// ===================================================
// 個体データ関連ユーティリティ
// ===================================================

/** レコードが旧形式（個体なし）かどうか判定 */
function isLegacyRecord(record) {
  return !record.pigs || !Array.isArray(record.pigs);
}

/** 旧形式レコードを新形式に変換 */
function normalizePigs(record) {
  if (!isLegacyRecord(record)) return record.pigs;
  const count = parseInt(record.headCount) || 1;
  return Array.from({ length: count }, (_, i) => ({
    ageInfo: i === 0 ? (record.ageInfo || '') : '',
    sex: '',
    memo: '',
    findings: record.findings || {},
  }));
}

/** 全写真枚数を集計 */
function countPhotos(record) {
  if (isLegacyRecord(record)) {
    return ORGAN_SECTIONS.reduce((sum, s) => sum + (record.findings?.[s.id]?.photos?.length || 0), 0);
  }
  return (record.pigs || []).reduce((sum, pig) => {
    return sum + ORGAN_SECTIONS.reduce((s2, sec) => s2 + (pig.findings?.[sec.id]?.photos?.length || 0), 0);
  }, 0);
}

// ===================================================
// ページ遷移
// ===================================================

function navigateTo(page) {
  state.currentPage = page;

  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.page === page);
  });

  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === `page-${page}`);
  });

  document.getElementById('fab').style.display = page === 'list' ? 'flex' : 'none';
}

// ===================================================
// 一覧ページ
// ===================================================

function renderList() {
  const query = state.searchQuery.toLowerCase();
  const filterFarm = state.filterFarm;

  let records = [...state.records];

  if (filterFarm) {
    records = records.filter(r => r.farmName === filterFarm);
  }

  if (query) {
    records = records.filter(r => {
      let searchText = [r.farmName, r.diagnosis, r.chiefComplaint, r.treatment].join(' ');
      // 旧形式
      if (isLegacyRecord(r)) {
        searchText += ORGAN_SECTIONS.map(s => r.findings?.[s.id]?.text || '').join(' ');
      } else {
        (r.pigs || []).forEach(pig => {
          searchText += ' ' + pig.memo + ' ';
          searchText += ORGAN_SECTIONS.map(s => pig.findings?.[s.id]?.text || '').join(' ');
        });
      }
      return searchText.toLowerCase().includes(query);
    });
  }

  records.sort((a, b) => new Date(b.date) - new Date(a.date));

  const container = document.getElementById('recordList');

  if (records.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <div class="empty-state-title">${state.records.length === 0 ? 'まだ記録がありません' : '該当する記録がありません'}</div>
        <div class="empty-state-desc">${state.records.length === 0
          ? '右下の＋ボタンから新規記録を作成してください'
          : '検索条件を変えてお試しください'}</div>
      </div>`;
    return;
  }

  container.innerHTML = records.map(r => {
    const diagText = r.diagnosis ? r.diagnosis : '（診断名未入力）';
    const photoCount = countPhotos(r);
    const pigCount = isLegacyRecord(r) ? (parseInt(r.headCount) || 1) : (r.pigs?.length || 1);
    return `
      <div class="record-card" onclick="openDetail('${r.id}')">
        <div class="record-card-header">
          <div class="record-card-farm">🏠 ${escHtml(r.farmName) || '農場名未入力'}</div>
          <div class="record-card-date">${formatDateShort(r.date)}</div>
        </div>
        <div class="record-card-diagnosis">
          <span class="record-card-diagnosis-label">診断名：</span>${escHtml(diagText)}
        </div>
        <div class="record-card-meta">
          ${r.examiner ? `<span>👤 ${escHtml(r.examiner)}</span>` : ''}
          <span>🐷 ${pigCount}頭</span>
          ${photoCount > 0 ? `<span>📷 ${photoCount}枚</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

function updateFarmFilter() {
  const farms = [...new Set(state.records.map(r => r.farmName).filter(Boolean))].sort();
  const sel = document.getElementById('farmFilter');
  const current = sel.value;
  sel.innerHTML = `<option value="">全農場</option>` +
    farms.map(f => `<option value="${escHtml(f)}" ${f === current ? 'selected' : ''}>${escHtml(f)}</option>`).join('');
}

// ===================================================
// カルテ詳細ページ
// ===================================================

async function openDetail(id) {
  state.viewingId = id;
  const record = await getRecord(id);
  if (!record) { showToast('記録が見つかりません', 'error'); return; }
  state.activeDetailPigTab = 0;
  renderDetail(record);
  navigateTo('detail');
}

function renderDetail(record) {
  const container = document.getElementById('page-detail');
  const pigs = normalizePigs(record);
  window._viewingRecord = record;
  window._viewingPigs = pigs;

  const pigCount = pigs.length;

  // 個体タブHTML
  const pigTabsHtml = pigCount > 1 ? `
    <div class="detail-pig-tabs">
      ${pigs.map((_, i) => `
        <button class="pig-tab ${i === state.activeDetailPigTab ? 'active' : ''}"
          onclick="switchDetailPigTab(${i})">${i + 1}頭目</button>
      `).join('')}
    </div>` : '';

  // 各個体パネル
  const pigPanelsHtml = pigs.map((pig, pigIdx) => {
    const organHtml = ORGAN_SECTIONS.map(section => {
      const finding = pig.findings?.[section.id] || {};
      const text = finding.text || '';
      const photos = finding.photos || [];
      const isEmpty = !text && photos.length === 0;

      const photosHtml = photos.length > 0
        ? `<div class="photo-grid" style="margin-top:10px">${photos.map((p, i) => `
            <div class="photo-thumb-wrapper view"
              onclick="openPhotoModal('${record.id}', ${pigIdx}, '${section.id}', ${i})">
              <img src="${p}" alt="写真${i + 1}">
            </div>`).join('')}</div>`
        : '';

      return `
        <div class="organ-section view-mode open">
          <div class="organ-section-header">
            <div class="organ-section-title">
              <div class="organ-icon">${section.icon}</div>
              ${escHtml(section.label)}
            </div>
          </div>
          <div class="organ-section-body">
            <div class="${isEmpty ? 'detail-section-body empty' : 'detail-section-body'}">
              ${isEmpty ? '（所見なし）' : escHtml(text)}
            </div>
            ${photosHtml}
          </div>
        </div>`;
    }).join('');

    const pigMeta = pigCount > 1 ? `
      <div class="detail-meta-grid" style="margin-bottom:12px">
        ${pig.ageInfo ? `<div class="detail-meta-item">
          <div class="detail-meta-label">日齢</div>
          <div class="detail-meta-value">${escHtml(pig.ageInfo)}</div>
        </div>` : ''}
        ${pig.sex ? `<div class="detail-meta-item">
          <div class="detail-meta-label">性別</div>
          <div class="detail-meta-value">${escHtml(pig.sex)}</div>
        </div>` : ''}
        ${pig.memo ? `<div class="detail-meta-item" style="grid-column:1/-1">
          <div class="detail-meta-label">個体メモ</div>
          <div class="detail-meta-value">${escHtml(pig.memo)}</div>
        </div>` : ''}
      </div>` : '';

    return `
      <div class="pig-panel ${pigIdx === state.activeDetailPigTab ? 'active' : ''}" id="detail-pig-panel-${pigIdx}">
        ${pigMeta}
        <div class="organ-sections">${organHtml}</div>
      </div>`;
  }).join('');

  // 共通ageInfo（1頭のとき）
  const singlePigMeta = pigCount === 1 ? `
    <div class="detail-meta-item" style="grid-column:1/-1">
      <div class="detail-meta-label">日齢</div>
      <div class="detail-meta-value">${escHtml(pigs[0]?.ageInfo || record.ageInfo || '—')}</div>
    </div>` : '';

  container.innerHTML = `
    <div class="form-page">
      <div class="detail-header">
        <div class="detail-farm">🏠 ${escHtml(record.farmName) || '農場名未入力'}</div>
        <div class="detail-date">解剖日時：${formatDate(record.date)}</div>
      </div>
      <div class="form-page-body">

        <div class="detail-meta-grid">
          <div class="detail-meta-item">
            <div class="detail-meta-label">解剖者</div>
            <div class="detail-meta-value">${escHtml(record.examiner) || '—'}</div>
          </div>
          <div class="detail-meta-item">
            <div class="detail-meta-label">頭数</div>
            <div class="detail-meta-value">${pigCount}頭</div>
          </div>
          ${singlePigMeta}
        </div>

        ${record.chiefComplaint ? `
          <div class="detail-section" style="margin-bottom:12px">
            <div class="detail-section-title">📝 稟告</div>
            <div class="detail-section-body">${escHtml(record.chiefComplaint)}</div>
          </div>` : ''}

        ${record.diagnosis ? `
          <div class="detail-diagnosis">
            <div class="detail-diagnosis-label">🔍 診断名</div>
            <div class="detail-diagnosis-value">${escHtml(record.diagnosis)}</div>
          </div>` : ''}

        <div class="section-heading">🔬 解剖所見</div>

        ${pigTabsHtml}
        ${pigPanelsHtml}

        ${record.treatment ? `
          <div class="detail-section" style="margin-top:12px">
            <div class="detail-section-title">💊 治療・検査内容</div>
            <div class="detail-section-body">${escHtml(record.treatment)}</div>
          </div>` : ''}

      </div>
      <div class="action-bar">
        <button class="btn btn-ghost btn-sm" onclick="navigateTo('list')">← 一覧へ</button>
        <button class="btn btn-secondary btn-sm" onclick="printRecord('${record.id}')">🖨️ 印刷/PDF</button>
        <button class="btn btn-secondary btn-sm" onclick="openEdit('${record.id}')">✏️ 編集</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDelete('${record.id}')">🗑️ 削除</button>
      </div>
    </div>`;
}

function switchDetailPigTab(idx) {
  state.activeDetailPigTab = idx;
  document.querySelectorAll('.detail-pig-tabs .pig-tab').forEach((btn, i) => {
    btn.classList.toggle('active', i === idx);
  });
  document.querySelectorAll('[id^="detail-pig-panel-"]').forEach(panel => {
    panel.classList.remove('active');
  });
  const target = document.getElementById(`detail-pig-panel-${idx}`);
  if (target) target.classList.add('active');
}

function openPhotoModal(recordId, pigIdx, organId, photoIndex) {
  const pigs = window._viewingPigs;
  if (!pigs) return;
  const src = pigs[pigIdx]?.findings?.[organId]?.photos?.[photoIndex];
  if (!src) return;
  document.getElementById('photoModalImg').src = src;
  document.getElementById('photoModal').classList.add('open');
}

// ===================================================
// 新規作成・編集フォーム
// ===================================================

function openNewForm() {
  state.editingId = null;
  state.activePigTab = 0;
  _initFormPhotos(1);
  renderForm(null, 1);
  navigateTo('form');
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  const el = document.getElementById('f-date');
  if (el) el.value = now.toISOString().slice(0, 16);
}

async function openEdit(id) {
  state.editingId = id;
  const record = await getRecord(id);
  if (!record) { showToast('記録が見つかりません', 'error'); return; }
  const pigs = normalizePigs(record);
  state.activePigTab = 0;
  _initFormPhotosFromPigs(pigs);
  renderForm(record, pigs.length, pigs);
  navigateTo('form');
}

function _initFormPhotos(pigCount) {
  state.formPhotos = {};
  for (let i = 0; i < pigCount; i++) {
    state.formPhotos[i] = {};
    ORGAN_SECTIONS.forEach(s => { state.formPhotos[i][s.id] = []; });
  }
}

function _initFormPhotosFromPigs(pigs) {
  state.formPhotos = {};
  pigs.forEach((pig, i) => {
    state.formPhotos[i] = {};
    ORGAN_SECTIONS.forEach(s => {
      state.formPhotos[i][s.id] = [...(pig.findings?.[s.id]?.photos || [])];
    });
  });
}

/** フォームの頭数を変更したときに呼ばれる */
function onHeadCountChange(value) {
  const count = Math.max(1, Math.min(20, parseInt(value) || 1));
  const currentCount = Object.keys(state.formPhotos).length;

  if (count === currentCount) return;

  if (count > currentCount) {
    for (let i = currentCount; i < count; i++) {
      state.formPhotos[i] = {};
      ORGAN_SECTIONS.forEach(s => { state.formPhotos[i][s.id] = []; });
    }
  } else {
    for (let i = count; i < currentCount; i++) {
      delete state.formPhotos[i];
    }
  }

  // 現在のフォーム値を保持してタブ数だけ更新
  const farmName = document.getElementById('f-farmName')?.value || '';
  const date = document.getElementById('f-date')?.value || '';
  const examiner = document.getElementById('f-examiner')?.value || '';
  const chiefComplaint = document.getElementById('f-chiefComplaint')?.value || '';
  const diagnosis = document.getElementById('f-diagnosis')?.value || '';
  const treatment = document.getElementById('f-treatment')?.value || '';

  // 各個体の現在値を保存
  const currentPigs = _collectPigFormValues(currentCount);

  // 新しい個体データを構築
  const newPigs = Array.from({ length: count }, (_, i) => {
    return currentPigs[i] || { ageInfo: '', sex: '', memo: '', findings: {} };
  });

  if (state.activePigTab >= count) state.activePigTab = count - 1;

  renderFormWithValues({
    farmName, date, examiner, chiefComplaint, diagnosis, treatment,
    headCount: String(count),
  }, count, newPigs);
}

/** フォームから各個体の現在値を収集 */
function _collectPigFormValues(pigCount) {
  return Array.from({ length: pigCount }, (_, i) => ({
    ageInfo: document.getElementById(`f-pig-ageInfo-${i}`)?.value || '',
    sex: document.getElementById(`f-pig-sex-${i}`)?.value || '',
    memo: document.getElementById(`f-pig-memo-${i}`)?.value || '',
    findings: Object.fromEntries(
      ORGAN_SECTIONS.map(s => [s.id, {
        text: document.getElementById(`finding-${i}-${s.id}`)?.value || '',
        photos: [...(state.formPhotos[i]?.[s.id] || [])],
      }])
    ),
  }));
}

/** フォームをレンダリング（新規または既存データ） */
function renderForm(record, pigCount, pigs) {
  const container = document.getElementById('page-form');
  const isEdit = !!record;
  const count = pigCount || 1;
  const pigData = pigs || Array.from({ length: count }, () => ({ ageInfo: '', sex: '', memo: '', findings: {} }));

  const pigTabsHtml = count > 1 ? `
    <div class="pig-tabs" id="formPigTabs">
      ${pigData.map((_, i) => `
        <button class="pig-tab ${i === state.activePigTab ? 'active' : ''}"
          onclick="switchFormPigTab(${i})">${i + 1}頭目</button>
      `).join('')}
    </div>` : `<div id="formPigTabs" style="display:none"></div>`;

  const pigPanelsHtml = pigData.map((pig, pigIdx) => {
    const organHtml = ORGAN_SECTIONS.map(section => {
      const text = pig.findings?.[section.id]?.text || '';
      return `
        <div class="organ-section" id="organ-section-${pigIdx}-${section.id}">
          <div class="organ-section-header" onclick="toggleOrganSection('${pigIdx}-${section.id}')">
            <div class="organ-section-title">
              <div class="organ-icon">${section.icon}</div>
              ${escHtml(section.label)}
            </div>
            <span class="organ-section-toggle">▼</span>
          </div>
          <div class="organ-section-body">
            <textarea
              class="form-control"
              id="finding-${pigIdx}-${section.id}"
              rows="3"
              placeholder="${escHtml(section.label)}の所見を入力..."
            >${escHtml(text)}</textarea>
            <div class="photo-area">
              <div class="photo-grid" id="photo-grid-${pigIdx}-${section.id}"></div>
              ${renderDropZoneHtml(pigIdx, section.id)}
              ${renderMobileBtnsHtml(pigIdx, section.id)}
            </div>
          </div>
        </div>`;
    }).join('');

    const sexOptions = ['', 'オス（去勢）', 'オス（未去勢）', 'メス'].map(v =>
      `<option value="${v}" ${pig.sex === v ? 'selected' : ''}>${v || '選択しない'}</option>`
    ).join('');

    return `
      <div class="pig-panel ${pigIdx === state.activePigTab ? 'active' : ''}" id="form-pig-panel-${pigIdx}">
        ${count > 1 ? `
        <div class="pig-card" style="margin-bottom:16px">
          <div class="pig-card-header">
            <div class="pig-number-badge">${pigIdx + 1}</div>
            <div class="pig-card-title">${pigIdx + 1}頭目の基本情報</div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">日齢</label>
              <input type="text" class="form-control" id="f-pig-ageInfo-${pigIdx}"
                value="${escHtml(pig.ageInfo || '')}" placeholder="例: 50日齢">
            </div>
            <div class="form-group">
              <label class="form-label">性別</label>
              <select class="form-control" id="f-pig-sex-${pigIdx}">${sexOptions}</select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">個体メモ</label>
            <textarea class="form-control" id="f-pig-memo-${pigIdx}" rows="2"
              placeholder="個体ごとのメモ（体重・特徴など）">${escHtml(pig.memo || '')}</textarea>
          </div>
        </div>` : ''}

        <div class="organ-sections">${organHtml}</div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="form-page">
      <div class="form-page-header">
        <span style="font-size:1.4rem">📋</span>
        <div class="form-page-title">${isEdit ? 'カルテを編集' : '新規解剖記録'}</div>
      </div>
      <div class="form-page-body">

        <div class="section-heading">📌 基本情報</div>

        <div class="form-group">
          <label class="form-label required">農場名</label>
          <div class="autocomplete-container">
            <input type="text" class="form-control" id="f-farmName"
              value="${escHtml(record?.farmName || '')}"
              placeholder="農場名を入力"
              autocomplete="off"
              oninput="showFarmSuggestions(this.value)"
              onblur="hideFarmSuggestionsDelayed()">
            <div class="autocomplete-list" id="farmSuggestions" style="display:none"></div>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label">解剖者</label>
            <input type="text" class="form-control" id="f-examiner"
              value="${escHtml(record?.examiner || '')}" placeholder="解剖者名">
          </div>
          <div class="form-group">
            <label class="form-label required">解剖日時</label>
            <input type="datetime-local" class="form-control" id="f-date"
              value="${record?.date ? record.date.slice(0, 16) : ''}">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label required">頭数</label>
            <input type="number" class="form-control" id="f-headCount"
              value="${escHtml(String(count))}"
              min="1" max="20" placeholder="例: 2"
              onchange="onHeadCountChange(this.value)">
          </div>
          ${count === 1 ? `
          <div class="form-group">
            <label class="form-label">日齢</label>
            <input type="text" class="form-control" id="f-pig-ageInfo-0"
              value="${escHtml(pigData[0]?.ageInfo || '')}" placeholder="例: 50日齢">
          </div>` : '<div></div>'}
        </div>

        <div class="form-group">
          <label class="form-label">稟告</label>
          <textarea class="form-control" id="f-chiefComplaint" rows="3"
            placeholder="農場からの訴え、発症状況など">${escHtml(record?.chiefComplaint || '')}</textarea>
        </div>

        <div class="section-divider"></div>

        <div class="section-heading">🔬 解剖所見（個体別）</div>

        ${pigTabsHtml}
        ${pigPanelsHtml}

        <div class="section-divider"></div>

        <div class="section-heading">🔍 診断・治療</div>

        <div class="form-group">
          <label class="form-label">診断名</label>
          <input type="text" class="form-control" id="f-diagnosis"
            value="${escHtml(record?.diagnosis || '')}"
            placeholder="例: PCV2関連疾病（PCVAD）">
        </div>

        <div class="form-group">
          <label class="form-label">治療・検査内容</label>
          <textarea class="form-control" id="f-treatment" rows="3"
            placeholder="実施した治療、提出検体、検査依頼内容など">${escHtml(record?.treatment || '')}</textarea>
        </div>

      </div>

      <div class="action-bar">
        <button class="btn btn-ghost btn-sm" onclick="handleFormCancel()">キャンセル</button>
        <button class="btn btn-primary" style="flex:1" onclick="handleFormSave()">
          💾 保存
        </button>
      </div>
    </div>`;

  // 写真グリッドを再描画 & ドラッグ&ドロップのイベント設定
  const count2 = Object.keys(state.formPhotos).length;
  for (let i = 0; i < count2; i++) {
    ORGAN_SECTIONS.forEach(s => {
      renderPhotoGrid(i, s.id);
      setupDropZone(i, s.id);
    });
  }
}

/** 既存値を引き継いでフォームを再レンダリング（頭数変更時） */
function renderFormWithValues(basicValues, pigCount, pigs) {
  renderForm({
    farmName: basicValues.farmName,
    examiner: basicValues.examiner,
    date: basicValues.date,
    headCount: basicValues.headCount,
    chiefComplaint: basicValues.chiefComplaint,
    diagnosis: basicValues.diagnosis,
    treatment: basicValues.treatment,
  }, pigCount, pigs);

  // 日時の値を直接セット（datetime-localはISO形式でなくローカル形式で）
  const dateEl = document.getElementById('f-date');
  if (dateEl && basicValues.date) dateEl.value = basicValues.date;
}

function switchFormPigTab(idx) {
  state.activePigTab = idx;
  document.querySelectorAll('#formPigTabs .pig-tab').forEach((btn, i) => {
    btn.classList.toggle('active', i === idx);
  });
  document.querySelectorAll('[id^="form-pig-panel-"]').forEach(panel => {
    panel.classList.remove('active');
  });
  const target = document.getElementById(`form-pig-panel-${idx}`);
  if (target) target.classList.add('active');
}

function toggleOrganSection(key) {
  const section = document.getElementById(`organ-section-${key}`);
  if (section) section.classList.toggle('open');
}

// ===================================================
// ドロップゾーンHTML生成
// ===================================================

function renderDropZoneHtml(pigIdx, organId) {
  return `
    <div class="photo-drop-zone" id="drop-zone-${pigIdx}-${organId}"
      onclick="triggerPhotoInput('${pigIdx}', '${organId}')">
      <div class="photo-drop-zone-icon">📸</div>
      <div class="photo-drop-zone-text">
        クリックまたはドラッグ&ドロップで写真を追加
        <div class="photo-drop-zone-sub">JPG / PNG / HEIC（最大5MB/枚）</div>
      </div>
    </div>
    <input
      type="file"
      class="photo-file-input"
      id="photo-input-${pigIdx}-${organId}"
      accept="image/*"
      multiple
      onchange="handlePhotoAdd('${pigIdx}', '${organId}', this)">`;
}

function renderMobileBtnsHtml(pigIdx, organId) {
  return `
    <div class="photo-mobile-btns">
      <label class="btn btn-secondary btn-sm" for="photo-input-camera-${pigIdx}-${organId}">
        📷 カメラ
      </label>
      <input type="file" class="photo-file-input"
        id="photo-input-camera-${pigIdx}-${organId}"
        accept="image/*" capture="environment"
        onchange="handlePhotoAdd('${pigIdx}', '${organId}', this)">
      <label class="btn btn-secondary btn-sm" for="photo-input-gallery-${pigIdx}-${organId}">
        🖼️ ギャラリー
      </label>
      <input type="file" class="photo-file-input"
        id="photo-input-gallery-${pigIdx}-${organId}"
        accept="image/*" multiple
        onchange="handlePhotoAdd('${pigIdx}', '${organId}', this)">
    </div>`;
}

function triggerPhotoInput(pigIdx, organId) {
  const input = document.getElementById(`photo-input-${pigIdx}-${organId}`);
  if (input) input.click();
}

// ===================================================
// ドラッグ&ドロップ設定
// ===================================================

function setupDropZone(pigIdx, organId) {
  const zone = document.getElementById(`drop-zone-${pigIdx}-${organId}`);
  if (!zone) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('drag-over');
  });

  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (!files.length) {
      showToast('画像ファイルをドロップしてください', 'warning');
      return;
    }
    processPhotoFiles(pigIdx, organId, files);
  });
}

// ===================================================
// 写真処理
// ===================================================

async function handlePhotoAdd(pigIdx, organId, input) {
  const files = Array.from(input.files);
  if (!files.length) return;
  await processPhotoFiles(pigIdx, organId, files);
  input.value = '';
}

async function processPhotoFiles(pigIdx, organId, files) {
  const maxSize = 5 * 1024 * 1024;
  const idx = parseInt(pigIdx);

  if (!state.formPhotos[idx]) {
    state.formPhotos[idx] = {};
    ORGAN_SECTIONS.forEach(s => { state.formPhotos[idx][s.id] = []; });
  }
  if (!state.formPhotos[idx][organId]) {
    state.formPhotos[idx][organId] = [];
  }

  for (const file of files) {
    if (file.size > maxSize) {
      showToast(`${file.name} は5MBを超えています。スキップします。`, 'warning');
      continue;
    }
    try {
      const base64 = await fileToBase64(file);
      const resized = await resizeImage(base64, 1200, 0.85);
      state.formPhotos[idx][organId].push(resized);
    } catch (e) {
      console.error('写真の読み込みに失敗:', e);
      showToast('写真の読み込みに失敗しました', 'error');
    }
  }
  renderPhotoGrid(idx, organId);
}

function resizeImage(base64, maxWidth, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      if (width > maxWidth) {
        height = Math.round(height * maxWidth / width);
        width = maxWidth;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = base64;
  });
}

function renderPhotoGrid(pigIdx, organId) {
  const grid = document.getElementById(`photo-grid-${pigIdx}-${organId}`);
  if (!grid) return;
  const photos = state.formPhotos[pigIdx]?.[organId] || [];
  grid.innerHTML = photos.map((src, i) => `
    <div class="photo-thumb-wrapper">
      <img src="${src}" alt="写真${i + 1}">
      <button class="photo-delete-btn"
        onclick="deleteFormPhoto(${pigIdx}, '${organId}', ${i})" title="削除">✕</button>
    </div>`).join('');
}

function deleteFormPhoto(pigIdx, organId, index) {
  if (state.formPhotos[pigIdx]?.[organId]) {
    state.formPhotos[pigIdx][organId].splice(index, 1);
    renderPhotoGrid(pigIdx, organId);
  }
}

// ===================================================
// 農場名オートコンプリート
// ===================================================

function showFarmSuggestions(value) {
  const list = document.getElementById('farmSuggestions');
  if (!value || value.length < 1) { list.style.display = 'none'; return; }
  const farms = [...new Set(state.records.map(r => r.farmName).filter(Boolean))]
    .filter(f => f.includes(value)).slice(0, 10);
  if (farms.length === 0) { list.style.display = 'none'; return; }
  list.innerHTML = farms.map(f =>
    `<div class="autocomplete-item" onmousedown="selectFarm('${escHtml(f)}')">${escHtml(f)}</div>`
  ).join('');
  list.style.display = 'block';
}

function selectFarm(name) {
  const input = document.getElementById('f-farmName');
  if (input) input.value = name;
  const list = document.getElementById('farmSuggestions');
  if (list) list.style.display = 'none';
}

function hideFarmSuggestionsDelayed() {
  setTimeout(() => {
    const list = document.getElementById('farmSuggestions');
    if (list) list.style.display = 'none';
  }, 200);
}

// ===================================================
// フォーム保存・キャンセル
// ===================================================

async function handleFormSave() {
  const farmName = document.getElementById('f-farmName')?.value.trim();
  const date = document.getElementById('f-date')?.value;

  if (!farmName) {
    showToast('農場名を入力してください', 'warning');
    document.getElementById('f-farmName')?.focus();
    return;
  }
  if (!date) {
    showToast('解剖日時を入力してください', 'warning');
    document.getElementById('f-date')?.focus();
    return;
  }

  const pigCount = Object.keys(state.formPhotos).length;

  // 各個体データを収集
  const pigs = Array.from({ length: pigCount }, (_, i) => {
    const findings = {};
    ORGAN_SECTIONS.forEach(section => {
      findings[section.id] = {
        text: document.getElementById(`finding-${i}-${section.id}`)?.value || '',
        photos: [...(state.formPhotos[i]?.[section.id] || [])],
      };
    });
    return {
      ageInfo: document.getElementById(`f-pig-ageInfo-${i}`)?.value?.trim() || '',
      sex: document.getElementById(`f-pig-sex-${i}`)?.value || '',
      memo: document.getElementById(`f-pig-memo-${i}`)?.value?.trim() || '',
      findings,
    };
  });

  const record = {
    id: state.editingId || generateId(),
    farmName,
    examiner: document.getElementById('f-examiner')?.value.trim() || '',
    date: new Date(date).toISOString(),
    headCount: String(pigCount),
    pigs,
    chiefComplaint: document.getElementById('f-chiefComplaint')?.value.trim() || '',
    diagnosis: document.getElementById('f-diagnosis')?.value.trim() || '',
    treatment: document.getElementById('f-treatment')?.value.trim() || '',
    updatedAt: new Date().toISOString(),
    createdAt: state.editingId
      ? (state.records.find(r => r.id === state.editingId)?.createdAt || new Date().toISOString())
      : new Date().toISOString(),
  };

  try {
    await saveRecord(record);
    state.records = await getAllRecords();
    updateFarmFilter();
    showToast('保存しました ✓', 'success');
    state.viewingId = record.id;
    state.activeDetailPigTab = 0;
    renderDetail(record);
    navigateTo('detail');

    // Googleドライブに自動同期（バックグラウンド）
    syncToDrive(false);
  } catch (e) {
    console.error('保存エラー:', e);
    showToast('保存に失敗しました', 'error');
  }
}

function handleFormCancel() {
  if (state.editingId) {
    navigateTo('detail');
  } else {
    navigateTo('list');
  }
}

// ===================================================
// 削除
// ===================================================

function confirmDelete(id) {
  showConfirm(
    'カルテを削除しますか？',
    'この操作は取り消せません。本当に削除しますか？',
    async () => {
      try {
        await deleteRecord(id);
        state.records = await getAllRecords();
        updateFarmFilter();
        renderList();
        showToast('削除しました', 'success');
        navigateTo('list');

        // Googleドライブに自動同期（バックグラウンド）
        syncToDrive(false);
      } catch (e) {
        console.error('削除エラー:', e);
        showToast('削除に失敗しました', 'error');
      }
    }
  );
}

// ===================================================
// データ管理ページ
// ===================================================

function renderDataPage() {
  document.getElementById('stat-total').textContent = state.records.length;

  const farms = new Set(state.records.map(r => r.farmName).filter(Boolean));
  document.getElementById('stat-farms').textContent = farms.size;

  const photos = state.records.reduce((sum, r) => sum + countPhotos(r), 0);
  document.getElementById('stat-photos').textContent = photos;

  // ドライブ設定エリアを描画
  renderDriveSettings();
}

function exportData() {
  const data = {
    exportedAt: new Date().toISOString(),
    version: 2,
    records: state.records,
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  a.href = url;
  a.download = `豚解剖記録_${dateStr}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('エクスポートしました ✓', 'success');
}

// ===================================================
// 集計ページ
// ===================================================

/** 日付文字列から年度（4月始まり）を返す */
function getFiscalYear(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const m = d.getMonth() + 1;
  return m >= 4 ? d.getFullYear() : d.getFullYear() - 1;
}

/** 利用可能な年度一覧を返す */
function getAvailableFiscalYears() {
  const years = new Set();
  state.records.forEach(r => {
    const fy = getFiscalYear(r.date);
    if (fy) years.add(fy);
  });
  return [...years].sort((a, b) => b - a);
}

/** 指定年度のレコードを返す（nullなら全件） */
function filterByFiscalYear(records, fy) {
  if (!fy) return records;
  return records.filter(r => getFiscalYear(r.date) === fy);
}

function renderStatsPage(selectedFy) {
  const container = document.getElementById('page-stats');
  if (!container) return;

  const years = getAvailableFiscalYears();
  const fy = selectedFy || years[0] || null;
  const filtered = filterByFiscalYear(state.records, fy);

  if (state.records.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <div class="empty-state-title">データがありません</div>
        <div class="empty-state-desc">カルテを登録すると集計が表示されます</div>
      </div>`;
    return;
  }

  // --- 集計処理 ---
  const totalCases = filtered.length;
  const totalHeads = filtered.reduce((sum, r) => {
    return sum + (r.pigs ? r.pigs.length : (parseInt(r.headCount) || 1));
  }, 0);
  const farms = new Set(filtered.map(r => r.farmName).filter(Boolean));

  // 診断名カウント
  const diagCount = {};
  filtered.forEach(r => {
    const d = r.diagnosis ? r.diagnosis.trim() : '（未入力）';
    diagCount[d] = (diagCount[d] || 0) + 1;
  });
  const diagRanking = Object.entries(diagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const diagMax = diagRanking[0]?.[1] || 1;

  // 農場別カウント
  const farmCount = {};
  filtered.forEach(r => {
    const f = r.farmName || '（未入力）';
    farmCount[f] = (farmCount[f] || 0) + 1;
  });
  const farmRanking = Object.entries(farmCount).sort((a, b) => b[1] - a[1]);
  const farmMax = farmRanking[0]?.[1] || 1;

  // 月別カウント（4月〜3月の順）
  const monthLabels = ['4月','5月','6月','7月','8月','9月','10月','11月','12月','1月','2月','3月'];
  const monthNums =   [4,5,6,7,8,9,10,11,12,1,2,3];
  const monthCount = {};
  monthNums.forEach(m => { monthCount[m] = 0; });
  filtered.forEach(r => {
    if (!r.date) return;
    const d = new Date(r.date);
    if (!isNaN(d)) monthCount[d.getMonth() + 1] = (monthCount[d.getMonth() + 1] || 0) + 1;
  });
  const monthMax = Math.max(...Object.values(monthCount), 1);

  // --- HTML生成 ---
  const yearOptions = years.map(y =>
    `<option value="${y}" ${y === fy ? 'selected' : ''}>${y}年度（${y}/4〜${y+1}/3）</option>`
  ).join('');

  const diagBars = diagRanking.map(([name, count], i) => `
    <div class="stats-bar-row">
      <div class="stats-bar-rank">${i + 1}</div>
      <div class="stats-bar-label" title="${escHtml(name)}">${escHtml(name)}</div>
      <div class="stats-bar-wrap">
        <div class="stats-bar-fill" style="width:${Math.round(count/diagMax*100)}%"></div>
      </div>
      <div class="stats-bar-count">${count}件</div>
    </div>`).join('');

  const farmBars = farmRanking.map(([name, count]) => `
    <div class="stats-bar-row">
      <div class="stats-bar-rank">🏠</div>
      <div class="stats-bar-label" title="${escHtml(name)}">${escHtml(name)}</div>
      <div class="stats-bar-wrap">
        <div class="stats-bar-fill" style="width:${Math.round(count/farmMax*100)}%;background:var(--accent)"></div>
      </div>
      <div class="stats-bar-count">${count}件</div>
    </div>`).join('');

  const monthBars = monthNums.map((m, i) => {
    const count = monthCount[m] || 0;
    return `
    <div class="stats-month-col">
      <div class="stats-month-bar-wrap">
        <div class="stats-month-bar-fill" style="height:${Math.round(count/monthMax*100)}%"></div>
      </div>
      <div class="stats-month-count">${count || ''}</div>
      <div class="stats-month-label">${monthLabels[i]}</div>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div class="stats-page">

      <!-- 年度セレクター -->
      <div class="stats-year-selector">
        <label class="form-label" style="margin:0;font-size:0.9rem">年度：</label>
        <select class="form-control" style="width:auto" onchange="renderStatsPage(parseInt(this.value))">
          ${yearOptions}
          <option value="" ${!fy ? 'selected' : ''}>全期間</option>
        </select>
        <button class="btn btn-primary btn-sm" onclick="exportStatsCSV(${fy || 'null'})">
          📊 集計CSVダウンロード
        </button>
      </div>

      <!-- サマリーカード -->
      <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:1.5rem">
        <div class="stat-card">
          <div class="stat-value">${totalCases}</div>
          <div class="stat-label">解剖回数</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${totalHeads}</div>
          <div class="stat-label">解剖頭数</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${farms.size}</div>
          <div class="stat-label">対象農場数</div>
        </div>
      </div>

      <!-- 診断名ランキング -->
      <div class="section-heading">🔍 診断名ランキング（上位10）</div>
      <div class="card" style="margin-bottom:1.5rem">
        <div class="card-body">
          ${diagRanking.length > 0 ? diagBars : '<div style="color:var(--text-muted);font-size:0.9rem">診断名のデータがありません</div>'}
        </div>
      </div>

      <!-- 農場別件数 -->
      <div class="section-heading">🏠 農場別件数</div>
      <div class="card" style="margin-bottom:1.5rem">
        <div class="card-body">
          ${farmRanking.length > 0 ? farmBars : '<div style="color:var(--text-muted);font-size:0.9rem">農場データがありません</div>'}
        </div>
      </div>

      <!-- 月別推移 -->
      <div class="section-heading">📅 月別解剖件数</div>
      <div class="card" style="margin-bottom:1.5rem">
        <div class="card-body">
          <div class="stats-month-chart">${monthBars}</div>
        </div>
      </div>

    </div>`;
}

/** 集計CSVをエクスポート */
function exportStatsCSV(fy) {
  const filtered = filterByFiscalYear(state.records, fy || null);
  if (filtered.length === 0) {
    showToast('対象データがありません', 'warning');
    return;
  }

  // 診断名集計
  const diagCount = {};
  filtered.forEach(r => {
    const d = r.diagnosis ? r.diagnosis.trim() : '（未入力）';
    diagCount[d] = (diagCount[d] || 0) + 1;
  });

  // 月別集計
  const monthCount = {};
  filtered.forEach(r => {
    if (!r.date) return;
    const d = new Date(r.date);
    if (!isNaN(d)) {
      const key = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}`;
      monthCount[key] = (monthCount[key] || 0) + 1;
    }
  });

  // 農場別集計
  const farmCount = {};
  filtered.forEach(r => {
    const f = r.farmName || '（未入力）';
    farmCount[f] = (farmCount[f] || 0) + 1;
  });

  const bom = '\uFEFF';
  const fyLabel = fy ? `${fy}年度` : '全期間';
  const totalHeads = filtered.reduce((sum, r) => sum + (r.pigs ? r.pigs.length : (parseInt(r.headCount) || 1)), 0);

  let csv = `${bom}豚解剖記録 集計レポート\r\n`;
  csv += `集計期間,${fyLabel}\r\n`;
  csv += `解剖回数,${filtered.length}\r\n`;
  csv += `解剖頭数,${totalHeads}\r\n`;
  csv += `\r\n`;
  csv += `【診断名別件数】\r\n診断名,件数\r\n`;
  Object.entries(diagCount).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
    csv += `"${k}",${v}\r\n`;
  });
  csv += `\r\n【農場別件数】\r\n農場名,件数\r\n`;
  Object.entries(farmCount).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
    csv += `"${k}",${v}\r\n`;
  });
  csv += `\r\n【月別件数】\r\n年月,件数\r\n`;
  Object.entries(monthCount).sort().forEach(([k,v]) => {
    csv += `${k},${v}\r\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
  a.href = url;
  a.download = `解剖集計_${fyLabel}_${dateStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`集計CSVをダウンロードしました ✓`, 'success');
}

// ===================================================
// CSV出力
// ===================================================

function exportCSV() {
  if (!state.records || state.records.length === 0) {
    showToast('エクスポートするデータがありません', 'warning');
    return;
  }

  const headers = [
    '解剖日時', '農場名', '解剖者', '個体No', '日齢', '性別',
    '診断名', '稟告',
    '外貌所見', '肺・胸腔所見', '心臓所見', '消化管所見', '脾腎肝所見', 'リンパ節所見',
    '治療・検査内容', '写真枚数', '作成日時',
  ];

  const rows = [headers];

  for (const record of state.records) {
    const pigs = normalizePigs(record);
    pigs.forEach((pig, i) => {
      const photoCount = ORGAN_SECTIONS.reduce(
        (sum, s) => sum + (pig.findings?.[s.id]?.photos?.length || 0), 0
      );
      rows.push([
        record.date ? formatDateShort(record.date) : '',
        record.farmName || '',
        record.examiner || '',
        i + 1,
        pig.ageInfo || (i === 0 ? record.ageInfo || '' : ''),
        pig.sex || '',
        i === 0 ? (record.diagnosis || '') : '',
        i === 0 ? (record.chiefComplaint || '') : '',
        pig.findings?.appearance?.text || '',
        pig.findings?.lung?.text || '',
        pig.findings?.heart?.text || '',
        pig.findings?.digestive?.text || '',
        pig.findings?.abdominal?.text || '',
        pig.findings?.lymph?.text || '',
        i === 0 ? (record.treatment || '') : '',
        photoCount,
        record.createdAt ? formatDateShort(record.createdAt) : '',
      ]);
    });
  }

  const csvContent = rows.map(row =>
    row.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')
  ).join('\r\n');

  const bom = '\uFEFF';
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  a.href = url;
  a.download = `豚解剖記録_${dateStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`CSVをエクスポートしました（${state.records.length}件）✓`, 'success');
}

// ===================================================
// PDF印刷
// ===================================================

function printRecord(id) {
  const record = id ? state.records.find(r => r.id === id) : null;
  const recordsToPrint = record ? [record] : state.records;

  if (recordsToPrint.length === 0) {
    showToast('印刷するデータがありません', 'warning');
    return;
  }

  const printHtml = _buildPrintHtml(recordsToPrint);
  const printWindow = window.open('', '_blank', 'width=850,height=700');
  if (!printWindow) {
    showToast('ポップアップがブロックされました。ブラウザの設定を確認してください', 'error', 5000);
    return;
  }
  printWindow.document.write(printHtml);
  printWindow.document.close();
}

function _buildPrintHtml(records) {
  const dateStr = new Date().toLocaleDateString('ja-JP');

  const recordsHtml = records.map(record => {
    const pigs = normalizePigs(record);

    const pigsHtml = pigs.map((pig, i) => {
      const organRows = ORGAN_SECTIONS.map(s => {
        const text = pig.findings?.[s.id]?.text || '';
        const photos = pig.findings?.[s.id]?.photos || [];
        const photosHtml = photos.length > 0
          ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${
              photos.map(p => `<img src="${p}" style="width:120px;height:90px;object-fit:cover;border-radius:3px;border:1px solid #ccc">`).join('')
            }</div>` : '';
        const isEmpty = !text && photos.length === 0;
        return `<tr>
          <td style="width:28%;font-weight:600;padding:5px 8px;border:1px solid #ccc;background:#f5f7ff;vertical-align:top">${s.icon} ${s.label}</td>
          <td style="padding:5px 8px;border:1px solid #ccc;vertical-align:top">${isEmpty ? '<span style="color:#aaa">（所見なし）</span>' : (text ? escHtml(text) : '')}${photosHtml}</td>
        </tr>`;
      }).join('');

      const pigHeader = pigs.length > 1
        ? `<div style="background:#1e3a8a;color:white;padding:4px 8px;font-weight:600;margin:10px 0 4px;border-radius:3px">
            ${i + 1}頭目${pig.ageInfo ? `　日齢：${pig.ageInfo}` : ''}${pig.sex ? `　性別：${pig.sex}` : ''}${pig.memo ? `　メモ：${pig.memo}` : ''}
          </div>` : '';

      return `${pigHeader}
        <table style="width:100%;border-collapse:collapse;margin-bottom:6px;font-size:10pt">${organRows}</table>`;
    }).join('');

    const dateFormatted = record.date
      ? new Date(record.date).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '日付不明';

    return `
      <div style="page-break-after:always;margin-bottom:20px;padding:16px;border:2px solid #1e3a8a;border-radius:6px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:8px;border-bottom:2px solid #1e3a8a;margin-bottom:10px">
          <div>
            <div style="font-size:1.2em;font-weight:700;color:#1e3a8a">🐷 豚解剖記録カルテ</div>
            <div style="color:#555;margin-top:3px">🏠 ${escHtml(record.farmName) || '農場名未入力'}　|　解剖日時：${dateFormatted}</div>
          </div>
          <div style="text-align:right;font-size:0.9em;color:#555;line-height:1.6">
            解剖者：${escHtml(record.examiner) || '—'}<br>頭数：${pigs.length}頭
          </div>
        </div>

        ${record.chiefComplaint ? `
        <div style="margin-bottom:8px;padding:6px 10px;background:#eff6ff;border-left:3px solid #3b82f6;border-radius:2px">
          <strong>📝 稟告：</strong>${escHtml(record.chiefComplaint)}
        </div>` : ''}

        ${record.diagnosis ? `
        <div style="margin-bottom:8px;padding:6px 10px;background:#fefce8;border-left:3px solid #f59e0b;border-radius:2px;font-weight:600">
          🔍 診断名：${escHtml(record.diagnosis)}
        </div>` : ''}

        <div style="font-weight:600;margin:8px 0 4px;color:#1e3a8a">🔬 解剖所見</div>
        ${pigsHtml}

        ${record.treatment ? `
        <div style="margin-top:8px;padding:6px 10px;background:#f0fff4;border-left:3px solid #22c55e;border-radius:2px">
          <strong>💊 治療・検査内容：</strong>${escHtml(record.treatment)}
        </div>` : ''}
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>豚解剖記録カルテ - 印刷</title>
  <style>
    body { font-family: 'Meiryo', 'Yu Gothic', 'Noto Sans JP', sans-serif; font-size: 10.5pt; color: #333; margin: 12mm; }
    @media print {
      .no-print { display: none !important; }
      body { margin: 8mm; }
    }
  </style>
</head>
<body>
  <div class="no-print" style="padding:10px 14px;background:#dbeafe;margin-bottom:14px;border-radius:5px;display:flex;justify-content:space-between;align-items:center;font-size:0.9em">
    <span>🖨️ ブラウザの印刷ダイアログで <strong>「PDFに保存」</strong> を選ぶとPDFになります</span>
    <button onclick="window.print()" style="padding:7px 18px;background:#1e3a8a;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600">🖨️ 印刷 / PDF保存</button>
  </div>
  <p style="color:#888;font-size:0.85em;margin-bottom:12px">出力日：${dateStr}　|　${records.length}件</p>
  ${recordsHtml}
</body>
</html>`;
}

function triggerImport() {
  document.getElementById('importFileInput').click();
}

async function handleImport(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.records || !Array.isArray(data.records)) {
        showToast('不正なファイル形式です', 'error');
        return;
      }
      showConfirm(
        'データをインポートしますか？',
        `${data.records.length}件の記録が含まれています。\n現在のデータに追加されます（同一IDは上書き）。`,
        async () => {
          try {
            for (const rec of data.records) { await saveRecord(rec); }
            state.records = await getAllRecords();
            updateFarmFilter();
            renderList();
            renderDataPage();
            showToast(`${data.records.length}件インポートしました ✓`, 'success');
          } catch (err) {
            console.error('インポートエラー:', err);
            showToast('インポートに失敗しました', 'error');
          }
        }
      );
    } catch (err) {
      showToast('JSONの解析に失敗しました', 'error');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

function handleDeleteAll() {
  showConfirm(
    '全データを削除しますか？',
    '⚠️ すべての記録が完全に削除されます。この操作は取り消せません。事前にエクスポートを推奨します。',
    async () => {
      try {
        await clearAllRecords();
        state.records = [];
        updateFarmFilter();
        renderList();
        renderDataPage();
        showToast('全データを削除しました', 'warning');
      } catch (e) {
        showToast('削除に失敗しました', 'error');
      }
    }
  );
}

// ===================================================
// イベントリスナーの設定
// ===================================================

function setupEventListeners() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const page = tab.dataset.page;
      if (page === 'list') { renderList(); navigateTo(page); }
      else if (page === 'stats') { renderStatsPage(); navigateTo(page); }
      else if (page === 'data') { renderDataPage(); renderDriveSettings(); navigateTo(page); }
    });
  });

  document.getElementById('fab').addEventListener('click', () => { openNewForm(); });

  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderList();
  });

  document.getElementById('farmFilter').addEventListener('change', (e) => {
    state.filterFarm = e.target.value;
    renderList();
  });

  document.getElementById('photoModalClose').addEventListener('click', () => {
    document.getElementById('photoModal').classList.remove('open');
  });

  document.getElementById('photoModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
  });

  document.getElementById('importFileInput').addEventListener('change', (e) => {
    handleImport(e.target);
  });
}

// ===================================================
// アプリ初期化
// ===================================================

async function init() {
  try {
    state.db = await openDB();
    state.records = await getAllRecords();
    updateFarmFilter();
    renderList();
    setupEventListeners();
    navigateTo('list');

    // ヘッダーの同期ステータス初期化
    const url = getDriveUrl();
    if (url) {
      updateSyncStatus('offline'); // まずオフライン扱いで表示
      // バックグラウンドでドライブから最新データを取得
      syncFromDrive();
    } else {
      updateSyncStatus('unset');
    }
  } catch (e) {
    console.error('初期化エラー:', e);
    document.body.innerHTML = `
      <div style="padding:40px;text-align:center;color:#dc2626">
        <p style="font-size:1.2rem;font-weight:bold">アプリの初期化に失敗しました</p>
        <p style="margin-top:12px;color:#64748b">IndexedDBが利用できない可能性があります。<br>ブラウザのプライベートモードを解除してお試しください。</p>
      </div>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
