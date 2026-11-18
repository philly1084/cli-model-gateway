import { routeAdmits } from "./route-table.js";
import type { ChatMessage } from "../types.js";
export const REVIEWER_IMAGE_ROUTES = "GATEWAY_REVIEWER_IMAGE_ROUTES";
const reject=(code:string):never=>{throw Object.assign(Error(code),{code,statusCode:400});};
export function sceneScope(value:unknown, role:"actor"|"verifier", source:string) {
  const v=value as Record<string,unknown>;
  if(!v || typeof v!=="object" || Array.isArray(v) || Object.keys(v).sort().join()!=="role,source,version" || v.version!==1 || v.role!==role || v.source!==source) reject("SCENE_SCOPE_INVALID");
}
export function reviewerRoutes(): Array<{provider:string;model:string}> {
  let rows:unknown;
  try{rows=JSON.parse(process.env[REVIEWER_IMAGE_ROUTES]??"[]");}catch{return reject("REVIEWER_ROUTES_INVALID");}
  if(!Array.isArray(rows)||rows.length>16||rows.some(r=>!r||typeof r!=="object"||Object.keys(r).sort().join()!=="model,provider"||![r.provider,r.model].every(v=>typeof v==="string"&&/^[A-Za-z0-9][\w./:-]{0,199}$/.test(v))))return reject("REVIEWER_ROUTES_INVALID");
  return rows;
}
export const reviewerRouteAllowed=(provider:string|undefined,model:string|undefined)=>routeAdmits(provider,model,"reviewerImages")&&reviewerRoutes().some(r=>r.provider===provider&&r.model===model);
export function reviewInputEnabled(scope:unknown){sceneScope(scope,"verifier","scene_review");return process.env.GATEWAY_KIMI_IMAGE_INPUT==="1"||reviewerRoutes().length>0;}
export function validateReviewerMessages(messages:ChatMessage[],scope:unknown){
  sceneScope(scope,"verifier","scene_review");
  const images=messages.flatMap(m=>m.inputImages??[]);
  if(images.length<1||images.length>3||messages.some(m=>m.inputImages?.length&&m.role!=="user"))return reject("REVIEWER_IMAGE_INVALID");
  for(const i of images){const b=Buffer.from(i.data,"base64");if(i.mediaType!=="image/jpeg"||b.length<4||b.length>48000||b.toString("base64")!==i.data||b.readUInt16BE(0)!==0xffd8||b.readUInt16BE(b.length-2)!==0xffd9)return reject("REVIEWER_IMAGE_INVALID");}
  return images;
}
export function privateSceneTurn(metadata?:Record<string,unknown>):boolean{
  if(metadata?.brain_scene_knowledge!==undefined){sceneScope(metadata.brain_scene_knowledge,"actor","scene_knowledge");return true;}
  if(metadata?.brain_scene_review!==undefined){sceneScope(metadata.brain_scene_review,"verifier","scene_review");return true;}
  return metadata?.brain_scene_preview!==undefined;
}
