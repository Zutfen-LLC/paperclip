import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {buildViewModel} from "../dist-test/ui/model.js";
import {OpsWorkView} from "../dist-test/ui/test-export.js";
const filters={query:"",scope:"all",recency:"any",project:""};
const item=(id,extra={})=>({ops_task_id:id,project:"ops",repository:"org/repo",issue_number:214,issue_title:"issue",issue_state:null,execution_state:null,review_state:null,qualification_state:null,updated_at:"2026-10-03T12:00:00.000Z",source_links:["https://example.test/item"],...extra});
const envelope=items=>({cached:false,fetchedAt:Date.parse("2026-10-03T12:00:00Z"),snapshot:{schema:"ops_work_snapshot_v1",ops_deployed_sha:"abcdef0123456789",items}});
const view=(state,rows={active:[],attention:[],outcomes:[]},selectedId=null)=>renderToStaticMarkup(React.createElement(OpsWorkView,{state,rows,filters,onFilters:()=>{},selectedId,onSelect:()=>{},onRefresh:()=>{},loading:false,now:Date.parse("2026-10-03T12:01:00Z"),items:state.kind==="ready"?state.envelope.snapshot.items:[],refreshFailed:false}));
const assertTableCellAlignment=html=>{const tables=[...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)];assert.ok(tables.length>0,"ready fixture should render tables");for(const [index,[,table]] of tables.entries()){const header=table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/)?.[1]??"";const headerCells=[...header.matchAll(/<th\b/g)].length;const body=table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)?.[1]??"";const rows=[...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)];assert.ok(rows.length>0,`table ${index} should have a body row`);for(const [rowIndex,[,row]] of rows.entries())assert.equal([...row.matchAll(/<td\b/g)].length,headerCells,`table ${index} body row ${rowIndex} must match header cells`);}};
const active=item("active",{review_state:"needs review"}), merged=item("merged",{execution_state:"merged"}), clean=item("clean");
test("ready view includes landmarks, section tables, filters, controls and field text",()=>{const e=envelope([active,merged,clean]);const rows={active:[{item:active,terminal:false,attentionReason:"review"},{item:clean,terminal:false,attentionReason:null}],attention:[{item:active,terminal:false,attentionReason:"review"}],outcomes:[{item:merged,terminal:true,attentionReason:null,outcomeLabel:"merged",outcomeKind:"success"}]};const html=view({kind:"ready",envelope:e,stale:false,fetchedAtIso:new Date(e.fetchedAt).toISOString(),malformedItemCount:0},rows,"active");for(const token of ["<main","<h1","Active work (2)","Human attention (1)","Recent outcomes (1)","<caption","scope=\"col\"","<fieldset","<legend","for=\"ops-filter-query\"","merged","rel=\"noreferrer\""])assert.ok(html.includes(token),token);assert.doesNotMatch(html,/<main[^>]*aria-live=/);assert.match(html,/<div role=\"status\" aria-live=\"polite\">OK<\/div>/);assert.doesNotMatch(html,/<tr[^>]*onclick/i);assert.ok([...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].every(m=>m[1].length>0));assert.doesNotMatch(html,/Authorization/);assertTableCellAlignment(html);});
test("loading, error and malformed states are explicit and fail closed",()=>{const loading=view({kind:"loading"});assert.match(loading,/role="status"/);assert.match(loading,/aria-busy="true"/);assert.match(loading,/aria-live="polite"/);const error=view({kind:"error"});assert.match(error,/role="alert"/);assert.doesNotMatch(error,/Bearer |secret raw error/);const malformed=view({kind:"malformed",reason:"unexpected_schema"});assert.match(malformed,/role="alert"/);assert.match(malformed,/unexpected_schema/);});
test("refresh failure keeps cached data visible with a fixed notice",()=>{const e=envelope([clean]);const html=renderToStaticMarkup(React.createElement(OpsWorkView,{state:{kind:"ready",envelope:e,stale:false,fetchedAtIso:"OK",malformedItemCount:0},rows:{active:[],attention:[],outcomes:[]},filters,onFilters:()=>{},selectedId:null,onSelect:()=>{},onRefresh:()=>{},loading:false,now:0,items:e.snapshot.items,refreshFailed:true}));assert.match(html,/Refresh failed — showing last observed snapshot/);assert.doesNotMatch(html,/Bearer /);});
test("malformed item count is shown",()=>{const e=envelope([]);const html=view({kind:"ready",envelope:e,stale:false,fetchedAtIso:"OK",malformedItemCount:2});assert.match(html,/2 malformed items skipped/);});
test("project options use the full item list",()=>{const e=envelope([item("project-item",{project:"pA"})]);const html=renderToStaticMarkup(React.createElement(OpsWorkView,{state:{kind:"ready",envelope:e,stale:false,fetchedAtIso:"OK",malformedItemCount:0},rows:{active:[],attention:[],outcomes:[]},filters,onFilters:()=>{},selectedId:null,onSelect:()=>{},onRefresh:()=>{},loading:false,now:0,items:e.snapshot.items,refreshFailed:false}));assert.match(html,/<option>pA<\/option>/);});
test("empty attention has a named empty state",()=>{const e=envelope([]);const html=view({kind:"ready",envelope:e,stale:false,fetchedAtIso:new Date(e.fetchedAt).toISOString(),malformedItemCount:0});assert.match(html,/No work waiting on human attention/);});
test("empty source links render unknown",()=>{const source=item("source-empty",{source_links:[],updated_at:null});const e=envelope([source]);const html=view({kind:"ready",envelope:e,stale:false,fetchedAtIso:new Date(e.fetchedAt).toISOString(),malformedItemCount:0},{active:[],attention:[{item:source,terminal:false,attentionReason:"review"}],outcomes:[]},"source-empty");assert.match(html,/<td>unknown<\/td>/);assert.match(html,/<dt>source_links<\/dt><dd>unknown<\/dd>/);});
test("stale data announces status and field text remains visible",()=>{const poison=item("p",{issue_title:"leak-POISONSEXTOKEN123"});const e=envelope([poison]);const html=view({kind:"ready",envelope:e,stale:true,fetchedAtIso:new Date(e.fetchedAt).toISOString(),malformedItemCount:0},{active:[{item:poison,terminal:false,attentionReason:null}],attention:[],outcomes:[]});assert.match(html,/role="status"/);assert.match(html,/leak-POISONSEXTOKEN123/);assert.doesNotMatch(html,/Authorization/);assertTableCellAlignment(html);});

const triageItem=item("task-triage",{issue_title:"A long title ".repeat(12),blocker:"B".repeat(400),run_id:"run-unique-123",parent_run_id:"run-parent-456",pr_head_sha:"head-sha-789",usage:{tokens:42},source_version:{revision:"source-v9"},source_links:["https://example.test/triage"],run_role:"worker",review_state:"needs review"});
const triageRows={active:[{item:triageItem,attentionReason:"review",terminal:false}],attention:[{item:triageItem,attentionReason:"review",terminal:false}],outcomes:[{item:item("outcome",{execution_state:"merged"}),attentionReason:null,terminal:true,outcomeLabel:"merged",outcomeKind:"success"}]};
const triageState={kind:"ready",envelope:envelope([triageItem,triageRows.outcomes[0].item]),stale:false,fetchedAtIso:"2026-10-03T12:00:00.000Z",malformedItemCount:0};

test("detail discoverability uses a named focusable region and selected row cue",()=>{
 const html=view(triageState,triageRows,"task-triage");
 assert.match(html,/<aside\b[^>]*role="region"[^>]*aria-labelledby="ops-detail-heading"[^>]*tabindex="-1"/);
 assert.match(html,/<h2 id="ops-detail-heading">/);
 assert.match(html,/<aside[\s\S]*?<button[^>]*>Close<\/button>/);
 assert.match(html,/<button[^>]*aria-current="true"[^>]*>View details \(selected\)<\/button>/);
});

test("attention leads active work in ready triage",()=>{
 const html=view(triageState,triageRows);
 assert.ok(html.indexOf('id="human-attention"')>=0 && html.indexOf('id="human-attention"')<html.indexOf('id="active-work"'));
 assertTableCellAlignment(html);
});

test("primary rows summarize long blobs and keep run ids in details only",()=>{
 const html=view(triageState,triageRows);
 assert.doesNotMatch(html,/B{400}/);
 assert.match(html,/B{20,79}…/);
 assert.doesNotMatch(html,/run-unique-123|run-parent-456/);
 assert.doesNotMatch(html.replace(/aria-label="[^"]*"/g,""),/A long title (?:A long title ){7}/);
});

test("verbose evidence remains available in the selected detail region",()=>{
 const html=view(triageState,triageRows,"task-triage");
 const aside=html.match(/<aside\b[^>]*>([\s\S]*?)<\/aside>/)?.[1];
 assert.ok(aside);
 for(const token of ["B".repeat(400),"run-unique-123","run-parent-456","head-sha-789","tokens","42","revision","source-v9","https://example.test/triage"])assert.ok(aside.includes(token),token);
 assert.doesNotMatch(html.slice(0,html.indexOf("<aside")),/run-unique-123|run-parent-456/);
});

test("human attention cell shows all applicable reasons concisely",()=>{
 const multi=item("multi",{review_state:"needs review",blocker:"waiting",qualification_state:"AWAITING_GO"});
 const e=envelope([multi]);
 const rows=buildViewModel(e.snapshot.items,{now:e.fetchedAt});
 const html=view({kind:"ready",envelope:e,stale:false,fetchedAtIso:new Date(e.fetchedAt).toISOString(),malformedItemCount:0},rows);
 const attention=html.match(/<section aria-labelledby="human-attention"[\s\S]*?<\/section>/)?.[0];
 assert.ok(attention);
 assert.match(attention,/<td>review, blocked, qualification<\/td>/);
});

test("ready view exposes only read-only Refresh Details and Close buttons",()=>{
 const html=view(triageState,triageRows,"task-triage");
 const buttons=[...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/g)];
 assert.equal(buttons.length,1+triageRows.active.length+triageRows.attention.length+triageRows.outcomes.length+1);
 assert.ok(buttons.every(([,attrs,label])=>/^(Refresh \(read-only\)|View details(?: \(selected\))?|Close)$/.test(label)&&!attrs.includes("href=")));
 assert.doesNotMatch(html,/<form\b|\bmethod=/i);
 const details=buttons.filter(([, ,label])=>label.startsWith("View details"));
 assert.equal(details.length,3);
 assert.ok(details.every(([,attrs])=>/aria-label="View details for #214 [^"]* · ops"/.test(attrs)));
 assertTableCellAlignment(html);
});
