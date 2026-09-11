import {InputError,object,text} from '@/lib/product/validation';
export type CollaborationCommand={action:'takeover'|'release'|'escalate';reason:string}|{action:'assign_self'|'unassign'}|{action:'assign_agent';agentRef:string};
export function parseCollaborationCommand(value:unknown):CollaborationCommand{
 const v=object(value);
 if(v.action==='assign_self'||v.action==='unassign')return {action:v.action};
 if(v.action==='assign_agent')return {action:v.action,agentRef:text(v.agentRef,'agent identity',200,true)};
 if(v.action==='takeover'||v.action==='release'||v.action==='escalate')return {action:v.action,reason:text(v.reason,'reason',2000,true)};
 throw new InputError('Unknown collaboration action');
}
export type AutonomyPolicy={mode:'allow'|'ask'|'deny'}|{mode:'limit';maximumActions:number;windowSeconds:number};
export function policySummary(policy:AutonomyPolicy):string{if(policy.mode==='limit'){if(!Number.isSafeInteger(policy.maximumActions)||policy.maximumActions<1||!Number.isSafeInteger(policy.windowSeconds)||policy.windowSeconds<1)throw new InputError('Invalid autonomy limit');return `Allow at most ${policy.maximumActions} actions per ${policy.windowSeconds} seconds`;}return {allow:'Allow within granted scope',ask:'Require human approval before execution',deny:'Deny execution'}[policy.mode];}
export function requiresOwner(command:CollaborationCommand){return ['takeover','release','assign_agent'].includes(command.action);}
// Approval queue and policy persistence intentionally have no invented HTTP routes.
export interface ApprovalQueueProjection {state:'unavailable'|'ready'|'degraded';requests:import('@/lib/social-gateway/types').GatewayActionRequest[];updatedAt:string|null;error:string|null}
