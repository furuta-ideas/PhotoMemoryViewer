const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
let browser;

(async () => {
  const temp = path.resolve(process.env.PHOTO_MEMORY_TEST_DIR || os.tmpdir());
  const output = path.resolve(process.env.PHOTO_MEMORY_SCREENSHOTS || 'test-results');
  await fs.mkdir(output, { recursive: true });
  browser = await chromium.launchPersistentContext(path.join(temp, 'photo-memory-browser-' + Date.now()), { headless: true, executablePath: process.env.PLAYWRIGHT_BROWSER_PATH || undefined, viewport: { width: 1440, height: 1000 }, env: { ...process.env, TEMP: temp, TMP: temp } });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.PHOTO_MEMORY_URL || 'http://localhost:5502');
  await page.waitForSelector('#empty-state');
  assert.equal(await page.locator('#play').isDisabled(), true);
  await page.screenshot({ path: path.join(output, 'PhotoMemoryViewer-initial.png') });
  await page.click('#demo');
  await page.waitForFunction(() => document.querySelectorAll('.memory-tile img').length === 4);
  assert.equal(await page.locator('.memory-tile').count(), 4);
  await page.waitForFunction(() => !document.getElementById('apply').disabled);
  await page.screenshot({ path: path.join(output, 'PhotoMemoryViewer-desktop.png') });
  await page.fill('#refresh', '4'); await page.click('#apply');
  await page.waitForTimeout(100);
  const initial = await page.locator('.caption').allTextContents();
  await page.click('#play'); await page.waitForTimeout(1200);
  assert.equal(await page.locator('#play-state').innerText(), '再生中');
  const changed = await page.locator('.caption').allTextContents();
  assert.notEqual(initial[0], changed[0]); assert.equal(initial[1], changed[1]);
  await page.click('#stop'); await page.waitForTimeout(800);
  const stopped = await page.locator('.caption').allTextContents();
  await page.waitForTimeout(1300);
  assert.deepEqual(await page.locator('.caption').allTextContents(), stopped);
  console.log('PASS staggered photo refresh and Stop');
  for (const count of [1, 2, 3, 4, 6, 8]) {
    await page.click(`[data-layout="${count}"]`); await page.click('#apply');
    await page.waitForFunction(n => document.querySelectorAll('.memory-tile').length === n, count);
    await page.waitForTimeout(180);
    assert.equal(await page.locator('.memory-tile').count(), count);
    const valid = await page.locator('.memory-tile').evaluateAll(tiles => tiles.every(tile => tile.clientWidth > 0 && tile.clientHeight > 0)); assert.equal(valid, true);
  }
  console.log('PASS all six layouts');
  await page.fill('#start-date', '20240403'); await page.fill('#end-date', '20240403'); await page.click('#apply');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#viewer-count').innerText(), '1 PHOTOS / 0 VIDEOS');
  assert.equal((await page.locator('.caption').allTextContents()).every(text => text === '20240403 （春の山歩き）'), true);
  assert.equal(await page.locator('#folder-caption').innerText(), '20240403 （春の山歩き）');
  assert.equal(await page.locator('#folder-caption').isVisible(), true);
  assert.match(await page.locator('#app-updated').innerText(), /2026年10月8日/);
  await page.fill('#start-date', '20240404'); await page.click('#apply');
  assert.equal(await page.locator('#form-error').isVisible(), true);
  await page.fill('#start-date', '20300101'); await page.fill('#end-date', '20301231'); await page.click('#apply');
  await page.waitForTimeout(100); assert.equal(await page.locator('#empty-state').isVisible(), true); assert.equal(await page.locator('#play').isDisabled(), true);
  console.log('PASS inclusive date filtering, invalid range, empty result');
  await page.fill('#start-date', ''); await page.fill('#end-date', ''); await page.click('[data-layout="4"]'); await page.click('#apply');
  await page.waitForTimeout(500);
  await page.reload(); await page.waitForTimeout(300); assert.equal(await page.locator('#refresh').inputValue(), '4');
  await page.click('#demo'); await page.waitForFunction(() => document.querySelectorAll('.memory-tile img').length === 4);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#settings-close'); await page.waitForTimeout(250);
  assert.equal(await page.locator('#settings').isVisible(), false);
  const phoneWidth = await page.locator('.memory-grid').evaluate(el => el.getBoundingClientRect().width); assert.equal(phoneWidth, 390);
  await page.click('#play'); await page.mouse.move(380, 750); await page.waitForTimeout(3350);
  assert.ok(await page.locator('#toolbar').evaluate(el => el.getBoundingClientRect().bottom <= 1));
  await page.locator('#viewer').dispatchEvent('pointerdown'); await page.waitForTimeout(350);
  assert.ok(await page.locator('#toolbar').evaluate(el => el.getBoundingClientRect().bottom > 1));
  await page.click('#stop');
  await page.screenshot({ path: path.join(output, 'PhotoMemoryViewer-phone.png') });
  await page.click('#settings-toggle'); assert.equal(await page.locator('#settings').isVisible(), true);
  await page.screenshot({ path: path.join(output, 'PhotoMemoryViewer-phone-settings.png') });
  await page.click('[data-layout="8"]'); await page.click('#apply'); await page.click('#settings-close');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.memory-tile').count(), 8);
  assert.equal(await page.locator('.memory-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
  await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(200);
  assert.equal(await page.locator('.memory-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 4);
  console.log('PASS phone portrait/landscape and settings overlay');
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.click('#settings-toggle');
  await page.click('#disconnect'); await page.waitForFunction(() => document.querySelectorAll('.memory-tile').length === 0);
  await page.evaluate(() => { delete window.showDirectoryPicker; });
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=', 'base64');
  await page.locator('#folder-input').evaluate((input, base64) => {
    const bytes = Uint8Array.from(atob(base64), x => x.charCodeAt(0));
    const image = new File([bytes], 'image.png', { type: 'image/png' });
    Object.defineProperty(image, 'webkitRelativePath', { value: 'photos/20240403 （京都旅行）/image.png' });
    const corrupt = new File(['broken'], 'broken.jpg', { type: 'image/jpeg' });
    Object.defineProperty(corrupt, 'webkitRelativePath', { value: 'photos/20240403 （京都旅行）/broken.jpg' });
    const transfer = new DataTransfer(); transfer.items.add(image); transfer.items.add(corrupt); input.files = transfer.files; input.dispatchEvent(new Event('change'));
  }, pixel.toString('base64'));
  await page.waitForFunction(() => document.querySelector('.memory-tile img'));
  await page.waitForFunction(() => !document.getElementById('apply').disabled);
  assert.equal(await page.locator('#viewer-count').innerText(), '2 PHOTOS / 0 VIDEOS');
  assert.equal(await page.locator('.memory-tile img').count(), 8);
  console.log('PASS actual local File import and corrupt-image fallback');

  // Official player and OAuth contracts are mocked; no account or remote video is needed.
  await page.route('https://www.youtube.com/iframe_api', route => route.fulfill({ contentType: 'text/javascript', body: `
    window.__players = [];
    window.YT = { PlayerState: { PLAYING: 1, ENDED: 0 }, Player: class {
      constructor(host, options) { this.options=options; this.seeks=[]; this.pauses=0; this.muted=false; window.__players.push(this); setTimeout(()=>options.events.onReady(),0); }
      playVideo() { setTimeout(()=>this.options.events.onStateChange({data:1}),0); }
      pauseVideo() { this.pauses++; }
      getDuration() { return 120; }
      seekTo(point) { this.seeks.push(point); }
      mute() { this.muted=true; }
      unMute() { this.muted=false; }
      setVolume(value) { this.volume=value; }
      destroy() { this.destroyed=true; }
    }};
    window.onYouTubeIframeAPIReady();
  ` }));
  await page.click('[data-layout="4"]'); await page.click('#apply');
  await page.locator('#folder-input').evaluate((input, base64) => {
    const bytes = Uint8Array.from(atob(base64), x => x.charCodeAt(0));
    const image = new File([bytes], 'image.png', { type: 'image/png' });
    Object.defineProperty(image, 'webkitRelativePath', { value: 'photos/20240403 （旅）/image.png' });
    const video = new File(['https://youtu.be/dQw4w9WgXcQ\nhttps://youtu.be/9bZkp7q19f0'], 'video.txt');
    Object.defineProperty(video, 'webkitRelativePath', { value: 'photos/20240403 （旅）/video.txt' });
    const transfer = new DataTransfer(); transfer.items.add(image); transfer.items.add(video); input.files = transfer.files; input.dispatchEvent(new Event('change'));
  }, pixel.toString('base64'));
  await page.waitForFunction(() => window.__players?.length === 1 && !document.getElementById('apply').disabled);
  assert.equal(await page.locator('.video-tile').count(), 1);
  await page.click('#play');
  await page.waitForFunction(() => window.__players[0].seeks.length >= 1);
  const firstSeek = await page.evaluate(() => window.__players[0].seeks.length);
  await page.waitForTimeout(4250);
  assert.ok(await page.evaluate(n => window.__players[0].seeks.length > n, firstSeek));
  assert.equal(await page.evaluate(() => window.__players.length), 1);
  assert.equal(await page.evaluate(() => window.__players[0].muted), false);
  await page.click('#stop');
  const afterStop = await page.evaluate(() => window.__players[0].seeks.length);
  await page.waitForTimeout(1100);
  assert.equal(await page.evaluate(() => window.__players[0].seeks.length), afterStop);
  await page.evaluate(() => window.__players[0].options.events.onAutoplayBlocked());
  assert.equal(await page.locator('.video-resume').isVisible(), true);
  await page.click('.video-resume');
  assert.equal(await page.locator('.video-resume').isVisible(), false);
  await page.click('#next-video');
  await page.waitForFunction(() => window.__players.length === 2);
  const ids = await page.evaluate(() => window.__players.map(p => p.options.videoId)); assert.notEqual(ids[0], ids[1]);
  await page.evaluate(() => window.__players[1].options.events.onError());
  await page.waitForFunction(() => window.__players.length === 3);
  await page.evaluate(() => window.__players[2].options.events.onError());
  await page.waitForFunction(() => !document.querySelector('.video-tile'));
  assert.equal(await page.locator('.memory-tile').count(), 4);
  console.log('PASS YouTube persistent video, T-second seek, audio ON, autoplay retry, next video and error fallback (mock API)');

  // Restore the same local files, then exercise BGM arbitration and narrow-video fallback.
  await page.click('#stop'); await page.click('#reload-source');
  await page.waitForFunction(() => document.querySelector('.video-tile') && !document.getElementById('apply').disabled);
  await page.evaluate(() => {
    window.__bgmPlays = 0;
    HTMLMediaElement.prototype.play = function () { if (this.id === 'bgm') window.__bgmPlays++; return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () {};
  });
  const wav = Buffer.alloc(8044, 128); wav.write('RIFF', 0); wav.writeUInt32LE(8036, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40);
  await page.selectOption('#bgm-mode', 'local');
  await page.locator('#bgm-file').setInputFiles({ name:'bgm.wav', mimeType:'audio/wav', buffer:wav });
  await page.click('#apply'); await page.click('#play'); await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__bgmPlays), 0);
  await page.uncheck('#youtube-sound'); await page.click('#apply'); await page.waitForTimeout(100);
  assert.ok(await page.evaluate(() => window.__bgmPlays > 0));
  await page.click('#stop');
  await page.setViewportSize({ width:390, height:844 });
  await page.waitForFunction(() => !document.querySelector('.video-tile'));
  assert.equal(await page.locator('.memory-tile').count(), 4);
  await page.setViewportSize({ width:1440, height:1000 });
  await page.waitForFunction(() => !!document.querySelector('.video-tile'));
  console.log('PASS local BGM arbitration and video minimum size fallback/restore (mock media playback)');

  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({ contentType: 'text/javascript', body: `
    window.google = { accounts: { oauth2: {
      initTokenClient(options) { return { ...options, requestAccessToken() { setTimeout(()=>this.callback({access_token:'mock-private-token', expires_in:3600}),0); } }; },
      hasGrantedAllScopes() { return true; },
      revoke(token, callback) { window.__revoked=token; callback(); }
    }}};
  ` }));
  await page.route('https://www.googleapis.com/drive/v3/**', route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('alt') === 'media') return route.fulfill({ contentType: 'image/png', body: pixel });
    const data = url.pathname.endsWith('/abcdefghijklmnop')
      ? { id:'abcdefghijklmnop', name:'20250815 （Googleの写真）', mimeType:'application/vnd.google-apps.folder' }
      : { files:[{id:'image123', name:'drive.png', mimeType:'image/png'}] };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.click('#stop'); await page.click('[data-source="drive"]');
  await page.locator('#drive-advanced').evaluate(el=>el.open=true);
  await page.fill('#drive-search-name','B.01 じいじの思い出アルバム');
  await page.click('#find-drive-folder');
  assert.match(await page.locator('#drive-status').innerText(), /検索を実行できません/);
  await page.fill('#drive-folder', 'https://drive.google.com/drive/folders/abcdefghijklmnop');
  await page.locator('#drive-setup').evaluate(el => el.open = true);
  await page.fill('#client-id', 'mock-client.apps.googleusercontent.com'); await page.locator('#client-id').dispatchEvent('change');
  await page.waitForFunction(() => !!window.google?.accounts?.oauth2);
  await page.waitForTimeout(100); await page.click('#connect-drive');
  await page.waitForFunction(() => document.getElementById('source-name').textContent === '20250815 （Googleの写真）');
  await page.waitForFunction(() => !document.getElementById('apply').disabled);
  assert.equal(await page.locator('.memory-tile img').count(), 4);
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('mock-private-token'))), false);
  await page.route('https://www.googleapis.com/drive/v3/**', route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('alt') === 'media') return route.fulfill({ contentType:'image/png', body:pixel });
    const q = url.searchParams.get('q') || '';
    const parent = {id:'albumparent123456',name:'B.01 じいじの思い出アルバム',mimeType:'application/vnd.google-apps.folder'};
    let data;
    if(q.includes('name contains')) data={files:[parent]};
    else if(url.pathname.endsWith('/albumparent123456')) data=parent;
    else if(q.includes('albumparent123456')) data={files:[{id:'dateA',name:'20050330 春の家族のお出かけ',mimeType:'application/vnd.google-apps.folder'},{id:'dateB',name:'20050405 入学式',mimeType:'application/vnd.google-apps.folder'}]};
    else data={files:[{id:q.includes('dateA')?'imageA':'imageB',name:'photo.png',mimeType:'image/png'}]};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.click('#find-drive-folder');
  await page.waitForSelector('#drive-folder-results button');
  await page.locator('#drive-folder-results button').click();
  await page.waitForFunction(()=>document.getElementById('viewer-count').textContent==='2 PHOTOS / 0 VIDEOS' && !document.getElementById('apply').disabled);
  assert.equal(await page.locator('#source-name').innerText(),'B.01 じいじの思い出アルバム');
  await page.fill('#start-date','20050405');await page.fill('#end-date','20050405');await page.click('#apply');
  await page.waitForFunction(()=>document.getElementById('folder-caption').textContent==='20050405 入学式');
  await page.fill('#start-date','');await page.fill('#end-date','');await page.click('#apply');
  await page.waitForFunction(()=>!document.getElementById('apply').disabled);
  console.log('PASS parent album search, selection, recursive dated folders and filtering (mock API)');
  await page.click('#disconnect'); await page.waitForFunction(() => document.querySelectorAll('.memory-tile').length === 0);
  assert.equal(await page.evaluate(() => window.__revoked), 'mock-private-token');
  console.log('PASS Google OAuth, Drive image fetch, token excluded from settings, disconnect revocation (mock API)');

  await browser.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
  });
  const ipad = await browser.newPage(); ipad.on('pageerror', error => errors.push(error.message));
  await ipad.setViewportSize({ width:768, height:1024 });
  await ipad.goto(process.env.PHOTO_MEMORY_URL || 'http://localhost:5502');
  await ipad.click('[data-source="local"]');
  assert.equal(await ipad.locator('#folder-button-label').innerText(), 'Google Driveの親フォルダを選択');
  assert.equal(await ipad.locator('#files-input').getAttribute('webkitdirectory'), null);
  await ipad.click('#choose-folder');
  assert.equal(await ipad.locator('#drive-fields').isVisible(),true);
  await ipad.click('[data-source="local"]');
  await ipad.locator('#file-selection').evaluate(el=>el.open=true);
  await ipad.click('#choose-files');
  assert.equal(await ipad.locator('#file-folder-name').evaluate(el => el === document.activeElement), true);
  await ipad.fill('#file-folder-name', '20250815 （夏休み）');
  const chooserPromise = ipad.waitForEvent('filechooser');
  await ipad.click('#choose-files');
  const chooser = await chooserPromise;
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles([{ name:'one.png', mimeType:'image/png', buffer:pixel }, { name:'two.png', mimeType:'image/png', buffer:pixel }]);
  await ipad.waitForFunction(() => document.querySelectorAll('.memory-tile img').length === 4 && !document.getElementById('apply').disabled);
  assert.equal(await ipad.locator('#source-name').innerText(), '20250815 （夏休み）');
  await ipad.click('#reload-source');
  await ipad.waitForFunction(() => !document.getElementById('apply').disabled);
  assert.equal(await ipad.locator('#folder-caption').innerText(), '20250815 （夏休み）');
  await ipad.screenshot({ path:path.join(output, 'PhotoMemoryViewer-ipad-files.png') });
  console.log('PASS iPad desktop-agent detection, regular multi-file picker, explicit folder metadata and reload (simulated device)');

  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS no uncaught browser errors');
})().catch(async error => { console.error(error); await browser?.close(); process.exitCode = 1; });
