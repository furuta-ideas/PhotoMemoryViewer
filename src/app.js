import { DEFAULTS, validateSettings, inRange, gridShape, ShuffleBag, RefreshClock, driveFolderId } from './core.js';
import { scanFiles, scanDirectory, storeHandle, restoreHandle, DriveSource, demoSource } from './sources.js';
import { VideoPlayer } from './youtube.js';

const $ = id => document.getElementById(id);
const STORAGE = 'photo-memory-viewer.settings.v1';
let settings = { ...DEFAULTS };
try { settings = validateSettings({ ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE) || '{}') }); } catch { settings = { ...DEFAULTS }; }
let draftLayout = settings.layout;
let source = null, directory = null, importedFiles = null;
let photos = [], videos = [], tiles = [], bag = new ShuffleBag([]);
let playing = false, epoch = 0, busy = false, sourceKind = '', sourceName = '';
let video = null, videoAudible = false, currentVideo = null, failedVideos = new Set(), badPhotos = new Set();
let toastTimer, hideTimer, bgmURL, preparedClient = '', scanController = null;
let videoRoom = null;
const drive = new DriveSource();
const clock = new RefreshClock(index => updateSlot(index));

function toast(message, duration = 6000) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration); }
function persist() { try { localStorage.setItem(STORAGE, JSON.stringify(settings)); } catch { toast('設定の保存が利用できません。この起動中はそのまま使えます。'); } }
function formError(message = '') { $('form-error').textContent = message; $('form-error').hidden = !message; }
function populate() {
  $('start-date').value = settings.start; $('end-date').value = settings.end;
  $('refresh').value = settings.refresh; $('effect').value = settings.effect; $('fit').value = settings.fit;
  $('youtube-enabled').checked = settings.youtube; $('youtube-sound').checked = settings.sound;
  $('volume').value = settings.volume; $('volume-output').value = `${settings.volume}%`;
  $('bgm-mode').value = settings.bgm; $('bgm-volume').value = settings.bgmVolume;
  $('drive-folder').value = settings.driveFolder; $('client-id').value = settings.clientId;
  chooseLayout(settings.layout); chooseTab(settings.sourceTab); $('bgm-fields').hidden = settings.bgm !== 'local';
}
function readSettings() {
  return validateSettings({ ...settings, start: $('start-date').value.trim(), end: $('end-date').value.trim(), layout: draftLayout,
    refresh: Number($('refresh').value), effect: $('effect').value, fit: $('fit').value,
    youtube: $('youtube-enabled').checked, sound: $('youtube-sound').checked, volume: Number($('volume').value),
    bgm: $('bgm-mode').value, bgmVolume: Number($('bgm-volume').value),
    driveFolder: $('drive-folder').value.trim(), clientId: $('client-id').value.trim() });
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
  for (const id of ['choose-folder', 'connect-drive', 'reload-source', 'disconnect', 'demo', 'empty-choose', 'apply']) $(id).disabled = value || (['reload-source', 'disconnect'].includes(id) && !source);
  $('play').disabled = value || !(photos.length || videos.length);
}
function progress(count) { $('source-name').textContent = `読み込み中… ${count}件確認`; }
function showReport(report) {
  $('scan-details').hidden = !report.skipped;
  $('scan-summary').textContent = `${report.skipped}件を対象外にしました`;
  $('scan-errors').replaceChildren(...report.messages.map(message => { const li = document.createElement('li'); li.textContent = message; return li; }));
}
function sourceLabel() { $('source-name').textContent = source ? sourceName : 'フォルダ未選択'; $('source-dot').classList.toggle('active', !!source); }
async function importSource(loader, kind, name) {
  if (busy) return;
  stop(); setBusy(true); formError();
  scanController = new AbortController();
  try {
    const result = await loader(scanController.signal);
    source = result; sourceKind = kind; sourceName = result.name || name;
    $('restore-folder')?.remove();
    if (kind !== 'drive') drive.disconnect();
    if (kind !== 'local') { directory = null; importedFiles = null; await storeHandle(null); }
    showReport(result.report); sourceLabel();
    await rebuild();
    toast(`${sourceName}\n写真${result.photos.length}枚・動画${result.videos.length}件を読み込みました。`);
  } catch (error) {
    sourceLabel(); toast(error.message || '写真の読み込みに失敗しました。');
  } finally { scanController = null; setBusy(false); }
}
async function pickFolder() {
  if (busy) return;
  if ('showDirectoryPicker' in window) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      await importSource(async () => { const result = await scanDirectory(handle, progress); directory = handle; importedFiles = null; await storeHandle(handle); return result; }, 'local', handle.name);
    } catch (error) { if (error.name !== 'AbortError') toast(error.message || 'フォルダの選択に失敗しました。'); }
  } else $('folder-input').click();
}

function destroyTiles() {
  epoch++; video?.destroy(); video = null;
  for (const tile of tiles) { tile.controller?.abort(); tile.urls.forEach(url => URL.revokeObjectURL(url)); tile.urls.clear(); }
  tiles = []; $('memory-grid').replaceChildren();
}
function makeTile(isVideo = false) {
  const element = document.createElement('div'); element.className = `memory-tile${isVideo ? ' video-tile' : ''}`;
  const caption = document.createElement('p'); caption.className = 'caption';
  const label = document.createElement('span'); caption.append(label); element.append(caption);
  const tile = { element, label, item: null, pending: null, urls: new Set(), busy: false, isVideo, controller: null, revision: 0 };
  $('memory-grid').append(element); tiles.push(tile); return tile;
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
        tile.item = item; tile.label.textContent = item.folder; old?.classList.add('leaving');
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
        if (['AUTH', 'NETWORK', 'SOURCE'].includes(error.code)) { stop(); toast(error.message, 12000); return; }
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
  currentVideo = item; tile.item = item; tile.label.textContent = item.folder;
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
    tile.isVideo = false; tile.element.classList.remove('video-tile'); tile.item = null; tile.label.textContent = ''; currentVideo = null;
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
  $('play').disabled = !hasMedia || busy;
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
  if (busy || !(photos.length || videos.length)) return;
  const wasPlaying = playing; playing = true;
  if (!wasPlaying) clock.start(settings.refresh, settings.layout);
  video?.play(); syncBGM(); showPlayback(); autoHide();
}
function stop() {
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
    const next = readSettings(); formError(); settings = next; persist();
    if (settings.bgm === 'local' && !bgmURL) toast('BGM用の音楽ファイルを選択してください。');
    await rebuild(); toast('設定を適用しました。');
  } catch (error) { formError(error.message); }
});
document.querySelectorAll('[data-layout]').forEach(button => button.addEventListener('click', () => chooseLayout(Number(button.dataset.layout))));
document.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', () => chooseTab(button.dataset.source)));
$('refresh').addEventListener('input', rhythmHint);
$('volume').addEventListener('input', () => { $('volume-output').value = `${$('volume').value}%`; });
$('bgm-mode').addEventListener('change', () => { $('bgm-fields').hidden = $('bgm-mode').value !== 'local'; });
$('bgm-file').addEventListener('change', () => {
  const file = $('bgm-file').files[0]; if (!file) return;
  $('bgm').pause(); if (bgmURL) URL.revokeObjectURL(bgmURL);
  bgmURL = URL.createObjectURL(file); $('bgm').src = bgmURL; $('bgm-name').textContent = file.name;
});
$('bgm').addEventListener('error', () => toast('音楽ファイルを再生できません。MP3またはAACをお試しください。'));
$('choose-folder').addEventListener('click', pickFolder);
$('empty-choose').addEventListener('click', () => { setPane(true); settings.sourceTab === 'drive' ? $('drive-folder').focus() : pickFolder(); });
$('folder-input').addEventListener('change', async () => {
  const files = [...$('folder-input').files]; if (!files.length) return;
  const name = files[0].webkitRelativePath.split('/')[0] || '選択した写真';
  await importSource(async () => { const result = await scanFiles(files, progress); importedFiles = files; directory = null; await storeHandle(null); return result; }, 'local', name);
  $('folder-input').value = '';
});
async function prepareDrive() {
  const clientId = $('client-id').value.trim(); if (!clientId || (clientId === preparedClient && drive.client)) return;
  await drive.prepare(clientId); preparedClient = clientId;
  $('connect-drive').textContent = 'Googleに接続して読み込む ↗';
}
$('client-id').addEventListener('change', () => { preparedClient = ''; prepareDrive().catch(error => toast(error.message)); });
$('connect-drive').addEventListener('click', async () => {
  if (busy) return;
  try {
    const folderValue = $('drive-folder').value.trim(); driveFolderId(folderValue);
    if (preparedClient !== $('client-id').value.trim() || !drive.client) {
      await prepareDrive(); toast('接続の準備ができました。もう一度「Googleに接続」を押してください。'); return;
    }
    // Call the popup directly from the click handler, before any asynchronous work.
    const authorization = drive.authorize();
    await importSource(async signal => { await authorization; return drive.scan(folderValue, progress, signal); }, 'drive', 'Google Drive');
    settings.driveFolder = folderValue; settings.clientId = $('client-id').value.trim(); persist();
  } catch (error) { $('drive-setup').open = true; toast(error.message); }
});
$('reload-source').addEventListener('click', async () => {
  if (sourceKind === 'drive') { $('connect-drive').click(); return; }
  if (sourceKind === 'demo') { await importSource(async () => demoSource(), 'demo', 'サンプル'); return; }
  if (directory) {
    try { const permission = await directory.requestPermission({ mode: 'read' }); if (permission !== 'granted') throw new Error('フォルダの読み取りを許可してください。'); await importSource(() => scanDirectory(directory, progress), 'local', directory.name); } catch (error) { toast(error.message); }
  } else if (importedFiles) { await importSource(() => scanFiles(importedFiles, progress), 'local', sourceName); }
});
$('disconnect').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  stop(); drive.disconnect(); preparedClient = ''; source = null; sourceKind = ''; directory = null; importedFiles = null; sourceName = '';
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
populate(); showPlayback(); resizeGrid();
if (settings.clientId) prepareDrive().catch(() => {});
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
