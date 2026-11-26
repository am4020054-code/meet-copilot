"""Private, text-only session journal. Event payloads use an explicit allowlist."""
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path


SESSION_ID = re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}')
TIMESTAMP = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z')
CODE = re.compile(r'[a-z][a-z0-9_]{0,39}')
DIGEST = re.compile(r'[a-f0-9]{64}')
SPEAKER_LABEL = re.compile(r'[A-Z]{1,3}')
TEXT_FIELDS = {
    'transcript_final': ('original', 'turn_original'),
    'question_edited': ('question',),
    'question_submitted': ('question',),
    'answer_prepared': ('question_ru', 'answer_en', 'caution_ru', 'facts', 'ask_en', 'next_why', 'next_say', 'preliminary_en'),
    'answer_shown': ('question_ru', 'answer_en', 'caution_ru', 'facts', 'ask_en', 'next_why', 'next_say', 'label', 'timing', 'preliminary_en'),
    'preliminary_shown': ('answer_en',),
    'answer_core_prepared': ('answer_en',),
    'say_preview': ('answer_en',),
    'next_prepared': ('next_why', 'next_say'),
    'next_updated': ('next_why', 'next_say'),
}
NUMBER_FIELDS = {
    'session_started': ('keyterm_count',),
    'session_stopped': ('socket_code',),
    'transcript_final': ('turn_id', 'provider_turn_id', 'segment_index'),
    'question_skipped': ('turn_id',),
    'question_submitted': ('request_id',),
    'answer_prepared': ('request_id', 'answer_id', 'api_ms', 'after_final_ms', 'first_say_ms'),
    'say_preview': ('request_id', 'first_say_ms'),
    'context_retrieved': ('request_id','retrieval_us','evidence_bytes','gateway_body_bytes','source_count'),
    'preliminary_shown': ('request_id', 'provider_turn_id', 'after_request_ms'),
    'preliminary_visible': ('request_id', 'provider_turn_id', 'after_request_ms'),
    'answer_core_prepared': ('request_id', 'answer_id', 'api_ms', 'after_final_ms'),
    'draft_visible': ('request_id', 'after_request_ms'),
    'answer_visible': ('request_id', 'answer_id', 'after_request_ms'),
    'answer_cancelled': ('request_id',),
    'answer_rejected': ('request_id', 'api_ms', 'after_final_ms'),
    'answer_shown': ('request_id', 'answer_id'),
    'next_prepared': ('request_id', 'answer_id'),
    'next_updated': ('request_id', 'answer_id'),
    'error': ('request_id', 'status', 'retry_after_s', 'elapsed_ms', 'socket_code'),
}
FLAGS = {
    'transcript_final': ('acknowledgement', 'mixed_speakers'),
    'capture_connected': ('speaker_labels',),
    'question_submitted': ('manual',),
    'answer_prepared': ('discarded', 'cached'),
    'preliminary_shown': ('before_final',),
    'preliminary_visible': ('before_final',),
    'answer_rejected': ('discarded', 'cached'),
}
KINDS = set(TEXT_FIELDS) | set(NUMBER_FIELDS) | {'capture_connected', 'capture_disconnected', 'speaker_named'}

# Exclude obvious credential formats even if they appear in a dictated phrase.
SECRET = re.compile(
    r'\b(?:authorization|api[-_ ]?key|access[-_ ]?token|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;&]+'
    r'|\bbearer\s+[A-Za-z0-9_.-]+|\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,}'
    r'|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b|\b[a-f0-9]{32,}\b',
    re.I,
)


def event_record(data, key):
    session = data.get('session', '')
    at = data.get('at', '')
    seq = data.get('seq')
    kind = data.get('kind', '')
    if (not isinstance(session, str) or not SESSION_ID.fullmatch(session)
            or not isinstance(at, str) or not TIMESTAMP.fullmatch(at)
            or type(seq) is not int or not 1 <= seq <= 1_000_000
            or not isinstance(kind, str) or kind not in KINDS):
        raise ValueError('Неверная запись журнала.')
    record = {'session': session, 'seq': seq, 'at': at, 'kind': kind,
              'saved_at': datetime.now(timezone.utc).isoformat(timespec='milliseconds')}
    for field in TEXT_FIELDS.get(kind, ()):
        value = data.get(field)
        if isinstance(value, str):
            if key:
                value = value.replace(key, '[скрыто]')
            record[field] = SECRET.sub('[скрыто]', value)[:12_000]
    for field in NUMBER_FIELDS.get(kind, ()):
        value = data.get(field)
        if type(value) is int and 0 <= value <= 10_000_000:
            record[field] = value
    for field in FLAGS.get(kind, ()):
        if type(data.get(field)) is bool:
            record[field] = data[field]
    if kind=='context_retrieved' and DIGEST.fullmatch(str(data.get('index_sha256',''))):
        record['index_sha256']=data['index_sha256']
    channel = data.get('channel')
    if kind in ('transcript_final', 'capture_connected', 'capture_disconnected', 'session_stopped', 'error', 'speaker_named') and channel in ('tab', 'mic'):
        record['channel'] = channel
    if kind in ('transcript_final', 'speaker_named', 'capture_connected') and channel == 'tab':
        capture = data.get('capture_id')
        if isinstance(capture, str) and SESSION_ID.fullmatch(capture):
            record['capture_id'] = capture
    if kind in ('transcript_final', 'speaker_named'):
        role = record.get('channel')
        label = data.get('speaker_label')
        capture = record.get('capture_id')
        expected = 'mic:local' if role == 'mic' else None
        if role == 'tab' and capture and isinstance(label, str):
            if SPEAKER_LABEL.fullmatch(label):
                record['speaker_label'] = label
                expected = f'tab:{capture}:{label}'
            elif label == 'PENDING':
                record['speaker_label'] = 'PENDING'
        if expected and data.get('speaker_id') == expected:
            record['speaker_id'] = expected
            name = data.get('speaker_name')
            name = ' '.join(name.split())[:60] if isinstance(name, str) else ''
            if key and name:
                name = name.replace(key, '[скрыто]')
            record['speaker_name'] = SECRET.sub('[скрыто]', name) if name else None
        elif kind == 'speaker_named':
            raise ValueError('Идентификатор голоса не связан с каналом.')
    if kind == 'transcript_final':
        observed = data.get('provider_speaker_label')
        if record.get('channel') == 'tab' and isinstance(observed, str) and (
                SPEAKER_LABEL.fullmatch(observed) or observed == 'PENDING'):
            record['provider_speaker_label'] = observed
        attribution = data.get('speaker_attribution')
        if attribution in ('identified', 'mixed', 'pending', 'unknown'):
            record['speaker_attribution'] = attribution
        fallback = {'tab': 'Собеседник', 'mic': 'Я'}.get(record.get('channel'))
        if record.get('mixed_speakers') is True:
            fallback = 'Несколько голосов'
        elif record.get('speaker_label') == 'PENDING' or attribution == 'unknown':
            fallback = 'Собеседник · голос не определён'
        elif record.get('speaker_id','').startswith('tab:'):
            fallback = 'Голос ' + record['speaker_label']
        record['speaker'] = record.get('speaker_name') or fallback
        uttered_at = data.get('uttered_at')
        if isinstance(uttered_at, str) and TIMESTAMP.fullmatch(uttered_at):
            record['uttered_at'] = uttered_at
        record['language'] = data.get('language') if data.get('language') in ('ru', 'en', 'mixed') else None
    if kind in ('error', 'session_stopped', 'question_skipped', 'answer_prepared', 'answer_rejected', 'answer_shown', 'answer_cancelled'):
        for field in ('code', 'stage', 'origin'):
            value = data.get(field)
            if isinstance(value, str) and CODE.fullmatch(value) and value != key:
                record[field] = value
    if kind in ('error', 'answer_prepared', 'answer_rejected'):
        fingerprint = data.get('fingerprint')
        if isinstance(fingerprint, str) and DIGEST.fullmatch(fingerprint) and fingerprint != key:
            record['fingerprint'] = fingerprint
    if kind in ('answer_prepared', 'answer_shown', 'next_prepared', 'next_updated') and data.get('goal_mode') in ('discussion', 'planning'):
        record['goal_mode'] = data['goal_mode']
    if kind in ('answer_prepared', 'answer_rejected'):
        sources = data.get('retrieved_source_ids')
        if isinstance(sources, list):
            record['retrieved_source_ids'] = [ref for ref in sources[:8] if isinstance(ref, str) and CODE.fullmatch(ref.lower()) and ref != key]
        if data.get('commercial_intent') in ('company_intro', 'discussion_value'):
            record['commercial_intent'] = data['commercial_intent']
    if kind == 'question_submitted':
        ids = data.get('turn_ids')
        if isinstance(ids, list):
            record['turn_ids'] = [i for i in ids[:40] if type(i) is int and 0 <= i <= 1_000_000]
    return record


def append_event(directory: Path, data, key):
    record = event_record(data, key)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise PermissionError('Небезопасные права каталога журнала.')
    path = directory / (record['session'] + '.jsonl')
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(path, flags, 0o600), 'a', encoding='utf-8') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise PermissionError('Небезопасные права файла журнала.')
        file.write(json.dumps(record, ensure_ascii=False) + '\n')
