import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {actorPreviewInput} from "../utils/actor-preview-input.js";
import {imageRequest} from "../utils/image-input.js";
import {normalizeChatMessages} from "../routes/openai.js";
import type {UnifiedRequest} from "../types.js";
const jpeg=Buffer.from([255,216,255,217]);
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
const part=(b=jpeg,mime="image/jpeg")=>({type:"image_url",image_url:{url:`data:${mime};base64,${b.toString("base64")}`}});
const scope=(b=jpeg,mime="image/jpeg")=>({version:1 as const,role:"actor" as const,source:"scene_preview" as const,images:[{sha256:createHash("sha256").update(b).digest("hex"),bytes:b.length,mime}]});
test("actor preview flag, role, MIME, provenance, count and size fail closed",()=>{
 assert.throws(()=>actorPreviewInput([part()],"user",scope(),false),/ACTOR_PREVIEW_DISABLED/);
 assert.throws(()=>actorPreviewInput([part()],"assistant",scope(),true),/ROLE_INVALID/);
 assert.throws(()=>actorPreviewInput([part()],"user",{...scope(),role:"verifier"},true),/SCOPE_INVALID/);
 assert.throws(()=>actorPreviewInput([part()],"user",{...scope(),source:"upload"},true),/SCOPE_INVALID/);
 assert.throws(()=>actorPreviewInput([part()],"user",scope(png),true),/PROVENANCE_INVALID/);
 assert.throws(()=>actorPreviewInput(Array(5).fill(part()),"user",scope(),true),/COUNT_INVALID/);
 const large=Buffer.alloc(300001);large.writeUInt16BE(0xffd8);large.writeUInt16BE(0xffd9,large.length-2);
 assert.throws(()=>actorPreviewInput([part(large)],"user",scope(large),true),/SIZE_INVALID|IMAGE_INVALID/);
 for(const url of ["https://example.invalid/frame.jpg","file:///tmp/frame.jpg","data:text/plain;base64,"+jpeg.toString("base64"),"data:image/png;base64,"+jpeg.toString("base64")])assert.throws(()=>actorPreviewInput([{type:"image_url",image_url:{url}}],"user",scope(),true),/IMAGE_INVALID|MIME_INVALID/);
 assert.equal(actorPreviewInput([part(png,"image/png")],"user",scope(png,"image/png"),true)[0]?.mediaType,"image/png");
});
test("actor preview stays closed for every codex route in the gpt62 profile",()=>{
 const input:Omit<UnifiedRequest,"model"|"providerModel">={requestId:"fixture",requestKind:"chat_completions",tools:[],messages:[{role:"user",content:"Fixture",inputImages:[{mediaType:"image/jpeg",data:jpeg.toString("base64")}]}],metadata:{brain_scene_preview:scope()}};
 for(const model of ["gpt-6.2-astra","gpt-6.2-sol","gpt-6-luna"])assert.throws(()=>imageRequest(input,"codex-cli",model),/ACTOR_PREVIEW_ROUTE_UNSUPPORTED/);
});
test("actor preview stays route-gated before accepting aggregate image payloads",()=>{
 const bytes=Buffer.alloc(210000);bytes.writeUInt16BE(0xffd8);bytes.writeUInt16BE(0xffd9,bytes.length-2);
 const marker={...scope(bytes),images:Array(3).fill(scope(bytes).images[0])};
 const messages=Array.from({length:3},()=>({role:"user" as const,content:"",inputImages:actorPreviewInput([part(bytes)],"user",marker,true)}));
 assert.throws(()=>imageRequest({requestId:"fixture",requestKind:"chat_completions",tools:[],messages,metadata:{brain_scene_preview:marker}},"codex-cli","gpt-6-luna"),/ACTOR_PREVIEW_ROUTE_UNSUPPORTED/);
});
