import { STALE_AFTER_MS } from "../constants.js";

export interface OpsWorkItem {
  project?: string | null; repository?: string | null; issue_number?: unknown; issue_title?: string | null; issue_state?: string | null;
  ops_task_id?: string | null; run_id?: string | null; run_role?: string | null; parent_run_id?: string | null; work_class?: string | null;
  execution_state?: string | null; review_state?: string | null; profile_id?: string | null; provider?: string | null; model?: string | null;
  pr_number?: unknown; pr_head_sha?: string | null; reviewed_sha?: string | null; base_sha?: string | null; qualification_state?: string | null;
  deployment_state?: string | null; blocker?: unknown; usage?: Record<string, unknown> | null; updated_at?: string | null;
  source_links?: unknown; source_version?: Record<string, unknown> | null; [key: string]: unknown;
}
export interface SnapshotEnvelope { cached?: boolean; fetchedAt: number; snapshot: { schema: string; generated_at?: string; ops_deployed_sha?: string | null; items: OpsWorkItem[]; [key: string]: unknown }; }
export type UiState = {kind:"loading"}|{kind:"error"}|{kind:"malformed";reason:"missing_envelope"|"missing_snapshot"|"unexpected_schema"|"items_not_array"}|{kind:"ready";envelope:SnapshotEnvelope;stale:boolean;fetchedAtIso:string;malformedItemCount:number};
export const TERMINAL_EXECUTION_STATES: ReadonlySet<string> = new Set(["succeeded","failed","stopped","stopped_for_review","merged","cancelled","done","skipped"]);
const obj=(v:unknown):v is Record<string,unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function parseEnvelope(raw:unknown, now:number):UiState {
 if (!obj(raw)) return {kind:"malformed",reason:"missing_envelope"};
 if (!obj(raw.snapshot)) return {kind:"malformed",reason:"missing_snapshot"};
 const snap=raw.snapshot;
 if (snap.schema !== "ops_work_snapshot_v1") return {kind:"malformed",reason:"unexpected_schema"};
 if (!Array.isArray(snap.items)) return {kind:"malformed",reason:"items_not_array"};
 const items=snap.items.filter((x):x is OpsWorkItem=>obj(x)&&typeof x.ops_task_id==="string"&&x.ops_task_id.trim().length>0);
 const hasFetchedAt=typeof raw.fetchedAt==="number"&&Number.isFinite(raw.fetchedAt); const fetchedAt=hasFetchedAt?raw.fetchedAt as number:0;
 const envelope={...raw,fetchedAt,snapshot:{...snap,items}} as unknown as SnapshotEnvelope;
 return {kind:"ready",envelope,stale:now-fetchedAt>STALE_AFTER_MS,fetchedAtIso:hasFetchedAt?new Date(fetchedAt).toISOString():"unknown",malformedItemCount:snap.items.length-items.length};
}
export function isTerminal(item:OpsWorkItem):boolean { return (typeof item.execution_state==="string"&&TERMINAL_EXECUTION_STATES.has(item.execution_state))||item.qualification_state==="MERGED"||item.issue_state==="closed"||item.issue_state==="merged"; }
export type AttentionReason="review"|"decision"|"approval"|"blocked"|"qualification"|null;
export function humanAttention(item:OpsWorkItem):{attention:boolean;reason:AttentionReason} {
 const review=(item.review_state??"").toLowerCase(); let reason:AttentionReason=null;
 const closedReview=["reviewed","review_complete","review_completed","changes_requested","approved","approval_completed","decision_recorded"].some(marker=>review.includes(marker));
 if(!isTerminal(item)&&!closedReview&&(review.includes("review")||review.includes("decision")||review.includes("adjudicat")||review.includes("approval")||review.includes("authorize"))){if(review.includes("review")) reason="review"; else if(review.includes("decision")||review.includes("adjudicat")) reason="decision"; else reason="approval";}
 if(reason===null&&item.blocker&&!isTerminal(item)) reason="blocked";
 else if(reason===null&&typeof item.qualification_state==="string"&&(/^(AWAITING|PENDING)/i).test(item.qualification_state)) reason="qualification";
 return {attention:reason!==null,reason};
}
export type OutcomeKind="success"|"failed"|"other";
export function outcomeLabel(item:OpsWorkItem):string { return item.execution_state??item.qualification_state??item.issue_state??"terminal"; }
export function outcomeKind(item:OpsWorkItem):OutcomeKind { if(["succeeded","merged","done"].includes(item.execution_state??"")||item.qualification_state==="MERGED")return "success"; if(item.execution_state==="failed")return "failed"; return "other"; }
export interface Row {item:OpsWorkItem;attentionReason:AttentionReason;terminal:boolean;outcomeKind?:OutcomeKind;outcomeLabel?:string}
export const OUTCOMES_CAP=25;
function compareRows(a:Row,b:Row):number { const av=Date.parse(a.item.updated_at??""); const bv=Date.parse(b.item.updated_at??""); const aok=Number.isFinite(av),bok=Number.isFinite(bv); if(aok&&bok&&av!==bv)return bv-av; if(aok!==bok)return aok?-1:1; return (a.item.ops_task_id??"").localeCompare(b.item.ops_task_id??""); }
export function buildViewModel(items:OpsWorkItem[],{now:_now}:{now:number}):{active:Row[];attention:Row[];outcomes:Row[]} { void _now; const all=items.map(item=>{const h=humanAttention(item),terminal=isTerminal(item);return {item,attentionReason:h.reason,terminal,...(terminal?{outcomeKind:outcomeKind(item),outcomeLabel:outcomeLabel(item)}:{})};}); return {active:all.filter(r=>!r.terminal).sort(compareRows),attention:all.filter(r=>r.attentionReason!==null).sort(compareRows),outcomes:all.filter(r=>r.terminal).sort(compareRows).slice(0,OUTCOMES_CAP)}; }
export interface Filters {query:string;scope:"all"|"active"|"attention"|"terminal";recency:"any"|"24h"|"7d";project:string}
export function applyFilters(rows:Row[],filters:Filters,now:number):Row[] { const q=filters.query.toLowerCase(); const cutoff=filters.recency==="24h"?now-86400000:filters.recency==="7d"?now-604800000:null; return rows.filter(r=>{const i=r.item;if(q&&!([i.issue_number,i.issue_title,i.ops_task_id,i.repository,i.project].some(v=>String(v??"").toLowerCase().includes(q))))return false;if(filters.scope==="active"&&r.terminal||filters.scope==="attention"&&r.attentionReason===null||filters.scope==="terminal"&&!r.terminal)return false;if(cutoff!==null){const t=Date.parse(i.updated_at??"");if(!Number.isFinite(t)||t<cutoff||t>now+300_000)return false;}if(filters.project&&i.project!==filters.project)return false;return true;}); }
export function accessibleName(row:Row):string {const i=row.item;const issue=i.issue_number!==null&&i.issue_number!==undefined?`#${String(i.issue_number)}${i.issue_title?` ${i.issue_title}`:""}`:(i.issue_title||"unknown issue");return `${issue} · ${i.project||"unknown"}`;}

export function summarize(text:unknown,max:number):string {
 const value=String(text).replace(/\s+/g," ").trim();
 const limit=Math.max(0,Math.trunc(max));
 return value.length<=limit?value:limit===0?"":`${value.slice(0,limit-1).trimEnd()}…`;
}
export function formatRecency(updated_at:string|null|undefined,now:number):string {
 const timestamp=Date.parse(updated_at??"");
 if(!Number.isFinite(timestamp)||!Number.isFinite(now))return "unknown";
 const seconds=Math.max(0,Math.floor((now-timestamp)/1000));
 if(seconds<60)return "just now";
 if(seconds<3600)return `${Math.floor(seconds/60)}m ago`;
 if(seconds<86400)return `${Math.floor(seconds/3600)}h ago`;
 if(seconds<30*86400)return `${Math.floor(seconds/86400)}d ago`;
 return new Date(timestamp).toISOString().slice(0,10);
}
export function blockSummary(item:OpsWorkItem):string {
 return item.blocker===null||item.blocker===undefined||String(item.blocker).trim()===""?"—":summarize(item.blocker,80);
}
export function resolveSelection(rows:{active:Row[];attention:Row[];outcomes:Row[]},selectedId:string|null):string|null {
 return selectedId!==null&&[...rows.active,...rows.attention,...rows.outcomes].some(row=>row.item.ops_task_id===selectedId)?selectedId:null;
}
