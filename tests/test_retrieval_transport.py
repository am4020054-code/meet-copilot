"""Synthetic inputs only: verify what crosses the provider boundary."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from context_index import ContextIndex
from hints import gateway_stream, HintJob

class TransportTests(unittest.TestCase):
    def test_only_retrieved_passages_and_metrics_sent(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root,'a.md').write_text('The fictional amber battery requires dry storage.')
            Path(root,'b.md').write_text('Unrelated fictional violet fabric is washable.')
            index=ContextIndex(root,config={})
            evidence=index.search('How do I store the amber battery?')
            requests=[]; traces=[]
            class Response:
                status=200
                def __iter__(self):
                    text='SAY: Keep the battery dry.\nUSE: R1\nRU: Как хранить?\nFACTS: Dry storage is required. (R1)\n'
                    yield b'data: '+json.dumps({'choices':[{'delta':{'content':text}}]}).encode()+b'\n'
                    yield b'data: [DONE]\n'
            class Connection:
                sock=None
                def __init__(self,*args,**kwargs):pass
                def connect(self):pass
                def request(self,*args):requests.append(args)
                def getresponse(self):return Response()
                def close(self):pass
            with patch('hints.http.client.HTTPSConnection',Connection), patch('hints.WARM.take', return_value=None):
                result=gateway_stream('Generic rules','synthetic-placeholder','How do I store the amber battery?',[],False,HintJob(),lambda *args:None,evidence=evidence,context_trace=traces.append)
            raw=requests[0][2]; body=json.loads(raw)
            self.assertIn('dry storage',body['messages'][1]['content'])
            self.assertNotIn('violet fabric',raw.decode())
            self.assertEqual(traces[0]['gateway_body_bytes'],len(raw))
            self.assertEqual(result['source_refs_local'][0]['title'],'a.md')
            self.assertEqual(result['context_metrics']['source_count'],1)

if __name__=='__main__':unittest.main()
