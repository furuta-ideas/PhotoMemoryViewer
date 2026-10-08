import { DEFAULTS, DRIVE_ALBUMS, DATE_MIN, DATE_MAX, DATE_DAYS, validDate, dateToDay, dayToDate, boundedDate, validateSettings, inRange, gridShape, ShuffleBag, RefreshClock, driveFolderId, datedFolder, prefersFileSelection } from './core.js?v=20261008-start9';
import { scanFiles, scanDirectory, storeHandle, restoreHandle, DriveSource, demoSource } from './sources.js?v=20261008-start9';
import { VideoPlayer } from './youtube.js?v=20261008-start9';
import { GOOGLE_CLIENT_ID } from './deployment-config.js?v=20261008-start9';

const $ = id => document.getElementById(id);
const STORAGE = 'photo-memory-viewer.settings.v1';
const preferFiles = prefersFileSelection(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
let settings = { ...DEFAULTS, sourceTab: preferFiles ? 'drive' : 'local', clientId: GOOGLE_CLIENT_ID, photoFitVersion: 1, driveUiVersion: 1 };
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE) || '{}');
  // Apply the new fill mode once to existing installations; later choices remain saved.
  settings = validateSettings({ ...DEFAULTS, ...saved, fit: saved.photoFitVersion === 1 ? (saved.fit || DEFAULTS.fit) : 'cover', clientId: GOOGLE_CLIENT_ID || saved.clientId || '', photoFitVersion: 1,
    start: boundedDate(saved.start, DATE_MIN), end: boundedDate(saved.end, DATE_MAX),
    sourceTab: preferFiles && saved.driveUiVersion !== 1 ? 'drive' : (saved.sourceTab || (preferFiles ? 'drive' : 'local')), driveUiVersion: 1,
    driveAlbums: Array.isArray(saved.driveAlbums) ? saved.driveAlbums.filter(name => DRIVE_ALBUMS.includes(name)) : [...DRIVE_ALBUMS] });
} catch { settings = { ...DEFAULTS, sourceTab: preferFiles ? 'drive' : 'local', clientId: GOOGLE_CLIENT_ID, photoFitVersion: 1, driveUiVersion: 1 }; }
let draftLayout = settings.layout;
let source = null, directory = null, importedFiles = null;
let importedFileFolder = null, pendingFileFolder = null;
let photos = [], videos = [], tiles = [], bag = new ShuffleBag([]);
let playing = false, epoch = 0, busy = false, sourceKind = '', sourceName = '';
let video = null, videoAudible = false, currentVideo = null, failedVideos = new Set(), badPhotos = new Set();
let toastTimer, hideTimer, bgmURL, preparedClient = '', scanController = null;
let videoRoom = null;
let drivePreparing = false, loadedDriveAlbums = [], resumeRoots = [];
let driveStreaming = false, driveAutoStartPending = false;
const drive = new DriveSource();
const clock = new RefreshClock(index => updateSlot(index));

function toast(message, duration = 6000) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration); }
function persist() { try { localStorage.setItem(STORAGE, JSON.stringify(settings)); } catch { toast('設定の保存が利用できません。この起動中はそのまま使えます。'); } }
function formError(message = '') { $('form-error').textContent = message; $('form-error').hidden = !message; }
function populate() {
  $('start-date').value = settings.start; $('end-date').value = settings.end;
  for (const bound of ['start', 'end']) { $(`${bound}-range`).max = DATE_DAYS; syncDateSlider(bound); }
  $('refresh').value = settings.refresh; $('effect').value = settings.effect; $('fit').value = settings.fit;
  $('youtube-enabled').checked = settings.youtube; $('youtube-sound').checked = settings.sound;
  $('volume').value = settings.volume; $('volume-output').value = `${settings.volume}%`;
  $('bgm-mode').value = settings.bgm; $('bgm-volume').value = settings.bgmVolume;
  $('drive-folder').value = settings.driveFolder; $('client-id').value = settings.clientId;
  $('file-folder-name').value = settings.localFileFolder;
  document.querySelectorAll('[data-drive-album]').forEach(input => { input.checked = settings.driveAlbums.includes(input.value); });
  chooseLayout(settings.layout); chooseTab(settings.sourceTab); $('bgm-fields').hidden = settings.bgm !== 'local';
}
function readSettings() {
  return validateSettings({ ...settings, start: $('start-date').value.trim() || DATE_MIN, end: $('end-date').value.trim() || DATE_MAX, layout: draftLayout,
    refresh: Number($('refresh').value), effect: $('effect').value, fit: $('fit').value,
    youtube: $('youtube-enabled').checked, sound: $('youtube-sound').checked, volume: Number($('volume').value),
    bgm: $('bgm-mode').value, bgmVolume: Number($('bgm-volume').value),
    driveFolder: $('drive-folder').value.trim(), clientId: $('client-id').value.trim(), localFileFolder: $('file-folder-name').value.trim() });
}
function displayDate(value) { return `${value.slice(0, 4)}年${Number(value.slice(4, 6))}月${Number(value.slice(6))}日`; }
function syncDateSlider(bound) {
  const value = $(`${bound}-date`).value.trim() || (bound === 'start' ? DATE_MIN : DATE_MAX);
  const valid = validDate(value) && value >= DATE_MIN && value <= DATE_MAX;
  $(`${bound}-date`).setAttribute('aria-invalid', String(!valid));
  $(`${bound}-date-label`).value = valid ? displayDate(value) : '日付を確認してください';
  if (!valid) return;
  $(`${bound}-range`).value = dateToDay(value);
  $(`${bound}-range`).setAttribute('aria-valuetext', displayDate(value));
}
function moveDateSlider(bound) {
  const value = dayToDate(Number($(`${bound}-range`).value));
  $(`${bound}-date`).value = value;
  const other = bound === 'start' ? 'end' : 'start';
  const otherValue = $(`${other}-date`).value.trim() || (other === 'start' ? DATE_MIN : DATE_MAX);
  // A single-day period is valid; dragging through the other handle moves it along.
  if (validDate(otherValue) && (bound === 'start' ? value > otherValue : value < otherValue)) $(`${other}-date`).value = value;
  syncDateSlider(bound); syncDateSlider(other); formError();
}
function chooseLayout(count) {
  draftLayout = count;
  document.querySelectorAll('[data-layout]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.layout) === count)));
  rhythmHint();
}
function rhythmHint() {
  const value = Number($('refresh').value) / draftLayout;
  $('rhythm-hint').textContent = Number.isFinite(value) && value > 0 ? `${Number(value.toFixed(3))}秒ごとに、1画面ずつ入れ替わります。` : '時間は4～3600秒で設定できます。';
}
function chooseTab(tab) {
  settings.sourceTab = tab === 'drive' ? 'drive' : 'local';
  document.querySelectorAll('[data-source]').forEach(button => { const selected = button.dataset.source === settings.sourceTab; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
  $('local-fields').hidden = settings.sourceTab !== 'local'; $('drive-fields').hidden = settings.sourceTab !== 'drive';
}
function setPane(open) {
  $('settings').hidden = !open; $('settings-toggle').setAttribute('aria-expanded', String(open));
  $('settings-toggle').classList.toggle('selected', open);
  document.body.classList.toggle('immersive', !open);
  $('scrim').hidden = !open || !matchMedia('(max-width:760px)').matches;
  if (open) { clearTimeout(hideTimer); document.body.classList.remove('toolbar-hidden'); }
  else { $('settings-toggle').focus({ preventScroll: true }); autoHide(); }
  requestAnimationFrame(resizeGrid);
}
function autoHide() {
  clearTimeout(hideTimer); document.body.classList.remove('toolbar-hidden');
  if (playing && $('settings').hidden && !document.querySelector('.toolbar :focus-visible')) hideTimer = setTimeout(() => document.body.classList.add('toolbar-hidden'), 3000);
}
function resizeGrid() {
  const rect = $('memory-grid').getBoundingClientRect();
  const [columns, rows] = gridShape(settings.layout, rect.height > rect.width);
  $('memory-grid').style.setProperty('--cols', columns); $('memory-grid').style.setProperty('--rows', rows);
  $('scrim').hidden = $('settings').hidden || !matchMedia('(max-width:760px)').matches;
  const hasVideo = settings.youtube && source?.videos.some(item => inRange(item, settings.start, settings.end));
  if (hasVideo && videoRoom !== null && videoRoom !== hasVideoRoom() && !busy) void rebuild();
}
function hasVideoRoom() {
  const rect = $('memory-grid').getBoundingClientRect();
  const [columns, rows] = gridShape(settings.layout, rect.height > rect.width);
  // YouTube embeds require a minimum 200×200 viewport. Reserve 32px for our caption.
  return (rect.width - (columns - 1) * 5) / columns >= 200 && (rect.height - (rows - 1) * 5) / rows >= 232;
}
function setBusy(value) {
  busy = value;
  for (const id of ['choose-folder', 'choose-files', 'find-drive-folder', 'connect-drive', 'reload-source', 'disconnect', 'demo', 'empty-choose', 'apply']) $(id).disabled = value || (['reload-source', 'disconnect'].includes(id) && !source);
  document.querySelectorAll('[data-drive-album]').forEach(input => { input.disabled = value; });
  updateDriveButton();
  $('play').disabled = (value && !driveStreaming) || !(photos.length || videos.length);
}
function progress(count) { $('source-name').textContent = `読み込み中… ${count}件確認`; }
function showReport(report) {
  $('scan-details').hidden = !report.skipped;
  $('scan-summary').textContent = `${report.skipped}件を対象外にしました`;
  $('scan-errors').replaceChildren(...report.messages.map(message => { const li = document.createElement('li'); li.textContent = message; return li; }));
}
function sourceLabel() { $('source-name').textContent = source ? sourceName : 'フォルダ未選択'; $('source-dot').classList.toggle('active', !!source); }
async function importSource(loader, kind, name, { progressive = false, autoStart = false } = {}) {
  if (busy) return;
  stop(); driveStreaming = progressive; driveAutoStartPending = autoStart; setBusy(true); formError();
  scanController = new AbortController();
  let published = false, previewReady = Promise.resolve();
  const adopt = result => {
    source = result; sourceKind = kind; sourceName = result.name || name;
    loadedDriveAlbums = kind === 'drive' ? (result.driveAlbums || []) : [];
    settings.lastSource = kind;
    if (kind === 'drive') rememberDrive(loadedDriveAlbums);
    else resumeRoots = [];
    persist(); sourceLabel();
  };
  const publish = result => {
    if (!published && !result.photos.some(item => inRange(item, settings.start, settings.end)) && !(settings.youtube && hasVideoRoom() && result.videos.some(item => inRange(item, settings.start, settings.end)))) return;
    if (!published) {
      published = true; adopt(result); previewReady = rebuild();
      if (driveAutoStartPending) start();
    } else appendDriveMedia();
  };
  try {
    const result = await loader(scanController.signal, publish);
    adopt(result);
    $('restore-folder')?.remove();
    if (kind !== 'drive') drive.disconnect();
    if (kind !== 'local') { directory = null; importedFiles = null; importedFileFolder = null; await storeHandle(null); }
    showReport(result.report); sourceLabel();
    if (!published) { await rebuild(); if (driveAutoStartPending) start(); }
    else { appendDriveMedia(); await previewReady; }
    toast(`${sourceName}\n写真${result.photos.length}枚・動画${result.videos.length}件を読み込みました。`);
    return result;
  } catch (error) {
    if (published) { appendDriveMedia(); showReport(source.report); }
    sourceLabel(); toast(error.message || '写真の読み込みに失敗しました。');
    if (kind === 'drive') driveStatus(error.message || '写真の読み込みに失敗しました。', true);
    return null;
  } finally { scanController = null; driveStreaming = false; driveAutoStartPending = false; setBusy(false); }
}
async function pickFolder() {
  if (busy) return;
  if (preferFiles) { chooseTab('drive'); $('drive-albums-connect').focus(); return; }
  if ('showDirectoryPicker' in window) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      await importSource(async () => { const result = await scanDirectory(handle, progress); directory = handle; importedFiles = null; importedFileFolder = null; await storeHandle(handle); return result; }, 'local', handle.name);
    } catch (error) { if (error.name !== 'AbortError') toast(error.message || 'フォルダの選択に失敗しました。'); }
  } else $('folder-input').click();
}
function pickFiles() {
  if (busy) return;
  $('file-selection').open = true;
  pendingFileFolder = datedFolder($('file-folder-name').value.trim());
  if (!pendingFileFolder) {
    toast('写真のフォルダ名を「20250815 （夏休み）」のように入力してください。');
    $('file-folder-name').focus(); return;
  }
  $('files-input').click();
}

function destroyTiles() {
  epoch++; video?.destroy(); video = null;
  for (const tile of tiles) { tile.controller?.abort(); tile.urls.forEach(url => URL.revokeObjectURL(url)); tile.urls.clear(); }
  tiles = []; $('memory-grid').replaceChildren(); updateFolderCaption();
}
function makeTile(isVideo = false) {
  const element = document.createElement('div'); element.className = `memory-tile${isVideo ? ' video-tile' : ''}`;
  const caption = document.createElement('p'); caption.className = 'caption'; caption.hidden = true;
  const label = document.createElement('span'); caption.append(label); element.append(caption);
  const tile = { element, label, item: null, pending: null, urls: new Set(), busy: false, isVideo, controller: null, revision: 0 };
  $('memory-grid').append(element); tiles.push(tile); return tile;
}
function updateFolderCaption() {
  const items = tiles.map(tile => tile.item).filter(Boolean);
  const shared = items.length > 0 && new Set(items.map(item => item.folder)).size === 1;
  $('folder-caption').textContent = shared ? items[0].folder : '';
  $('folder-caption').hidden = !shared;
}
function exclusions(tile) { return new Set([...tiles.filter(t => t !== tile).flatMap(t => [t.item?.id, t.pending?.id]), tile.item?.id, ...badPhotos].filter(Boolean)); }
async function replacePhoto(tile, generation = epoch) {
  if (tile.busy) return;
  tile.busy = true; tile.controller = new AbortController(); const revision = ++tile.revision;
  let loadedURL;
  try {
    for (let attempt = 0; attempt < Math.min(photos.length, 12); attempt++) {
      if (generation !== epoch || revision !== tile.revision) return;
      const candidates = photos.filter(item => !badPhotos.has(item.id));
      if (!candidates.length) break;
      const excluded = exclusions(tile);
      let item = bag.draw(excluded);
      if (!item || excluded.has(item.id)) {
        let available = candidates.filter(candidate => !excluded.has(candidate.id));
        if (!available.length) {
          const otherSlots = new Set(tiles.filter(other => other !== tile).flatMap(other => [other.item?.id, other.pending?.id]));
          available = candidates.filter(candidate => !otherSlots.has(candidate.id));
        }
        if (!available.length) available = candidates;
        item = available[Math.floor(Math.random() * available.length)];
      }
      tile.pending = item;
      try {
        loadedURL = await item.load(tile.controller.signal);
        const image = new Image(); image.alt = item.folder; image.src = loadedURL;
        let timeout;
        try { await Promise.race([image.decode(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('画像の読み込みがタイムアウトしました。')), 20000); })]); }
        finally { clearTimeout(timeout); }
        if (generation !== epoch || revision !== tile.revision) { URL.revokeObjectURL(loadedURL); loadedURL = null; return; }
        tile.urls.add(loadedURL);
        const old = tile.element.querySelector('img');
        const duration = !old || settings.effect === 'none' || matchMedia('(prefers-reduced-motion:reduce)').matches ? 0 : Math.min(.6, settings.refresh / settings.layout / 2);
        tile.element.classList.remove('smooth', 'fade', 'slide', 'none'); tile.element.classList.add(settings.effect);
        tile.element.style.setProperty('--duration', `${duration}s`); tile.element.style.setProperty('--fit', settings.fit);
        image.classList.add('entering'); tile.element.insertBefore(image, tile.element.querySelector('.caption')); tile.element.querySelector('.tile-error')?.remove();
        tile.item = item; tile.label.textContent = item.folder; updateFolderCaption(); old?.classList.add('leaving');
        // Force the initial opacity to commit before starting the transition.
        image.getBoundingClientRect(); image.classList.remove('entering');
        if (old) {
          const oldURL = old.src;
          setTimeout(() => { old.remove(); tile.urls.delete(oldURL); URL.revokeObjectURL(oldURL); }, duration * 1000 + 30);
        }
        loadedURL = null; return;
      } catch (error) {
        if (loadedURL) { URL.revokeObjectURL(loadedURL); loadedURL = null; }
        if (generation !== epoch || revision !== tile.revision || error.name === 'AbortError') return;
        if (['AUTH', 'NETWORK', 'SOURCE'].includes(error.code)) { stop(); if (sourceKind === 'drive' && error.code === 'AUTH') offerDriveResume(rememberedDriveRoots(), error.message); toast(error.message, 12000); return; }
        badPhotos.add(item.id);
        if (badPhotos.size === 1) toast('読み込めない写真をスキップしました。設定の再読み込みで再試行できます。');
      }
    }
    if (!tile.item) { const label = document.createElement('div'); label.className = 'tile-error'; label.textContent = '表示できる写真がありません'; tile.element.append(label); }
  } finally {
    if (revision === tile.revision) { tile.busy = false; tile.pending = null; }
  }
}
async function mountVideo(tile, generation, item) {
  currentVideo = item; tile.item = item; tile.label.textContent = item.folder; updateFolderCaption();
  const host = document.createElement('div'); host.className = 'video-host'; tile.element.prepend(host);
  const resume = document.createElement('button'); resume.className = 'video-resume'; resume.textContent = 'タップして動画を再生'; resume.hidden = true; tile.element.append(resume);
  const player = new VideoPlayer({
    onError: () => {
      if (generation !== epoch || video !== player) return;
      failedVideos.add(item.id); toast('再生できない動画をスキップしました。');
      changeVideo(true);
    },
    onBlocked: () => { if (generation === epoch) { resume.hidden = false; toast('動画の音声再生には、動画内の再生ボタンを押してください。'); } },
    onAudible: audible => { if (generation === epoch) { videoAudible = audible; syncBGM(); } }
  });
  video = player;
  resume.addEventListener('click', () => { start(); player.play(); resume.hidden = true; });
  player.running = playing;
  try { await player.mount(host, item, settings); }
  catch (error) { if (generation === epoch && video === player) { failedVideos.add(item.id); toast(error.message); changeVideo(true); } }
}
async function changeVideo(failure = false) {
  const tile = tiles.find(t => t.isVideo); if (!tile) return;
  const available = videos.filter(item => !failedVideos.has(item.id) && (failure || item.id !== currentVideo?.id));
  if (!available.length && !failure && videos.length === 1) { video?.seek(); return; }
  video?.destroy(); video = null;
  tile.element.querySelectorAll('iframe,.video-host,.video-resume').forEach(element => element.remove());
  if (available.length) await mountVideo(tile, epoch, available[Math.floor(Math.random() * available.length)]);
  else {
    tile.isVideo = false; tile.element.classList.remove('video-tile'); tile.item = null; tile.label.textContent = ''; currentVideo = null; updateFolderCaption();
    $('next-video').hidden = true; syncBGM();
    if (photos.length) await replacePhoto(tile);
    else { stop(); toast('再生できる動画がありません。別のフォルダを選択してください。'); const text = document.createElement('div'); text.className = 'tile-error'; text.textContent = 'この動画は再生できません'; tile.element.append(text); }
  }
}
async function rebuild() {
  clock.stop(); destroyTiles(); failedVideos = new Set(); badPhotos = new Set();
  const generation = epoch;
  photos = (source?.photos || []).filter(item => inRange(item, settings.start, settings.end));
  const eligibleVideos = settings.youtube ? (source?.videos || []).filter(item => inRange(item, settings.start, settings.end)) : [];
  videoRoom = hasVideoRoom();
  videos = videoRoom ? eligibleVideos : [];
  if (eligibleVideos.length && !videoRoom) toast('動画の表示には200×200以上の領域が必要です。分割数を減らすか設定ペインを閉じてください。', 10000);
  bag = new ShuffleBag(photos);
  const hasMedia = !!(photos.length || videos.length);
  $('empty-state').hidden = hasMedia;
  $('empty-message').textContent = source ? 'この期間に表示できる写真・動画がありません。\n期間やフォルダを変更してください。' : '写真フォルダを選んで、Playを押すだけ。\nあの日の景色が、ゆっくり巡ります。';
  if (!hasMedia && eligibleVideos.length && !videoRoom) $('empty-message').textContent = '動画を表示する領域が小さすぎます。\n分割数を減らすか、設定ペインを閉じてください。';
  $('viewer-title').textContent = source ? sourceName : 'あなたの思い出を、ここに。';
  $('viewer-count').textContent = source ? `${photos.length} PHOTOS / ${videos.length} VIDEOS` : 'READY WHEN YOU ARE';
  $('timing-label').textContent = `${settings.layout}画面 · ${settings.refresh}秒で一巡`;
  $('next-video').hidden = !videos.length;
  $('play').disabled = !hasMedia || (busy && !driveStreaming);
  if (!hasMedia) { stop(); return; }
  const firstVideo = videos.length ? videos[Math.floor(Math.random() * videos.length)] : null;
  const jobs = [];
  for (let i = 0; i < settings.layout; i++) {
    const isVideo = !!firstVideo && i === settings.layout - 1;
    const tile = makeTile(isVideo);
    if (isVideo) jobs.push(mountVideo(tile, generation, firstVideo));
    else if (photos.length) jobs.push(replacePhoto(tile, generation));
    else { const label = document.createElement('div'); label.className = 'tile-error'; label.textContent = '写真はありません'; tile.element.append(label); }
  }
  resizeGrid(); syncBGM();
  // Loading an external video API must not delay the photo slideshow.
  if (playing) clock.start(settings.refresh, settings.layout);
  await Promise.allSettled(jobs);
}
function appendDriveMedia() {
  photos = source.photos.filter(item => inRange(item, settings.start, settings.end));
  videos = settings.youtube && hasVideoRoom() ? source.videos.filter(item => inRange(item, settings.start, settings.end)) : [];
  bag = new ShuffleBag(photos);
  sourceName = source.name || sourceName;
  $('viewer-title').textContent = sourceName;
  $('viewer-count').textContent = `${photos.length} PHOTOS / ${videos.length} VIDEOS`;
  $('next-video').hidden = !videos.length;
  $('play').disabled = !(photos.length || videos.length);
  if (!photos.length && !videos.length) { void rebuild(); return; }
  if (!tiles.length) return;
  if (videos.length && !tiles.some(tile => tile.isVideo)) {
    const tile = tiles.at(-1);
    tile.revision++; tile.controller?.abort(); tile.busy = false; tile.pending = null;
    tile.urls.forEach(url => URL.revokeObjectURL(url)); tile.urls.clear();
    tile.element.querySelectorAll('img,.tile-error').forEach(element => element.remove());
    tile.isVideo = true; tile.element.classList.add('video-tile');
    void mountVideo(tile, epoch, videos[0]);
  }
  for (const tile of tiles) if (!tile.isVideo && !tile.item && !tile.busy && photos.length) void replacePhoto(tile);
  if (driveAutoStartPending && (photos.length || videos.length)) start();
}
function updateSlot(index) {
  if (!playing || document.hidden) return;
  const tile = tiles[index]; if (!tile) return;
  if (tile.isVideo) video?.seek(); else if (photos.length) void replacePhoto(tile);
}
function showPlayback() {
  $('play-state').textContent = playing ? '再生中' : '停止中'; $('play-dot').classList.toggle('active', playing);
  $('play').setAttribute('aria-pressed', String(playing));
  $('play').title = playing ? '再生中' : '再生';
}
function start() {
  if ((busy && !driveStreaming) || !(photos.length || videos.length)) return;
  driveAutoStartPending = false;
  const wasPlaying = playing; playing = true;
  if (!wasPlaying) clock.start(settings.refresh, settings.layout);
  video?.play(); syncBGM(); showPlayback(); autoHide();
}
function stop() {
  driveAutoStartPending = false;
  playing = false; clock.stop(); video?.pause(); $('bgm').pause(); videoAudible = false;
  for (const tile of tiles) { if (tile.busy) { tile.revision++; tile.controller?.abort(); tile.busy = false; tile.pending = null; } }
  clearTimeout(hideTimer); document.body.classList.remove('toolbar-hidden'); showPlayback();
}
function syncBGM() {
  const audio = $('bgm'); audio.volume = settings.bgmVolume / 100;
  const videoSoundEnabled = !!video && settings.sound && settings.volume > 0;
  if (playing && !document.hidden && settings.bgm === 'local' && bgmURL && !videoAudible && !videoSoundEnabled) {
    if (audio.paused) audio.play().catch(() => toast('BGMの再生がブロックされました。Playを押して再試行してください。'));
  } else audio.pause();
}

$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  try {
    const next = readSettings(); formError(); settings = next;
    if (sourceKind === 'drive' && settings.driveAutoResume) rememberDrive(loadedDriveAlbums);
    persist();
    $('start-date').value = settings.start; $('end-date').value = settings.end;
    syncDateSlider('start'); syncDateSlider('end');
    if (settings.bgm === 'local' && !bgmURL) toast('BGM用の音楽ファイルを選択してください。');
    await rebuild(); toast('設定を適用しました。');
  } catch (error) { formError(error.message); }
});
document.querySelectorAll('[data-layout]').forEach(button => button.addEventListener('click', () => chooseLayout(Number(button.dataset.layout))));
document.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', () => chooseTab(button.dataset.source)));
$('refresh').addEventListener('input', rhythmHint);
for (const bound of ['start', 'end']) {
  $(`${bound}-range`).addEventListener('input', () => moveDateSlider(bound));
  $(`${bound}-date`).addEventListener('input', () => syncDateSlider(bound));
}
$('all-dates').addEventListener('click', () => {
  $('start-date').value = DATE_MIN; $('end-date').value = DATE_MAX;
  syncDateSlider('start'); syncDateSlider('end'); formError();
});
$('volume').addEventListener('input', () => { $('volume-output').value = `${$('volume').value}%`; });
$('bgm-mode').addEventListener('change', () => { $('bgm-fields').hidden = $('bgm-mode').value !== 'local'; });
$('bgm-file').addEventListener('change', () => {
  const file = $('bgm-file').files[0]; if (!file) return;
  $('bgm').pause(); if (bgmURL) URL.revokeObjectURL(bgmURL);
  bgmURL = URL.createObjectURL(file); $('bgm').src = bgmURL; $('bgm-name').textContent = file.name;
});
$('bgm').addEventListener('error', () => toast('音楽ファイルを再生できません。MP3またはAACをお試しください。'));
$('choose-folder').addEventListener('click', pickFolder);
$('choose-files').addEventListener('click', pickFiles);
$('files-input').addEventListener('change', async () => {
  const files = [...$('files-input').files]; if (!files.length) return;
  const folder = pendingFileFolder || datedFolder($('file-folder-name').value.trim());
  if (!folder) { toast('日付付きフォルダ名を入力してから写真を選択してください。'); $('files-input').value = ''; return; }
  await importSource(async () => {
    const result = await scanFiles(files, progress, folder);
    importedFiles = files; importedFileFolder = folder; directory = null;
    await storeHandle(null); return result;
  }, 'local', folder.folder);
  settings.localFileFolder = folder.folder; persist();
  pendingFileFolder = null; $('files-input').value = '';
});
$('empty-choose').addEventListener('click', () => { if (resumeRoots.length) { void loadDriveAlbums(resumeRoots); return; } setPane(true); settings.sourceTab === 'drive' ? $('drive-albums-connect').focus() : pickFolder(); });
$('folder-input').addEventListener('change', async () => {
  const files = [...$('folder-input').files]; if (!files.length) return;
  const name = files[0].webkitRelativePath.split('/')[0] || '選択した写真';
  await importSource(async () => { const result = await scanFiles(files, progress); importedFiles = files; importedFileFolder = null; directory = null; await storeHandle(null); return result; }, 'local', name);
  $('folder-input').value = '';
});
async function prepareDrive() {
  const clientId = $('client-id').value.trim(); if (!clientId || (clientId === preparedClient && drive.client)) return;
  drivePreparing = true; updateDriveButton();
  try {
    await drive.prepare(clientId); preparedClient = clientId;
    $('connect-drive').textContent = 'Googleに接続して読み込む ↗';
    if (!busy && !source) driveStatus(resumeRoots.length ? '前回のアルバムを記憶しています。再接続すると自動再生します。' : 'アルバムを選び、「Googleに接続して写真を表示」を押してください。');
  } finally { drivePreparing = false; updateDriveButton(); }
}
function driveStatus(message, error = false) {
  $('drive-status').textContent = message;
  $('drive-status').classList.toggle('form-error', error);
  $('drive-status').hidden = false;
}
function updateDriveButton() {
  const configured = !!$('client-id').value.trim();
  $('drive-albums-connect').disabled = busy || drivePreparing || !configured || (!resumeRoots.length && !settings.driveAlbums.length);
  $('drive-albums-connect').textContent = drivePreparing ? 'Google接続を準備中…' : resumeRoots.length ? '前回のアルバムに再接続して再生' : 'Googleに接続して写真を表示';
}
function driveReady() {
  if (!$('client-id').value.trim()) { driveStatus('Google接続は管理者の初期設定待ちです。アルバムの選択は保存されています。接続設定が完了すると、このボタンから利用できます。', true); return false; }
  if (drivePreparing) return false;
  if (preparedClient !== $('client-id').value.trim() || !drive.client) {
    prepareDrive().then(() => driveStatus('準備できました。「Googleに接続して写真を表示」を押してください。')).catch(error => driveStatus(error.message, true)); return false;
  }
  return true;
}
function rememberDrive(roots) {
  if (!roots.length) return;
  settings.driveResolvedAlbums = roots.map(({id,name}) => ({id,name}));
  const preview = (source?.photos || []).filter(item => inRange(item, settings.start, settings.end)).slice(0,16).map(({id,name,folder,date}) => ({id,name,folder,date}));
  settings.driveResume = {roots:settings.driveResolvedAlbums,clientId:$('client-id').value.trim(),preview};
  settings.lastSource = 'drive'; settings.driveAutoResume = true; resumeRoots = [];
  $('empty-choose').textContent = '写真フォルダを選ぶ →';
}
function rememberedDriveRoots() {
  if (settings.driveAutoResume === false) return [];
  if (settings.lastSource && settings.lastSource !== 'drive') return [];
  if (settings.driveResume && settings.driveResume.clientId !== settings.clientId) return [];
  const roots = settings.driveResume?.roots || settings.driveResolvedAlbums || (settings.sourceTab === 'drive' && settings.driveFolder ? [{id:settings.driveFolder,name:'前回のアルバム'}] : []);
  if (!Array.isArray(roots)) return [];
  return roots.flatMap(root => { try { return [{id:driveFolderId(root.id),name:String(root.name || '前回のアルバム')}]; } catch { return []; } });
}
function offerDriveResume(roots, message = '前回のアルバムを記憶しています。Googleに再接続すると自動再生します。') {
  resumeRoots = roots; if (!roots.length) return;
  chooseTab('drive'); setPane(true); updateDriveButton(); driveStatus(message);
  if (!source) {
    $('empty-message').textContent = `${roots.map(root => root.name).join(' / ')}\nGoogleに再接続して、思い出の続きを。`;
    $('empty-choose').textContent = 'Googleに再接続して再生';
    $('source-name').textContent = roots.map(root => root.name).join(' / ');
  }
}
async function loadDriveAlbums(roots, { automatic = false } = {}) {
  if (busy) return;
  const authorized = drive.hasAuthorization();
  if (!authorized && (automatic || !driveReady())) { offerDriveResume(roots); return; }
  roots = roots.map(root => ({...root}));
  // Open Google directly from the user gesture when reconnecting an expired token.
  const authorization = authorized ? Promise.resolve() : drive.authorize();
  const result = await importSource(async (signal, publish) => {
    await authorization;
    const merged = { photos: [], videos: [], report: { skipped: 0, messages: [] }, name: roots.map(root => root.name).join(' / '), driveAlbums: roots };
    // Only IDs/names/dates are remembered. Every photo is still fetched online with no-store.
    const remembered = settings.driveResume;
    const sameRoots = remembered?.clientId === $('client-id').value.trim() && JSON.stringify(remembered.roots?.map(root => root.id)) === JSON.stringify(roots.map(root => root.id));
    if (settings.driveAutoResume !== false && sameRoots) merged.photos = drive.restorePhotos(remembered.preview);
    const photoIds = new Set(merged.photos.map(item => item.id)), videoIds = new Set(), discoveredIds = new Set(), discovered = [];
    publish(merged);
    for (const root of roots) {
      driveStatus(`${root.name} の写真を読み込んでいます…`);
      const album = await drive.scan(root.id, progress, signal, batch => {
        if (batch.name) root.name = batch.name;
        merged.name = roots.map(root => root.name).join(' / ');
        for (const item of batch.photos) {
          if (!discoveredIds.has(item.id)) { discoveredIds.add(item.id); discovered.push(item); }
          if (!photoIds.has(item.id)) { photoIds.add(item.id); merged.photos.push(item); }
        }
        for (const item of batch.videos) if (!videoIds.has(item.id)) { videoIds.add(item.id); merged.videos.push(item); }
        publish(merged);
      });
      merged.report.skipped += album.report.skipped; merged.report.messages.push(...album.report.messages);
    }
    // Remove stale saved candidates once the current folder listing is complete.
    merged.photos = discovered;
    merged.report.messages = merged.report.messages.slice(0, 50);
    return merged;
  }, 'drive', roots.map(root => root.name).join(' / '), {progressive:true,autoStart:true});
  if (result) {
    settings.clientId = $('client-id').value.trim(); persist();
    $('drive-folder-results').hidden = true;
    driveStatus(`一覧の読み込み完了：写真${result.photos.length}枚・動画${result.videos.length}件。${playing ? '再生中です。' : '停止中です。'}`);
  }
  else if (automatic || !drive.hasAuthorization()) offerDriveResume(roots, $('drive-status').textContent || 'Googleに再接続してください。');
  return result;
}
function showAlbumMatches(groups) {
  const results = $('drive-folder-results'); results.replaceChildren();
  const selects = groups.map((group, index) => {
    const label = document.createElement('label'); label.textContent = group.name;
    const select = document.createElement('select'); select.id = `album-match-${index}`; label.htmlFor = select.id;
    if (group.matches.length > 1) select.add(new Option('同名のフォルダから選んでください', ''));
    for (const folder of group.matches) select.add(new Option(`${folder.name}（ID：${folder.id}）`, folder.id));
    results.append(label, select); return select;
  });
  const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'folder-button'; confirm.textContent = '選んだフォルダの写真を表示';
  confirm.addEventListener('click', () => {
    const roots = groups.map((group, index) => group.matches.find(folder => folder.id === selects[index].value));
    if (roots.some(root => !root)) { driveStatus('同名のフォルダを選択してください。', true); return; }
    void loadDriveAlbums(roots);
  });
  results.append(confirm); results.hidden = false;
  driveStatus('同じ名前のフォルダが複数あります。読み込むフォルダを選択してください。');
}
document.querySelectorAll('[data-drive-album]').forEach(input => input.addEventListener('change', () => {
  resumeRoots = []; delete settings.driveResume; delete settings.driveResolvedAlbums; settings.driveAutoResume = false;
  settings.driveAlbums = [...document.querySelectorAll('[data-drive-album]:checked')].map(input => input.value);
  persist(); $('drive-folder-results').hidden = true; updateDriveButton();
  if (!settings.driveAlbums.length) driveStatus('表示するアルバムを1つ以上選んでください。');
}));
$('drive-albums-connect').addEventListener('click', async () => {
  if (resumeRoots.length) { await loadDriveAlbums(resumeRoots); return; }
  if (busy || !driveReady() || !settings.driveAlbums.length) return;
  const authorization = drive.token && Date.now() < drive.expires ? Promise.resolve() : drive.authorize();
  setBusy(true); $('drive-folder-results').hidden = true; driveStatus('Googleに接続し、選んだアルバムを探しています…');
  try {
    await authorization;
    const groups = await Promise.all(settings.driveAlbums.map(async name => ({ name, matches: await drive.findFolders(name, undefined, true) })));
    const missing = groups.filter(group => !group.matches.length);
    if (missing.length) throw new Error(`見つからないアルバム：${missing.map(group => group.name).join('、')}。Googleで選んだアカウントと、マイドライブ内のフォルダ名をご確認ください。`);
    setBusy(false);
    if (groups.some(group => group.matches.length > 1)) showAlbumMatches(groups);
    else await loadDriveAlbums(groups.map(group => group.matches[0]));
  } catch (error) { driveStatus(error.message, true); }
  finally { setBusy(false); }
});
$('client-id').addEventListener('change', () => { preparedClient = ''; updateDriveButton(); prepareDrive().catch(error => driveStatus(error.message, true)); });
$('find-drive-folder').addEventListener('click', async () => {
  if (busy) return;
  const results = $('drive-folder-results');
  try {
    if (!$('client-id').value.trim()) {
      $('drive-setup').open = true; $('client-id').focus();
      driveStatus('Google接続の初期設定がまだ完了していないため、検索を実行できません。アプリ管理者が接続設定を準備しています。', true); return;
    }
    if (preparedClient !== $('client-id').value.trim() || !drive.client) {
      driveStatus('Google接続を準備しています…');
      await prepareDrive(); driveStatus('Google接続の準備ができました。もう一度「親フォルダを探す」を押してGoogleの認証画面を開いてください。'); return;
    }
    const authorization = drive.token && Date.now() < drive.expires ? Promise.resolve() : drive.authorize();
    setBusy(true); results.hidden = true; results.replaceChildren();
    driveStatus('Googleへの接続・フォルダ検索を実行しています…');
    await authorization;
    const folders = await drive.findFolders($('drive-search-name').value);
    for (const folder of folders) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'folder-button';
      button.textContent = `${folder.name} を選択`; button.title = `フォルダID：${folder.id}`;
      button.addEventListener('click', async () => {
        if (busy) return;
        $('drive-folder').value = folder.id;
        const result = await loadDriveAlbums([folder]);
        if (result) {
          settings.driveFolder = folder.id; settings.clientId = $('client-id').value.trim(); persist(); results.hidden = true;
        }
      });
      results.append(button);
    }
    if (!folders.length) { const message = document.createElement('p'); message.className = 'hint'; message.textContent = '該当するフォルダがありません。名前の先頭部分（例：B.01）で検索してください。'; results.append(message); }
    results.hidden = false;
    driveStatus(folders.length ? `${folders.length}件の親フォルダが見つかりました。下から選択してください。` : 'フォルダが見つかりません。名前の先頭部分（B.01など）で再検索してください。');
    settings.clientId = $('client-id').value.trim(); persist();
  } catch (error) { $('drive-setup').open = true; driveStatus(error.message, true); toast(error.message); }
  finally { setBusy(false); }
});
$('connect-drive').addEventListener('click', async () => {
  if (busy) return;
  try {
    const folderValue = $('drive-folder').value.trim(); driveFolderId(folderValue);
    if (preparedClient !== $('client-id').value.trim() || !drive.client) {
      await prepareDrive(); toast('接続の準備ができました。もう一度「Googleに接続」を押してください。'); return;
    }
    const result = await loadDriveAlbums([{id:driveFolderId(folderValue),name:'選択したアルバム'}]);
    if (result) { settings.driveFolder = folderValue; settings.clientId = $('client-id').value.trim(); persist(); }
  } catch (error) { $('drive-setup').open = true; toast(error.message); }
});
$('reload-source').addEventListener('click', async () => {
  if (sourceKind === 'drive' && loadedDriveAlbums.length) { await loadDriveAlbums(loadedDriveAlbums); return; }
  if (sourceKind === 'drive') { $('connect-drive').click(); return; }
  if (sourceKind === 'demo') { await importSource(async () => demoSource(), 'demo', 'サンプル'); return; }
  if (directory) {
    try { const permission = await directory.requestPermission({ mode: 'read' }); if (permission !== 'granted') throw new Error('フォルダの読み取りを許可してください。'); await importSource(() => scanDirectory(directory, progress), 'local', directory.name); } catch (error) { toast(error.message); }
  } else if (importedFiles) { await importSource(() => scanFiles(importedFiles, progress, importedFileFolder), 'local', sourceName); }
});
$('disconnect').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  stop(); drive.disconnect(); preparedClient = ''; source = null; sourceKind = ''; directory = null; importedFiles = null; sourceName = '';
  importedFileFolder = null; pendingFileFolder = null;
  loadedDriveAlbums = [];
  resumeRoots = []; delete settings.driveResume; delete settings.driveResolvedAlbums; settings.driveFolder = ''; settings.lastSource = ''; settings.driveAutoResume = false; persist();
  $('drive-folder').value = ''; $('empty-choose').textContent = '写真フォルダを選ぶ →';
  $('restore-folder')?.remove();
  await storeHandle(null); sourceLabel(); showReport({ skipped: 0, messages: [] }); await rebuild(); setBusy(false); toast('接続を解除しました。');
});
$('demo').addEventListener('click', () => importSource(async () => demoSource(), 'demo', 'サンプル'));
$('play').addEventListener('click', start); $('stop').addEventListener('click', stop);
$('next-video').addEventListener('click', () => changeVideo());
$('settings-toggle').addEventListener('click', () => setPane($('settings').hidden));
$('settings-close').addEventListener('click', () => setPane(false)); $('scrim').addEventListener('click', () => setPane(false));
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else { setPane(false); if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); else toast('この端末ではブラウザ内で最大表示します。'); }
  } catch { toast('全画面に切り替えられないため、ブラウザ内で最大表示します。'); }
});
document.addEventListener('fullscreenchange', () => { $('fullscreen').setAttribute('aria-label', document.fullscreenElement ? '全画面を終了' : '全画面'); resizeGrid(); });
document.addEventListener('pointermove', autoHide, { passive: true }); document.addEventListener('pointerdown', autoHide, { passive: true });
$('toolbar').addEventListener('focusin', () => { clearTimeout(hideTimer); document.body.classList.remove('toolbar-hidden'); });
$('toolbar').addEventListener('focusout', () => setTimeout(autoHide, 0));
document.addEventListener('keydown', event => {
  clearTimeout(hideTimer); document.body.classList.remove('toolbar-hidden');
  if (event.key === 'Escape' && !$('settings').hidden) setPane(false);
  if (event.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(event.target.tagName)) { event.preventDefault(); playing ? stop() : start(); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clock.stop(); video?.pause(); $('bgm').pause(); }
  else if (playing) { clock.start(settings.refresh, settings.layout); video?.play(); syncBGM(); }
});
window.addEventListener('pagehide', () => { stop(); scanController?.abort(); });
new ResizeObserver(resizeGrid).observe($('viewer'));
populate(); persist(); showPlayback(); resizeGrid();
if (preferFiles) {
  $('folder-button-label').textContent = 'Google Driveの親フォルダを選択';
  $('local-picker-hint').textContent = 'iPad・iPhoneではGoogle Driveを選び、登録済みのアルバムにチェックを入れて接続してください。下の写真選択は1フォルダだけの補助機能です。';
}
updateDriveButton();
if (settings.clientId) {
  const roots = rememberedDriveRoots();
  const authorized = drive.restoreSession(settings.clientId);
  if (roots.length) {
    if (authorized) { setPane(false); void loadDriveAlbums(roots, {automatic:true}); }
    else offerDriveResume(roots);
  }
  prepareDrive().catch(error => driveStatus(error.message, true));
}
else driveStatus('Google接続は管理者の初期設定待ちです。2つのアルバムは登録済みです。接続設定が完了すると、このボタンから利用できます。', true);
restoreHandle().then(handle => {
  if (!source && !busy && handle) {
    directory = handle;
    const restore = document.createElement('button'); restore.id = 'restore-folder'; restore.type = 'button'; restore.className = 'folder-button'; restore.style.marginTop = '8px'; restore.textContent = `${handle.name} を再接続`;
    restore.addEventListener('click', async () => {
      if (busy) return;
      try { const permission = await handle.requestPermission({ mode: 'read' }); if (permission !== 'granted') throw new Error('読み取り権限を許可してください。'); await importSource(() => scanDirectory(handle, progress), 'local', handle.name); restore.remove(); }
      catch (error) { toast(error.message); }
    });
    $('local-fields').append(restore);
  }
});
