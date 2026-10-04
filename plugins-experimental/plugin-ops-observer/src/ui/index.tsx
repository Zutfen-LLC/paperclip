import { useEffect,useMemo,useState } from "react";
import type { JSX } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { parseEnvelope,buildViewModel,applyFilters,resolveSelection } from "./model.js";
import type { Filters,SnapshotEnvelope,UiState } from "./model.js";
import { OpsWorkView } from "./view.js";

export function OpsWorkPage():JSX.Element {
 const {data,loading,error,refresh}=usePluginData<SnapshotEnvelope>("ops-snapshot",{});
 const [now,setNow]=useState(Date.now()); const [filters,setFilters]=useState<Filters>({query:"",scope:"all",recency:"any",project:""});const [selectedId,setSelectedId]=useState<string|null>(null);
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(t);},[]);
 const state:UiState=loading&&!data?{kind:"loading"}:error&&!data?{kind:"error"}:parseEnvelope(data,now);
 const rows=useMemo(()=>{if(state.kind!=="ready")return {active:[],attention:[],outcomes:[]};const vm=buildViewModel(state.envelope.snapshot.items,{now});return {active:applyFilters(vm.active,filters,now),attention:applyFilters(vm.attention,filters,now),outcomes:applyFilters(vm.outcomes,filters,now)};},[state,filters,now]);
 const visibleSelectedId=resolveSelection(rows,selectedId);
 useEffect(()=>{if(selectedId!==null&&visibleSelectedId===null)setSelectedId(null);},[selectedId,visibleSelectedId]);
 return <OpsWorkView state={state} rows={rows} filters={filters} onFilters={setFilters} selectedId={visibleSelectedId} onSelect={setSelectedId} onRefresh={()=>void refresh()} loading={loading} now={now} items={state.kind==="ready"?state.envelope.snapshot.items:[]} refreshFailed={Boolean(error&&data)}/>;
}
export default OpsWorkPage;
