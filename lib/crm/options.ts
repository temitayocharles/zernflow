import 'server-only';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {Database} from '@/lib/types/database';
export async function crmOptions(supabase:SupabaseClient<Database>,workspaceId:string){
 const [companies,contacts]=await Promise.all([supabase.from('companies').select('id,name').eq('workspace_id',workspaceId).order('name').limit(200),supabase.from('contacts').select('id,display_name,email').eq('workspace_id',workspaceId).order('display_name').limit(200)]);
 if(companies.error||contacts.error)throw new Error('CRM data unavailable. Confirm migration 00021 is applied.');
 return {companies:(companies.data??[]).map(c=>({id:c.id,label:c.name})),contacts:(contacts.data??[]).map(c=>({id:c.id,label:c.display_name??c.email??c.id}))};
}
