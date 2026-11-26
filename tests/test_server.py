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

class ContextTests(unittest.TestCase):
    def test_empty_and_multiple_documents(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'MEET_COPILOT_CONFIG':''}):
            text, meta = load_bundle(root)
            self.assertEqual(meta['files'], [])
            self.assertIn('No reference documents', text)
            Path(root,'a.md').write_text('Fictional amber widget has three settings.')
            Path(root,'b.txt').write_text('Fictional blue widget is rechargeable.')
            Path(root,'ignored.json').write_text('{}')
            text, meta = load_bundle(root)
            self.assertEqual(meta['files'], ['a.md','b.txt'])
            self.assertIn('amber widget',text)
            self.assertIn('rechargeable',text)
    def test_symlink_not_transmitted(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'MEET_COPILOT_CONFIG':''}):
            Path(root,'link.md').symlink_to('/etc/hosts')
            self.assertEqual(load_bundle(root)[1]['files'], [])
    def test_context_limit(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root,'large.md').write_text('x'*140001)
            with self.assertRaises(ValueError): load_bundle(root)
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
