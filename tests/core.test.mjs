import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, validDate, datedFolder, nearestFolder, inRange, validateSettings, gridShape, youtubeId, youtubeLinks, driveFolderId, randomSeek, ShuffleBag, RefreshClock, prefersFileSelection } from '../src/core.js';

test('iPads with desktop user agent and iPhones prefer individual file selection', () => {
  assert.equal(prefersFileSelection('Mozilla/5.0 (iPad)', 'iPad', 5), true);
  assert.equal(prefersFileSelection('Mozilla/5.0 (Macintosh)', 'MacIntel', 5), true);
  assert.equal(prefersFileSelection('Mozilla/5.0 (iPhone)', 'iPhone', 1), true);
  assert.equal(prefersFileSelection('Mozilla/5.0 (Macintosh)', 'MacIntel', 0), false);
  assert.equal(prefersFileSelection('Mozilla/5.0 (Windows NT 10.0)', 'Win32', 5), false);
});

test('calendar validation includes leap years and rejects rollover dates', () => {
  assert.equal(validDate('20240229'), true);
  for (const value of ['20230229', '20241301', '20240431', '20240010', '20240100', '00000101', '2024-0101', '202410']) assert.equal(validDate(value), false, value);
  assert.equal(validDate('00990101'), true);
});
test('folder parsing and nearest dated ancestor', () => {
  assert.deepEqual(datedFolder('20240403 （京都旅行）'), { date: '20240403', folder: '20240403 （京都旅行）' });
  assert.ok(datedFolder('20240403　(京都旅行)'));
  assert.equal(datedFolder('20240431 （旅）'), null);
  assert.equal(datedFolder('20240403'), null);
  assert.equal(nearestFolder('root/20240403 （旅）/未整理/a.jpg').date, '20240403');
  assert.equal(nearestFolder('root/20240403 （旅）/20250815 （海）/a.jpg').date, '20250815');
  assert.equal(nearestFolder('root/画像/a.jpg'), null);
});
test('inclusive filtering and invalid settings', () => {
  const item = { date: '20240403' };
  assert.equal(inRange(item, '20240403', '20240403'), true);
  assert.equal(inRange(item, '', ''), true);
  assert.equal(inRange(item, '20240404', ''), false);
  for (const patch of [{ start: '20240404', end: '20240403' }, { end: '20240230' }, { refresh: 3 }, { refresh: 15.1 }, { refresh: 3601 }, { layout: 5 }, { volume: -1 }, { bgmVolume: 150 }]) assert.throws(() => validateSettings({ ...DEFAULTS, ...patch }));
});
test('all responsive grids preserve their number of slots', () => {
  for (const count of [1, 2, 3, 4, 6, 8]) for (const portrait of [true, false]) { const [c, r] = gridShape(count, portrait); assert.equal(c * r, count); }
  assert.deepEqual(gridShape(8, true), [2, 4]); assert.deepEqual(gridShape(8, false), [4, 2]);
});
test('YouTube URLs are restricted to actual YouTube hosts and valid IDs', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [`https://youtu.be/${id}?t=90`, `https://www.youtube.com/watch?v=${id}&list=abc`, `https://youtube.com/shorts/${id}`, `https://m.youtube.com/watch?v=${id}`]) assert.equal(youtubeId(url), id);
  for (const url of [`https://evil.youtube.com/watch?v=${id}`, `https://youtube.com.evil.org/watch?v=${id}`, 'javascript:alert(1)', 'https://youtu.be/short']) assert.equal(youtubeId(url), null);
  assert.deepEqual(youtubeLinks(`[InternetShortcut]\r\nURL=https://youtu.be/${id}\r\nhttps://www.youtube.com/watch?v=${id}`), [id]);
});
test('Drive input rejects arbitrary URLs and query injection', () => {
  const id = 'abcdefghijklmnop';
  assert.equal(driveFolderId(id), id);
  assert.equal(driveFolderId(`https://drive.google.com/drive/u/0/folders/${id}?usp=sharing`), id);
  assert.throws(() => driveFolderId("abc' or trashed=false"));
  assert.throws(() => driveFolderId(`https://evil.example/folders/${id}`));
});
test('random seek leaves room for the refresh interval and handles short videos', () => {
  assert.equal(randomSeek(100, 15, -100, () => .5), 42);
  assert.equal(randomSeek(10, 15), 0);
  assert.equal(randomSeek(0, 15), null);
  assert.equal(randomSeek(Infinity, 15), null);
  for (let i = 0; i < 100; i++) assert.ok(randomSeek(100, 15) <= 85);
});
test('shuffle avoids visible images when alternatives exist; shortage remains usable', () => {
  const items = Array.from({ length: 8 }, (_, id) => ({ id: String(id) }));
  const bag = new ShuffleBag(items, () => .2);
  const visible = new Set(); for (let i = 0; i < 4; i++) visible.add(bag.draw(visible).id);
  assert.equal(visible.size, 4);
  for (let i = 0; i < 30; i++) assert.equal(visible.has(bag.draw(visible).id), false);
  const one = new ShuffleBag([{ id: 'one' }]); assert.equal(one.draw(new Set(['one'])).id, 'one');
  assert.equal(new ShuffleBag([]).draw(), null);
});
test('clock staggers updates by T/N, wraps, and Stop cancels updates', context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const seen = []; const clock = new RefreshClock(index => seen.push(index));
  clock.start(15, 4);
  context.mock.timers.tick(3749); assert.deepEqual(seen, []);
  context.mock.timers.tick(1); assert.deepEqual(seen, [0]);
  context.mock.timers.tick(11250); assert.deepEqual(seen, [0, 1, 2, 3]);
  context.mock.timers.tick(3750); assert.deepEqual(seen, [0, 1, 2, 3, 0]);
  clock.stop(); context.mock.timers.tick(15000); assert.equal(seen.length, 5);
  clock.start(4, 8); context.mock.timers.tick(500); assert.equal(seen.at(-1), 0); clock.stop();
});
