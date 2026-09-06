import json
import time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait

output = Path(__file__).parent / 'results'
output.mkdir(exist_ok=True)
options = webdriver.ChromeOptions()
options.add_argument('--headless=new')
options.add_argument('--window-size=1440,1000')
options.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
cached = list((Path.home() / '.cache/selenium/chromedriver/win64').glob('*/chromedriver.exe'))
service = Service(str(max(cached, key=lambda p: tuple(map(int, p.parent.name.split('.')))))) if cached else Service()
with webdriver.Chrome(service=service, options=options) as driver:
    driver.get('http://127.0.0.1:3011/experiments/pdf-viewer/index.html')
    wait = WebDriverWait(driver, 60)
    try:
        wait.until(lambda d: d.execute_script('return document.querySelectorAll("[data-page-number]").length===300 && !!document.querySelector("canvas")'))
    except Exception:
        driver.save_screenshot(str(output / 'failure.png'))
        print(driver.get_log('browser'), flush=True)
        print(driver.page_source[:5000], flush=True)
        raise
    print('Geometry and first page ready', flush=True)
    before = driver.execute_script('''const s=document.querySelector('.overflow-auto');
      return {height:s.scrollHeight, pages:[...document.querySelectorAll('[data-page-number]')].map(p=>[p.offsetWidth,p.offsetHeight]), ...window.pdfMetrics};''')
    driver.save_screenshot(str(output / 'first-page.png'))
    driver.execute_script('''const s=document.querySelector('.overflow-auto'),p=document.querySelector('[data-page-number="201"]');
      s.scrollTop+=p.getBoundingClientRect().top-s.getBoundingClientRect().top;''')
    start=time.perf_counter()
    wait.until(lambda d: d.execute_script('return !!document.querySelector(\'[data-page-number="201"] canvas\')'))
    jump_ms=(time.perf_counter()-start)*1000
    top=driver.execute_script("return document.querySelector('.overflow-auto').scrollTop")
    time.sleep(1)
    after=driver.execute_script('''const s=document.querySelector('.overflow-auto');
      return {height:s.scrollHeight, top:s.scrollTop, canvases:document.querySelectorAll('canvas').length,
      pages:[...document.querySelectorAll('[data-page-number]')].map(p=>[p.offsetWidth,p.offsetHeight])};''')
    assert before['height']==after['height'], (before['height'],after['height'])
    assert before['pages']==after['pages']
    assert top==after['top']
    assert after['canvases']<10, after['canvases']
    driver.save_screenshot(str(output / 'page-201.png'))
    driver.find_element('css selector','[aria-label="Zoom in"]').click()
    wait.until(lambda d: d.execute_script('return !!document.querySelector(\'[data-page-number="201"] canvas\') && document.body.textContent.includes("125%")'))
    driver.save_screenshot(str(output / 'zoom.png'))
    driver.set_window_size(700,900)
    wait.until(lambda d: d.execute_script('return !!document.querySelector("canvas") && document.querySelector("canvas").width<1000'))
    driver.save_screenshot(str(output / 'narrow.png'))
    report={**{k:v for k,v in before.items() if k!='pages'}, 'jumpMs':jump_ms,'canvasesAfterJump':after['canvases'],'stableGeometry':True,'stableScrollTop':True,'browserErrors':driver.get_log('browser')}
    (output/'metrics.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2),flush=True)
