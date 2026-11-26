"""Experiment, not wired into the server: cross-language retrieval.

The local index is lexical. A question in English shares no words with documents in Russian,
so the right paragraph is not retrieved unless `search_aliases` happens to cover the term.
This probe compares, on the same questions:

  plain     ContextIndex.search(question), as the server does now;
  expanded  one small model call turns the question into search keywords in the language of
            the documents, then the same local search runs on question + keywords.

    python bench/expand_probe.py --context private/ctx [--answers]

Needs ASSEMBLYAI_API_KEY. One billed request per question, two with --answers.
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
from context_index import ContextIndex, terms  # noqa: E402

EXPAND = """You prepare a full-text search over documents written in {language}.
For the question, output up to 10 search keywords in {language}: the key nouns and terms as they
would appear in the documents, plus one or two likely synonyms. Keep product names, technology
names and abbreviations as they are. Lowercase, comma-separated, nothing else."""


def document_language(index):
    sample = ' '.join(row['text'] for row in list(index.rows.values())[:400])
    cyrillic = len(re.findall(r'[а-яё]', sample, re.I))
    latin = len(re.findall(r'[a-z]', sample, re.I))
    return 'Russian' if cyrillic > latin else 'English'


def keywords(key, question, language):
    body = json.dumps({'model': hints.MODEL, 'max_tokens': 60, 'fallback_config': {'retry': False},
                       'messages': [{'role': 'system', 'content': EXPAND.format(language=language)},
                                    {'role': 'user', 'content': question}]})
    start = time.monotonic()
    connection = http.client.HTTPSConnection(hints.ENDPOINT, timeout=30)
    connection.request('POST', '/v1/chat/completions', body, {'Authorization': key, 'Content-Type': 'application/json'})
    response = connection.getresponse()
    data = json.loads(response.read())
    connection.close()
    if response.status != 200:
        raise RuntimeError(f'HTTP {response.status}: {str(data)[:200]}')
    text = data['choices'][0]['message']['content']
    return [w for w in terms(text)], round((time.monotonic() - start) * 1000)


def describe(evidence):
    return [f"{row['source']['title']} | {row['source']['section'][:44]}" for row in evidence['results']]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--context', required=True)
    parser.add_argument('--questions', default=str(Path(__file__).with_name('questions.txt')))
    parser.add_argument('--answers', action='store_true', help='also generate the hint from each evidence set')
    args = parser.parse_args()
    key = os.environ.get('ASSEMBLYAI_API_KEY', '')
    if not key:
        sys.exit('ASSEMBLYAI_API_KEY is not set')
    index = ContextIndex(args.context, config={})
    language = document_language(index)
    system, _ = hints.load_bundle()
    print(f"{index.metadata['documents']} documents, {index.metadata['passages']} passages, language: {language}")
    expand_ms = []
    questions = [q.strip() for q in Path(args.questions).read_text(encoding='utf-8').splitlines() if q.strip()]
    for number, question in enumerate(questions, 1):
        plain = index.search(question)
        words, ms = keywords(key, question, language)
        expand_ms.append(ms)
        query = ' '.join(words)
        # Keywords first: the search keeps only the first 20 terms.
        expanded = index.search(query + ' ' + question)
        print(f'\nQ{number}: {question}')
        print(f'   keywords ({ms} ms): {", ".join(words)}')
        for label, evidence in (('plain', plain), ('expanded', expanded)):
            print(f'   {label}: ' + '; '.join(describe(evidence)))
            if args.answers:
                try:
                    result = hints.gateway_stream(system, key, question, [], False, hints.HintJob(),
                                                  lambda *a: None, mode='discussion', evidence=evidence)
                    say = 'SKIP' if result.get('skip') else result['answer_en']
                    notice = result.get('context_notice', '')
                    print(f"      -> {say}" + (f'  [{notice}]' if notice else '') + f"  ({result.get('elapsed_ms')} ms)")
                except hints.HintError as error:
                    print(f'      -> error {error.code}')
    print(f'\nmedian keyword step: {round(statistics.median(expand_ms))} ms')


if __name__ == '__main__':
    main()
