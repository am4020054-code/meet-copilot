import {Turns, continuesQuestion, displayAnswer, isAcknowledgement, isCallAside, isReplyTurn, KEYTERM_GROUPS, KEYTERMS, streamingParameters, configureVocabulary, tabVoiceParts, matchesThinkingPhrase} from './core.mjs';
const $ = id => document.getElementById(id);
let csrf = '', configured = false, keySaved = false, knowledge, busy = false;
let queued = false, timer, socket, stream, context, worklet, captureEpoch = 0;
let turns = new Turns(), grouped = [], groupTime = 0;
const CLIENT_VERSION = 'meet-copilot-public-1';
const thinkingPhrases=[...document.querySelectorAll('[data-thinking-phrase]')].map(node=>node.textContent);
const speakerPreferenceKey='meetCopilot.speakerLabels';
let speakerLabelsPreference=false;
const voices=new Map();
let tabCapture=null,tabCaptureNumber=0,groupSpeakerId=null;
const dialogue = [];
let coachedHostId=0, coachingTimer, queuedCoach;
const retained = {discussion:[], planning:[]};
const goalLabels = {discussion:'Уточнить потребности и следующий шаг',
  planning:'Согласовать план и ответственность'};
let microphone = null;
const currentGoal = () => $('goalMode').value === 'planning' ? 'planning' : 'discussion';
let answerHistory = [], answerIndex = -1, liveAnswerReceived = false;

let beforeSpeechState = '';
let answerInFlightAtSpeechStart = false;
let groupCanContinue = false;
let speaking = false, speechStartedAt = null, readyAt = 0, pendingQuestion = false, queuedManual = false;
let lifetimeTimer, connectionTimer, latestFinalAt = null;
let retryTimer, cooldownUntil = 0, retryQuestion = '', retryCount = 0, lastAnswered = '';
let journalEnabled = false, captureLog, requestNumber = 0;
let groupedTurnIds = [], questionEdited = false;
let activeRequest;
let preliminaryTurn, preliminaryTimer, preliminaryJob, groupedPair = null, finalSpeech = '';
let lastPreliminaryAt = -Infinity;
const preliminaryDelay = 450, preliminarySpacing = 2700;
const preliminaryIdle = 'Появится, если смысл вопроса понятен до конца реплики.';
const normalizedWords = text => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
const error = text => { $('error').textContent = text; $('error').hidden = !text; };
function record(kind, details = {}, session = captureLog) {
  if (!session) return;
  const entry = {session:session.id, seq:++session.seq, at:new Date().toISOString(), kind, ...details};
  fetch('/api/journal', {
    method:'POST', keepalive:true,
    headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
    body:JSON.stringify(entry)
  }).then(response => {
    if (!response.ok) throw new Error('journal');
  }).catch(() => {
    $('journalState').hidden=false;
    $('journalState').textContent='Часть событий не удалось записать в локальный журнал.';
  });
}

function recordVisible(id, kind, details, started, session, stillCurrent) {
  if(!session || typeof window.requestAnimationFrame!=='function' || !Number.isFinite(started)) return;
  window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>{
    if(!stillCurrent() || document.visibilityState!=='visible') return;
    const node=$(id), bounds=node.getBoundingClientRect();
    if(node.hidden || !bounds.width || !bounds.height || bounds.top<0 || bounds.bottom>window.innerHeight
        || bounds.left<0 || bounds.right>window.innerWidth) return;
    record(kind,{...details,after_request_ms:Math.round(performance.now()-started)},session);
  }));
}

function savedSpeakerLabels(defaultValue) {
  try {
    const value=window.localStorage?.getItem(speakerPreferenceKey);
    if(value==='on' || value==='off')return value==='on';
  } catch {}
  return defaultValue===true;
}
const micBlocking=()=>microphone?.startedAt!=null && !microphone.thinkingPossible && !microphone.readingPreview;
const micUncertain=()=>microphone?.startedAt!=null && !microphone.readingPreview
  && microphone.thinkingPossible && !microphone.thinkingConfirmed;

function readsPreliminary(text, preview, partial=false) {
  const heard=normalizedWords(text), displayed=normalizedWords(preview?.text || '');
  if (!heard || !displayed) return false;
  return heard===displayed || (partial && displayed.startsWith(heard+' '));
}

const micPending=()=>micUncertain() || Boolean(microphone?.readingPreview);
function waitForMicEvidence() {
  const input=microphone;
  if(!micPending()) return;
  return new Promise(resolve=>{
    const timer=setTimeout(()=>input.releaseEvidence?.(),input.readingPreview ? 2400 : 1400);
    input.releaseEvidence=()=>{clearTimeout(timer);input.releaseEvidence=null;resolve();};
  });
}

function answerText({question_ru, answer_en, caution_ru, facts, ask_en, next_why, next_say, goal_mode}) {
  return {question_ru, answer_en, caution_ru, facts, ask_en, next_why, next_say, goal_mode};
}

function strategyContext(goal_mode=currentGoal(), limit=16_000) {
  const references=retained[goal_mode], selected=new Map(), encoder=new TextEncoder();
  let bytes=0;
  const candidates=[...references.map(id=>dialogue[id-1]),...dialogue.slice(0,3),...dialogue.slice().reverse()];
  for (const turn of candidates) {
    if (!turn || selected.has(turn.id) || selected.size>=520 || turn.text.length>12_000) continue;
    const row={id:turn.id,role:turn.role,text:turn.text};
    const size=encoder.encode(JSON.stringify(row)).length+1;
    if (bytes+size>limit) continue;
    bytes+=size;
    selected.set(row.id,row);
  }
  const rows=[...selected.values()].sort((a,b)=>dialogue[a.id-1].at-dialogue[b.id-1].at || a.id-b.id);
  return {goal_mode,dialogue:rows,retained:references.filter(id=>selected.has(id)),
    context_limited:selected.size<dialogue.length};
}

async function post(path, body = {}) {
  const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Запрос не выполнен.'), {
    status: response.status, retryAfter: data.retry_after_seconds, code: data.code, fingerprint: data.fingerprint
  });
  return data;
}
async function streamHint(payload, request, onSay, onCore) {
  const response=await fetch('/api/ask', {
    method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
    body:JSON.stringify(payload), signal:request.controller.signal
  });
  if (!response.ok || !response.body) {
    const data=await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Подсказка недоступна.'), {status:response.status,code:data.code,retryAfter:data.retry_after_seconds});
    return data;
  }
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let buffer='';
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (done) throw Object.assign(new Error('Ответ прервался.'), {code:'stream_interrupted'});
      buffer+=decoder.decode(value,{stream:true});
      let end;
      while ((end=buffer.indexOf('\n'))>=0) {
        const event=JSON.parse(buffer.slice(0,end));
        buffer=buffer.slice(end+1);
        if (event.type==='say') onSay?.(event);
        if (event.type==='answer_core') onCore?.(event);
        if (event.type==='answer') return event.result;
        if (event.type==='error') throw Object.assign(new Error(event.message), {code:event.code,status:event.code==='rate_limited'?429:502,retryAfter:event.retry_after_seconds});
      }
    }
  } finally {
    reader.cancel().catch(()=>{});
  }
}
function connection() {
  $('connection').textContent = configured ? (keySaved ? 'Распознавание настроено · звук выключен' : 'Ключ подключён · API требует проверки') : 'Без ключа · доступны карточки';
  $('settingsButton').textContent = 'Материалы пользователя';
}
function sources(ids) {
  $('sources').replaceChildren();
  const seen = new Set();
  for (const id of ids || []) {
    const card = [...knowledge.cards,...(knowledge.context_entries || [])].find(c => c.id === id);
    if (!card) continue;
    for (const ref of card.source_refs || [{source_id:card.source_id,location:card.location}]) {
      const source = knowledge.sources.find(s => s.id === ref.source_id);
      if (!source) continue;
      const key = ref.source_id+ref.location;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = document.createElement('div');
      line.textContent = `${source.title} · ${ref.location}`;
      $('sources').append(line);
    }
  }
}
function renderNext(answer) {
  $('nextGoal').textContent='Цель · '+goalLabels[answer.goal_mode || currentGoal()];
  $('nextWhy').textContent=answer.next_why || 'Для этой подсказки следующего шага пока нет.';
  $('nextLine').textContent=answer.next_say || '';
  $('nextLine').hidden=!answer.next_say;
  $('showNextIdea').hidden=!answerHistory[answerIndex]?.pendingNext;
}
function renderAnswer(answer, label, originalQuestion) {
  answer = displayAnswer(answer, originalQuestion);
  $('questionRu').textContent = answer.question_ru;
  $('answerEn').textContent = answer.answer_en;
  $('answerEn').dataset.shownAt = new Date().toISOString();
  $('caution').textContent = answer.caution_ru || '';
  $('facts').textContent=answer.facts || '';
  $('factsPanel').hidden=!answer.facts;
  $('askNext').textContent=answer.ask_en || '';
  $('askPanel').hidden=!answer.ask_en;
  renderNext(answer);
  $('answerState').textContent = answer.language_issue ? 'Язык требует проверки' : label;
  $('sourceTitle').textContent=answer.material_ids?.length?'Материалы подготовки':'Источники ответа';
  $('sourceDetails').hidden=!(answer.material_ids || answer.source_ids)?.length;
  sources(answer.material_ids || answer.source_ids);
  return answer;
}
function historyControls() {
  const remaining=answerHistory.length-answerIndex-1;
  const unread=answerHistory.filter(item=>!item.seen).length;
  $('previousAnswer').disabled=answerIndex<=0;
  $('nextAnswer').disabled=remaining<=0;
  $('nextAnswer').textContent=remaining>0?`Следующая подсказка (${remaining})`:'Следующая подсказка';
  $('answerPosition').textContent=answerIndex<0?'Пока без ответа':`Подсказка ${answerIndex+1} из ${answerHistory.length}`;
  $('newAnswerNotice').textContent=unread>0?`Готово новых подсказок: ${unread}. Текущий ответ сохранён.`:'Ответ остаётся на экране, пока вы сами не перейдёте к следующему.';
}
function renderPreliminary(preview, state=preliminaryIdle) {
  $('previewText').textContent=preview?.text || '';
  $('previewText').hidden=!preview?.text;
  $('previewState').textContent=state;
}
function previewStatus(item) {
  return item.preliminary?.changed ? 'Ранний вариант · вопрос уточнён'
    : item.previewPending ? 'По текущему фрагменту речи'
    : item.preliminary ? 'Для выбранной подсказки' : 'Для этого ответа предварительной подсказки не было.';
}
function renderSelected(item) {
  renderPreliminary(item.preliminary,previewStatus(item));
  const preview=item.preliminary;
  if(preview && !preview.wasShown) {
    preview.wasShown=true;
    const details={request_id:preview.requestId,provider_turn_id:preview.turnId,before_final:item.previewPending};
    record('preliminary_shown',{...details,answer_en:preview.text,
      after_request_ms:Math.round(performance.now()-preview.started)},item.session);
    recordVisible('previewText','preliminary_visible',details,preview.started,item.session,
      ()=>answerHistory[answerIndex]===item);
  }
}
function readAnswer(index) {
  if(index<0 || index>=answerHistory.length)return;
  answerIndex=index;
  const item=answerHistory[index];item.seen=true;
  renderSelected(item);
  if(!item.answer) {
    $('questionRu').textContent='';
    $('answerEn').textContent=item.label;
    $('answerState').textContent='Предварительная подсказка';
    $('timing').textContent='';
    $('caution').textContent='';
    $('factsPanel').hidden=true;
    $('askPanel').hidden=true;
    $('sourceDetails').hidden=true;
    renderNext({});
    historyControls();
    return;
  }
  const displayed=renderAnswer(item.answer,item.label,item.originalQuestion);
  $('timing').textContent=item.timing || '';
  record('answer_shown', {...answerText(displayed), label:$('answerState').textContent, timing:item.timing,
    answer_id:index+1, request_id:item.requestId, origin:item.origin, preliminary_en:item.preliminary?.text,
    code:displayed.language_issue ? 'client_language_warning' : displayed.validation_code}, item.session);
  recordVisible('answerEn','answer_visible',{request_id:item.requestId,answer_id:index+1},
    item.started,item.session,()=>answerIndex===index);
  historyControls();
}
function showAnswer(answer,label,incoming=false,timing='',requestId,started,pair=null) {
  // Keep the complete answer and its source/warning together. History is in memory
  // for this window only. Never evict an answer while the user may still read it.
  const origin=answer.source_recovery ? 'source_recovery' : requestId ? 'model' : label.startsWith('Карточка') ? 'card' : 'phrase';
  const session=captureLog || null;
  const item=pair && !pair.answer ? pair : {preliminary:pair?.preliminary};
  Object.assign(item,{answer,label,timing,requestId,started,origin,session,originalQuestion:$('question').value});
  const index=answerHistory.indexOf(item);
  if(index<0) answerHistory.push(item);
  if (!requestId) record('answer_prepared', {...answerText(answer), answer_id:answerHistory.length, origin}, session);
  if(index>=0 && answerIndex===index) readAnswer(index);
  else if(index<0 && (!incoming || !liveAnswerReceived)) readAnswer(answerHistory.length-1);
  if(incoming)liveAnswerReceived=true;
  historyControls();
  return item;
}
function cancelPending() {
  turns.invalidate(); queued=false; queuedManual=false;queuedCoach=null;
  clearTimeout(timer); clearTimeout(retryTimer); clearTimeout(coachingTimer);
  const request=activeRequest;
  if (request && !request.controller.signal.aborted) {
    request.controller.abort();
    microphone?.releaseEvidence?.();
    post('/api/cancel',{job_id:request.id}).catch(()=>{});
    record('answer_cancelled',{request_id:request.number,code:'continued_speech'},request.session);
  }
}
function cancelPreliminary() {
  clearTimeout(preliminaryTimer);
  preliminaryTimer=null;
  const job=preliminaryJob;
  preliminaryJob=null;
  if (!job) return;
  job.controller.abort();
  post('/api/cancel',{job_id:job.id}).catch(()=>{});
}
function resetPreliminary() {
  cancelPreliminary();
  preliminaryTurn=null;
}
function setUnselectedPreviewState(state=preliminaryIdle) {
  if(answerIndex<0) renderPreliminary(null,state);
}
function closePreviewPair(pair, label) {
  if(!pair || pair.answer) return;
  pair.previewPending=false;
  pair.label=label;
  if(answerHistory[answerIndex]===pair) readAnswer(answerIndex);
}
function isPreliminaryCandidate(text) {
  const clauses=text.split(/[.!?。！？]+\s*/u).filter(Boolean);
  const opening=normalizedWords(clauses.at(-1) || text)
    .replace(/^(?:(?:um|uh|well|so|okay|all right|before we start|next question|так|ну|хорошо) )+/u,'');
  const direct=/^(?:what|how|who|why|when|where|which|can you|could you|would you|do you|is it|are there|что|как|кто|когда|почему|где|какой|какая|можете ли) /u;
  return text.length<=4000 && opening.split(' ').length>=5
    && (direct.test(opening) || /[?？]$/u.test(text))
    && !/(?:^| )(?:and|or|if|the|of|for|a|to|или|что|если|и|для)$/u.test(opening)
    && !isCallAside(text);
}
function considerPreliminary(event) {
  if (!configured || !$('automatic').checked || micBlocking() || cooldownUntil>Date.now()) return;
  const text=event.transcript?.trim() || '';
  if (preliminaryTurn?.id!==event.turn_order) {
    closePreviewPair(preliminaryTurn?.pair,'Реплика завершилась без ответа.');
    resetPreliminary();
    preliminaryTurn={id:event.turn_order,anchor:'',text:'',attempts:0,pair:null};
    setUnselectedPreviewState();
  }
  const turn=preliminaryTurn, words=normalizedWords(text);
  if (turn.anchor && words!==turn.anchor && !words.startsWith(turn.anchor+' ')) {
    cancelPreliminary();
    turn.anchor='';
    if(turn.pair) {
      turn.pair.preliminary.changed=true;
      if(answerHistory[answerIndex]===turn.pair) renderSelected(turn.pair);
    }
  }
  turn.text=text;
  if (turn.pair || !isPreliminaryCandidate(text) || preliminaryTimer || preliminaryJob || turn.anchor || turn.attempts>=2) return;
  turn.anchor=words;
  const delay=Math.max(preliminaryDelay,lastPreliminaryAt+preliminarySpacing-Date.now());
  preliminaryTimer=setTimeout(()=>{
    preliminaryTimer=null;
    if(preliminaryTurn===turn && speaking && !micBlocking() && isPreliminaryCandidate(turn.text)) preparePreliminary(turn);
  },delay);
}
async function preparePreliminary(turn) {
  const job={id:crypto.randomUUID(),controller:new AbortController(),number:++requestNumber,session:captureLog};
  const started=performance.now();
  const goal=currentGoal();
  preliminaryJob=job;
  turn.attempts++;
  lastPreliminaryAt=Date.now();
  setUnselectedPreviewState('Готовлю по текущему фрагменту…');
  try {
    const answer=await streamHint({question:turn.text,preliminary:true,job_id:job.id,...strategyContext(goal,8000)},job);
    if (preliminaryJob!==job || preliminaryTurn!==turn || !speaking || currentGoal()!==goal) return;
    const value=answer.answer_en?.trim();
    if (answer.skip || answer.unavailable || !value || value.length>240 || /[0-9]/u.test(value)
        || displayAnswer(answer,turn.text).answer_language_invalid) {
      setUnselectedPreviewState();
      return;
    }
    const preliminary={text:value,fragment:turn.text,started,requestId:job.number,turnId:turn.id};
    const pair={preliminary,previewPending:true,label:'Жду полного вопроса.',session:job.session};
    turn.pair=pair;
    answerHistory.push(pair);
    if(!liveAnswerReceived) {
      liveAnswerReceived=true;
      readAnswer(answerHistory.length-1);
    }
    historyControls();
  } catch (error) {
    if (preliminaryJob!==job) return;
    if (error.status===429) {
      const seconds=Number(error.retryAfter)||60;
      cooldownUntil=Math.max(cooldownUntil,Date.now()+seconds*1000);
    }
    setUnselectedPreviewState();
  } finally {
    if (preliminaryJob===job) preliminaryJob=null;
  }
}
function resetQuestion() {
  closePreviewPair(preliminaryTurn?.pair,'Подготовка остановлена.');
  closePreviewPair(groupedPair,'Подготовка остановлена.');
  resetPreliminary();groupedPair=null;finalSpeech='';
  setUnselectedPreviewState();
  grouped=[]; groupedTurnIds=[]; groupTime=0; groupSpeakerId=null; groupCanContinue=false; pendingQuestion=false; readyAt=0;
}
function scheduleAnswer() {
  clearTimeout(timer);
  if (!pendingQuestion || speaking || micBlocking() || !$('automatic').checked) return;
  timer=setTimeout(()=>ask(), Math.max(0,readyAt-Date.now()));
}
function speechStarted() {
  if (speaking) return;
  speechStartedAt=Date.now();
  beforeSpeechState=$('generationState').textContent;
  answerInFlightAtSpeechStart=Boolean(activeRequest && !activeRequest.controller.signal.aborted);
  speaking=true;
  cancelPending();
  $('generationState').textContent='Собеседник продолжает · жду конец вопроса';
}
function selectCard(card) {
  liveAnswerReceived=true;
  resetQuestion();
  cancelPending(); error('');
  showAnswer({...card, source_ids:[card.id]}, 'Карточка · без API',false,'Готовая формулировка. Это не распознавание речи и не ответ модели.');
  $('question').value = card.example_question;
}
function waitForAnswerRetry(manual, coaching=null, hostId=0) {
  const seconds = Math.max(1, Math.ceil((cooldownUntil-Date.now())/1000));
  clearTimeout(retryTimer);
  error(`Лимит подсказок · пауза ${seconds} с. Распознавание звука продолжается.`);
  $('generationState').textContent=retryCount>1
    ? 'Автоповтор остановлен · после паузы можно запросить подсказку вручную'
    : 'Пауза API · повторю один актуальный запрос';
  if(retryCount>1) return;
  const moment=Math.min(2_000_000_000,Math.max(0,cooldownUntil-Date.now())+100);
  retryTimer=setTimeout(()=>{
    if(speaking || micBlocking() || !(manual || $('automatic').checked)) return;
    if(coaching && (coaching!==answerHistory.at(-1) || pendingQuestion || hostId<=coachedHostId)) return;
    ask(manual,coaching,hostId);
  },moment);
}

function showUnavailable() {
  const previous=answerIndex>=0;
  $('generationState').textContent=previous?'Новая подсказка не готова · предыдущая на экране':'Подсказка пока не готова';
  error(previous?'Можно повторить вопрос или открыть карточку ниже.':'Повторите вопрос или откройте карточку ниже.');
}

async function ask(manual=false, coaching=null, hostId=0) {
  clearTimeout(timer);
  if (!manual && (speaking || micBlocking() || Date.now()<readyAt)) { scheduleAnswer(); return; }
  const question = (coaching?.originalQuestion || $('question').value).trim();
  if (!question) { if(manual) error('Введите или дождитесь вопроса.'); return; }
  if (!manual && !coaching && (isAcknowledgement(question) || question===lastAnswered)) return;
  if (question.length>4000) { error('Вопрос длиннее 4000 символов. Сократите его вручную.'); return; }
  const turnIds=groupedTurnIds;
  const pair=manual || coaching ? null : groupedPair;
  const preliminary=pair?.preliminary;
  const completeSpeech=manual || coaching ? '' : finalSpeech;
  if (manual) { cancelPending(); resetQuestion(); pendingQuestion=true; }
  if (!configured) {
    if (manual) { $('setup').hidden=false; error('Подключите API или выберите готовую карточку ниже.'); }
    return;
  }
  if (coaching && busy) return;
  const retryKey=JSON.stringify([currentGoal(),question,coaching ? 'next' : 'answer',coaching ? hostId : turnIds.at(-1)]);
  if (retryKey!==retryQuestion) {retryQuestion=retryKey;retryCount=0;}
  if (!manual && retryCount>1) { $('generationState').textContent='Автоповтор остановлен · запросите ответ вручную'; return; }
  if (cooldownUntil>Date.now()) { waitForAnswerRetry(manual,coaching,hostId); return; }
  if (busy) { queued=true; queuedManual=manual; return; }
  // A fresh manual request after a pause permits one new bounded retry.
  if(manual && retryCount>1) retryCount=0;
  clearTimeout(retryTimer);
  busy=true; queued=false; const version=turns.invalidate();
  const started=performance.now(), finalAt=manual?null:latestFinalAt;
  const session=captureLog || null, requestId=++requestNumber;
  const request={id:crypto.randomUUID(),controller:new AbortController(),number:requestId,session};
  activeRequest=request;
  let shortItem;
  if(coaching && $('generationState').textContent.startsWith('Пауза API')) {
    $('generationState').textContent='Текущая подсказка сохранена';
    error('');
  }
  if(!coaching) {
    $('generationState').textContent='Готовлю новый ответ · текущий сохранён';
    $('ask').textContent='Готовлю ответ…'; error('');
  }
  try {
    if (!coaching) {
      if (manual && questionEdited) record('question_edited', {question}, session);
      questionEdited=false;
      record('question_submitted', {request_id:requestId, question, manual, turn_ids:turnIds}, session);
    }
    const strategy=strategyContext();
    const answer=await streamHint({question,manual,job_id:request.id,refresh_next:!!coaching,
      displayed_preview:preliminary?.wasShown ? preliminary.text : '',final_speech:completeSpeech,...strategy},request,event=>{
      if (coaching || !turns.current(version) || request.controller.signal.aborted) return;
      record('say_preview',{request_id:requestId,first_say_ms:event.elapsed_ms,answer_en:event.text},session);
    },event=>{
      if (coaching || shortItem || micPending() || micBlocking() || !turns.current(version)
          || request.controller.signal.aborted || currentGoal()!==strategy.goal_mode) return;
      const short={question_ru:'Перевод вопроса готовится.',answer_en:event.text,source_ids:[],goal_mode:strategy.goal_mode};
      if (displayAnswer(short,question).answer_language_invalid || pair?.answer?.answer_en===event.text) return;
      shortItem=showAnswer(short,'Краткий ответ · детали готовятся',!manual,'',requestId,started,pair);
      record('answer_core_prepared',{request_id:requestId,answer_id:answerHistory.indexOf(shortItem)+1,
        answer_en:event.text,api_ms:event.elapsed_ms,
        after_final_ms:finalAt===null?undefined:Math.round(performance.now()-finalAt)},session);
    });
    if (!coaching && micPending()) await waitForMicEvidence();
    const current=turns.current(version);
    if (current && !answer.skip && !answer.unavailable && answer.goal_mode===strategy.goal_mode) {
      const refs=(answer.context_refs || []).filter(id=>strategy.dialogue.some(row=>row.id===id));
      retained[strategy.goal_mode]=[...new Set([...refs,...retained[strategy.goal_mode]])].slice(0,8);
    }
    if (coaching) {
      if (current && answer.next_say) {
        coachedHostId=hostId;
        const next={next_why:answer.next_why,next_say:answer.next_say,goal_mode:answer.goal_mode};
        if (next.next_say!==coaching.answer.next_say || next.next_why!==coaching.answer.next_why) {
          coaching.pendingNext={...next,request_id:requestId};
          if (answerHistory[answerIndex]===coaching) $('showNextIdea').hidden=false;
          record('next_prepared', {...next,request_id:requestId,answer_id:answerHistory.indexOf(coaching)+1},session);
        }
      }
      return;
    }
    const afterFinal=finalAt===null ? undefined : Math.round(performance.now()-finalAt);
    if (answer.skip) {
      record('question_skipped',{request_id:requestId,code:'model_skip'},session);
      if (current) {
        lastAnswered=question; pendingQuestion=false;
        closePreviewPair(pair,'Реплика не требует ответа.');
        $('generationState').textContent='Реплика не требует ответа';
      }
      return;
    }
    const invalidLanguage=displayAnswer(answer,question).answer_language_invalid;
    const unavailable=answer.unavailable || invalidLanguage;
    const existingItem=shortItem || (pair && (!pair.answer || pair.answer.answer_en===answer.answer_en) ? pair : null);
    record(unavailable?'answer_rejected':'answer_prepared', {...answerText(answer), origin:answer.source_recovery?'source_recovery':'model',
      request_id:requestId, cached:!!answer.cached, code:answer.validation_code || (invalidLanguage?'client_answer_language':undefined), fingerprint:answer.fingerprint,
      retrieved_source_ids:answer.retrieved_source_ids, commercial_intent:answer.commercial_intent,
      answer_id:current && !unavailable ? (existingItem ? answerHistory.indexOf(existingItem)+1 : answerHistory.length+1) : undefined,
      preliminary_en:preliminary?.text, discarded:!current,
      api_ms:answer.elapsed_ms, after_final_ms:afterFinal, first_say_ms:answer.first_say_ms}, session);
    if (current) {
      if(preliminary) preliminary.finalReadyAt=Date.now();
      lastAnswered=question; retryCount=0; pendingQuestion=false;
      if (unavailable) {
        if(!shortItem) {closePreviewPair(pair,'Ответ недоступен.');showUnavailable();}
        return;
      }
      const label=answer.source_recovery?'Проверенный резерв · модель не ответила':
        answer.validation_code==='repaired_commercial_number'?'По источникам · число сверено':
        answer.reviewed_copy?'Подготовленный ответ · выбран моделью':answer.status==='follow_up'?'Нужна проверка':answer.status==='clarify'?'Уточнение':'Черновик по источникам';
      const sayTime=Number.isFinite(answer.first_say_ms) ? `Первая фраза: ${(answer.first_say_ms/1000).toFixed(1)} с · ` : '';
      const timing=answer.cached?'Повтор из локальной памяти.':`${sayTime}Готовая подсказка: ${(answer.elapsed_ms/1000).toFixed(1)} с после отправки.`;
      if (existingItem?.answer) {
        Object.assign(existingItem,{answer,label,timing});
        if (answerHistory[answerIndex]===existingItem) {
          renderAnswer(answer,label,existingItem.originalQuestion);
          $('timing').textContent=timing;
        }
      } else {
        showAnswer(answer,label,!manual,timing,requestId,started,pair);
      }
      $('generationState').textContent=answer.source_recovery?'Готова проверенная подсказка':'Новый ответ готов';
      if (!answer.source_recovery) $('connection').textContent='API ответов подключён';
    }
  } catch(e) {
    if (request.controller.signal.aborted || e.code==='cancelled') return;
    record('error', {stage:'answer', code:e.code || (e.status ? 'local_http' : 'network'),
      status:e.status, request_id:requestId, retry_after_s:e.retryAfter, fingerprint:e.fingerprint,
      elapsed_ms:Math.round(performance.now()-started)}, session);
    if(e.status===429) {
      const advertised=Number(e.retryAfter);
      const seconds=Number.isFinite(advertised) && advertised>0 ? Math.ceil(advertised) : 60;
      cooldownUntil=Math.max(cooldownUntil,Date.now()+seconds*1000);
      if(turns.current(version)) {
        retryCount++;
        waitForAnswerRetry(manual,coaching,hostId);
      }
    } else if(!coaching && turns.current(version)) {
      pendingQuestion=false;
      if (!shortItem) {closePreviewPair(pair,'Ответ недоступен.');showUnavailable();}
    }
  } finally {
    if (shortItem?.label==='Краткий ответ · детали готовятся') {
      shortItem.label='Краткий ответ';
      if(answerHistory[answerIndex]===shortItem) $('answerState').textContent=shortItem.label;
      if(turns.current(version)) $('generationState').textContent='Краткий ответ готов';
    }
    if (activeRequest===request) activeRequest=null;
    busy=false; $('ask').textContent='Подсказать ответ';
    if(queued && configured) {
      const manualNext=queuedManual; queued=false; queuedManual=false;queuedCoach=null;
      if (manualNext) ask(true); else scheduleAnswer();
    } else if(queuedCoach) {
      const host=queuedCoach;queuedCoach=null;
      scheduleCoach(host,0);
    }
  }
}
function withdrawsQuestion(text) {
  return /^(?:never mind|forget (?:that|the question)|no need to answer|отбой|забудь(?:те)? вопрос|не нужно отвечать)(?=$|[\s,.!?])/iu.test(text);
}
function pickQuestionPart(utterances) {
  const tail=utterances.at(-1);
  if(!tail || utterances.length===1 || withdrawsQuestion(tail.text)
      || /^(?:actually|i mean|specifically|only|make that|точнее|имею в виду|только)(?=$|[\s,.!?])/iu.test(tail.text)) return tail;
  const recent=utterances.slice().reverse();
  return recent.find(row=>/[?？]/u.test(row.text)
    || /^(?:(?:can|could|would|will) you|what about|how about|tell us|please (?:explain|share|tell)|что насчёт|расскажите|уточните)(?=$|[\s,.!?])/iu.test(row.text))
    || recent.find(row=>isReplyTurn(row.text)) || tail;
}

function onTurn(event) {
  if (event.type==='SpeechStarted') { speechStarted(); return; }
  if (event.type!=='Turn' || !Number.isInteger(event.turn_order) || turns.final.has(event.turn_order)) return;
  if (!event.end_of_turn) {
    showPartial('partial','Собеседник',event.transcript);
    // Even "Okay" can grow into "Okay, but ..." before the final.
    if (event.transcript?.trim()) {speechStarted();considerPreliminary(event);}
    return;
  }
  const final=turns.accept(event);
  if (!final) return;
  const earlyPair=preliminaryTurn?.id===event.turn_order ? preliminaryTurn.pair : null;
  const priorPair=groupedPair;
  resetPreliminary();
  const startedAt=speechStartedAt ?? Date.now(), wasSpeaking=speaking;
  const parts=final.text ? tabVoiceParts(event,Boolean(tabCapture?.speakerLabels)) : [];
  const utterances=parts.map((part,index)=>appendTranscript('tab',part.original,startedAt+part.offset,final.id,
    {label:part.label,mixed:part.mixed,pending:part.pending,capture:tabCapture,segment:index,
      providerLabel:event.speaker_label,turnOriginal:index===0 && parts.length>1 ? event.transcript : undefined}));
  const utterance=pickQuestionPart(utterances);
  const text=utterance?.text || '', acknowledgement=isAcknowledgement(text);
  const answerWasInFlight=wasSpeaking ? answerInFlightAtSpeechStart :
    Boolean(activeRequest && !activeRequest.controller.signal.aborted);
  speaking=false; speechStartedAt=null; showPartial('partial');
  if(withdrawsQuestion(text)) {
    closePreviewPair(earlyPair,'Вопрос отозван.');
    cancelPending();resetQuestion();
    record('question_skipped',{turn_id:utterance.id,code:'question_withdrawn'});
    $('generationState').textContent='Вопрос отозван';
    return;
  }
  // A microphone check or comment on the tool remains in the transcript.
  const aside=isCallAside(text);
  const previous=grouped.join(' ');
  const currentSpeakerId=utterance?.voiceId || null;
  const sameVoice=!tabCapture?.speakerLabels || Boolean(currentSpeakerId && currentSpeakerId===groupSpeakerId);
  const merge=groupCanContinue && sameVoice && continuesQuestion(previous,text,startedAt-groupTime,answerWasInFlight);
  const candidate=merge ? previous+' '+text : text;
  const questionReady=isReplyTurn(candidate) && (isReplyTurn(text) || (merge && /[\p{L}\p{N}]+[\s,]+[\p{L}\p{N}]+/u.test(text)));
  if (text && !acknowledgement && (aside || !questionReady)) {
    record('question_skipped', {turn_id:utterance.id, code:aside?'call_aside':'no_question'});
  }
  if (!text || acknowledgement || aside || !questionReady) {
    closePreviewPair(earlyPair,'Реплика не требует ответа.');
    setUnselectedPreviewState();
    if (acknowledgement) groupCanContinue=false;
    if (wasSpeaking) $('generationState').textContent=beforeSpeechState;
    if (pendingQuestion && (wasSpeaking || activeRequest)) {
      if (!wasSpeaking) cancelPending();
      readyAt=Date.now();scheduleAnswer();
    } else if (acknowledgement) {
      const host=dialogue.at(-2);
      if(host?.role==='mic') scheduleCoach(host,0);
    }
    return;
  }
  $('transcript').dataset.finalAt = new Date().toISOString();
  latestFinalAt=performance.now(); cancelPending();
  if(priorPair && (!merge || earlyPair)) closePreviewPair(priorPair,'Собеседник перешёл к другому вопросу.');
  groupedPair=earlyPair || (merge ? priorPair : null);
  finalSpeech=(merge ? finalSpeech+' '+event.transcript : event.transcript).trim().slice(-16_000);
  if(earlyPair) {
    const shown=earlyPair.preliminary;
    shown.changed ||= !normalizedWords(event.transcript).startsWith(normalizedWords(shown.fragment))
      || /\b(?:actually|rather|instead|i meant)\b|(?:на самом деле|точнее|вместо этого)/iu.test(event.transcript);
    closePreviewPair(earlyPair,'Готовлю финальный ответ.');
  }
  setUnselectedPreviewState();
  grouped = merge ? [...grouped,text] : [text];
  groupedTurnIds = merge ? [...groupedTurnIds,utterance.id] : [utterance.id];
  questionEdited=false;
  groupTime=Date.now(); groupSpeakerId=currentSpeakerId; groupCanContinue=true; pendingQuestion=true; readyAt=Date.now();
  $('question').value=grouped.join(' ');
  $('generationState').textContent=merge?'Собеседник продолжил · обновляю подсказку':'Готовлю подсказку';
  scheduleAnswer();
}
function scheduleCoach(host, delay=2600) {
  clearTimeout(coachingTimer);
  const item=answerHistory.at(-1);
  if(host.thinkingPhrase || host.id<=coachedHostId || !isReplyTurn(host.text) || item?.origin!=='model') return;
  coachingTimer=setTimeout(()=>{
    if(!$('automatic').checked || speaking || pendingQuestion || microphone?.startedAt!=null
        || item!==answerHistory.at(-1) || host.id<=coachedHostId) return;
    if(busy) {
      if(activeRequest?.controller.signal.aborted) queuedCoach=host;
      return;
    }
    ask(false,item,host.id);
  },delay);
}
function showPartial(id, speaker='', text='') {
  const value=text?.trim() || '';
  $(id).textContent=value ? speaker+' · '+value : '';
  $(id).hidden=!value;
}
function voiceDisplay(voice) {
  if(!voice.name) return voice.fallback;
  return voice.channel==='mic' ? voice.name+' · Я' : voice.name;
}

function registerVoice(channel, {label,mixed,capture}={}) {
  const fallback=channel==='mic' ? 'Я'
    : mixed ? 'Несколько голосов' : label ? `Голос ${label} · подключение ${capture.number}`
    : capture?.speakerLabels ? 'Собеседник · голос не определён' : 'Собеседник';
  const id=channel==='mic' ? 'mic:local' : label && capture ? `tab:${capture.id}:${label}` : null;
  if(!id) return {id:null,name:null,fallback,channel};
  if(voices.has(id)) return voices.get(id);
  const voice={id,name:channel==='mic'?'Я':null,fallback,channel,labels:[]};
  voices.set(id,voice);
  const form=document.createElement('form');form.className='speaker-name-row';
  const caption=document.createElement('label');
  const input=document.createElement('input');input.type='text';input.maxLength=60;input.value=voice.name || '';
  input.autocomplete='off';
  const save=document.createElement('button');save.type='submit';save.textContent='Подтвердить';
  caption.textContent=channel==='mic' ? 'Имя у микрофона' : fallback;
  caption.append(input);form.append(caption,save);
  form.onsubmit=event=>{
    event.preventDefault();
    const entered=input.value.trim().replace(/\s+/g,' ').slice(0,60);
    voice.name=entered || null;
    input.value=entered;
    voice.labels.forEach(heading=>{heading.textContent=voiceDisplay(voice);});
    record('speaker_named',{channel,speaker_id:id,speaker_name:voice.name,capture_id:capture?.id,speaker_label:label});
  };
  $('speakerRows').append(form);
  $('speakerControls').hidden=false;
  return voice;
}

function appendTranscript(role, original, at, providerId, attribution={}) {
  const text=original.trim();
  const voice=registerVoice(role,attribution);
  const turn={id:dialogue.length+1, role, text, at, voiceId:voice.id,thinkingPhrase:attribution.thinkingPhrase};
  dialogue.push(turn);
  const item=answerHistory.at(-1);
  if(item?.pendingNext && !attribution.thinkingPhrase) {
    item.pendingNext=null;
    if(answerHistory[answerIndex]===item) $('showNextIdea').hidden=true;
  }
  const viewport=$('transcript'), list=$('dialogueTurns');
  const follow=list.children.length===0 || viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop<48;
  const line=document.createElement('li');
  line.className='dialogue-turn';
  line.dataset.channel=role;
  line.dataset.at=String(at);
  const heading=document.createElement('div');
  heading.className='dialogue-turn-heading';
  const who=document.createElement('strong');who.textContent=voiceDisplay(voice);
  if(voice.id) voice.labels.push(who);
  const time=document.createElement('time');
  time.dateTime=new Date(at).toISOString();
  time.textContent=new Date(at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const words=document.createElement('p');words.textContent=text;
  heading.append(who,time);line.append(heading,words);
  let previous=list.lastElementChild;
  while(previous && Number(previous.dataset.at)>at) previous=previous.previousElementSibling;
  list.insertBefore(line,previous ? previous.nextElementSibling : list.firstElementChild);
  $('dialogueEmpty').hidden=true;
  if(follow) viewport.scrollTop=viewport.scrollHeight;
  const cyrillic=/[а-яё]/i.test(text), latin=/[a-z]/i.test(text);
  const language=cyrillic && latin ? 'mixed' : cyrillic ? 'ru' : latin ? 'en' : null;
  const {capture,label,mixed,pending,providerLabel,segment,turnOriginal}=attribution;
  record('transcript_final',{original,turn_id:turn.id,provider_turn_id:providerId, segment_index:segment,
    turn_original:turnOriginal, uttered_at:time.dateTime,channel:role,speaker:voiceDisplay(voice),speaker_id:voice.id,speaker_name:voice.name,
    capture_id:capture?.id, speaker_label:label || (pending?'PENDING':undefined),
    provider_speaker_label:capture?.speakerLabels ? providerLabel : undefined,
    speaker_attribution:role==='mic' || label ? 'identified' : mixed ? 'mixed' : pending ? 'pending'
      : capture?.speakerLabels ? 'unknown' : undefined,
    mixed_speakers:Boolean(mixed),language,acknowledgement:isAcknowledgement(text)});
  return turn;
}
function closeSpeechSocket(ws) {
  if (ws?.readyState===WebSocket.OPEN) {
    ws.onmessage=event=> { try { if(JSON.parse(event.data).type==='Termination') ws.close(); } catch {} };
    try { ws.send(JSON.stringify({type:'Terminate'})); } catch { ws.close(); }
    setTimeout(()=>ws.close(),1600);
  } else if(ws && ws.readyState!==WebSocket.CLOSED) ws.close();
}
function connectAudioSource(audioContext, media) {
  const source=audioContext.createMediaStreamSource(new MediaStream(media.getAudioTracks()));
  const node=new AudioWorkletNode(audioContext,'pcm-processor');
  source.connect(node);node.connect(audioContext.destination);
  return node;
}
function stopMic(message='Микрофон суфлёра выключен', retry=false) {
  const input=microphone;
  microphone=null;
  if(input) {
    clearTimeout(input.timer);
    input.releaseEvidence?.();
    input.reject?.(new Error('Микрофон остановлен.'));
    input.stream?.getTracks().forEach(track=>track.stop());
    input.worklet?.disconnect();
    closeSpeechSocket(input.socket);
    record('capture_disconnected',{channel:'mic'});
  }
  showPartial('micPartial');
  $('micLevel').value=0;
  $('mic').textContent=retry?'Повторить подключение микрофона':'Включить микрофон';
  $('mic').setAttribute('aria-pressed','false');
  $('micState').textContent=message;
  if(input && pendingQuestion) scheduleAnswer();
}
function micSpeechStarted(input) {
  if(input.startedAt!==null) return;
  input.startedAt=Date.now();
  input.thinkingPossible=thinkingPhrases.length>0;
  input.thinkingConfirmed=false;
  clearTimeout(coachingTimer);
  if(activeRequest && !input.thinkingPossible) cancelPending();
}
function onMicTurn(input,payload) {
  if(payload.type==='SpeechStarted') {micSpeechStarted(input);return;}
  if(payload.type!=='Turn' || !Number.isInteger(payload.turn_order) || input.turns.final.has(payload.turn_order)) return;
  if(!payload.end_of_turn) {
    if(payload.transcript?.trim()) {
      micSpeechStarted(input);
      const preview=(preliminaryTurn?.pair || groupedPair)?.preliminary;
      input.readingPreview=preview?.wasShown && readsPreliminary(payload.transcript,preview,true);
      if(input.thinkingPossible && (payload.transcript.match(/[\p{L}\p{N}]+/gu) || []).length>=4) {
        input.thinkingPossible=matchesThinkingPhrase(payload.transcript,thinkingPhrases,{partial:true});
        input.thinkingConfirmed=input.thinkingPossible;
        if(!input.thinkingPossible && !input.readingPreview && activeRequest)cancelPending();
        if(!input.readingPreview) input.releaseEvidence?.();
      }
      if(activeRequest && micBlocking()) cancelPending();
    }
    showPartial('micPartial','Я',payload.transcript);
    return;
  }
  const final=input.turns.accept(payload);
  const at=input.startedAt ?? Date.now();
  input.startedAt=null;input.thinkingPossible=false;input.thinkingConfirmed=false;input.readingPreview=false;
  input.releaseEvidence?.();
  showPartial('micPartial');
  if(!final?.text) {scheduleAnswer();return;}
  const thinkingPhrase=matchesThinkingPhrase(final.text,thinkingPhrases);
  const host=appendTranscript('mic',payload.transcript,at,final.id,{thinkingPhrase});
  if(isAcknowledgement(final.text) || thinkingPhrase) {
    if(!activeRequest) scheduleAnswer();
    return;
  }
  const candidate=(preliminaryTurn?.pair || groupedPair)?.preliminary;
  const repeatsPreview=candidate?.wasShown && readsPreliminary(final.text,candidate);
  if(at>=groupTime && !repeatsPreview) groupCanContinue=false;
  const substantive=isReplyTurn(final.text);
  const selected=candidate?.wasShown && answerHistory[answerIndex]?.preliminary===candidate;
  if(candidate && !candidate.updatedForSpeech && !speaking && substantive
      && (pendingQuestion || selected || at <= (candidate.finalReadyAt ?? 0))) {
    candidate.updatedForSpeech=true;
    lastAnswered='';
    pendingQuestion=true;
    if(activeRequest) cancelPending();
  } else if(activeRequest && pendingQuestion && substantive && !repeatsPreview) {
    cancelPending();
  }
  if(pendingQuestion) scheduleAnswer();
  else if(isReplyTurn(final.text)) scheduleCoach(host);
}
async function startMic() {
  if(microphone){stopMic();return;}
  if(!context || !stream) {
    $('micState').textContent='Сначала подключите звук вкладки Meet.';
    return;
  }
  if(!navigator.mediaDevices?.getUserMedia) {
    stopMic('Микрофон суфлёра недоступен. Откройте суфлёр в Chrome и попробуйте снова.',true);
    return;
  }
  const localContext=context, input={turns:new Turns(),startedAt:null,thinkingPossible:false,thinkingConfirmed:false};
  microphone=input;
  $('mic').textContent='Выключить микрофон';
  $('micState').textContent='Разрешите микрофон для суфлёра, если Chrome спросит';
  try {
    const media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
    if(microphone!==input){media.getTracks().forEach(track=>track.stop());return;}
    input.stream=media;
    if(!media.getAudioTracks().length) throw new Error('Микрофон недоступен.');
    media.getAudioTracks().forEach(track=>track.addEventListener('ended',()=>{
      if(microphone===input) stopMic('Микрофон суфлёра отключён.',true);
    },{once:true}));
    $('micState').textContent='Подключаю распознавание микрофона…';
    const {token}=await post('/api/token');
    if(microphone!==input)return;
    const ws=new WebSocket('wss://streaming.assemblyai.com/v3/ws?'+streamingParameters(token,localContext.sampleRate));
    input.socket=ws;
    await new Promise((resolve,reject)=>{
      input.reject=reject;
      input.timer=setTimeout(()=>reject(new Error('Микрофон не подключился. Повторите попытку.')),15000);
      ws.onmessage=event=>{
        if(microphone!==input)return;
        let data;try{data=JSON.parse(event.data);}catch{return;}
        if(data.type==='Begin') {
          clearTimeout(input.timer);input.reject=null;
          record('capture_connected',{channel:'mic'});resolve();
        } else if(data.type==='Termination') stopMic('Распознавание микрофона завершено.',true);
        else onMicTurn(input,data);
      };
      ws.onerror=()=>{if(input.reject)input.reject(new Error('Не удалось подключить микрофон.'));};
      ws.onclose=event=>{
        if(microphone!==input)return;
        if(input.reject)input.reject(new Error('Не удалось подключить распознавание микрофона.'));
        else {
          record('error',{stage:'capture',channel:'mic',code:'socket_closed',socket_code:event.code});
          stopMic('Распознавание микрофона прервалось.',true);
        }
      };
    });
    if(microphone!==input)return;
    input.worklet=connectAudioSource(localContext,media);
    input.worklet.port.onmessage=event=>{
      if(microphone!==input || ws.readyState!==WebSocket.OPEN)return;
      $('micLevel').value=Math.min(1,event.data.rms*5);
      if(ws.bufferedAmount>localContext.sampleRate*2*3) {
        record('error',{stage:'capture',channel:'mic',code:'audio_backlog'});
        stopMic('Сеть не успевает передавать звук с микрофона.',true);
        return;
      }
      ws.send(event.data.buffer);
    };
    $('mic').setAttribute('aria-pressed','true');
    $('micState').textContent='Слушаю микрофон суфлёра · Я';
  } catch(error) {
    if(microphone!==input)return;
    const denied=error.name==='NotAllowedError';
    record('error',{stage:'capture',channel:'mic',code:denied?'capture_denied':'capture_failed'});
    stopMic(denied?'Разрешите микрофон для суфлёра в настройках сайта Chrome и повторите подключение.'
      :error.name==='NotFoundError'?'Chrome не нашёл микрофон. Проверьте устройство ввода и повторите подключение.'
      :'Не удалось подключить микрофон суфлёра.',true);
  }
}
function releaseAudio() {
  stream?.getTracks().forEach(t=>t.stop()); stream=null;
  worklet?.disconnect(); worklet=null;
  if(context) context.close().catch(()=>{}); context=null;
  $('level').value=0;
}
function stopAudio(message='Звук остановлен', code='manual_stop', socketCode) {
  if(socket || stream || context) record('session_stopped', {code, channel:'tab', socket_code:socketCode});
  stopMic();
  $('mic').disabled=true;
  captureEpoch++;tabCapture=null;
  $('speakerDiarization').disabled=false;$('speakerDiarization').checked=speakerLabelsPreference;
  clearTimeout(timer); clearTimeout(lifetimeTimer); clearTimeout(connectionTimer);
  clearTimeout(retryTimer); retryQuestion=''; retryCount=0; lastAnswered='';
  cancelPending(); resetQuestion(); speaking=false; speechStartedAt=null; showPartial('partial');
  const oldSocket=socket; socket=null;
  closeSpeechSocket(oldSocket);
  if($('vocabularyState').dataset.state==='connected') {
    $('vocabularyState').textContent=`Сессия завершена · ${KEYTERMS.length} терминов отправятся снова при запуске`;
    $('vocabularyState').dataset.state='stopped';
  } else {
    $('vocabularyState').textContent='Готов к отправке при следующем запуске.';
    $('vocabularyState').dataset.state='ready';
  }
  releaseAudio(); $('start').disabled=false;$('stop').disabled=true;$('stopTop').disabled=true;
  $('audioState').textContent=message;
  $('connection').textContent=configured?'Звук остановлен · ключ подключён':'Звук остановлен · без ключа';
}
async function startAudio() {
  if(!configured) { $('setup').hidden=false; error('Для распознавания нужен ключ AssemblyAI.'); return; }
  if(!navigator.mediaDevices?.getDisplayMedia || !window.AudioWorkletNode) {
    error('Откройте этот адрес в актуальном Chrome на Mac. Захват вкладки здесь недоступен.');return;
  }
  const epoch=++captureEpoch;
  const speakerLabels=$('speakerDiarization').checked;
  $('speakerDiarization').disabled=true;
  if (journalEnabled && !captureLog) {
    captureLog={id:crypto.randomUUID(),seq:0};
    record('session_started', {keyterm_count:KEYTERMS.length});
    $('journalState').hidden=false;
    $('journalState').textContent='Журнал разговора сохраняется на этом Mac.';
  }
  $('start').disabled=true; $('stop').disabled=false; $('stopTop').disabled=false; error('');
  $('audioState').textContent='Выберите вкладку Meet со звуком';
  $('vocabularyState').textContent='Словарь будет отправлен после выбора звука.';
  $('vocabularyState').dataset.state='ready';
  let localStream, localContext;
  try {
    localContext=new AudioContext(); context=localContext;
    await localContext.resume();
    if(epoch!==captureEpoch) {await localContext.close();return;}
    localStream=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser'},audio:{suppressLocalAudioPlayback:false},selfBrowserSurface:'exclude',systemAudio:'exclude',preferCurrentTab:false});
    if(epoch!==captureEpoch) {localStream.getTracks().forEach(t=>t.stop());return;}
    stream=localStream;
    if(!stream.getAudioTracks().length) throw new Error('В выбранном источнике нет звука. Выберите вкладку Chrome и включите её звук в окне выбора.');
    for(const track of stream.getTracks()) track.addEventListener('ended',()=>{if(epoch===captureEpoch)stopAudio('Передача вкладки завершена','share_ended');},{once:true});
    $('audioState').textContent='Подключаю AssemblyAI…';
    const {token}=await post('/api/token');
    if(epoch!==captureEpoch)return;
    await localContext.audioWorklet.addModule('/audio-worklet.js');
    if(epoch!==captureEpoch)return;
    const params=streamingParameters(token,localContext.sampleRate,{speakerLabels});
    $('vocabularyState').textContent=`Отправляю ${KEYTERMS.length} терминов…`;
    $('vocabularyState').dataset.state='connecting';
    const ws=new WebSocket('wss://streaming.assemblyai.com/v3/ws?'+params);socket=ws;
    await new Promise((resolve,reject)=>{
      let begun=false;
      connectionTimer=setTimeout(()=>reject(new Error('AssemblyAI не подтвердил подключение. Повторите запуск.')),15000);
      ws.onmessage=event=>{
        if(epoch!==captureEpoch)return;
        let payload;try{payload=JSON.parse(event.data);}catch{return;}
        if(payload.type==='Begin') {
          begun=true;clearTimeout(connectionTimer);
          tabCapture={id:crypto.randomUUID(),number:++tabCaptureNumber,speakerLabels};
          record('capture_connected',{channel:'tab',capture_id:tabCapture.id,speaker_labels:speakerLabels});
          $('vocabularyState').textContent=`Сессия открыта · отправлено ${KEYTERMS.length} терминов`;
          $('vocabularyState').dataset.state='connected';
          $('vocabularyState').dataset.connectedAt=new Date().toISOString();
          resolve();
        }
        else if(payload.type==='Turn' || payload.type==='SpeechStarted') onTurn(payload);
        else if(payload.type==='Termination') stopAudio('Сессия AssemblyAI завершена','provider_terminated');
      };
      ws.onerror=()=>{if(!begun)reject(new Error('Не удалось подключиться к AssemblyAI. Проверьте сеть и аккаунт.'));};
      ws.onclose=event=>{
        if(!begun)reject(Object.assign(new Error(`Сессия не открылась (код ${event.code}). Проверьте аккаунт и доступ к распознаванию.`),
          {code:'socket_open_failed',socketCode:event.code}));
        else if(epoch===captureEpoch){
          record('error',{stage:'capture',code:'socket_closed',socket_code:event.code});
          stopAudio(`Соединение прервано (код ${event.code})`,'socket_closed',event.code);
          error('Распознавание остановилось. Нажмите «Начать запись диалога» для нового подключения.');
        }
      };
    });
    if(epoch!==captureEpoch)return;
    turns.reset();resetQuestion();speaking=false;speechStartedAt=null;
    worklet=connectAudioSource(localContext,stream);
    worklet.port.onmessage=event=>{
      if(epoch!==captureEpoch)return;
      $('level').value=Math.min(1,event.data.rms*5);
      if(ws.readyState===WebSocket.OPEN) {
        if(ws.bufferedAmount>localContext.sampleRate*2*3) {
          record('error',{stage:'capture',code:'audio_backlog'});
          stopAudio('Сеть не успевает передавать звук','audio_backlog');
          error('Очередь звука превысила несколько секунд. Переподключитесь после проверки сети.');return;
        }
        ws.send(event.data.buffer);
      }
    };
    await localContext.resume();
    if(epoch!==captureEpoch) return false;
    $('mic').disabled=false;
    $('audioState').textContent='Слушаю звук вкладки · Собеседник';$('connection').textContent='AssemblyAI · распознавание подключено';
    lifetimeTimer=setTimeout(()=>stopAudio('Достигнут предел сессии. При необходимости подключитесь снова.','duration_limit'),7100*1000);
    return true;
  } catch(e) {
    if(epoch===captureEpoch) {
      const denied=e.name==='NotAllowedError';
      record('error',{stage:'capture',code:e.code || (denied?'capture_denied':'capture_failed'),
        status:e.status,socket_code:e.socketCode});
      stopAudio('Звук остановлен','capture_failed');
      error(denied?'Выбор вкладки отменён или доступ запрещён. Можно повторить подключение.':e.message);
    }
  }
}
$('settingsButton').onclick=()=>{document.body.classList.remove('focus');$('focus').textContent='Режим чтения';$('setup').hidden=!$('setup').hidden;};
$('closeSetup').onclick=()=>{$('setup').hidden=true;};
$('questionForm').onsubmit=event=>{event.preventDefault();ask(true);};
$('question').oninput=()=>{cancelPending();resetQuestion();questionEdited=true;$('generationState').textContent='Вопрос изменён · запросите ответ';};
$('automatic').onchange=()=>{if(!$('automatic').checked){cancelPending();closePreviewPair(preliminaryTurn?.pair,'Подготовка остановлена.');resetPreliminary();setUnselectedPreviewState();}else{scheduleAnswer();}};
$('mic').onclick=startMic;
$('goalMode').onchange=()=>{
  const item=answerHistory.at(-1);
  if(item) item.pendingNext=null;
  $('showNextIdea').hidden=true;
  cancelPending();closePreviewPair(preliminaryTurn?.pair,'Цель разговора изменилась.');resetPreliminary();setUnselectedPreviewState();scheduleAnswer();
  if(answerIndex<0) $('nextGoal').textContent='Цель · '+goalLabels[currentGoal()];
};
$('start').onclick=async ()=>{
  if($('start').disabled) return;
  if(await startAudio() && socket && stream && context && !microphone) await startMic();
};
$('stop').onclick=()=>stopAudio();$('stopTop').onclick=()=>stopAudio();
$('focus').onclick=()=>{const enabled=document.body.classList.toggle('focus');$('focus').textContent=enabled?'Обычный вид':'Режим чтения';};
$('fontSize').oninput=event=>{document.documentElement.style.setProperty('--answer-size',event.target.value+'px');};
$('previousAnswer').onclick=()=>readAnswer(answerIndex-1);
$('nextAnswer').onclick=()=>readAnswer(answerIndex+1);
$('showNextIdea').onclick=()=>{
  const item=answerHistory[answerIndex];
  if(!item?.pendingNext) return;
  const {request_id,...next}=item.pendingNext;
  item.pendingNext=null;
  Object.assign(item.answer,next);
  renderNext(item.answer);
  record('next_updated',{...next,request_id,answer_id:answerIndex+1},item.session);
};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('answerEn').textContent);$('copy').textContent='Скопировано';setTimeout(()=>{$('copy').textContent='Копировать ответ';},1600);}catch{error('Выделите английский текст и скопируйте вручную.');}};
for(const button of document.querySelectorAll('.phrase'))button.onclick=()=>{cancelPending();resetQuestion();showAnswer({question_ru:button.textContent,answer_en:button.dataset.phrase,caution_ru:'',source_ids:[]},'Фраза для разговора');$('timing').textContent='';};
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();ask(true);}});
window.addEventListener('pagehide',()=>stopAudio('Вкладка закрыта','page_hidden'));
document.body.dataset.clientVersion=CLIENT_VERSION;
$('speakerDiarization').checked=false;
$('speakerDiarization').onchange=()=>{
  speakerLabelsPreference=$('speakerDiarization').checked;
  try {window.localStorage?.setItem(speakerPreferenceKey,speakerLabelsPreference?'on':'off');} catch {}
};
try {
  const response=await fetch('/api/status');if(!response.ok)throw new Error('Локальный сервер недоступен.');
  const status=await response.json();csrf=status.csrf;configured=status.configured;keySaved=status.key_saved;knowledge=status.knowledge;
  configureVocabulary(status.vocabulary);
  $('vocabularyTitle').textContent=`Словарь пользователя · ${KEYTERMS.length} терминов`;
  for(const group of KEYTERM_GROUPS) {
    const heading=document.createElement('strong'),p=document.createElement('p');
    heading.textContent=group.title;p.textContent=group.terms.join(' · ');
    $('vocabularyList').append(heading,p);
  }
  journalEnabled=status.journal_schema===1;
  speakerLabelsPreference=savedSpeakerLabels(status.speaker_labels_default);
  $('speakerDiarization').checked=speakerLabelsPreference;
  $('bundleText').textContent=status.bundle?.gateway_context || '';connection();$('setup').hidden=true;
  if (status.gateway_enabled===false) {
    $('serverNotice').textContent='Локальный просмотр · звук и внешние подсказки выключены.';
    $('serverNotice').hidden=false;
    $('start').disabled=true;
    $('speakerDiarization').disabled=true;
    $('ask').disabled=true;
  }
  if(!journalEnabled && !['2026-11-24-free-conversation-1','legacy-context-1','legacy-context-2'].includes(status.version)) {
    $('serverNotice').hidden=false;
    $('serverNotice').textContent='История и сохранение чтения включены. Улучшение ответов ещё не включено: работающий сервер пока может подменять ответ общей карточкой.';
  }
  for(const card of knowledge.cards){const b=document.createElement('button');b.textContent=card.title;b.onclick=()=>selectCard(card);$('cards').append(b);}
  $('scope').textContent=knowledge.limitations;
  $('question').value=''; historyControls();
  $('generationState').textContent='Свободный разговор · сценарий не нужен';
  for(const s of knowledge.sources){const article=document.createElement('article');const title=document.createElement('strong');title.textContent=s.title;const p=document.createElement('p');p.textContent=s.path;const code=document.createElement('code');code.textContent='SHA-256: '+s.sha256;article.append(title,p,code);$('sourceList').append(article);}
} catch(e){error(e.message);}
