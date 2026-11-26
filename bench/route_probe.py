"""Experiment, not wired into the server: pick sections for each question, then answer from them.

Without prompt caching the model re-reads the whole context on every hint, and the wait before
the first token grows with its size. This probe measures a two-step alternative on the same model:

  step 1  the model sees only a table of contents (file, heading, first words of each section)
          and names the sections it needs;
  step 2  the usual hint request, but REFERENCE DATA holds only those sections.

    python bench/route_probe.py --context private/ctx

Needs ASSEMBLYAI_API_KEY. Two billed requests per question.
"""
import argparse
import http.client
import json
import os
import re
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import hints  # noqa: E402

HEADING = re.compile(r'^#{1,3}[ \t]+(.+)$', re.M)
ROUTER = """You route a question to reference sections. Below is a table of contents: one section per
line as ID | file | heading | opening words. The documents may be in another language than the question.
Reply with the IDs of the sections most likely to contain the answer, most relevant first, at most
{limit}, comma-separated, and nothing else. If nothing fits, reply NONE.
"""


def sections(root):
    """Split every document on level 1-3 headings. Returns [(id, file, heading, text)]."""
    result = []
    for path in sorted(Path(root).iterdir()):
        if path.suffix.lower() not in ('.md', '.txt') or not path.is_file() or path.is_symlink():
            continue
        text = path.read_text(encoding='utf-8')
        marks = list(HEADING.finditer(text))
        starts = [0] + [m.start() for m in marks]
        titles = ['(start)'] + [m[1].strip() for m in marks]
        for index, start in enumerate(starts):
            body = text[start:starts[index + 1] if index + 1 < len(starts) else len(text)].strip()
            if len(body) > 40:
                result.append((f'S{len(result) + 1}', path.name, titles[index], body))
    return result


def complete(key, messages, max_tokens, on_token=None):
    """One streamed request on a new connection. Returns (text, first_token_ms, total_ms, usage)."""
    body = json.dumps({'model': hints.MODEL, 'stream': True, 'max_tokens': max_tokens,
                       'fallback_config': {'retry': False}, 'messages': messages})
    start = time.monotonic()
    ms = lambda: round((time.monotonic() - start) * 1000)
    connection = http.client.HTTPSConnection(hints.ENDPOINT, timeout=60)
    connection.request('POST', '/v1/chat/completions', body,
                       {'Authorization': key, 'Content-Type': 'application/json', 'Accept': 'text/event-stream'})
    response = connection.getresponse()
    if response.status != 200:
        raise RuntimeError(f'HTTP {response.status}: {response.read().decode("utf-8", "replace")[:200]}')
    text, first, usage = '', None, {}
    for line in response:
        if not line.startswith(b'data:') or line[5:].strip() == b'[DONE]':
            continue
        event = json.loads(line[5:])
        usage = event.get('usage') or usage
        for choice in event.get('choices', []):
            content = choice.get('delta', {}).get('content')
            if isinstance(content, str) and content:
                first = first if first is not None else ms()
                text += content
                if on_token:
                    on_token(text, ms)
    connection.close()
    return text, first, ms(), usage


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--context', required=True)
    parser.add_argument('--questions', default=str(Path(__file__).with_name('questions.txt')))
    parser.add_argument('--limit', type=int, default=6, help='sections to select per question')
    parser.add_argument('--budget', type=int, default=24_000, help='bytes of selected sections')
    parser.add_argument('--preview', type=int, default=30, help='opening characters of each section in the table')
    parser.add_argument('--show', action='store_true')
    args = parser.parse_args()
    key = os.environ.get('ASSEMBLYAI_API_KEY', '')
    if not key:
        sys.exit('ASSEMBLYAI_API_KEY is not set')
    parts = sections(args.context)
    by_id = {part[0]: part for part in parts}
    toc = '\n'.join(f'{sid} | {name} | {title[:70]} | '
                    + ' '.join(body.split('\n', 1)[-1].split())[:args.preview] for sid, name, title, body in parts)
    total_bytes = sum(len(part[3].encode()) for part in parts)
    print(f'{len(parts)} sections, {total_bytes} bytes; table of contents {len(toc.encode())} bytes')
    print('  #   route  token@2  say_line@2   total@2 |  first text   in_tok(1+2)  picked')
    firsts = []
    questions = [q.strip() for q in Path(args.questions).read_text(encoding='utf-8').splitlines() if q.strip()]
    for index, question in enumerate(questions, 1):
        picked_text, _, route_ms, usage1 = complete(key, [
            {'role': 'system', 'content': ROUTER.format(limit=args.limit) + '\n' + toc},
            {'role': 'user', 'content': question}], 40)
        picked, size = [], 0
        for sid in re.findall(r'S\d+', picked_text):
            part = by_id.get(sid)
            if part and sid not in picked and size + len(part[3].encode()) <= args.budget:
                picked.append(sid)
                size += len(part[3].encode())
        reference = '\n\n'.join(f'SOURCE {json.dumps(by_id[s][1])} — {by_id[s][2]}:\n{by_id[s][3]}' for s in picked)
        system = (hints.FORMAT + '\nUser preferences: ""\nREFERENCE DATA (sections selected for this question; '
                  'other sections exist):\n' + (reference or 'No section matched. Ask for the missing detail.'))
        messages = hints.gateway_messages(system, question, [], False, mode='discussion', dialogue=(), retained=(),
                                          context_limited=False, refresh_next=False, preliminary=False,
                                          displayed='', final_speech='')
        marks = {}

        def on_token(text, ms):
            match = hints.SAY_START.search(text)
            if 'say_line' not in marks and match and match.end() < len(text) and match[1].strip():
                marks['say_line'] = ms()

        answer, token_ms, total_ms, usage2 = complete(key, messages, 640, on_token)
        say_line = marks.get('say_line', total_ms)
        firsts.append(route_ms + say_line)
        print(f'{index:>3} {route_ms:>7} {token_ms:>8} {say_line:>11} {total_ms:>9} | {route_ms + say_line:>10}   '
              f"{usage1.get('prompt_tokens', '?')}+{usage2.get('prompt_tokens', '?')}  "
              + ', '.join(f'{s}:{by_id[s][1]}' for s in picked))
        if args.show:
            print('     ' + answer.strip().replace('\n', '\n     '))
    print(f'median time to first text on screen (route + say_line): {round(statistics.median(firsts))} ms')


if __name__ == '__main__':
    main()
