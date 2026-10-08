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

test('plain file selections use an explicit date folder and retain date filtering metadata', async () => {
  const folder = { date: '20250815', folder: '20250815 （夏休み）' };
  const image = new File(['image'], 'one.jpg', { type: 'image/jpeg' });
  const link = new File(['https://youtu.be/dQw4w9WgXcQ'], 'video.txt');
  const result = await scanFiles([image, link], () => {}, folder);
  assert.equal(result.photos.length, 1); assert.equal(result.videos.length, 1);
  assert.equal(result.photos[0].date, folder.date); assert.equal(result.videos[0].folder, folder.folder);
  assert.equal((await scanFiles([image])).photos.length, 0);
  const nested = file('a.jpg', 'root/20240403 （旅）/a.jpg');
  assert.equal((await scanFiles([nested], () => {}, folder)).photos[0].date, '20240403');
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

test('Drive scans metadata lazily and does not cache metadata or displayed photo bytes', async context => {
  const source = new DriveSource(); source.token = 'test-token'; source.expires = Date.now() + 60000;
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (urlString, options) => {
    const url = new URL(urlString); requests.push({url, options});
    if (url.searchParams.get('alt') === 'media') return new Response(new Blob(['image'], {type:'image/jpeg'}));
    if (url.pathname.endsWith('/abcdefghijklmnop')) return Response.json({id:'abcdefghijklmnop',name:'20240229 思い出',mimeType:'application/vnd.google-apps.folder'});
    return Response.json({files:[{id:'photo1',name:'a.jpg',mimeType:'image/jpeg'}]});
  });
  const result = await source.scan('abcdefghijklmnop');
  assert.equal(result.photos.length, 1);
  assert.equal(requests.filter(({url}) => url.searchParams.get('alt') === 'media').length, 0);
  const controller = new AbortController();
  const objectURL = await result.photos[0].load(controller.signal);
  try {
    assert.ok(objectURL.startsWith('blob:'));
    assert.equal(requests.filter(({url}) => url.searchParams.get('alt') === 'media').length, 1);
    assert.ok(requests.every(({options}) => options.cache === 'no-store' && options.headers.Authorization === 'Bearer test-token'));
    assert.equal(requests.at(-1).options.signal, controller.signal);
  } finally { URL.revokeObjectURL(objectURL); }
});

test('Drive folder name search escapes query syntax and follows pagination', async context => {
  const source = new DriveSource(); const queries=[];
  context.mock.method(source,'request',async (path,params)=>{
    queries.push(params);
    return params.pageToken ? {files:[{id:'second',name:'B.01 second'}]} : {files:[{id:'first',name:'B.01 album'}],nextPageToken:'next'};
  });
  const result=await source.findFolders("B.01 someone's album");
  assert.equal(result.length,2); assert.equal(queries[1].pageToken,'next');
  assert.ok(queries[0].q.includes("someone\\'s"));
  await assert.rejects(source.findFolders('  '));
});
