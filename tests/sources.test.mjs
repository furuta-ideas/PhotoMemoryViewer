import test from 'node:test';
import assert from 'node:assert/strict';
import { scanFiles, scanDirectory, DriveSource } from '../src/sources.js';

function file(name, path, content = 'image', type = 'image/jpeg') { const f = new File([content], name, { type }); Object.defineProperty(f, 'webkitRelativePath', { value: path }); return f; }

test('file import detects closest date, URL files, and invalid folders', async () => {
  const result = await scanFiles([
    file('one.jpg', 'root/20240403 （旅）/one.jpg'),
    file('two.png', 'root/20240403 （旅）/20250815 （海）/two.png'),
    file('video.url', 'root/20240403 （旅）/video.url', '[InternetShortcut]\nURL=https://youtu.be/dQw4w9WgXcQ'),
    file('invalid.jpg', 'root/20240431 （不正）/invalid.jpg'),
    file('raw.heic', 'root/20240403 （旅）/raw.heic')
  ]);
  assert.equal(result.photos.length, 2); assert.equal(result.videos.length, 1); assert.equal(result.report.skipped, 2);
  assert.equal(result.photos[1].date, '20250815');
  const url = await result.photos[0].load(); assert.ok(url.startsWith('blob:')); URL.revokeObjectURL(url);
});
test('directory traversal handles selecting a dated root and ignores undated leaves', async () => {
  const image = { name: 'a.jpg', kind: 'file', getFile: async () => new File(['data'], 'a.jpg') };
  const child = { name: 'sub', kind: 'directory', async *values() { yield image; } };
  const root = { name: '20240403 （旅）', async *values() { yield child; } };
  assert.equal((await scanDirectory(root)).photos[0].folder, root.name);
  assert.equal((await scanDirectory({ ...root, name: 'root' })).report.skipped, 1);
});
test('Drive scan follows nextPageToken and inherits nearest folder', async context => {
  const requests = [];
  const source = new DriveSource(); source.token = 'test-token'; source.expires = Date.now() + 60000;
  context.mock.method(globalThis, 'fetch', async urlString => {
    const url = new URL(urlString); requests.push(url);
    let data;
    if (url.pathname.endsWith('/abcdefghijklmnop')) data = { id: 'abcdefghijklmnop', name: 'root', mimeType: 'application/vnd.google-apps.folder' };
    else if (url.searchParams.get('q')?.includes('abcdefghijklmnop')) data = { files: [{ id: 'child', name: '20240403 （旅）', mimeType: 'application/vnd.google-apps.folder' }] };
    else if (url.searchParams.get('pageToken') === 'second') data = { files: [{ id: 'b', name: 'b.png' }] };
    else data = { nextPageToken: 'second', files: [{ id: 'a', name: 'a.jpg' }] };
    return Response.json(data);
  });
  const result = await source.scan('abcdefghijklmnop');
  assert.equal(result.photos.length, 2); assert.equal(result.photos[1].folder, '20240403 （旅）');
  assert.ok(requests.some(url => url.searchParams.get('pageToken') === 'second'));
});
test('Drive refuses expired tokens and marks HTTP401 for reconnect', async context => {
  const source = new DriveSource();
  await assert.rejects(source.request('files'), error => error.code === 'AUTH');
  source.token = 'test-token'; source.expires = Date.now() + 60000;
  context.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 401 }));
  await assert.rejects(source.request('files'), error => error.code === 'AUTH');
});
