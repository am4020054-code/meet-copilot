import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import * as core from '../public/core.mjs';

const knowledge={cards:[],sources:[],limitations:'Generic test fixture'};
const thinkingPhrases=[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/data-thinking-phrase>([^<]+)</g)]
  .map(([,textContent])=>({textContent}));
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*?;\n/,'');
export const success={question_ru:'Каков состав материала?',answer_en:'We need the project data to check that detail.',caution_ru:'Нужна проверка.',source_ids:[],status:'clarify',elapsed_ms:10};
export const rate=(seconds=7)=>({ok:false,status:429,data:{error:'Лимит API',code:'rate_limited',retry_after_seconds:seconds}});
export const ok=()=>({ok:true,status:200,data:success});
export async function harness({journalEnabled = false, micDenials = 0, tabDenials = 0, frameEnabled = false, speakerLabelsDefault = false, preferences = new Map()} = {}) {
  let now=100000,timerId=0;
  const timers=new Map(),elements=new Map(),requests=[],responses=[],sockets=[],journal=[],cancelled=[];
  const capture={tab:0,mic:0,micStops:0};
  const track={stop(){},addEventListener(){}};
  const micTrack={stop(){capture.micStops++;},addEventListener(){}};
  class Socket {
    static OPEN=1; static CLOSED=3;
    constructor(url){this.url=url;this.readyState=1;this.bufferedAmount=0;sockets.push(this);}
    send(){} close(){this.readyState=3;}
    receive(payload){this.onmessage?.({data:JSON.stringify(payload)});}
  }
  class AudioContext {
    constructor(){this.sampleRate=48000;this.audioWorklet={addModule:async()=>{}};}
    async resume(){} async close(){} createMediaStreamSource(){return {connect(){}};}
  }
  class AudioWorkletNode {constructor(){this.port={};}connect(){}disconnect(){}}

  class Element {
    constructor(){this.value='';this.textContent='';this.dataset={};this.children=[];this.checked=true;this.hidden=false;this.style={setProperty(){}};this.classList={remove(){},toggle(){return false;}};}
    getBoundingClientRect(){return {left:0,top:0,right:200,bottom:40,width:200,height:40};}
    addEventListener(){} setAttribute(){} append(...items){for(const item of items)item.parent=this;this.children.push(...items);}
    get firstElementChild(){return this.children[0] || null;}
    get lastElementChild(){return this.children.at(-1) || null;}
    get previousElementSibling(){return this.parent?.children[this.parent.children.indexOf(this)-1] || null;}
    get nextElementSibling(){return this.parent?.children[this.parent.children.indexOf(this)+1] || null;}
    insertBefore(item,next){const at=next ? this.children.indexOf(next) : this.children.length;item.parent=this;this.children.splice(at,0,item);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
    replaceChildren(...items){this.children=[...items];}
  }
  const el=id=>{
    if(!elements.has(id)) {
      const element=new Element();
      if(id==='speakerDiarization')element.checked=false;
      elements.set(id,element);
    }
    return elements.get(id);
  };
  const env={...core,Math,JSON,Number,String,Promise,URLSearchParams,Float32Array,crypto:{randomUUID},TextDecoder,TextEncoder,AbortController,
    Date:class extends Date{static now(){return now;}}, performance:{now:()=>now},
    setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,at:now+ms});return id;},
    clearTimeout:id=>timers.delete(id),
    document:{visibilityState:'visible',getElementById:el,createElement:()=>new Element(),querySelectorAll:selector=>selector==='[data-thinking-phrase]'?thinkingPhrases:[],addEventListener(){},body:new Element(),documentElement:new Element()},
    window:{addEventListener(){},AudioWorkletNode,innerWidth:1280,innerHeight:800,
      localStorage:{getItem:key=>preferences.get(key)??null,setItem:(key,value)=>preferences.set(key,value)},
      requestAnimationFrame:frameEnabled?fn=>{const id=++timerId;timers.set(id,{fn,at:now+16});return id;}:undefined},navigator:{mediaDevices:{getDisplayMedia:async()=>{
        capture.tab++;
        if(tabDenials>0){tabDenials--;throw Object.assign(new Error('Tab access denied'),{name:'NotAllowedError'});}
        return {getAudioTracks:()=>[track],getTracks:()=>[track]};
      },
      getUserMedia:async()=>{
        capture.mic++;
        if(micDenials>0){micDenials--;throw Object.assign(new Error('Mic access denied'),{name:'NotAllowedError'});}
        return {getAudioTracks:()=>[micTrack],getTracks:()=>[micTrack]};
      }}}, WebSocket:Socket, AudioContext,AudioWorkletNode,MediaStream:class{},
    fetch:async (path,opts)=>{
      if(path==='/api/status')return{ok:true,json:async()=>({configured:true,csrf:'test',model:'test',knowledge,speaker_labels_default:speakerLabelsDefault,journal_schema:journalEnabled?1:undefined})};
      if(path==='/api/token')return{ok:true,json:async()=>({token:'test-token'})};
      if(path==='/api/cancel'){cancelled.push(JSON.parse(opts.body));return{ok:true,json:async()=>({ok:true})};}
      if(path==='/api/journal'){
        assert.equal(opts.headers['X-CSRF-Token'],'test');
        journal.push(JSON.parse(opts.body));
        return {ok:true};
      }
      assert.equal(path,'/api/ask');requests.push(JSON.parse(opts.body));
      let next=responses.shift()??ok();
      if(typeof next==='function')next=await next();
      if(next.body){next.onRequest?.(opts.signal);return next;}
      return{ok:next.ok,status:next.status,json:async()=>next.data};
    }
  };
  const app=await vm.runInNewContext(`(async()=>{${source}\n return {ask,onTurn,stopAudio,startAudio,startMic,selectCard};})()`,env);
  async function tick(ms) {
    now+=ms;
    const due=[...timers.entries()].filter(([,t])=>t.at<=now);
    for(const [id,t] of due){timers.delete(id);t.fn();}
    // Drain promise continuations used by the real fetch/ask flow.
    await new Promise(setImmediate);
  }
  function question(text){el('question').value=text;}
  function turn(text,id=0){app.onTurn({type:'Turn',turn_order:id,transcript:text,end_of_turn:true});}
  function partial(text,id=1){app.onTurn({type:'Turn',turn_order:id,transcript:text,end_of_turn:false});}
  function speech(){app.onTurn({type:'SpeechStarted',timestamp:now});}
  return{app,el,requests,responses,capture,timers,tick,question,turn,partial,speech,sockets,journal,cancelled};
}

