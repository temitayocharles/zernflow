import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getWorkspace} from '@/lib/workspace';
import {isCrmResource} from '@/lib/crm/contracts';
import {crmForms} from '@/lib/product/forms';
import {RecordForm} from '@/components/product/record-form';
import {crmOptions} from '@/lib/crm/options';
export default async function CrmPage({params,searchParams}:{params:Promise<{resource:string}>;searchParams:Promise<{q?:string;page?:string}>}){
 const {resource}=await params;if(!isCrmResource(resource))notFound();const {workspace,supabase}=await getWorkspace();const search=await searchParams;const page=Math.max(0,Math.floor(Number(search.page)||0));
 let query=supabase.from(resource).select('*',{count:'exact'}).eq('workspace_id',workspace.id).order('created_at',{ascending:false}).order('id').range(page*50,page*50+49);
 if(search.q&&resource!=='customer_profiles')query=query.ilike('name',`%${search.q.slice(0,100).replace(/[%_\\]/g,'\\$&')}%`);
 const {data,error,count}=await query;const config=crmForms[resource];
 if(error)return <p role="alert" className="p-8">CRM data unavailable. Apply migration 00021 and reload.</p>;
 const options=await crmOptions(supabase,workspace.id);
 return <main className="space-y-6 overflow-auto p-4 md:p-8"><nav className="flex flex-wrap gap-4 text-sm">{Object.entries(crmForms).map(([key,value])=><Link key={key} href={`/dashboard/crm/${key}`} className="underline">{value.title}</Link>)}</nav><h1 className="text-2xl font-semibold">{config.title}</h1><details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Create {resource==='companies'?'company':resource==='deals'?'opportunity':'customer profile'}</summary><div className="mt-4"><RecordForm fields={config.fields} endpoint={`/api/v1/crm/${resource}`} redirectBase={`/dashboard/crm/${resource}`} options={options}/></div></details>
 <form className="flex gap-2"><label className="sr-only" htmlFor="crm-search">Search names</label><input id="crm-search" name="q" defaultValue={search.q} placeholder="Search names" className="rounded-lg border border-border bg-background p-2"/><button className="rounded-lg border border-border px-3">Search</button></form>
 <p className="text-sm text-muted-foreground">{count??0} records · Reference selectors show the first 200 contacts/companies.</p><div className="divide-y divide-border rounded-xl border border-border">{data?.map(row=><Link key={row.id} href={`/dashboard/crm/${resource}/${row.id}`} className="block p-4 hover:bg-muted"><span className="font-medium">{'name' in row?row.name:options.contacts.find(c=>c.id===row.contact_id)?.label??row.contact_id}</span><span className="ml-3 text-sm text-muted-foreground">{'stage' in row?`${row.stage} · ${row.value_minor} minor units (${row.currency})`:row.lifecycle}</span></Link>)}{!data?.length&&<p className="p-6 text-sm text-muted-foreground">No records match this view.</p>}</div><nav className="flex gap-4 text-sm">{page>0&&<Link href={`?${new URLSearchParams({q:search.q??'',page:String(page-1)})}`}>Previous</Link>}{(page+1)*50<(count??0)&&<Link href={`?${new URLSearchParams({q:search.q??'',page:String(page+1)})}`}>Next</Link>}</nav></main>;
}
