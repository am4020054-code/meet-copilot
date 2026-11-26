import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import urlopen, Request
from urllib.error import HTTPError

from hints import load_bundle, parse_hint, gateway_messages, HintError
from server import make_server
from context_index import ContextIndex

class ContextTests(unittest.TestCase):
    def test_recursive_documents_and_bounded_retrieval(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root,'nested').mkdir()
            Path(root,'nested/a.md').write_text('# Amber widget\n\nAmber widget is rechargeable only with the supplied adapter.')
            Path(root,'b.txt').write_text('Blue widget has replaceable batteries.')
            Path(root,'ignored.json').write_text('{}')
            index=ContextIndex(root,config={})
            self.assertEqual(index.metadata['documents'],2)
            result=index.search('How is the amber widget charged?')
            self.assertIn('supplied adapter',result['results'][0]['passage']['text'])
            self.assertLessEqual(result['evidence_bytes'],7000)
            self.assertLessEqual(len(index.search('widget',preliminary=True)['results']),3)
            self.assertEqual(result['results'][0]['source']['path'],'nested/a.md')
    def test_symlinks_not_indexed(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root,'link.md').symlink_to('/etc/hosts')
            Path(root,'directory').symlink_to('/tmp',target_is_directory=True)
            self.assertEqual(ContextIndex(root,config={}).metadata['files'], [])
    def test_larger_context_and_aliases_followup(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root,'large.md').write_text(('Unrelated filler text.\n\n'*7000)+'# Violet widget\n\nViolet widget battery must stay dry.')
            index=ContextIndex(root,config={'search_aliases':[['battery','батарея']]})
            self.assertGreater(index.metadata['bytes'],140000)
            self.assertIn('Violet',index.search('батарея')['results'][0]['passage']['text'])
            self.assertIn('Violet',index.search('What about it?',((1,'mic','The violet widget'),))['results'][0]['passage']['text'])
    def test_context_not_in_system_and_exact_citations(self):
        evidence={'results':[{'passage':{'id':'R1','text':'Fictional violet widget must stay dry.'},'source':{'title':'example.md'}}]}
        answer=parse_hint('SAY: Keep it dry.\nUSE: R1, R8\nFACTS: Keep dry. (R1)\nUnsupported. (R8)','How?',evidence=evidence)
        self.assertEqual(answer['source_refs_local'],[{'title':'example.md'}])
        self.assertNotIn('Unsupported',answer['facts'])
        self.assertIn('не найдены',answer['context_notice'])
        messages=gateway_messages('User rules','How?',[],False,mode=None,dialogue=(),retained=(),context_limited=False,refresh_next=False,preliminary=False,displayed='',final_speech='',evidence=evidence)
        self.assertNotIn('Fictional violet widget',messages[0]['content'])
        self.assertIn('Fictional violet widget',messages[1]['content'])
    def test_parse_and_no_echo(self):
        result=parse_hint('SAY: We can discuss the options.\nRU: Какие варианты?', 'What options?')
        self.assertEqual(result['answer_en'],'We can discuss the options.')
        with self.assertRaises(HintError): parse_hint('SAY: What options?', 'What options?')
    def test_preview_is_not_speech(self):
        messages=gateway_messages('Example reference context','What next?',[],False,
            mode='discussion',dialogue=((1,'mic','I can send details.'),),retained=(),
            context_limited=False,refresh_next=False,preliminary=False,
            displayed='A suggested line.',final_speech='What next?')
        self.assertIn('not spoken unless confirmed',messages[1]['content'])
        self.assertIn('Turn 1, Representative',messages[1]['content'])

class ServerTests(unittest.TestCase):
    def test_offline_status_assets_and_csrf(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            'ASSEMBLYAI_API_KEY':'', 'MEET_COPILOT_CONTEXT':root,'MEET_COPILOT_CONFIG':''}):
            app=make_server(0,credentials=Path(root,'missing.json'),journal=Path(root,'logs'))
            thread=threading.Thread(target=app.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{app.server_port}'
            try:
                status=json.load(urlopen(base+'/api/status'))
                self.assertFalse(status['configured'])
                self.assertFalse(status['gateway_enabled'])
                self.assertNotIn('key',status)
                self.assertEqual(status['bundle']['files'],[])
                response=json.load(urlopen(Request(base+'/api/context/preview',data=json.dumps({'question':'example'}).encode(),headers={'Content-Type':'application/json','Origin':base,'X-CSRF-Token':status['csrf']})))
                self.assertEqual(response['results'],[])
                for path in ['/', '/app.js','/core.mjs','/style.css','/audio-worklet.js']:
                    self.assertEqual(urlopen(base+path).status,200)
                with self.assertRaises(HTTPError) as caught:
                    urlopen(Request(base+'/api/token',data=b'{}',headers={'Content-Type':'application/json'}))
                self.assertEqual(caught.exception.code,403)
                with self.assertRaises(HTTPError) as caught:
                    urlopen(Request(base+'/api/token',data=b'{}',headers={'Content-Type':'application/json',
                        'Origin':base,'X-CSRF-Token':status['csrf']}))
                self.assertEqual(caught.exception.code,409)
            finally:
                app.shutdown();app.server_close();thread.join()

if __name__=='__main__': unittest.main()
