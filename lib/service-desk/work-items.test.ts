import {describe,expect,it} from 'vitest';import {allowedTransitions,parseWorkInput} from './work-items';
describe('work item validation',()=>{
 it('rejects protected fields and invalid snapshots',()=>{for(const input of [{name:'X',workspace_id:'x'},{name:'X',reference:4},{name:'X',first_response_minutes:0},{name:'X',kind:'other'}])expect(()=>parseWorkInput(input)).toThrow();});
 it('requires update versions and forbids retroactive SLA editing',()=>{expect(()=>parseWorkInput({status:'closed'},true)).toThrow();expect(()=>parseWorkInput({version:1,first_response_minutes:10},true)).toThrow();});
 it('validates assignment and escalation types',()=>{expect(()=>parseWorkInput({version:1,assignee_id:'bad'},true)).toThrow();expect(()=>parseWorkInput({version:1,escalated:'yes'},true)).toThrow();});
 it('defines close/reopen transitions',()=>{expect(allowedTransitions('open')).not.toContain('closed');expect(allowedTransitions('resolved')).toEqual(['closed','open']);expect(allowedTransitions('closed')).toEqual(['open']);});
});
