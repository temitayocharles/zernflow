import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({context:vi.fn(),single:vi.fn(),assign:vi.fn(),takeover:vi.fn(),escalate:vi.fn(),audit:vi.fn(),actor:vi.fn()}));
vi.mock('@/lib/product/api',async()=>{const actual=await vi.importActual<typeof import('@/lib/product/api')>('@/lib/product/api');return {...actual,productContext:mocks.context};});
vi.mock('@/lib/social-gateway/server',()=>({requireOperatorGatewayClient:(id:string)=>{mocks.actor(id);return {assignConversation:mocks.assign,setHumanTakeover:mocks.takeover,escalateConversation:mocks.escalate};}}));
vi.mock('@/lib/supabase/server',()=>({createServiceClient:async()=>({from:()=>({insert:mocks.audit})}),createClient:vi.fn()}));
import {POST} from './route';
const id='00000000-0000-4000-8000-000000000001';
const call=(body:unknown)=>POST(new Request('https://app.example/api/control',{method:'POST',body:JSON.stringify(body)}),{params:Promise.resolve({id})});
beforeEach(()=>{vi.clearAllMocks();mocks.context.mockResolvedValue({workspaceId:'ws',role:'member',user:{id:'operator'},supabase:{from:()=>({select:()=>({eq:()=>({eq:()=>({maybeSingle:mocks.single})})})})}});mocks.single.mockResolvedValue({data:{id,late_conversation_id:'remote'},error:null});mocks.assign.mockResolvedValue({version:3,assignment_type:'human',human_takeover:false,escalated:false});mocks.audit.mockResolvedValue({error:null});});
describe('collaboration API authorization',()=>{
 it('blocks member takeover before Gateway access',async()=>{expect((await call({action:'takeover',reason:'review'})).status).toBe(403);expect(mocks.takeover).not.toHaveBeenCalled();});
 it('blocks member agent assignment',async()=>{expect((await call({action:'assign_agent',agentRef:'a'})).status).toBe(403);});
 it('rejects inaccessible projected conversations',async()=>{mocks.single.mockResolvedValue({data:null,error:null});expect((await call({action:'assign_self'})).status).toBe(404);expect(mocks.assign).not.toHaveBeenCalled();});
 it('uses trusted user identity, not body attribution',async()=>{expect((await call({action:'assign_self',userId:'forged'})).status).toBe(200);expect(mocks.actor).toHaveBeenCalledWith('operator');expect(mocks.assign).toHaveBeenCalledWith('remote',{assignmentType:'human',assigneeRef:'operator'});expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({actor_id:'operator',workspace_id:'ws'}));});
 it('reports audit failure without lying about applied Gateway action',async()=>{mocks.audit.mockResolvedValue({error:{code:'failed'}});const response=await call({action:'assign_self'});expect(await response.json()).toMatchObject({auditRecorded:false,warning:expect.stringContaining('Do not retry')});});
 it('does not claim success when Gateway rejects the call',async()=>{mocks.assign.mockRejectedValue(new Error('upstream'));expect((await call({action:'assign_self'})).status).toBe(500);expect(mocks.audit).not.toHaveBeenCalled();});
});
