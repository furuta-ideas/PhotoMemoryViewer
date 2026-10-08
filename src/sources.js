import { datedFolder, nearestFolder, youtubeLinks, driveFolderId } from './core.js?v=20261008-range8';
const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const LINK = /\.(txt|url)$/i;
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const issues = () => ({ skipped: 0, messages: [] });
function skip(report, message) { report.skipped++; if (report.messages.length < 50) report.messages.push(message); }

async function collectFile(name, id, folder, getFile, result) {
  if (!IMAGE.test(name) && !LINK.test(name)) {
    skip(result.report, `${name}：対応していない形式`); return;
  }
  if (!folder) { skip(result.report, `${name}：日付付きフォルダに所属していません`); return; }
  if (IMAGE.test(name)) {
    result.photos.push({ id, name, ...folder, load: async signal => URL.createObjectURL(await getFile(signal)) });
  } else {
    try {
      const file = await getFile();
      if (file.size > 1024 * 1024) { skip(result.report, `${name}：URLファイルは1MB以下にしてください`); return; }
      const links = youtubeLinks(await file.text());
      if (!links.length) skip(result.report, `${name}：有効なYouTubeリンクがありません`);
      for (const videoId of links) result.videos.push({ id: `${id}:${videoId}`, name, ...folder, videoId });
    } catch (error) {
      if (['AUTH', 'NETWORK', 'SOURCE'].includes(error.code)) throw error;
      skip(result.report, `${name}：${error.message}`);
    }
  }
}

export async function scanFiles(files, onProgress = () => {}, fallbackFolder = null) {
  const result = { photos: [], videos: [], report: issues() };
  let done = 0;
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    // A regular file picker does not provide the parent folder. Use only explicit metadata.
    await collectFile(file.name, path, nearestFolder(path) || (!file.webkitRelativePath ? fallbackFolder : null), async () => file, result);
    if (++done % 25 === 0) { onProgress(done); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  return result;
}

export async function scanDirectory(handle, onProgress = () => {}) {
  const result = { photos: [], videos: [], report: issues() }; let done = 0;
  async function walk(dir, path, inherited) {
    const folder = datedFolder(dir.name) || inherited;
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') await walk(entry, `${path}/${entry.name}`, folder);
      else {
        await collectFile(entry.name, `${path}/${entry.name}`, folder, () => entry.getFile(), result);
        if (++done % 25 === 0) { onProgress(done); await new Promise(resolve => setTimeout(resolve, 0)); }
      }
    }
  }
  await walk(handle, handle.name, null); return result;
}

export async function storeHandle(handle) {
  // Permission is re-requested from a user gesture when restoring this handle.
  try {
    const db = await handleDB();
    await new Promise((resolve, reject) => { const tx = db.transaction('handles', 'readwrite'); const store = tx.objectStore('handles'); handle ? store.put(handle, 'folder') : store.delete('folder'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  } catch { /* File imports remain usable when IndexedDB is unavailable. */ }
}
function handleDB() {
  return new Promise((resolve, reject) => { const request = indexedDB.open('photo-memory-handles', 1); request.onupgradeneeded = () => request.result.createObjectStore('handles'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export async function restoreHandle() {
  try {
    const db = await handleDB();
    const value = await new Promise((resolve, reject) => { const request = db.transaction('handles').objectStore('handles').get('folder'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return value;
  } catch { return null; }
}

const scriptPromises = new Map();
export function loadScript(url, ready) {
  if (ready()) return Promise.resolve();
  if (scriptPromises.has(url)) return scriptPromises.get(url);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = url; script.async = true;
    const timeout = setTimeout(() => { script.remove(); reject(new Error('外部サービスに接続できません。ネットワークを確認してください。')); }, 20000);
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('外部サービスの読み込みに失敗しました。')); };
    document.head.append(script);
  }).catch(error => { scriptPromises.delete(url); throw error; });
  scriptPromises.set(url, promise); return promise;
}

export class DriveSource {
  constructor() { this.token = null; this.expires = 0; this.client = null; this.clientId = ''; }
  async prepare(clientId) {
    if (!clientId.endsWith('.apps.googleusercontent.com')) throw new Error('Google Cloudで取得したOAuthクライアントIDを設定してください。');
    await loadScript('https://accounts.google.com/gsi/client', () => !!window.google?.accounts?.oauth2);
    if (clientId !== this.clientId) { this.token = null; this.expires = 0; }
    this.clientId = clientId;
    this.client = window.google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPE, callback: () => {} });
  }
  authorize() {
    if (!this.client) throw new Error('Google接続の初期設定を完了してください。');
    return new Promise((resolve, reject) => {
      this.client.callback = response => {
        if (response.error || !response.access_token || !window.google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) { reject(new Error('Driveの読み取り権限が許可されませんでした。')); return; }
        this.token = response.access_token; this.expires = Date.now() + response.expires_in * 1000 - 30000; resolve();
      };
      this.client.error_callback = () => reject(new Error('Google認証がキャンセルまたはブロックされました。もう一度接続してください。'));
      this.client.requestAccessToken({ prompt: '' });
    });
  }
  async request(path, params = {}, signal, blob = false) {
    if (!this.token || Date.now() >= this.expires) throw Object.assign(new Error('Googleの認証が切れました。「Googleに接続」を押して再認証してください。'), { code: 'AUTH' });
    const url = `https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams(params)}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      // Display on demand without retaining Drive responses in the browser HTTP cache.
      try { response = await fetch(url, { cache: 'no-store', headers: { Authorization: `Bearer ${this.token}` }, signal }); }
      catch (error) { if (error.name === 'AbortError') throw error; throw Object.assign(new Error('ネットワークに接続できません。接続を確認してPlayまたは再読み込みを押してください。'), { code: 'NETWORK' }); }
      if (response.ok) return blob ? response.blob() : response.json();
      if (response.status === 401) { this.token = null; this.expires = 0; throw Object.assign(new Error('Googleに再接続してください。'), { code: 'AUTH' }); }
      const body = await response.json().catch(() => ({}));
      const rateLimit = response.status === 429 || response.status >= 500 || body.error?.errors?.some(e => /rateLimitExceeded|userRateLimitExceeded/.test(e.reason));
      if (rateLimit && attempt < 3) { await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt)); continue; }
      if (response.status === 403) throw Object.assign(new Error('Drive APIが無効、またはフォルダの読み取り権限がありません。設定手順を確認してください。'), { code: 'SOURCE' });
      if (response.status === 404) throw new Error('フォルダまたはファイルが見つかりません。');
      throw Object.assign(new Error('Google Driveの読み込みに失敗しました。しばらくして再試行してください。'), { code: 'NETWORK' });
    }
  }
  async findFolders(name, signal, exact = false) {
    const escaped = name.trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    if (!escaped) throw new Error('親フォルダの名前を入力してください。');
    const folders = []; let pageToken = '';
    do {
      const params = { q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name ${exact ? '=' : 'contains'} '${escaped}'`, fields: 'nextPageToken,files(id,name)', pageSize: '1000', orderBy: 'name' };
      if (pageToken) params.pageToken = pageToken;
      const page = await this.request('files', params, signal);
      folders.push(...(page.files || [])); pageToken = page.nextPageToken;
    } while (pageToken);
    return folders;
  }
  async scan(value, onProgress = () => {}, signal) {
    const id = driveFolderId(value);
    const root = await this.request(`files/${id}`, { fields: 'id,name,mimeType' }, signal);
    if (root.mimeType !== 'application/vnd.google-apps.folder') throw new Error('写真の入ったフォルダを指定してください。');
    const result = { photos: [], videos: [], report: issues(), name: root.name };
    let done = 0;
    const visited = new Set();
    const walk = async (dir, inherited) => {
      if (visited.has(dir.id)) return; visited.add(dir.id);
      const folder = datedFolder(dir.name) || inherited;
      let pageToken = '';
      do {
        const params = { q: `'${dir.id}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,mimeType)', pageSize: '1000' };
        if (pageToken) params.pageToken = pageToken;
        const page = await this.request('files', params, signal);
        for (const entry of page.files || []) {
          if (entry.mimeType === 'application/vnd.google-apps.folder') await walk(entry, folder);
          else await collectFile(entry.name, entry.id, folder, s => this.request(`files/${entry.id}`, { alt: 'media' }, s || signal, true), result);
          onProgress(++done);
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    };
    await walk(root, null); return result;
  }
  disconnect() {
    if (this.token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(this.token, () => {});
    this.token = null; this.expires = 0; this.client = null; this.clientId = '';
  }
}

export function demoSource() {
  const scenes = [
    ['20240403 （春の山歩き）', '#d4dad0', '#889c8f', '#4f776b', '#d8c68f', 'mountain'],
    ['20250815 （夏の海辺）', '#c5dedc', '#669a9b', '#2e6b77', '#edd5aa', 'sea'],
    ['20251102 （秋の散歩）', '#e5d4b5', '#bb946a', '#785d40', '#d6b982', 'forest'],
    ['20260118 （冬の湖）', '#c8d1d4', '#9aafb6', '#586d76', '#dbe3dd', 'lake'],
    ['20240504 （緑の休日）', '#dbe4c5', '#a0b084', '#526b48', '#e6d2a3', 'forest'],
    ['20250720 （夕暮れの海）', '#edc7a9', '#b88b7b', '#735c69', '#f5d79b', 'sea'],
    ['20251012 （高原の旅）', '#d7cec1', '#ae9f83', '#6a7a61', '#ebd1a0', 'mountain'],
    ['20260211 （静かな朝）', '#d4dce1', '#b1b8bd', '#667a83', '#e4ded3', 'lake']
  ];
  const photos = scenes.map(([folder, sky, middle, front, sun, kind], index) => ({
    id: `demo-${index}`, name: `sample-${index}.svg`, ...datedFolder(folder), load: async () => {
      let shape;
      if (kind === 'sea') shape = `<path fill="${middle}" d="M0 450h1200v350H0z"/><path fill="${front}" d="M0 525q300-70 600 0t600 0v275H0z"/><path fill="${sun}" opacity=".65" d="M0 690q400-130 780 40l420-50v120H0z"/><path stroke="#fff" opacity=".35" fill="none" stroke-width="3" d="M0 550q300-70 600 0t600 0M100 600h220m380-10h360"/>`;
      else if (kind === 'forest') shape = `<path fill="${middle}" d="M0 550q600-230 1200-70v320H0z"/>` + Array.from({ length: 12 }, (_, i) => `<path fill="${front}" opacity="${.5 + i % 3 * .2}" d="m${i * 110} ${250 + i % 3 * 65} 85 330h-170Z"/><path stroke="${front}" stroke-width="12" d="M${i * 110} 480v270"/>`).join('') + `<path fill="${sun}" d="M530 800q-70-110 90-200q-35 170 150 200Z"/>`;
      else shape = `<path fill="${middle}" d="m0 530 250-260 160 180 230-290 240 330 140-110 180 230v190H0Z"/><path fill="${front}" d="m0 700 270-210 190 90 300-170 220 200 220-90v280H0Z"/>` + (kind === 'lake' ? `<path fill="${sky}" opacity=".75" d="M0 660q500-100 1200 0v140H0Z"/><path fill="${front}" opacity=".15" d="m0 800 400-120 400 70 400-40v90Z"/>` : '');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"><defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="${sky}"/><stop offset="1" stop-color="${sun}"/></linearGradient><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".65" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter></defs><path fill="url(#s)" d="M0 0h1200v800H0z"/><circle cx="920" cy="175" r="65" fill="${sun}"/>${shape}<path filter="url(#grain)" opacity=".045" d="M0 0h1200v800H0z"/></svg>`;
      return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    }
  }));
  return { photos, videos: [], report: issues(), name: 'サンプルの風景イラスト' };
}
