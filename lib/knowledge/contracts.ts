export interface RetrievalRequest {workspaceRef:string;query:string;sourceRefs:string[];limit:number}
export interface Citation {sourceRef:string;title:string;excerpt:string;url:string|null;score:number|null}
export interface RetrievalResult {requestId:string;citations:Citation[];indexingStatus:'ready'|'partial'|'indexing'|'unknown'}
export interface KnowledgeClient {retrieve(request:RetrievalRequest):Promise<RetrievalResult>}
