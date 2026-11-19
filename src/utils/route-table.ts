import data from '../route-table-v1.json';
export interface ModelRoute {
  model:string;providerId:string;providerModel:string;
  capabilities:{tools:boolean;images:boolean;knowledge:boolean;reasoning:boolean};
  admission:{actorPreview:boolean;reviewerImages:boolean};
  allowedEfforts:string[];defaultEffort:string;tier:string;costClass:string;availabilityNotes:string;
  manualOnly:boolean;autoEligible:boolean;
}
const reject=(code:string):never=>{throw Object.assign(Error(code),{code,statusCode:400});};
export function validateRouteTable(value:typeof data):typeof data {
  if(value.schemaVersion!==1||value.profile!=='gpt62'||!Array.isArray(value.routes)||!value.routes.length||value.routes.length>64)reject('ROUTE_TABLE_INVALID');
  const seen=new Set<string>();
  for(const row of value.routes){
    if(![row.model,row.providerId,row.providerModel].every(s=>typeof s==='string'&&/^[A-Za-z0-9][\w./:-]{0,199}$/.test(s))||seen.has(row.model)||!row.allowedEfforts.length||!row.allowedEfforts.includes(row.defaultEffort)||row.allowedEfforts.some(e=>!['low','medium','high','xhigh','disabled','provider-default'].includes(e))||Object.values(row.capabilities).some(v=>typeof v!=='boolean')||Object.values(row.admission).some(v=>typeof v!=='boolean')||row.manualOnly!==true||row.autoEligible!==false||row.capabilities.knowledge&&row.providerId!=='codex-cli')reject('ROUTE_TABLE_INVALID');
    seen.add(row.model);
  }
  if(JSON.stringify(value.effortAliases)!==JSON.stringify({none:'low',minimal:'low',max:'xhigh'}))reject('ROUTE_TABLE_INVALID');
  for(const row of Object.values(value.workClasses))if(!value.routes.some(r=>r.model===row.model&&r.allowedEfforts.includes(row.effort)&&!r.availabilityNotes.startsWith('UNAVAILABLE')))reject('ROUTE_TABLE_INVALID');
  return value;
}
export const routeTable=validateRouteTable(data);
export function modelRoute(model:string):ModelRoute {const route=routeTable.routes.find(r=>r.model===model);return route??reject('MODEL_ROUTE_UNLISTED');}
export function isProfileManagedModel(model:string):boolean {
  return model.startsWith('gpt-6.2-') || (routeTable.routes.some(route=>route.model===model&&route.providerId==='codex-cli') && Object.values(routeTable.workClasses).some(work=>work.model===model));
}
export function normalizeRouteEffort(model:string,effort?:string):string {
  const route=modelRoute(model),requested=effort??route.defaultEffort;
  const aliases:Record<string,string>=routeTable.effortAliases;
  const normalized=route.capabilities.reasoning?(aliases[requested]??requested):requested;
  if(!route.allowedEfforts.includes(normalized))return reject('MODEL_EFFORT_UNSUPPORTED');
  return normalized;
}
export function routeAdmits(provider:string|undefined,model:string|undefined,capability:'knowledge'|'actorPreview'|'reviewerImages'):boolean {
  const route=routeTable.routes.find(r=>r.model===model&&r.providerId===provider);
  return !!route&&(capability==='knowledge'?route.capabilities.knowledge:route.admission[capability]);
}
export function requireGpt62Binding(provider:string,model:string,providerModel:string):void {
  if(!isProfileManagedModel(model)&&!model.startsWith('gpt-6.2-')&&!providerModel.startsWith('gpt-6.2-'))return;
  const route=modelRoute(model);if(route.providerId!==provider||route.providerModel!==providerModel)reject('MODEL_ROUTE_BINDING_INVALID');
}
