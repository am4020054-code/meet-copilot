"""Latency probe for the hint path. Retrieves passages from the local index like the server
does, sends the same request (hints.gateway_messages, same max_tokens) and times each phase.

    python bench/latency.py --context private/ctx --model gemma-4-31b

Needs ASSEMBLYAI_API_KEY. Every run is a real, billed LLM Gateway request.

Phases, all in ms from the moment the request starts:
  connect   TCP + TLS handshake (the server opens a new connection per hint)
  headers   response headers received
  token     first content token
  say1      first complete SAY sentence   -> server emits `say` (journal only)
  say_line  whole SAY line finished       -> server emits `answer_core`: first text on screen
  total     stream finished               -> server emits `answer`: full card
"""
import argparse
import http.client
import json
import os
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import hints  # noqa: E402
from context_index import ContextIndex, settings  # noqa: E402


def probe(system, key, question, model, mode, evidence, preliminary=False, reuse=None):
    messages = hints.gateway_messages(system, question, [], False, mode=mode, dialogue=(), retained=(),
                                      context_limited=False, refresh_next=False, preliminary=preliminary,
                                      displayed='', final_speech='', evidence=evidence)
    payload = {'model': model, 'stream': True,
               'max_tokens': 300 if preliminary else (640 if mode else 520),
               'fallback_config': {'retry': False}, 'messages': messages}
    body = json.dumps(payload)
    out = {'request_bytes': len(body)}
    start = time.monotonic()
    ms = lambda: round((time.monotonic() - start) * 1000)
    connection = reuse or http.client.HTTPSConnection(hints.ENDPOINT, timeout=60)
    if not reuse:
        connection.connect()
    out['connect'] = ms()
    connection.request('POST', '/v1/chat/completions', body,
                       {'Authorization': key, 'Content-Type': 'application/json', 'Accept': 'text/event-stream'})
    response = connection.getresponse()
    out['headers'] = ms()
    out['status'] = response.status
    for name in ('X-Ratelimit-Limit-Tokens', 'X-Ratelimit-Remaining-Tokens', 'X-Ratelimit-Remaining', 'Retry-After'):
        if response.getheader(name) is not None:
            out[name] = response.getheader(name)
    if response.status != 200:
        out['error'] = response.read().decode('utf-8', 'replace')[:300]
        connection.close()
        return out
    answer = ''
    for line in response:
        if not line.startswith(b'data:'):
            continue
        data = line[5:].strip()
        if data == b'[DONE]':
            break
        event = json.loads(data)
        if event.get('usage'):
            out['usage'] = event['usage']
        for choice in event.get('choices', []):
            content = choice.get('delta', {}).get('content')
            if not isinstance(content, str) or not content:
                continue
            out.setdefault('token', ms())
            answer += content
            if 'say1' not in out and hints.first_draft(answer, question):
                out['say1'] = ms()
            if 'say_line' not in out:
                match = hints.SAY_START.search(answer)
                if match and match.end() < len(answer) and match[1].strip():
                    out['say_line'] = ms()
    out['total'] = ms()
    out['answer'] = answer
    if not reuse:
        connection.close()
    return out


def real(system, key, question, model, mode, evidence):
    """Time the server's own gateway_stream, including its connection handling."""
    out = {'status': 200}
    try:
        result = hints.gateway_stream(system, key, question, [], False, hints.HintJob(),
                                      lambda ms, say: out.setdefault('say1', ms), model, mode=mode,
                                      core=lambda ms, say: out.setdefault('say_line', ms), evidence=evidence)
    except hints.HintError as error:
        return {'status': 429 if error.code == 'rate_limited' else 502, 'error': f'{error.code}: {error}',
                'Retry-After': error.retry_after}
    out['total'] = result.get('elapsed_ms')
    if result.get('skip'):
        out['answer'], out['say_words'] = 'SKIP', 0
        return out
    out['say_words'] = len(result['answer_en'].split())
    sources = ', '.join(dict.fromkeys(ref['title'] for ref in result.get('source_refs_local', [])))
    lines = ['SAY: ' + result['answer_en']]
    if result.get('facts'):
        lines.append('FACTS: ' + ' | '.join(result['facts'].splitlines()))
    if sources:
        lines.append('SOURCES: ' + sources)
    if result.get('context_notice'):
        lines.append('NOTICE: ' + result['context_notice'])
    out['answer'] = chr(10).join(lines)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--context', required=True)
    parser.add_argument('--model', default=hints.MODEL)
    parser.add_argument('--questions', default=str(Path(__file__).with_name('questions.txt')))
    parser.add_argument('--limit', type=int, default=0, help='use only the first N questions')
    parser.add_argument('--no-goal', action='store_true', help='omit the NEXT/MOVE/KEEP strategy block')
    parser.add_argument('--preliminary', action='store_true')
    parser.add_argument('--real', action='store_true',
                        help="call the server's gateway_stream (warm connection included) instead of the raw probe")
    parser.add_argument('--pause', type=float, default=0, help='seconds between requests')
    parser.add_argument('--show', action='store_true', help='print each answer')
    parser.add_argument('--json', help='append raw results to this JSONL file')
    args = parser.parse_args()
    key = os.environ.get('ASSEMBLYAI_API_KEY', '')
    if not key:
        sys.exit('ASSEMBLYAI_API_KEY is not set')
    index = ContextIndex(args.context, config=settings())
    system, _ = hints.load_bundle()
    bundle = index.metadata
    questions = [q.strip() for q in Path(args.questions).read_text(encoding='utf-8').splitlines() if q.strip()]
    if args.limit:
        questions = questions[:args.limit]
    mode = None if args.no_goal else 'discussion'
    print(f"model={args.model} context={bundle['bytes']} bytes in {len(bundle['files'])} files, {bundle['passages']} passages "
          f"mode={mode} preliminary={args.preliminary}")
    columns = ('connect', 'headers', 'token', 'say1', 'say_line', 'total')
    print('  #  ' + ''.join(f'{c:>9}' for c in columns) + '   in_tok  cached out_tok  tpm_left')
    rows = []
    if args.real and hasattr(hints, 'WARM'):
        hints.WARM.keep()
        time.sleep(2)
    for number, question in enumerate(questions, 1):
        evidence = index.search(question, preliminary=args.preliminary)
        result = (real(system, key, question, args.model, mode, evidence) if args.real
                  else probe(system, key, question, args.model, mode, evidence, args.preliminary))
        result['evidence_bytes'], result['passages'] = evidence['evidence_bytes'], len(evidence['results'])
        usage = result.get('usage', {})
        cached = (usage.get('prompt_tokens_details') or {}).get('cached_tokens', '')
        if result['status'] != 200:
            print(f"{number:>3}  HTTP {result['status']} retry-after={result.get('Retry-After')} {result.get('error', '')[:160]}")
        else:
            rows.append(result)
            print(f'{number:>3}  ' + ''.join(f"{result.get(c, '-'):>9}" for c in columns)
                  + f"  {usage.get('prompt_tokens', '?'):>7} {cached:>7} {usage.get('completion_tokens', '?'):>7}"
                  + f"  {result.get('X-Ratelimit-Remaining-Tokens', '?'):>8}"
                  + f"  passages={result['passages']}"
                  + (f" say_words={result['say_words']}" if 'say_words' in result else ''))
            if args.show:
                print('     ' + result['answer'].strip().replace('\n', '\n     '))
        if args.json:
            with open(args.json, 'a', encoding='utf-8') as file:
                file.write(json.dumps({'model': args.model, 'context_bytes': bundle['bytes'], 'mode': mode,
                                       'preliminary': args.preliminary, 'question': question, **result},
                                      ensure_ascii=False) + '\n')
        if args.pause:
            time.sleep(args.pause)
    if rows:
        print('med  ' + ''.join(
            f"{round(statistics.median([r[c] for r in rows if c in r])) if any(c in r for r in rows) else '-':>9}"
            for c in columns))


if __name__ == '__main__':
    main()
