export class Turns {
  constructor() { this.final = new Map(); this.version = 0; }
  accept(event) {
    if (event.type !== 'Turn' || typeof event.transcript !== 'string') return null;
    const id = event.turn_order;
    if (!Number.isInteger(id) || !event.end_of_turn) return null;
    if (this.final.has(id)) return null;
    this.final.set(id, event.transcript.trim());
    return { id, text: event.transcript.trim() };
  }
  invalidate() { return ++this.version; }
  reset() { this.final.clear(); this.invalidate(); }
  current(id) { return id === this.version; }
}

const CONTINUATION_WINDOW_MS = 3000;
const NEW_QUESTION = /^(?:next question|another question|moving on|separately|my next question|следующий вопрос|другой вопрос|отдельный вопрос|перейд[её]м к)(?=$|[\s,.?!:;])/iu;

// Use the start of the next segment, even when its final transcript arrives later.
export function continuesQuestion(previous, next, gap, answerWasInFlight) {
  return Boolean(previous && next && !isAcknowledgement(next) && !NEW_QUESTION.test(next.trim()) &&
    (gap <= CONTINUATION_WINDOW_MS || answerWasInFlight));
}

// Only unambiguous acknowledgements, never short questions such as "Why?".
export function isAcknowledgement(text) {
  const value = text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:(?:ok|okay|yes|no|yeah|yep|right|alright|thanks|thank you|got it|understood|mm hmm|mhm|uh huh|да|нет|ага|угу|хорошо|понятно|спасибо)\s*)+$/.test(value);
}

export function isCallAside(text) {
  const value = text.toLowerCase().replace(/[’']/g, "'").trim();
  return /^(?:(?:hi|hello|hey)[,\s]+(?:[a-z]+[,\s]+)?)?(?:can|could|do) you hear me(?: now)?[?.!\s]*$/.test(value)
    || /^(?:(?:привет|здравствуйте)[,\s]+(?:[а-яё]+[,\s]+)?)?(?:ты|вы) меня слыш(?:ишь|ите)[?.!\s]*$/.test(value)
    || (!value.includes('?') && /\b(?:model's answer|answer (?:from|of) the model|the teleprompter)\b|ответ модели|суфл[её]р показал/.test(value))
    || (!value.includes('?') && /^(?:screenshot(?:[.!,:\s]|$)|take a screenshot\b|за?скриншот\S*(?:[.!,:\s]|$))/iu.test(value))
    || /^(?:нажми\S*|открой\S*|закрой\S*|click|open|close)\s+.*(?:источник|подсказк|вкладк|кнопк|button|sources|tab|panel)/u.test(value);
}

// A transcript can end a turn on filler, a stray word, or ordinary commentary.
const FILLER = new Set('we i you the a an all so uh huh um mm it and or okay yes no well мы я вы это и но да нет так ну ка сейчас думаю вот тоже э эм'.split(' '));
export function isReplyTurn(text) {
  const value = text.trim();
  if (!value || isAcknowledgement(value) || isCallAside(value)) return false;
  const words = value.match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length === 1) {
    return (/[?？]/u.test(value) && !FILLER.has(words[0].toLowerCase())) ||
      /^(?:why|when|where|how|почему|когда|где|сколько)[?.!]?$/iu.test(value);
  }
  if (/[?？]/u.test(value)) return words.length > 1;
  const request = /(?:^|[\s,.!;:])(?:could you|would you|can you|do you|will you|we need to know|i(?:'d| would) like to know|tell us|tell me|расскажите|объясните|уточните|представьте)(?=$|[\s,:?!])/iu;
  const questionStart = /(?:^|[.!;,]\s*)(?:(?:and|but|a|а|и|но)\s+)?(?:explain|describe|introduce|what|how|why|where|when|which|who|сколько|почему|какие|какой|какая|как|что|где|кто|когда)(?=$|[\s,:?!])/iu;
  return request.test(value) || questionStart.test(value) ||
    words.filter(word => !FILLER.has(word.toLowerCase())).length >= 2;
}
export function pcm16(input) {
  const out = new ArrayBuffer(input.length * 2), view = new DataView(out);
  for (let i=0;i<input.length;i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
  }
  return out;
}

// Catch obvious script failures, not the semantic quality of a translation.
export function displayAnswer(answer, originalQuestion = '') {
  const result = {...answer};
  const warnings = [];
  const russian = value => /[А-Яа-яЁё]/.test(value) && !/[^\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]/u.test(value);
  const english = value => /[A-Za-z]/.test(value) && !/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(value);
  if (!russian(result.question_ru || '')) {
    result.question_ru = 'Перевод недоступен. Исходный вопрос: ' + originalQuestion;
    warnings.push('Перевод вопроса не прошёл проверку языка.');
  }
  if (!english(result.answer_en || '')) {
    result.answer_language_invalid = true;
    result.answer_en = 'I would like to check the technical details before giving you a firm answer. Could you share the project data?';
    result.source_ids = [];
    warnings.push('Язык ответа модели не соответствует английскому. Показана фраза уточнения.');
  }
  if (result.caution_ru && !russian(result.caution_ru)) {
    result.caution_ru = 'Примечание модели не прошло проверку языка. Проверьте ответ по источникам.';
    warnings.push('Язык примечания требует проверки.');
  }
  result.language_issue = warnings.length > 0;
  result.caution_ru = [result.caution_ru, ...warnings].filter(Boolean).join(' ');
  return result;
}

// Generic defaults; no project vocabulary is bundled.
export let KEYTERM_GROUPS = Object.freeze([]);
export let KEYTERMS = Object.freeze([]);
export let AUDIO_CONTEXT = 'A conversation in English or Russian.';
export function configureVocabulary(value = {}) {
  KEYTERMS = Object.freeze((Array.isArray(value?.terms)?value.terms:[]).filter(x=>typeof x==='string' && x.length<=80).slice(0,100));
  KEYTERM_GROUPS = Object.freeze(KEYTERMS.length?[{title:'Ваши термины',terms:KEYTERMS}]:[]);
  AUDIO_CONTEXT = typeof value?.prompt==='string'?value.prompt.slice(0,2000):'A conversation in English or Russian.';
}
export function streamingParameters(token, sampleRate, {speakerLabels=false} = {}) {
  const params=new URLSearchParams({
    token, speech_model: 'assemblyai-stt-3-7-realtime',
    sample_rate: String(sampleRate), encoding: 'pcm_s16le', mode: 'balanced',
    keyterms_prompt: JSON.stringify(KEYTERMS), prompt: AUDIO_CONTEXT
  });
  if(speakerLabels) params.set('speaker_labels','true');
  return params;
}

const speakerCode=value=>typeof value==='string' && /^[A-Z]{1,3}$/.test(value) ? value : null;
export function tabVoiceParts(event, enabled) {
  const original=event.transcript;
  const whole=(label=null, mixed=false, pending=false)=>[{original,label,mixed,pending,offset:0}];
  if (!enabled) return whole();
  const dominant=speakerCode(event.speaker_label);
  const words=Array.isArray(event.words)?event.words.filter(word=>word?.word_is_final===true && typeof word.text==='string' && word.text.trim()):[];
  if (!words.length) return whole(dominant,false,event.speaker_label==='PENDING');
  const labels=words.map(word=>word.speaker==null ? dominant : speakerCode(word.speaker));
  const pending=words.map(word=>word.speaker==='PENDING' || (word.speaker==null && event.speaker_label==='PENDING'));
  if (labels.every(label=>label===labels[0])) return whole(labels[0],false,pending.some(Boolean));

  const lower=original.toLowerCase(), groups=[];
  let cursor=0;
  const initial=Number.isFinite(words[0].start)?words[0].start:0;
  for (const [index,word] of words.entries()) {
    const position=lower.indexOf(word.text.toLowerCase(),cursor);
    if (position<0) return whole(null,true);
    if (!groups.length || groups.at(-1).label!==labels[index]) {
      const offset=Number.isFinite(word.start)?Math.max(0,word.start-initial):0;
      groups.push({position:index===0?0:position,label:labels[index],offset,pending:pending[index]});
    } else if(pending[index]) {
      groups.at(-1).pending=true;
    }
    cursor=position+word.text.length;
  }
  return groups.map((group,index)=>({
    original:original.slice(group.position,groups[index+1]?.position ?? original.length),
    label:group.label, offset:group.offset, mixed:false, pending:group.pending
  }));
}

const thinkingWords=text=>{
  const words=text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if(words[0]==='well')words.shift();
  return words;
};
export function matchesThinkingPhrase(text,phrases,{partial=false}={}) {
  const words=thinkingWords(text);
  if(!words.length)return false;
  return phrases.some(phrase=>{
    const expected=thinkingWords(phrase);
    return (partial ? words.length<=expected.length : words.length===expected.length)
      && words.every((word,index)=>word===expected[index]);
  });
}
