import { expect, it, vi } from 'vitest';
import { atelierUrl, ATELIER_DOCUMENT, ATELIER_URL, createAtelierFrame, ATELIER_SANDBOX } from './local-atelier.js';
import { bindChatDraft } from './chat-draft.js';
it('requires the native opt-in descriptor and exact document, scope and URL',()=>{
 const approved={id:'atelier-dj',url:ATELIER_URL};
 expect(atelierUrl('agent',ATELIER_DOCUMENT,approved)).toBe(ATELIER_URL);
 for(const scope of ['project','aurore',''])expect(atelierUrl(scope,ATELIER_DOCUMENT,approved)).toBeNull();
 for(const path of ['index.html',ATELIER_DOCUMENT+'?x',ATELIER_DOCUMENT.replace('/index.html','/../atelier-dj/index.html'),ATELIER_URL])expect(atelierUrl('agent',path,approved)).toBeNull();
 for(const value of [undefined,null,{},true,{...approved,url:'http://localhost:8941/'},{...approved,url:ATELIER_URL+'next'}, {...approved,url:'http://127.0.0.1:8942/'}])expect(atelierUrl('agent',ATELIER_DOCUMENT,value)).toBeNull();
});
it('creates a separate sandbox without navigation, popup, forms or parent bridge',()=>{
 const attributes:Record<string,string>={};const frame={hidden:false,setAttribute:(name:string,value:string)=>{attributes[name]=value;}};
 vi.stubGlobal('document',{createElement:()=>frame});
 try{expect(createAtelierFrame()).toBe(frame);expect(attributes['sandbox']).toBe(ATELIER_SANDBOX);
 expect(attributes['sandbox']).not.toMatch(/allow-(top-navigation|popups|forms)/);expect(frame.hidden).toBe(true);
 expect(attributes['referrerpolicy']).toBe('no-referrer');}finally{vi.unstubAllGlobals();}
});
it('restores local drafts including recipient, persists edits and clearing, never sends',()=>{
 const values=new Map<string,string>(),listeners=new Map<string,()=>void>();
 values.set('mind-wake.chat-compose',JSON.stringify({text:'1',recipient:'auroracle'}));
 const field={value:'',addEventListener:(name:string,fn:()=>void)=>{listeners.set(name,fn);}};
 const recipient={value:'owner',addEventListener:vi.fn()};
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
 const save=bindChatDraft(field,recipient,storage);expect(field.value).toBe('1');expect(recipient.value).toBe('auroracle');
 field.value='human edit';listeners.get('input')!();expect(JSON.parse(values.get('mind-wake.chat-compose')!).text).toBe('human edit');
 field.value='';save();expect(JSON.parse(values.get('mind-wake.chat-compose')!).text).toBe('');
 field.value='already typing';values.set('mind-wake.chat-compose',JSON.stringify({text:'stale',recipient:'owner'}));
 bindChatDraft(field,recipient,storage);expect(field.value).toBe('already typing');
});
