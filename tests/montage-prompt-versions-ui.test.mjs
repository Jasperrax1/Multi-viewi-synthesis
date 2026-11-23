import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createMontagePresetStore} from '../server/montage-preset-store.mjs';
import {startPromptEditor} from '../server/montage-prompt-editor.mjs';

const id = 'minimax-h3-highspeed';
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(),'prompt-version-ui-'));
  const file = path.join(directory,'presets.json');
  const values=JSON.parse(await readFile(new URL('../config/montage-presets.json',import.meta.url),'utf8'));
  values[id].activeVersionId='rotation';
  values[id].prompt=values[id].promptVersions.rotation.prompt;
  await writeFile(file,JSON.stringify(values));
  const store = createMontagePresetStore(file);
  const server = await startPromptEditor({port:0,store});
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  t.after(async()=>{await browser.close();await server.close();await rm(directory,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  await page.clock.install();
  await page.goto(server.origin);
  await page.waitForFunction(()=>!document.querySelector('#prompt').disabled);
  return {store,page,browser,origin:server.origin};
}
async function text(page,selector,expected) {
  await page.waitForFunction(({selector,expected})=>document.querySelector(selector).textContent.includes(expected),{selector,expected});
}

test('prompt version UI preserves independent drafts, saves inactive text and activates only saved versions',async t=>{
  const {store,page,browser,origin}=await fixture(t);
  await text(page,'#active-version','旋转运镜');
  assert.equal(await page.locator('[data-version="rotation"]').getAttribute('aria-pressed'),'true');
  const initial = await store.read();
  const mini = initial.presets.find(p=>p.id===id);
  const originalRotation = mini.versions.find(v=>v.id==='rotation').prompt;
  const originalCinema = mini.versions.find(v=>v.id==='cinematic').prompt;
  await page.locator('#prompt').fill(originalRotation+'\n旋转草稿');
  await page.locator('[data-version="cinematic"]').click();
  assert.equal(await page.locator('#prompt').inputValue(),originalCinema);
  assert.equal(await page.locator('#activate-version').isEnabled(),true);
  await page.locator('#prompt').fill(originalCinema+'\n电影版修改');
  assert.equal(await page.locator('#activate-version').isDisabled(),true);
  await text(page,'#save-label','保存此版本');
  await page.locator('#save').click();
  await text(page,'#notice','此版本已保存');
  let snapshot=await store.read();
  assert.equal(snapshot.presets.find(p=>p.id===id).activeVersionId,'rotation');
  await page.locator('[data-version="rotation"]').click();
  assert.equal(await page.locator('#prompt').inputValue(),originalRotation+'\n旋转草稿');
  await page.locator('[data-version="cinematic"]').click();
  await page.locator('#activate-version').click();
  await text(page,'#active-version','电影穿梭');
  snapshot=await store.read();
  assert.equal(snapshot.presets.find(p=>p.id===id).activeVersionId,'cinematic');
  assert.equal((await store.resolve(id)).prompt,originalCinema+'\n电影版修改');
  await page.locator('[data-preset="vidu-q2-pro-fast"]').click();
  assert.equal(await page.locator('[data-version="cinematic"]').count(),0);
  await page.locator('[data-preset="minimax-h3-highspeed"]').click();
  await page.locator('[data-version="rotation"]').click();
  assert.equal(await page.locator('#prompt').inputValue(),originalRotation+'\n旋转草稿');

  // Another window activates rotation while this window retains an unsaved rotation draft.
  snapshot=await store.read();
  await store.activateVersion(id,'rotation',snapshot.revision);
  await page.clock.runFor(8100);
  await text(page,'#active-version','旋转运镜');
  assert.equal(await page.locator('#prompt').inputValue(),originalRotation+'\n旋转草稿');
  await text(page,'#notice','未保存编辑已保留');
  // A new page reflects persisted activation instead of the other page's selected editor tab.
  const another=await browser.newPage();
  await another.goto(origin);
  await text(another,'#active-version','旋转运镜');
  assert.equal(await another.locator('[data-version="rotation"]').getAttribute('aria-pressed'),'true');
  assert.equal(await another.locator('#prompt').inputValue(),originalRotation);
});

test('an old poll cannot undo a newer activation',async t=>{
  const {page,store}=await fixture(t);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let capturedResolve;
  const captured=new Promise(resolve=>{capturedResolve=resolve;});
  let holdNext=true;
  await page.route('**/api/presets',async route=>{
    if(route.request().method()==='GET'&&holdNext){
      holdNext=false;
      const response=await route.fetch();
      const snapshot=await response.json();
      capturedResolve();
      await gate;
      await route.fulfill({response,json:snapshot});
    }else await route.continue();
  });
  await page.clock.runFor(8100);
  await captured;
  await page.locator('[data-version="cinematic"]').click();
  await page.locator('#activate-version').click();
  await text(page,'#active-version','电影穿梭');
  release();
  await page.waitForTimeout(100);
  await text(page,'#active-version','电影穿梭');
  assert.equal((await store.read()).presets.find(p=>p.id===id).activeVersionId,'cinematic');
});
