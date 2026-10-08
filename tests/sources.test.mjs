import test from 'node:test';
import assert from 'node:assert/strict';
import { scanFiles, scanDirectory, DriveSource, DRIVE_SESSION } from '../src/sources.js';

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

test('Drive restores only matching unexpired tab sessions and clears revoked tokens', async context => {
  const items = new Map(), storage = {getItem:key=>items.get(key),setItem:(key,value)=>items.set(key,value),removeItem:key=>items.delete(key)};
  const source = new DriveSource(storage), clientId = 'test.apps.googleusercontent.com';
  const saved = {token:'private-token',clientId,scope:'https://www.googleapis.com/auth/drive.readonly',expires:Date.now()+60000};
  storage.setItem(DRIVE_SESSION,JSON.stringify(saved));
  assert.equal(source.restoreSession(clientId),true);assert.equal(source.hasAuthorization(),true);
  context.mock.method(globalThis,'fetch',async()=>Response.json({}, {status:401}));
  await assert.rejects(source.request('files'),error=>error.code==='AUTH');
  assert.equal(items.has(DRIVE_SESSION),false);assert.equal(source.token,null);
  for (const patch of [{expires:Date.now()-1},{clientId:'other.apps.googleusercontent.com'},{scope:'wrong'},{expires:Date.now()+7200000}]) {
    storage.setItem(DRIVE_SESSION,JSON.stringify({...saved,...patch}));
    assert.equal(source.restoreSession(clientId),false);assert.equal(items.has(DRIVE_SESSION),false);
  }
  storage.setItem(DRIVE_SESSION,'not-json');assert.equal(source.restoreSession(clientId),false);
});

test('Drive publishes photos before delayed descendants and before YouTube link downloads', async context => {
  const source = new DriveSource(null), batches = [], events = [];
  let release; const gate = new Promise(resolve=>{release=resolve;});
  let first; const found = new Promise(resolve=>{first=resolve;});
  context.mock.method(source,'request',async(path,params)=>{
    if (path==='files/abcdefghijklmnop') return {id:'abcdefghijklmnop',name:'20200101 アルバム',mimeType:'application/vnd.google-apps.folder'};
    if (params.alt==='media') {events.push('link');return new Blob(['https://youtu.be/dQw4w9WgXcQ']);}
    if (params.q.includes('slow')) {await gate;return {files:[{id:'later',name:'later.jpg'}]};}
    return {files:[{id:'slow',name:'subfolder',mimeType:'application/vnd.google-apps.folder'},{id:'link',name:'video.url'},{id:'early',name:'early.jpg'}]};
  });
  let completed = false;
  const scan = source.scan('abcdefghijklmnop',()=>{},undefined,batch=>{batches.push(batch);if(batch.photos.length){events.push(batch.photos[0].id);first();}}).then(result=>{completed=true;return result;});
  await found;
  assert.equal(completed,false);assert.equal(events[0],'early');assert.equal(events.includes('link'),false);
  release();const result=await scan;
  assert.deepEqual(result.photos.map(photo=>photo.id),['early','later']);
  assert.equal(result.videos.length,1);assert.deepEqual(events,['early','later','link']);
  assert.equal(batches[0].name,'20200101 アルバム');
});

test('Drive quick-start metadata is bounded, validated and still loads online on demand', async context => {
  const source = new DriveSource(null), records = Array.from({length:30},(_,i)=>({id:'photo'+i,name:i+'.jpg',folder:'20200101 家族',date:'20200101',data:'ignored'}));
  const restored = source.restorePhotos(records);
  assert.equal(restored.length,16);assert.equal(restored[0].data,undefined);
  assert.equal(source.restorePhotos([{...records[0],id:'../other'},{...records[0],date:'20200102'},{id:'photo'}]).length,0);
  let requests=0;
  context.mock.method(source,'request',async(path,params)=>{requests++;assert.equal(path,'files/photo0');assert.equal(params.alt,'media');return new Blob(['image']);});
  assert.equal(requests,0);const url=await restored[0].load();assert.equal(requests,1);URL.revokeObjectURL(url);
});
