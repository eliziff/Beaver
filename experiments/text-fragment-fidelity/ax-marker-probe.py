#!/usr/bin/env python3
"""Probe whether CDP exposes Chromium's actual text-fragment markers via AX."""
import hashlib
import importlib.util
import json
import tempfile
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fragment_exact_gate", HERE / "webdriver-exact-gate.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)

seed = next(row for row in gate.read_jsonl(gate.TARGETS) if row["label"] == "BCCA_2008_BCCA_283_p85_short-exact")
manifest = {gate.url_key(row["url"]): row for row in gate.read_jsonl(gate.MANIFEST) if row.get("url") and row.get("file") and not row.get("challenged")}
cached = manifest[gate.url_key(seed["target"].split("#")[0])]
files = {cached["file"]: gate.CACHE / cached["file"]}
options = Options()
options.page_load_strategy = "eager"
for argument in (
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions",
    "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
    "--disable-sync", "--metrics-recording-only", "--no-first-run", "--renderer-process-limit=1",
    "--disable-features=MediaRouter,OptimizationHints,Translate", "--force-renderer-accessibility",
    "--window-size=480,520", "--force-device-scale-factor=1",
):
    options.add_argument(argument)
options.add_argument(f"--user-data-dir={tempfile.mkdtemp(prefix='fragment-ax-probe-')}")
with gate.CacheServer(files) as server:
    started = time.perf_counter()
    driver = webdriver.Chrome(service=Service(str(gate.DRIVER)), options=options)
    try:
        launched = time.perf_counter()
        fragment = seed["target"].partition("#")[2]
        replay = hashlib.sha1(seed["label"].encode()).hexdigest()[:12]
        driver.get(f"{server.origin}/page/{cached['file']}?seed={replay}#{fragment}")
        navigated = time.perf_counter()
        dom = driver.execute_cdp_cmd("DOM.getDocument", {"depth": -1, "pierce": True})["root"]
        target_pseudos = []
        def visit_dom(node, parent=None):
            if node.get("pseudoType") == "target-text":
                target_pseudos.append({"parent": parent, "node": node})
            for key in ("children", "pseudoElements", "shadowRoots"):
                for child in node.get(key, []):
                    visit_dom(child, {name: node.get(name) for name in ("nodeId", "backendNodeId", "nodeName", "nodeValue", "attributes")})
        visit_dom(dom)
        dom_read = time.perf_counter()
        driver.execute_cdp_cmd("Accessibility.enable", {})
        tree = driver.execute_cdp_cmd("Accessibility.getFullAXTree", {"depth": -1})["nodes"]
        marked = []
        for node in tree:
            properties = {item["name"]: item.get("value", {}).get("value") for item in node.get("properties", [])}
            marker_properties = {name: value for name, value in properties.items() if "marker" in name.lower() or "highlight" in name.lower()}
            if marker_properties:
                marked.append({"role": node.get("role", {}).get("value"), "name": node.get("name", {}).get("value"), "properties": marker_properties})
        named = next((node for node in tree if "addition, DeMitri" in str(node.get("name", {}).get("value", ""))), None)
        property_names = sorted({item["name"] for node in tree for item in node.get("properties", [])})
        driver.switch_to.new_window("tab")
        driver.get("chrome://accessibility/")
        ax_opened = time.perf_counter()
        controls = driver.execute_script("return [...document.querySelectorAll('button,a')].map((e,i)=>({i,tag:e.tagName,text:e.innerText,id:e.id,href:e.href,parent:e.parentElement?.innerText?.slice(0,300)}))")
        inputs = driver.execute_script("return [...document.querySelectorAll('input,select')].map(e=>({tag:e.tagName,type:e.type,id:e.id,name:e.name,value:e.value,checked:e.checked,labels:[...e.labels||[]].map(x=>x.innerText)}))")
        driver.execute_script("const e=document.getElementById('filter-allow'); e.value='name markerTypes markerStarts markerEnds'; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}))")
        target_button = next(item for item in controls if item.get("text") == "Show accessibility tree" and "2008 BCCA 283" in (item.get("parent") or ""))
        hook_info = driver.execute_script("return {windowKeys:Object.getOwnPropertyNames(window).filter(x=>/web|listener|access|ui/i.test(x)),crKeys:typeof cr==='object'?Object.getOwnPropertyNames(cr):[],chromeKeys:typeof chrome==='object'?Object.getOwnPropertyNames(chrome):[]}")
        hooked = driver.execute_script("window.__axResult=null; const owner=typeof cr==='object'&&typeof cr.webUIListenerCallback==='function'?cr:window; const original=owner.webUIListenerCallback; if(typeof original!=='function') return false; owner.webUIListenerCallback=function(event,...args){if(event==='showOrRefreshTree'&&args[0]?.tree){window.__axResult=args[0];return;} return original.call(this,event,...args)}; return true")
        driver.execute_script("document.getElementById(arguments[0]).click()", target_button["id"])
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            tree_text = driver.execute_script("return window.__axResult?.tree || ''")
            if tree_text:
                break
            time.sleep(0.05)
        dumped = time.perf_counter()
        terms = ("marker", "highlight", "textfragment", "text fragment")
        marker_lines = [line for line in tree_text.splitlines() if any(term in line.lower() for term in terms)]
        print(json.dumps({
            "cdp": {"nodes": len(tree), "marked": marked, "sample": named, "propertyNames": property_names},
            "dom": {"targetTextPseudos": target_pseudos},
            "chromeAccessibility": {"hooked": hooked, "hookInfo": hook_info, "treeChars": len(tree_text), "markerLines": marker_lines, "inputs": inputs},
            "seconds": {"launch": launched-started, "navigate": navigated-launched, "dom": dom_read-navigated, "openAx": ax_opened-dom_read, "dump": dumped-ax_opened, "total": dumped-started},
        }, ensure_ascii=False, indent=1))
    finally:
        driver.quit()
