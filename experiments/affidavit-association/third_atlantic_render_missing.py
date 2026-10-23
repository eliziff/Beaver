"""Retain already-receipted original images; render only missing review pages."""
import sys,fitz
from third_atlantic_sources import s
r=s.source(sys.argv[1]);d=s.views_folder(r)
with fitz.open(r['original_path'])as pdf:
 for n in map(int,sys.argv[2:]):
  p=d/f'page-{n:04}.png'
  if not p.exists():pdf[n-1].get_pixmap(dpi=180,alpha=False).save(p)
  print(p)
