const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
let browser;
(async () => {
  const temp = path.resolve(process.env.PHOTO_MEMORY_TEST_DIR || os.tmpdir());
  const output = path.resolve(process.env.PHOTO_MEMORY_SCREENSHOTS || 'test-results');
  await fs.mkdir(output, { recursive:true });
  browser = await chromium.launchPersistentContext(path.join(temp,'photo-memory-drive-ui-'+Date.now()), {headless:true,executablePath:process.env.PLAYWRIGHT_BROWSER_PATH||undefined,viewport:{width:768,height:1024},env:{...process.env,TEMP:temp,TMP:temp}});
  await browser.addInitScript(() => {
    Object.defineProperty(navigator,'platform',{get:()=> 'MacIntel'});
    Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5});
    const actualNow=Date.now;window.__clockOffset=0;Date.now=()=>actualNow()+window.__clockOffset;
  });
  const url=process.env.PHOTO_MEMORY_URL||'http://localhost:5502';
  const errors=[];
  const family='①古田家の思い出アルバム',grandpa='②じいじの思い出アルバム';
  const stored=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('photo-memory-viewer.settings.v1')));
  const album=(page,name)=>page.locator(`[data-drive-album][value="${name}"]`);
  const idle=page=>page.waitForFunction(()=>!document.getElementById('apply').disabled);
  const pending=await browser.newPage();pending.on('pageerror',e=>errors.push(e.message));
  await pending.route('**/src/deployment-config.js*',r=>r.fulfill({contentType:'text/javascript',body:"export const GOOGLE_CLIENT_ID = '';"}));
  await pending.goto(url);await pending.waitForSelector('[data-drive-album]');
  assert.equal(await pending.locator('#drive-fields').isVisible(),true);
  assert.equal(await pending.locator('[data-drive-album]:checked').count(),2);
  assert.equal(await pending.locator('#drive-albums-connect').isDisabled(),true);
  assert.match(await pending.locator('#drive-status').innerText(),/初期設定/);
  assert.equal(await pending.locator('#drive-advanced').evaluate(e=>e.open),false);
  await album(pending,family).uncheck();await pending.reload();
  assert.equal(await album(pending,family).isChecked(),false);assert.equal(await album(pending,grandpa).isChecked(),true);
  await album(pending,grandpa).uncheck();await pending.reload();assert.equal(await pending.locator('[data-drive-album]:checked').count(),0);
  await album(pending,family).check();await album(pending,grandpa).check();await pending.reload();assert.equal(await pending.locator('[data-drive-album]:checked').count(),2);
  await pending.click('[data-source="local"]');await pending.click('#apply');await idle(pending);await pending.reload();
  assert.equal(await pending.locator('#local-fields').isVisible(),true);assert.equal((await stored(pending)).driveUiVersion,1);
  await pending.click('[data-source="drive"]');
  await pending.screenshot({path:path.join(output,'PhotoMemoryViewer-ipad-drive-pending.png')});
  console.log('PASS iPad Drive defaults, album checkbox persistence, one-time tab migration and honest missing-ID status');
  await pending.close();
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/src/deployment-config.js*',r=>r.fulfill({contentType:'text/javascript',body:"export const GOOGLE_CLIENT_ID = 'mock-client.apps.googleusercontent.com';"}));
  await page.route('https://accounts.google.com/gsi/client',r=>r.fulfill({contentType:'text/javascript',body:`
    window.__authCalls=0;window.__authGestures=[];window.__rejectOAuth=false;
    window.google={accounts:{oauth2:{
      initTokenClient(options){return {...options,requestAccessToken(){window.__authCalls++;window.__authGestures.push(navigator.userActivation.isActive);setTimeout(()=>this.callback(window.__rejectOAuth?{error:'access_denied'}:{access_token:'private-drive-test-token',expires_in:3600}),0);}};},
      hasGrantedAllScopes(){return true;},revoke(token,callback){callback();}
    }}};
  `}));
  const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=','base64');
  const roots=[{id:'familyalbum123456',name:family,mimeType:'application/vnd.google-apps.folder'},{id:'grandpaalbum123456',name:grandpa,mimeType:'application/vnd.google-apps.folder'}];
  const searches=[];let failure='';
  await page.route('https://www.googleapis.com/drive/v3/**',r=>{
    const u=new URL(r.request().url());if(u.searchParams.get('alt')==='media')return r.fulfill({contentType:'image/png',body:pixel});
    const q=u.searchParams.get('q')||'';let data;
    if(failure==='api')return r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{message:'denied'}})});
    if(failure==='unauthorized')return r.fulfill({status:401,contentType:'application/json',body:'{}'});
    if(q.includes('name =')){searches.push(q);data={files:roots.filter(root=>q.includes(root.name)&&!(failure==='missing'&&root.name===grandpa))};if(failure==='duplicates'&&q.includes(grandpa))data.files.push({...roots[1],id:'duplicatealbum123456'});}
    else if(roots.some(root=>u.pathname.endsWith('/'+root.id)))data=roots.find(root=>u.pathname.endsWith('/'+root.id));
    else if(q.includes('familyalbum123456'))data={files:[{id:'familydate123456',name:'20200101 家族の正月',mimeType:'application/vnd.google-apps.folder'}]};
    else if(q.includes('grandpaalbum123456'))data={files:[{id:'grandpadate123456',name:'20210203 じいじと散歩',mimeType:'application/vnd.google-apps.folder'}]};
    else if(q.includes('familydate123456')||q.includes('grandpadate123456')){const prefix=q.includes('familydate123456')?'family':'grandpa';data={files:[1,2].map(n=>({id:prefix+'image'+n,name:n+'.png',mimeType:'image/png'}))};}
    else throw new Error('Unexpected Drive request: '+u);
    return r.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(url);await page.click('[data-source="drive"]');await page.waitForFunction(()=>!document.getElementById('drive-albums-connect').disabled);
  await page.click('#drive-albums-connect');await page.waitForFunction(()=>document.getElementById('viewer-count').textContent==='4 PHOTOS / 0 VIDEOS'&&!document.getElementById('apply').disabled);
  const expected=family+' / '+grandpa;
  assert.equal(await page.locator('#source-name').innerText(),expected);assert.equal(await page.locator('.memory-tile img').count(),4);
  assert.ok(searches.some(q=>q.includes(`name = '${family}'`)));assert.ok(searches.some(q=>q.includes(`name = '${grandpa}'`)));
  const resolved=JSON.stringify((await stored(page)).driveResolvedAlbums);assert.match(resolved,/familyalbum123456/);assert.match(resolved,/grandpaalbum123456/);
  assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>v.includes('private-drive-test-token'))),false);
  for(const [date,caption] of [['20200101','20200101 家族の正月'],['20210203','20210203 じいじと散歩']]){
    await page.fill('#start-date',date);await page.fill('#end-date',date);await page.click('#apply');await idle(page);
    await page.waitForFunction(caption=>document.getElementById('folder-caption').textContent===caption,caption);
    assert.equal(await page.locator('#viewer-count').innerText(),'2 PHOTOS / 0 VIDEOS');assert.equal(await page.locator('#folder-caption').innerText(),caption);
  }
  await page.fill('#start-date','');await page.fill('#end-date','');await page.click('#apply');await idle(page);
  await page.screenshot({path:path.join(output,'PhotoMemoryViewer-ipad-drive-albums.png')});
  console.log('PASS configured deployment, exact folder names, two recursive albums, date filters and private-token handling');
  const authCalls=await page.evaluate(()=>window.__authCalls),searchCount=searches.length;
  await page.evaluate(()=>window.__clockOffset=2*60*60*1000);await page.click('#reload-source');await idle(page);
  assert.equal(await page.evaluate(()=>window.__authCalls),authCalls+1);assert.equal(searches.length,searchCount);
  assert.equal(await page.evaluate(()=>window.__authGestures.every(Boolean)),true);
  assert.equal(await page.locator('#viewer-count').innerText(),'4 PHOTOS / 0 VIDEOS');
  console.log('PASS expired-token reload authorizes inside user gesture and reuses resolved folder IDs');
  const goodResolved=JSON.stringify((await stored(page)).driveResolvedAlbums);
  const preserved=async()=>{assert.equal(await page.locator('#source-name').innerText(),expected);assert.equal(await page.locator('#viewer-count').innerText(),'4 PHOTOS / 0 VIDEOS');assert.equal(JSON.stringify((await stored(page)).driveResolvedAlbums),goodResolved);};
  failure='missing';await page.click('#drive-albums-connect');await idle(page);assert.match(await page.locator('#drive-status').innerText(),/見つか|ありません/);await preserved();
  failure='api';await page.click('#drive-albums-connect');await idle(page);assert.match(await page.locator('#drive-status').innerText(),/API|権限|失敗|接続/);await preserved();
  failure='unauthorized';await page.click('#reload-source');await idle(page);await preserved();
  const authBeforeRetry=await page.evaluate(()=>window.__authCalls);
  failure='';await page.click('#reload-source');await idle(page);assert.equal(await page.evaluate(()=>window.__authCalls),authBeforeRetry+1);await preserved();
  failure='duplicates';await page.click('#drive-albums-connect');await page.waitForSelector('#album-match-1');await preserved();
  assert.equal(await page.locator('#album-match-1').inputValue(),'');
  await page.selectOption('#album-match-1','grandpaalbum123456');
  await page.getByRole('button',{name:'選んだフォルダの写真を表示'}).click();await idle(page);await preserved();
  failure='';await page.evaluate(()=>{window.__clockOffset+=2*60*60*1000;window.__rejectOAuth=true;});await page.click('#reload-source');await idle(page);await preserved();
  assert.equal(await page.locator('#drive-albums-connect').isDisabled(),false);
  console.log('PASS missing album, API failure and OAuth denial preserve photos/resolved IDs and allow retry');
  assert.deepEqual(errors,[]);await browser.close();console.log('PASS no uncaught browser errors');
})().catch(async error=>{console.error(error);await browser?.close();process.exitCode=1;});
