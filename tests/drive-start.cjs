const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
let browser;
(async () => {
  const temp=path.resolve(process.env.PHOTO_MEMORY_TEST_DIR||os.tmpdir()),output=path.resolve(process.env.PHOTO_MEMORY_SCREENSHOTS||'test-results');
  await fs.mkdir(output,{recursive:true});
  browser=await chromium.launchPersistentContext(path.join(temp,'photo-memory-start-'+Date.now()),{headless:true,executablePath:process.env.PLAYWRIGHT_BROWSER_PATH||undefined,viewport:{width:768,height:1024},env:{...process.env,TEMP:temp,TMP:temp}});
  await browser.addInitScript(()=>{Object.defineProperty(navigator,'platform',{get:()=> 'MacIntel'});Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5});});
  await browser.route('**/src/deployment-config.js*',r=>r.fulfill({contentType:'text/javascript',body:"export const GOOGLE_CLIENT_ID = 'mock-client.apps.googleusercontent.com';"}));
  await browser.route('https://accounts.google.com/gsi/client',r=>r.fulfill({contentType:'text/javascript',body:`
    window.__authCalls=0;window.__authGestures=[];
    window.google={accounts:{oauth2:{initTokenClient(options){return {...options,requestAccessToken(){window.__authCalls++;window.__authGestures.push(navigator.userActivation.isActive);setTimeout(()=>this.callback({access_token:'private-session-token',expires_in:3600}),0);}};},hasGrantedAllScopes(){return true;},revoke(token,callback){callback();}}}};
  `}));
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const family='①古田家の思い出アルバム',rootId='familyalbum123456';
  const root={id:rootId,name:family,mimeType:'application/vnd.google-apps.folder'};
  const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=','base64');
  let release,block=false,gate=Promise.resolve(),failTail=false,unauthorized=false,searches=0,scans=0,rootGate=null,releaseRoot,emptyListing=false;
  const hold=()=>{block=true;gate=new Promise(resolve=>{release=()=>{block=false;resolve();};});};
  await page.route('https://www.googleapis.com/drive/v3/**',async r=>{
    const u=new URL(r.request().url()),q=u.searchParams.get('q')||'';
    if(unauthorized)return r.fulfill({status:401,contentType:'application/json',body:'{}'});
    if(u.searchParams.get('alt')==='media')return r.fulfill({contentType:'image/png',body:pixel});
    let data;
    if(q.includes('name =')){searches++;data={files:[root]};}
    else if(u.pathname.endsWith('/'+rootId)){scans++;if(rootGate)await rootGate;data=root;}
    else if(q.includes(rootId))data={files:emptyListing?[]:[{id:'firstdate',name:'20200101 家族の正月',mimeType:'application/vnd.google-apps.folder'},{id:'seconddate',name:'20210203 散歩',mimeType:'application/vnd.google-apps.folder'}]};
    else if(u.searchParams.get('pageToken')==='tail'){
      if(block)await gate;
      if(failTail)return r.fulfill({status:403,contentType:'application/json',body:'{}'});
      data={files:[{id:'secondphoto',name:'2.png',mimeType:'image/png'}]};
    }
    else if(q.includes('firstdate'))data={nextPageToken:'tail',files:[{id:'firstphoto',name:'1.png',mimeType:'image/png'}]};
    else data={files:[{id:'thirdphoto',name:'3.png',mimeType:'image/png'}]};
    return r.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  const url=process.env.PHOTO_MEMORY_URL||'http://localhost:5502';
  const idle=()=>page.waitForFunction(()=>!document.getElementById('apply').disabled);
  const visible=()=>page.waitForFunction(()=>document.querySelector('.memory-tile img')?.complete&&document.querySelector('.memory-tile img')?.naturalWidth>0);
  await page.goto(url);await page.waitForFunction(()=>!document.getElementById('drive-albums-connect').disabled);
  await page.locator('[data-drive-album][value="②じいじの思い出アルバム"]').uncheck();
  hold();await page.click('#drive-albums-connect');await visible();
  assert.equal(await page.locator('#apply').isDisabled(),true);assert.equal(await page.locator('#play-state').innerText(),'再生中');
  await page.evaluate(()=>{window.__firstPhoto=document.querySelector('.memory-tile img');});
  await page.screenshot({path:path.join(output,'PhotoMemoryViewer-progressive-ipad.png')});
  await page.click('#stop');release();await idle();
  assert.equal(await page.locator('#play-state').innerText(),'停止中');assert.equal(await page.locator('#viewer-count').innerText(),'3 PHOTOS / 0 VIDEOS');
  assert.equal(await page.evaluate(()=>window.__firstPhoto===document.querySelector('.memory-tile img')),true);
  assert.equal(await page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('private-session-token'))),false);
  assert.equal(await page.evaluate(()=>!!sessionStorage.getItem('photo-memory-viewer.drive-session.v1')),true);
  const resume=await page.evaluate(()=>JSON.parse(localStorage.getItem('photo-memory-viewer.settings.v1')).driveResume);
  assert.ok(resume.preview.length>0&&resume.preview.length<=16);assert.deepEqual(Object.keys(resume.preview[0]).sort(),['date','folder','id','name']);
  console.log('PASS first photo and autoplay before slow tail; Stop respected; displayed image retained; no persistent token/photos');

  const beforeSearch=searches,beforeScans=scans;
  rootGate=new Promise(resolve=>{releaseRoot=resolve;});
  await page.reload();await visible();assert.equal(await page.locator('#apply').isDisabled(),true);
  releaseRoot();rootGate=null;await idle();
  assert.equal(await page.evaluate(()=>window.__authCalls),0);assert.equal(searches,beforeSearch);assert.ok(scans>beforeScans);
  assert.equal(await page.locator('#play-state').innerText(),'再生中');assert.equal(await page.locator('#settings').isHidden(),true);
  console.log('PASS same-tab startup uses saved root and valid tab session without OAuth popup or name search');

  await page.click('#settings-toggle');await page.click('#stop');
  await page.evaluate(()=>{const key='photo-memory-viewer.drive-session.v1';const value=JSON.parse(sessionStorage.getItem(key));value.expires=Date.now()-1;sessionStorage.setItem(key,JSON.stringify(value));});
  await page.reload();await page.waitForFunction(()=>!document.getElementById('drive-albums-connect').disabled);
  assert.equal(await page.evaluate(()=>window.__authCalls),0);assert.equal(await page.evaluate(()=>sessionStorage.getItem('photo-memory-viewer.drive-session.v1')),null);
  assert.match(await page.locator('#drive-albums-connect').innerText(),/前回/);
  await page.click('#drive-albums-connect');await visible();await idle();
  assert.equal(await page.evaluate(()=>window.__authCalls),1);assert.equal(await page.evaluate(()=>window.__authGestures.every(Boolean)),true);assert.equal(searches,beforeSearch);
  assert.equal(await page.locator('#play-state').innerText(),'再生中');
  console.log('PASS expired session offers one-tap reconnect to exact remembered root and autoplays');

  unauthorized=true;await page.reload();await page.waitForFunction(()=>!document.getElementById('apply').disabled&&!document.getElementById('drive-albums-connect').disabled);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('photo-memory-viewer.drive-session.v1')),null);
  assert.match(await page.locator('#drive-albums-connect').innerText(),/前回/);
  unauthorized=false;await page.click('#drive-albums-connect');await visible();await idle();
  assert.equal(await page.locator('#play-state').innerText(),'再生中');assert.equal(searches,beforeSearch);
  console.log('PASS revoked session is discarded and remembered custom location remains reconnectable');

  await page.click('#stop');failTail=true;hold();await page.click('#reload-source');await visible();release();await idle();
  assert.equal(await page.locator('.memory-tile img').count(),4);assert.match(await page.locator('#drive-status').innerText(),/API|権限/);
  failTail=false;await page.click('#reload-source');await idle();
  assert.equal(await page.locator('#viewer-count').innerText(),'3 PHOTOS / 0 VIDEOS');
  console.log('PASS partial scan failure preserves preview; retry succeeds');

  await page.fill('#start-date','20210203');await page.fill('#end-date','20210203');await page.click('#apply');await idle();
  hold();await page.click('#reload-source');
  await page.waitForFunction(()=>document.getElementById('apply').disabled);
  await page.waitForTimeout(100);release();await idle();await visible();
  assert.equal(await page.locator('#viewer-count').innerText(),'1 PHOTOS / 0 VIDEOS');assert.equal(await page.locator('#folder-caption').innerText(),'20210203 散歩');
  assert.equal(await page.locator('#play-state').innerText(),'再生中');
  console.log('PASS out-of-period first page does not block later eligible photo/autoplay');

  emptyListing=true;await page.reload();await idle();
  await page.waitForFunction(()=>document.getElementById('viewer-count').textContent==='0 PHOTOS / 0 VIDEOS');
  assert.equal(await page.locator('.memory-tile img').count(),0);assert.equal(await page.locator('#empty-state').isVisible(),true);assert.equal(await page.locator('#play-state').innerText(),'停止中');
  await page.click('#settings-toggle');
  console.log('PASS removed saved candidates are cleared when current listing has no eligible photos');

  await page.click('#disconnect');await idle();await page.reload();await page.waitForSelector('#drive-albums-connect');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('photo-memory-viewer.drive-session.v1')),null);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('photo-memory-viewer.settings.v1')));
  assert.equal(saved.driveResume,undefined);assert.equal(saved.driveAutoResume,false);assert.equal(await page.locator('.memory-tile img').count(),0);
  assert.deepEqual(errors,[]);console.log('PASS disconnect forgets automatic connection; no uncaught browser errors');
  await browser.close();
})().catch(async error=>{console.error(error);await browser?.close();process.exitCode=1;});
