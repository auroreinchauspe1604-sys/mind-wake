import { expect, it } from 'vitest';
import { DocumentScopeState, documentScopeLabel, localDocumentScope } from './document-scope.js';

it('restores the linked Aurore scope without ever mapping it to a local backend',()=>{
  const state=new DocumentScopeState('aurore');
  expect(state.current).toBe('aurore');expect(state.local).toBeNull();
  expect(state.accepts(state.capture())).toBe(true);
  expect(documentScopeLabel(state.current)).toBe('Atelier d’Aurore');
  expect(localDocumentScope('aurore')).toBeNull();
  expect(new DocumentScopeState('invalid').current).toBe('agent');
});

it('rejects deferred responses across scope changes, even after returning to the same local scope',async()=>{
  const state=new DocumentScopeState('agent'),old=state.capture();
  let finish!:()=>void;
  let accepted=false;
  const pending=new Promise<void>(resolve=>{finish=resolve;}).then(()=>{accepted=state.accepts(old);});
  state.select('aurore');expect(state.local).toBeNull();
  state.select('agent');finish();await pending;
  expect(accepted).toBe(false);expect(state.accepts(state.capture())).toBe(true);
  state.select('project');expect(state.local).toBe('project');expect(state.accepts(state.capture())).toBe(true);
});
