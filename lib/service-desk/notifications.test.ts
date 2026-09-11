import {describe,expect,it} from 'vitest';import {slaNotifications} from './notifications';import type {WorkItem} from '@/lib/product/types';
const item={id:'i',workspace_id:'w',reference:1,status:'open',assignee_id:'u',created_at:'2026-09-11T00:00:00Z',priority:'normal',first_response_minutes:60,resolution_minutes:120,warning_fraction:0.8,first_responded_at:null,resolved_at:null} as WorkItem;
describe('SLA notification signals',()=>{
 it('uses stable dedupe keys for repeated reviews',()=>{const first=slaNotifications([item],'u','2026-09-11T01:00:00Z');const second=slaNotifications([item],'u','2026-09-11T01:01:00Z');expect(first[0].dedupe_key).toBe(second[0].dedupe_key);expect(first[0].kind).toBe('sla_breached');});
 it('does not notify closed work or another recipient',()=>{expect(slaNotifications([{...item,status:'closed'}],'u','2026-09-11T03:00:00Z')).toEqual([]);expect(slaNotifications([item],'other','2026-09-11T03:00:00Z')).toEqual([]);});
 it('keeps response and resolution objectives separate',()=>{expect(slaNotifications([item],'u','2026-09-11T02:00:00Z')).toHaveLength(2);expect(slaNotifications([{...item,first_responded_at:'2026-09-11T00:30:00Z'}],'u','2026-09-11T02:00:00Z')).toHaveLength(1);});
});
