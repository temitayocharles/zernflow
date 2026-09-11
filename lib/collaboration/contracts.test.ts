import {describe,expect,it} from 'vitest';import {parseCollaborationCommand,policySummary,requiresOwner} from './contracts';
describe('collaboration controls',()=>{
 it('requires reasons for escalation and takeover',()=>{for(const action of ['takeover','release','escalate'])expect(()=>parseCollaborationCommand({action})).toThrow();});
 it('gates admin controls',()=>{expect(requiresOwner({action:'takeover',reason:'Review'})).toBe(true);expect(requiresOwner({action:'assign_agent',agentRef:'agent-1'})).toBe(true);expect(requiresOwner({action:'assign_self'})).toBe(false);});
 it('rejects unsupported execution commands',()=>expect(()=>parseCollaborationCommand({action:'approve_arbitrary_request'})).toThrow());
 it('describes all policy modes and validates limits',()=>{expect(policySummary({mode:'ask'})).toContain('approval');expect(policySummary({mode:'deny'})).toContain('Deny');expect(policySummary({mode:'allow'})).toContain('scope');expect(policySummary({mode:'limit',maximumActions:2,windowSeconds:60})).toContain('2 actions');expect(()=>policySummary({mode:'limit',maximumActions:0,windowSeconds:60})).toThrow();});
});
