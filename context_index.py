"""Private local document snapshot and bounded, offline full-text retrieval."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time

STOP = set('what which who why when where how would should could these those that this the and for with from are you your our can about have has will was were did does its tell please что как когда где это для при какие какой какая нужно можно'.split())
FOLLOW = re.compile(r'\b(it|its|there|that|those|they|them|это|этот|эта|там|он|она|они)\b', re.I)
WORDS = re.compile(r'[^\W\d_]{3,}', re.U)


ENDING = re.compile('(?:иями|ями|ами|ией|ого|его|ому|ему|ыми|ими|ов|ев|ей|ий|ый|ой|ая|яя|ое|ее|ые|ие|ых|их|ам|ям|ах|ях|ом|ем|ую|юю|[аяыиеоуюь])$')


def stem(word):
    # The query is a prefix match, and Russian endings change with case and number:
    # 'тарифы' must also find 'тарифные', 'интеграции' must find 'интеграция'.
    if not re.fullmatch('[а-я]+', word):
        return word
    short = ENDING.sub('', word)
    return short if len(short) >= 4 else word


def terms(text):
    return list(dict.fromkeys(stem(w) for w in WORDS.findall(text.casefold().replace('ё','е')) if w not in STOP))


def settings():
    path = Path(os.environ.get('MEET_COPILOT_CONFIG') or Path.home()/'.config/meet-copilot/config.json')
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}


def context_root():
    return Path(os.environ.get('MEET_COPILOT_CONTEXT') or Path.home()/'.config/meet-copilot/context')


class ContextIndex:
    """Index selected text once on startup. Never persist documents in the software repository."""
    def __init__(self, root=None, config=None):
        self.root = Path(root or context_root())
        self.config = settings() if config is None else config
        self.lock = threading.Lock()
        self.db = sqlite3.connect(':memory:', check_same_thread=False)
        self.db.execute('CREATE VIRTUAL TABLE search USING fts5(body, title, tokenize="unicode61")')
        self.rows = {}
        files=[]; skipped=[]; total=0; digest=hashlib.sha256()
        if self.root.is_symlink():
            raise ValueError('Context directory must not be a symlink.')
        for directory, dirs, names in os.walk(self.root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not d.startswith('.') and not (Path(directory)/d).is_symlink())
            for name in sorted(names):
                path=Path(directory)/name
                if name.startswith('.') or path.is_symlink() or not path.is_file(): continue
                if path.suffix.lower() not in ('.md','.txt'):
                    # Reported in the status and on screen: a .docx or .pdf left out must not go unnoticed.
                    skipped.append(path.relative_to(self.root).as_posix()); continue
                if path.stat().st_size > 5_000_000: raise ValueError('A context file exceeds the 5 MB limit.')
                raw=path.read_bytes(); total+=len(raw)
                if total > 20_000_000: raise ValueError('Selected context exceeds 20 MB.')
                text=raw.decode('utf-8'); relative=path.relative_to(self.root).as_posix()
                files.append(relative); digest.update(relative.encode()+b'\0'+raw+b'\0')
                for section,line,body in self.passages(text):
                    ident=len(self.rows)+1
                    self.rows[ident]={'text':body,'source':{'title':relative,'path':relative,'section':section,'line':line,'authority':'User-selected document'}}
                    self.db.execute('INSERT INTO search(rowid,body,title) VALUES(?,?,?)',(ident,body,relative+' '+section))
        self.db.commit()
        self.metadata={'documents':len(files),'passages':len(self.rows),'bytes':total,'sha256':digest.hexdigest(),'files':files,'skipped':skipped}

    @staticmethod
    def passages(text):
        section=''; paragraph=[]; start=1
        def split_block(block,line):
            # Keep paragraph conditions together. Oversized paragraphs remain local-searchable,
            # but are never silently truncated to fit an outbound packet.
            return section,line,'\n'.join(block)
        for number,line in enumerate(text.splitlines(),1):
            if line.startswith('#'):
                if paragraph: yield split_block(paragraph,start);paragraph=[]
                section=line.lstrip('# ').strip()
            elif not line.strip():
                if paragraph: yield split_block(paragraph,start);paragraph=[]
            else:
                if not paragraph:start=number
                paragraph.append(line)
        if paragraph: yield split_block(paragraph,start)

    def search(self, question, dialogue=(), final_speech='', *, preliminary=False, local=False):
        started=time.perf_counter_ns()
        current=(final_speech or question)+' '+question
        selected_terms=terms(current)[:20]
        follow=bool(FOLLOW.search(current)) or len(terms(current))<=2
        if follow:
            recent=[row[2] for row in dialogue[-6:] if row[2] not in (question, final_speech)]
            selected_terms+=terms(' '.join(recent[-2:]))[:12]
        for group in self.config.get('search_aliases',[]):
            if isinstance(group,list) and any(isinstance(x,str) and x.casefold() in current.casefold() for x in group):
                selected_terms += terms(' '.join(x for x in group if isinstance(x,str)))[:8]
        selected_terms=list(dict.fromkeys(selected_terms))[:40]
        expression=' OR '.join('"'+term+'"*' for term in selected_terms)
        results=[]; limit=3400 if preliminary else 7000; count=3 if preliminary else 6
        if expression:
            with self.lock:
                hits=self.db.execute('SELECT rowid FROM search WHERE search MATCH ? ORDER BY bm25(search,1.0,2.0) LIMIT 80',(expression,)).fetchall()
            for (ident,) in hits:
                row=self.rows[ident]; ref='R'+str(len(results)+1)
                passage={'id':ref,'title':row['source']['title'],'section':row['source']['section'],'text':row['text']}
                candidate={'source':row['source'],'passage':passage}
                size=len(json.dumps([x['passage'] for x in results]+[passage],ensure_ascii=False,separators=(',',':')).encode())
                if size>limit: continue
                results.append(candidate)
                if len(results)>=count:break
        evidence_bytes=len(json.dumps([x['passage'] for x in results],ensure_ascii=False,separators=(',',':')).encode())
        return {'results':results,'evidence_bytes':evidence_bytes,'retrieval_ms':(time.perf_counter_ns()-started)/1e6,'index_sha256':self.metadata['sha256']}
