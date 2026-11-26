"""Meet Copilot, bound to localhost with a limited provider context."""
import argparse
import json
import math
import os
import re
import secrets
import stat
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

from hints import DEFAULT_RETRY_AFTER, GOAL_ROUTE, MODEL, HintError, HintJob, gateway_stream, load_bundle
from session_journal import SESSION_ID, append_event

ROOT = Path(__file__).resolve().parent
VERSION = 'meet-copilot-public-1'
ASSETS = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'application/javascript'),
          '/core.mjs': ('core.mjs', 'application/javascript'), '/style.css': ('style.css', 'text/css'),
          '/audio-worklet.js': ('audio-worklet.js', 'application/javascript')}


def read_key(path):
    try:
        parent = path.parent.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_mode & 0o777 != 0o700 or parent.st_uid != os.getuid():
            return ''
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), encoding='utf-8') as file:
            item = os.fstat(file.fileno())
            if (not stat.S_ISREG(item.st_mode) or item.st_mode & 0o777 != 0o600 or item.st_uid != os.getuid()):
                return ''
            key = json.load(file).get('key', '')
        return key if isinstance(key, str) and re.fullmatch(r'[A-Za-z0-9_-]{16,256}', key) else ''
    except (OSError, ValueError, AttributeError):
        return ''


def strategy_context(data):
    mode = data.get('goal_mode')
    if mode is None:
        return None, (), (), False
    if not isinstance(mode, str) or mode not in GOAL_ROUTE:
        raise ValueError()
    rows, retained = data.get('dialogue', []), data.get('retained', [])
    if not isinstance(rows, list) or len(rows) > 520 or not isinstance(retained, list) or len(retained) > 8:
        raise ValueError()
    transcript = []
    ids = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError()
        turn, role, text = row.get('id'), row.get('role'), row.get('text')
        if (type(turn) is not int or not 1 <= turn <= 9_999_999 or turn in ids
                or role not in ('mic', 'tab') or not isinstance(text, str) or not text.strip() or len(text) > 12_000):
            raise ValueError()
        ids.add(turn)
        transcript.append((turn, role, text.strip()))
    if sum(len(row[2].encode()) for row in transcript) > 36_000:
        raise ValueError()
    validated = tuple(sorted({ref for ref in retained if type(ref) is int and ref in ids}))
    return mode, tuple(transcript), validated, data.get('context_limited') is True


def streaming_token(key):
    data = {'product': 'streaming', 'expires_in_seconds': 60, 'max_session_duration_seconds': 7200,
            'access': {name: {'enabled': False} for name in ('tts', 'speech_to_speech', 'llm_gateway', 'sync', 'dictation')}}
    request = Request('https://token.assemblyai.com/v1/token', data=json.dumps(data).encode(),
                      headers={'Content-Type': 'application/json', 'Authorization': key}, method='POST')
    try:
        with urlopen(request, timeout=10) as response:
            token = json.load(response)['token']
        if isinstance(token, str) and token:
            return token
    except (OSError, ValueError, KeyError):
        pass
    raise HintError('speech_auth', 'Не удалось подключить распознавание речи.')


class State:
    def __init__(self, credentials=None, journal=None, gateway=False):
        self.system, self.bundle = load_bundle()
        self.knowledge = {'cards': [], 'sources': [], 'limitations': 'Answers use the selected context. Verify important claims.'}
        self.key = os.environ.get('ASSEMBLYAI_API_KEY', '') or read_key(credentials or Path.home() / '.config/meet-copilot/credentials.json')
        self.gateway = gateway
        preferences = Path(os.environ.get('MEET_COPILOT_CONFIG') or Path.home() / '.config/meet-copilot/config.json')
        settings = json.loads(preferences.read_text(encoding='utf-8')) if preferences.is_file() else {}
        self.vocabulary = settings.get('vocabulary', {})
        self.speaker_labels_default = settings.get('speaker_diarization', {}).get('enabled') is True
        self.csrf = secrets.token_urlsafe(32)
        self.journal = journal or Path(os.environ.get('MEET_COPILOT_LOG_DIR', Path.home() / '.local/share/meet-copilot/sessions'))
        self.lock = threading.Lock()
        self.jobs = {}
        self.cancelled_before_start = OrderedDict()
        self.cache = OrderedDict()
        self.cooldown_until = 0.0

    def cooldown_remaining(self):
        with self.lock:
            return max(0, math.ceil(self.cooldown_until - time.monotonic()))

    def extend_cooldown(self, seconds):
        with self.lock:
            self.cooldown_until = max(self.cooldown_until, time.monotonic() + seconds)

    def start_job(self, job_id):
        with self.lock:
            wait = max(0, math.ceil(self.cooldown_until - time.monotonic()))
            if wait:
                return None, wait
            if job_id in self.cancelled_before_start or job_id in self.jobs or len(self.jobs) >= 3:
                return None, 0
            job = self.jobs[job_id] = HintJob()
            return job, 0

    def cancel_job(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                self.cancelled_before_start[job_id] = True
                if len(self.cancelled_before_start) > 128:
                    self.cancelled_before_start.popitem(last=False)
        if job is not None:
            job.cancel()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    @property
    def state(self):
        return self.server.state

    def valid_host(self):
        port = self.server.server_port
        return self.headers.get('Host') in {f'localhost:{port}', f'127.0.0.1:{port}'}

    def begin(self, status, content_type, size=None, retry_after=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type + '; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; object-src 'none'; connect-src 'self' wss://streaming.assemblyai.com; frame-ancestors 'none'; base-uri 'none'")
        if size is not None:
            self.send_header('Content-Length', str(size))
        if retry_after is not None:
            self.send_header('Retry-After', str(retry_after))
        self.end_headers()

    def send(self, status, data, retry_after=None):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.begin(status, 'application/json', len(body), retry_after)
        self.wfile.write(body)

    def event(self, kind, **data):
        self.wfile.write((json.dumps({'type': kind, **data}, ensure_ascii=False) + '\n').encode())
        self.wfile.flush()

    def do_GET(self):
        if not self.valid_host():
            return self.send(403, {'error': 'Доступ возможен только через локальный адрес.'})
        if self.path == '/api/status':
            return self.send(200, {'version': VERSION, 'key_saved': bool(self.state.key), 'configured': bool(self.state.key),
                                   'model': MODEL, 'journal_schema': 1, 'csrf': self.state.csrf,
                                   'bundle': self.state.bundle, 'knowledge': self.state.knowledge,
                                   'gateway_enabled': self.state.gateway,
                                   'vocabulary': self.state.vocabulary, 'speaker_labels_default': self.state.speaker_labels_default})
        asset = ASSETS.get(self.path)
        if not asset:
            return self.send(404, {'error': 'Страница не найдена.'})
        body = (ROOT / 'public' / asset[0]).read_bytes()
        self.begin(200, asset[1], len(body))
        self.wfile.write(body)

    def do_POST(self):
        expected = 'http://' + self.headers.get('Host', '')
        if (not self.valid_host() or self.headers.get('Origin') != expected
                or not secrets.compare_digest(self.headers.get('X-CSRF-Token', ''), self.state.csrf)):
            return self.send(403, {'error': 'Запрос разрешён только из локального окна.'})
        try:
            length = int(self.headers.get('Content-Length', 0))
            limit = 64_000 if self.path == '/api/ask' else 32_000
            if not 0 < length <= limit or not self.headers.get('Content-Type', '').startswith('application/json'):
                raise ValueError()
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError()
            if self.path == '/api/journal':
                try:
                    with self.state.lock:
                        append_event(self.state.journal, data, self.state.key)
                except OSError:
                    return self.send(500, {'error': 'Не удалось сохранить запись на этом компьютере.'})
                return self.send(200, {'saved': True})
            if self.path == '/api/token':
                if not self.state.gateway:
                    return self.send(409, {'error': 'В этом запуске звук и ответы отключены.'})
                if not self.state.key:
                    return self.send(409, {'error': 'Сохранённое подключение AssemblyAI недоступно.'})
                return self.send(200, {'token': streaming_token(self.state.key)})
            if self.path in ('/api/ask', '/api/cancel'):
                job_id = data.get('job_id')
                if not isinstance(job_id, str) or not SESSION_ID.fullmatch(job_id):
                    raise ValueError()
                if self.path == '/api/cancel':
                    self.state.cancel_job(job_id)
                    return self.send(200, {'ok': True})
                return self.ask(job_id, data)
            return self.send(404, {'error': 'Страница не найдена.'})
        except HintError as error:
            return self.send(502, {'error': str(error), 'code': error.code})
        except (ValueError, TypeError):
            return self.send(400, {'error': 'Не удалось прочитать запрос.'})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def ask(self, job_id, data):
        if not self.state.gateway:
            return self.send(409, {'error': 'Во время локального просмотра внешние ответы отключены.', 'code': 'preview_only'})
        question = data.get('question')
        history = data.get('history', [])
        manual = data.get('manual') is True
        if (not isinstance(question, str) or not 1 <= len(question.strip()) <= 4000
                or not isinstance(history, list) or any(not isinstance(line, str) for line in history)):
            raise ValueError()
        mode, dialogue, retained, context_limited = strategy_context(data)
        refresh_next = data.get('refresh_next') is True and mode is not None
        preliminary = data.get('preliminary') is True
        displayed, final_speech = data.get('displayed_preview',''), data.get('final_speech','')
        if (not isinstance(displayed,str) or len(displayed)>800
                or not isinstance(final_speech,str) or len(final_speech)>16_000):
            raise ValueError()
        if preliminary and (displayed or final_speech or manual or refresh_next):
            raise ValueError()
        history = [line[:900] for line in history[-6:]]
        question = question.strip()
        job, wait = self.state.start_job(job_id)
        if wait:
            return self.send(429, {'error': 'AssemblyAI просит подождать перед следующей подсказкой.',
                                   'code': 'rate_limited', 'retry_after_seconds': wait}, retry_after=wait)
        if job is None:
            return self.send(409, {'error': 'Эта подсказка уже отменена или готовится.', 'code': 'cancelled'})
        cache_key = (question, tuple(history), manual, mode, dialogue, retained, context_limited, refresh_next, preliminary, displayed, final_speech)
        try:
            self.begin(200, 'application/x-ndjson')
            with self.state.lock:
                entry = self.state.cache.get(cache_key)
            if entry is not None and time.monotonic() - entry[0] < 90 and not job.cancelled.is_set():
                return self.event('answer', result={**entry[1], 'elapsed_ms': 0, 'first_say_ms': 0, 'cached': True})
            result = gateway_stream(self.state.system, self.state.key, question, history, manual, job,
                                    lambda ms, say: self.event('say', elapsed_ms=ms, text=say),
                                    mode=mode, dialogue=dialogue, retained=retained, context_limited=context_limited,
                                    refresh_next=refresh_next, preliminary=preliminary,
                                    displayed=displayed, final_speech=final_speech,
                                    core=lambda ms, say: self.event('answer_core',elapsed_ms=ms,text=say))
            if job.cancelled.is_set():
                raise HintError('cancelled', 'Подсказка отменена.')
            if not result.get('skip'):
                with self.state.lock:
                    self.state.cache[cache_key] = (time.monotonic(), result)
                    if len(self.state.cache) > 16:
                        self.state.cache.popitem(last=False)
            self.event('answer', result=result)
        except HintError as error:
            details = {'code': error.code, 'message': str(error)}
            if error.code == 'rate_limited':
                self.state.extend_cooldown(error.retry_after or DEFAULT_RETRY_AFTER)
                details['retry_after_seconds'] = self.state.cooldown_remaining()
            try:
                self.event('error', **details)
            except (BrokenPipeError, ConnectionResetError):
                job.cancel()
        except (BrokenPipeError, ConnectionResetError):
            job.cancel()
        finally:
            with self.state.lock:
                self.state.jobs.pop(job_id, None)


def make_server(port=8765, *, credentials=None, journal=None, gateway=False):
    state = State(credentials, journal, gateway)
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.state = state
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--gateway', action='store_true', help='Enable AssemblyAI for the selected user context and call audio')
    args = parser.parse_args()
    with make_server(args.port, gateway=args.gateway) as app:
        print(f'Meet Copilot: http://127.0.0.1:{app.server_port}/', flush=True)
        app.serve_forever()
