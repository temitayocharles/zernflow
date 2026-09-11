import { isCrmResource, parseCrmInput } from "@/lib/crm/contracts";
import { uuid } from "@/lib/product/validation";
import { ApiError, databaseError, failure, json, productContext } from "@/lib/product/api";
type Context={params:Promise<{resource:string;id:string}>};
export async function GET(_request:Request,{params}:Context){try{
  const {resource,id}=await params; if(!isCrmResource(resource)) throw new ApiError(404,"Unknown CRM resource"); uuid(id,"id");
  const {supabase,workspaceId}=await productContext();
  const {data,error}=await supabase.from(resource).select().eq("workspace_id",workspaceId).eq("id",id).maybeSingle();databaseError(error);
  if(!data) throw new ApiError(404,"Record not found"); return json(data);
}catch(error){return failure(error);}}
export async function PATCH(request:Request,{params}:Context){try{
  const {resource,id}=await params; if(!isCrmResource(resource)) throw new ApiError(404,"Unknown CRM resource");uuid(id,"id");
  const {supabase,workspaceId}=await productContext(); const {version,...input}=parseCrmInput(resource,await request.json(),true);
  const {data,error}=await supabase.from(resource).update(input).eq("workspace_id",workspaceId).eq("id",id).eq("version",version as number).select().maybeSingle();databaseError(error);
  if(!data) throw new ApiError(409,"Record changed or is unavailable. Reload before editing.");return json(data);
}catch(error){return failure(error);}}
