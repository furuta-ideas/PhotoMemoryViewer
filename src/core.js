export const DRIVE_ALBUMS = Object.freeze(['①古田家の思い出アルバム', '②じいじの思い出アルバム']);
export const DEFAULTS = Object.freeze({ start: '', end: '', layout: 4, refresh: 15, effect: 'smooth', fit: 'cover', youtube: true, sound: true, volume: 70, bgm: 'off', bgmVolume: 40, sourceTab: 'local', driveFolder: '', clientId: '', localFileFolder: '', driveAlbums: DRIVE_ALBUMS });

export function prefersFileSelection(userAgent, platform, touchPoints) {
  return /iPad|iPhone|iPod/i.test(userAgent) || (platform === 'MacIntel' && touchPoints > 1);
}

export function validDate(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const year = +value.slice(0, 4), month = +value.slice(4, 6), day = +value.slice(6);
  const d = new Date(0); d.setUTCFullYear(year, month - 1, day); d.setUTCHours(0, 0, 0, 0);
  return year >= 1 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function datedFolder(name) {
  const match = /^(\d{8})[\s\u3000]+(.+)$/.exec(name);
  return match && validDate(match[1]) && match[2].trim() ? { date: match[1], folder: name } : null;
}

export function nearestFolder(path) {
  return path.split(/[\\/]/).slice(0, -1).reduce((found, part) => datedFolder(part) || found, null);
}

export function inRange(item, start, end) { return (!start || item.date >= start) && (!end || item.date <= end); }

export function validateSettings(s) {
  if (s.start && !validDate(s.start)) throw new Error('開始日は実在する日付をYYYYMMDDで入力してください。');
  if (s.end && !validDate(s.end)) throw new Error('終了日は実在する日付をYYYYMMDDで入力してください。');
  if (s.start && s.end && s.start > s.end) throw new Error('開始日は終了日以前にしてください。');
  if (![1, 2, 3, 4, 6, 8].includes(s.layout)) throw new Error('画面分割数が不正です。');
  if (!Number.isInteger(s.refresh) || s.refresh < 4 || s.refresh > 3600) throw new Error('リフレッシュ時間は4～3600秒の整数にしてください。');
  if (!['smooth', 'fade', 'slide', 'none'].includes(s.effect) || !['contain', 'cover'].includes(s.fit)) throw new Error('表示設定が不正です。');
  if (![s.volume, s.bgmVolume].every(value => Number.isFinite(value) && value >= 0 && value <= 100) || !['off', 'local'].includes(s.bgm)) throw new Error('音声設定が不正です。');
  return s;
}

export function gridShape(count, portrait) {
  const landscape = { 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 6: [3, 2], 8: [4, 2] };
  const vertical = { 1: [1, 1], 2: [1, 2], 3: [1, 3], 4: [2, 2], 6: [2, 3], 8: [2, 4] };
  return (portrait ? vertical : landscape)[count] || [2, 2];
}

export function youtubeId(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    let id;
    if (host === 'youtu.be' || host === 'www.youtu.be') id = url.pathname.split('/')[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com'].includes(host)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[2];
    }
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

export function youtubeLinks(text) {
  const links = text.match(/https?:\/\/[^\s<>"']+/g) || [];
  return [...new Set(links.map(youtubeId).filter(Boolean))];
}

export function driveFolderId(value) {
  let id = value.trim();
  if (id.startsWith('http')) {
    try {
      const url = new URL(id);
      if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') throw new Error();
      id = /\/folders\/([\w-]+)/.exec(url.pathname)?.[1] || '';
    } catch { id = ''; }
  }
  if (!/^[\w-]{10,200}$/.test(id)) throw new Error('Google DriveのフォルダURLまたはフォルダIDを入力してください。');
  return id;
}

export function randomSeek(duration, refresh, previous = -100, random = Math.random) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const max = Math.max(0, duration - refresh);
  let point = random() * max;
  for (let i = 0; i < 8 && max > refresh * 2 && Math.abs(point - previous) < refresh; i++) point = random() * max;
  return Math.floor(point);
}

export class ShuffleBag {
  constructor(items, random = Math.random) { this.items = items; this.random = random; this.bag = []; this.last = null; }
  draw(excluded = new Set()) {
    if (!this.items.length) return null;
    if (!this.bag.length) {
      this.bag = [...this.items];
      for (let i = this.bag.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]]; }
    }
    let index = this.bag.findIndex(item => !excluded.has(item.id) && item.id !== this.last);
    if (index < 0) index = this.bag.findIndex(item => !excluded.has(item.id));
    // If remaining entries are on screen, begin another bag rather than duplicate them.
    if (index < 0) {
      const alternate = this.items.filter(item => !excluded.has(item.id) && item.id !== this.last);
      if (alternate.length) {
        const item = alternate[Math.floor(this.random() * alternate.length)];
        this.last = item.id; return item;
      }
      index = 0;
    }
    const [item] = this.bag.splice(index, 1); this.last = item.id; return item;
  }
}

export class RefreshClock {
  constructor(callback) { this.callback = callback; this.timer = null; this.index = 0; }
  start(refresh, count) {
    this.stop(); this.index = 0;
    this.timer = setInterval(() => { this.callback(this.index); this.index = (this.index + 1) % count; }, refresh * 1000 / count);
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}
