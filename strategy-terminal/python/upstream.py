import os, subprocess, sys
from pathlib import Path
REPO=os.environ.get('UPSTREAM_REPO','yankhaing-cmyk/BursaMusangKing')
REF=os.environ.get('UPSTREAM_REF','main')
DIR=Path(os.environ.get('UPSTREAM_DIR','_upstream')).resolve(); _loaded=False

def ensure():
    global _loaded
    if _loaded:return DIR
    if not (DIR/'screener.py').exists():
        DIR.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run(['git','clone','--depth','1','--branch',REF,f'https://github.com/{REPO}.git',str(DIR)],check=True)
    if str(DIR) not in sys.path:sys.path.append(str(DIR))
    _loaded=True;return DIR

def engine():
    ensure();import config,data_fetcher,indicators,screener
    return {'config':config,'data_fetcher':data_fetcher,'indicators':indicators,'screener':screener}
