const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let browser;
(async () => {
  const temp=process.env.PHOTO_MEMORY_TEST_DIR||require('node:os').tmpdir();
  browser=await chromium.launchPersistentContext(path.join(temp,'photo-memory-live-'+Date.now()),{headless:true,executablePath:process.env.PLAYWRIGHT_BROWSER_PATH||undefined,viewport:{width:1024,height:900},env:{...process.env,TEMP:temp,TMP:temp}});
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const url=process.env.PHOTO_MEMORY_URL||'http://localhost:5502';
  await browser.route('**/src/deployment-config.js*',r=>r.fulfill({contentType:'text/javascript',body:"export const GOOGLE_CLIENT_ID = '';"}));
  // Check the bundled CPU model itself, without a cloud inference service.
  await page.goto(url);
  const realRequests=[];page.on('request',r=>realRequests.push(r.url()));
  const astronaut=await fs.readFile(process.env.PHOTO_MEMORY_FACE_FIXTURE || path.join(temp,'astronaut.png'));
  const actual=await page.evaluate(async base64=>{
    const {faceFilter}=await import('/src/faces.js');
    const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();
    const portrait=await faceFilter.check(image,'astronaut');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=512;canvas.getContext('2d').fillRect(0,0,512,512);
    const blank=new Image();blank.src=canvas.toDataURL();await blank.decode();
    const landscape=await faceFilter.check(blank,'blank');
    return {portrait,landscape,backend:faceapi.tf.getBackend(),tensors:faceapi.tf.memory().numTensors};
  },astronaut.toString('base64'));
  assert.equal(actual.portrait,true);assert.equal(actual.landscape,false);assert.equal(actual.backend,'cpu');
  assert.equal(realRequests.some(value=>!value.startsWith(url)),false);
  console.log('PASS real bundled CPU face model: portrait accepted, blank rejected, same-origin assets only');

  const timeoutPage=await browser.newPage();await timeoutPage.goto(url);await timeoutPage.clock.install();
  await timeoutPage.evaluate(async()=>{
    window.faceapi={tf:{setBackend:async()=>{}},nets:{tinyFaceDetector:{isLoaded:false,loadFromUri:()=>new Promise(()=>{})}},TinyFaceDetectorOptions:class{},detectSingleFace:async()=>({})};
    const {faceFilter}=await import('/src/faces.js?deadline-test');window.__filter=faceFilter;
    const canvas=document.createElement('canvas');canvas.width=canvas.height=4;
    window.__image=new Image();window.__image.src=canvas.toDataURL();await window.__image.decode();
    faceFilter.check(window.__image,'first').catch(error=>window.__faceError=error.code);
  });
  await timeoutPage.clock.runFor(20010);assert.equal(await timeoutPage.evaluate(()=>window.__faceError),'FACE');
  const retried=await timeoutPage.evaluate(async()=>{faceapi.nets.tinyFaceDetector.loadFromUri=async()=>{};return window.__filter.check(window.__image,'retry');});
  assert.equal(retried,true);await timeoutPage.close();
  console.log('PASS stalled face model reaches deadline, fails closed and permits retry');

  await browser.route('**/src/faces.js*',r=>r.fulfill({contentType:'text/javascript',body:`export const faceFilter={clear(){},async check(image,id){if(window.__faceFailure)throw Object.assign(new Error('顔の判定に失敗しました'),{code:'FACE'});image.dataset.checkedId=id;return id.includes('portrait');}};`}));
  await browser.route('**/src/deployment-config.js*',r=>r.fulfill({contentType:'text/javascript',body:"export const GOOGLE_CLIENT_ID='mock-client.apps.googleusercontent.com';"}));
  await browser.route('https://accounts.google.com/gsi/client',r=>r.fulfill({contentType:'text/javascript',body:'window.google={accounts:{oauth2:{initTokenClient(){return {};}}}};'}));
  await browser.route('https://www.youtube.com/iframe_api',r=>r.fulfill({contentType:'text/javascript',body:`
    window.__players=[];window.YT={PlayerState:{PLAYING:1,ENDED:0},Player:class{
      constructor(host,options){this.options=options;this.seeks=[];this.duration=0;window.__players.push(this);setTimeout(()=>options.events.onReady(),0);setTimeout(()=>this.duration=240,450);}
      getDuration(){return this.duration;}seekTo(point){this.seeks.push({point,time:performance.now()});}playVideo(){setTimeout(()=>this.options.events.onStateChange({data:1}),0);}pauseVideo(){}mute(){this.muted=true;}unMute(){this.muted=false;}setVolume(value){this.volume=value;}destroy(){this.destroyed=true;}
    }};window.onYouTubeIframeAPIReady();`}));
  await page.addInitScript(()=>{
    if(localStorage.getItem('live-fixture'))return;
    localStorage.setItem('live-fixture','1');
    localStorage.setItem('photo-memory-viewer.settings.v1',JSON.stringify({clientId:'mock-client.apps.googleusercontent.com',lastSource:'drive',sourceTab:'drive',layout:4,refresh:4,driveResolvedAlbums:[{id:'abcdefghijklmnop',name:'家族'}],driveAutoResume:true}));
    sessionStorage.setItem('photo-memory-viewer.drive-session.v1',JSON.stringify({clientId:'mock-client.apps.googleusercontent.com',scope:'https://www.googleapis.com/auth/drive.readonly',token:'test-token',expires:Date.now()+300000}));
  });
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=','base64');
  await page.route('https://www.googleapis.com/drive/v3/**',async r=>{
    const u=new URL(r.request().url()),q=u.searchParams.get('q')||'';let data;
    if(u.searchParams.get('alt')==='media')return r.fulfill(u.pathname.endsWith('/link')?{contentType:'text/plain',body:'[InternetShortcut]\nURL=https://youtu.be/dQw4w9WgXcQ'}:{contentType:'image/png',body:pixel});
    if(u.pathname.endsWith('/abcdefghijklmnop'))data={id:'abcdefghijklmnop',name:'20200101 家族',mimeType:'application/vnd.google-apps.folder'};
    else if(q.includes('slow')){await gate;data={files:[{id:'portrait-later',name:'later.png'}]};}
    else data={files:[{id:'landscape',name:'landscape.png'},{id:'portrait-first',name:'portrait.png'},{id:'link',name:'video.url'},{id:'slow',name:'20210203 散歩',mimeType:'application/vnd.google-apps.folder'}]};
    return r.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.reload();
  await page.waitForFunction(()=>window.__players?.[0]?.seeks.length && document.querySelectorAll('.memory-tile img').length===3);
  assert.equal(await page.locator('#choose-folder').isDisabled(),true);
  assert.equal(await page.locator('#play').count(),0);assert.equal(await page.locator('#apply').count(),0);
  assert.equal(await page.locator('#play-state').innerText(),'再生中');
  assert.equal(await page.locator('.memory-tile img').evaluateAll(images=>images.every(img=>img.dataset.checkedId.includes('portrait'))),true);
  const first=await page.evaluate(()=>window.__players[0].seeks[0]);assert.ok(first.point>0&&first.point<=236);
  await page.waitForTimeout(4200);assert.ok(await page.evaluate(()=>window.__players[0].seeks.length>=2));
  assert.equal(await page.evaluate(()=>window.__players.length),1);
  console.log('PASS priority video before slow metadata, delayed duration randomized promptly, same video seeks each refresh; only approved portraits displayed');
  await page.click('#settings-toggle');
  await page.evaluate(()=>{window.__photo=document.querySelector('.memory-tile img');});
  await page.selectOption('#effect','slide');await page.selectOption('#fit','contain');await page.locator('#volume').fill('25');await page.uncheck('#youtube-sound');
  assert.equal(await page.evaluate(()=>window.__photo===document.querySelector('.memory-tile img')),true);
  assert.equal(await page.evaluate(()=>window.__players[0].volume),25);assert.equal(await page.evaluate(()=>window.__players[0].muted),true);
  assert.equal(await page.locator('.memory-tile').first().evaluate(el=>el.style.getPropertyValue('--fit')),'contain');
  await page.fill('#start-date','20300101');await page.fill('#end-date','20301231');
  await page.waitForFunction(()=>document.querySelectorAll('.memory-tile').length===0);
  await page.click('#all-dates');await page.waitForFunction(()=>document.querySelectorAll('.memory-tile').length===4);
  assert.equal(await page.locator('#play-state').innerText(),'再生中');
  await page.click('#stop');await page.click('[data-layout="6"]');
  await page.waitForFunction(()=>document.querySelectorAll('.memory-tile').length===6);
  assert.equal(await page.locator('#play-state').innerText(),'停止中');
  release();await page.waitForFunction(()=>!document.getElementById('choose-folder').disabled);
  assert.equal(await page.locator('#play-state').innerText(),'停止中');
  await page.click('#stop');assert.equal(await page.locator('#play-state').innerText(),'再生中');
  await page.fill('#start-date','20210203');await page.fill('#end-date','20210203');
  await page.waitForFunction(()=>document.getElementById('folder-caption').textContent==='20210203 散歩');
  assert.equal(await page.locator('.video-tile').count(),0);
  await page.fill('#start-date','202102');await page.selectOption('#effect','fade');
  assert.equal(await page.locator('#folder-caption').innerText(),'20210203 散歩');
  assert.equal(await page.locator('.memory-tile').first().evaluate(el=>el.classList.contains('fade')),true);
  await page.click('#all-dates');await page.waitForFunction(()=>!!document.querySelector('.video-tile'));
  console.log('PASS live date/layout/effect/fit/audio during scan, no-media recovery, pause preserved, invalid date retains previous period');
  await page.uncheck('#youtube-enabled');await page.waitForFunction(()=>!document.querySelector('.video-tile'));
  await page.evaluate(()=>window.__faceFailure=true);await page.click('#reload-source');
  await page.waitForFunction(()=>document.getElementById('face-status').textContent.includes('失敗'));
  assert.equal(await page.locator('.memory-tile img').count(),0);
  assert.equal(await page.locator('#play-state').innerText(),'停止中');
  assert.deepEqual(errors,[]);console.log('PASS face detector errors fail closed without showing unverified images; no uncaught errors');
  await browser.close();
})().catch(async error=>{console.error(error);await browser?.close();process.exitCode=1;});
