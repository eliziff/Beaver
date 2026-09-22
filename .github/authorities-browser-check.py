import asyncio,json,os,time
from pathlib import Path
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True)
  page=await browser.new_page(viewport={'width':1280,'height':900})
  errors=[];workers=[];events=[];out=Path(os.environ['HIGHLIGHT_RECEIPTS'])
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('worker',lambda w:workers.append(w.url))
  page.on('response',lambda r:events.append({'url':r.url,'status':r.status}))
  gate=asyncio.Event()
  async def hold_annotations(route):
   await gate.wait();await route.continue_()
  await page.route('**/annotations',hold_annotations)
  try:
   await page.goto('http://127.0.0.1:3036/.regression/index.html')
   started=time.monotonic()
   await page.get_by_role('button',name='Edit in PDF').click()
   await page.locator('[data-page-number="1"] canvas').wait_for(timeout=15000)
   first_paint_ms=round((time.monotonic()-started)*1000)
   assert not any(x['url'].endswith('/annotations') for x in events),'First paint waited for annotation response'
   gate.set()
   await page.wait_for_function('document.querySelectorAll("[data-page-number=\\"1\\"] [data-pdf-text-run]").length>3')
   for i in range(200):
    if await page.get_by_role('button',name='Highlight text',exact=True).is_enabled():break
    await page.wait_for_timeout(50)
   await page.get_by_role('button',name='Highlight text',exact=True).click()
   words=page.locator('[data-page-number="1"] [data-pdf-text-run]')
   first=await words.nth(0).bounding_box();last=await words.nth(3).bounding_box()
   await page.mouse.move(first['x']-2,first['y']+first['height']/2)
   await page.mouse.down();await page.mouse.move(last['x']+last['width']+2,last['y']+last['height']/2,steps=12)
   await page.mouse.up()
   saved=[]
   for i in range(50):
    product=await(await page.request.get('http://127.0.0.1:3037/api/fixture')).json()
    saved=product['state']['authorities']['scan'].get('annotations',{}).get('scan',{}).get('marks',[])
    if any(mark['origin']=='manual' and mark['excerpt']=='Recognized words are selectable' for mark in saved):break
    await page.wait_for_timeout(100)
   assert any(mark['origin']=='manual' and mark['excerpt']=='Recognized words are selectable' for mark in saved),f'No persisted manual OCR highlight: {saved}'
   (out/'saved-marks.json').write_text(json.dumps(saved,indent=2))
   await page.screenshot(path=str(out/'actual-authorities-highlight.png'))
   await page.locator('[data-page-number="12"][data-geometry-ready="true"]').wait_for(state='attached')
   await page.evaluate('''()=>{const s=document.querySelector('.overflow-auto'),pg=document.querySelector('[data-page-number="6"]');s.scrollTop=pg.offsetTop+pg.getBoundingClientRect().height+2+s.clientHeight;}''')
   before=await asyncio.wait_for(page.evaluate('window.heartbeats'),3)
   await page.wait_for_timeout(300)
   after=await asyncio.wait_for(page.evaluate('window.heartbeats'),3);assert after>before,'Heartbeat stopped at page gap'
   assert workers,'PDF.js dedicated worker did not start'
   assert not errors,errors
   trace=await(await page.request.get('http://127.0.0.1:3037/api/fixture-trace')).json()
   assert not any('authorities-runtime' in x['url'] or '/resolution' in x['url'] for x in trace)
   annotations=[x for x in trace if x['url'].endswith('/annotations')]
   assert annotations and all(x['bytes']<1000 for x in annotations)
   await page.reload()
   await page.get_by_role('button',name='Edit in PDF').click()
   await page.locator('[data-page-number="1"] canvas').wait_for(timeout=15000)
   await page.get_by_text('Recognized words are selectable',exact=True).first.wait_for()
   await page.wait_for_function('document.querySelectorAll("[data-page-number=\\"1\\"] [data-pdf-text-run]").length>3')
   (out/'browser.json').write_text(json.dumps({'dedicatedWorkers':workers,'errors':errors,'heartbeatAdvanced':after-before,'firstPaintMs':first_paint_ms,'noStatelessUpload':True,'firstPaintBeforeAnnotations':True,'persistedOcrExcerpt':True,'reloadedSelectionAndMarks':True,'requests':trace},indent=2))
   print('PASS actual Authorities editor/host/HTTP with dedicated PDF.js worker, persisted OCR highlight and reload')
  finally:
   gate.set()
   (out/'browser-events.json').write_text(json.dumps({'responses':events,'errors':errors,'workers':workers},indent=2))
   try:await page.screenshot(path=str(out/'last-browser-state.png'),timeout=3000)
   finally:
    print('BROWSER ERRORS',errors,'WORKERS',workers)
    await browser.close()
asyncio.run(main())
