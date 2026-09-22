import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthoritiesHighlights } from '../src/app/authorities/AuthoritiesHighlightEditor';
import { beaverAuthoritiesHost } from '../src/app/authorities/beaverHost';
import { initializeRuntimeConfig } from '../src/app/lib/runtimeConfig';
import '../src/app/base.css';
await initializeRuntimeConfig(async()=>new Response(JSON.stringify({mode:'local',capabilities:{connectors:false}})));
const initial=await (await fetch('/api/fixture')).json();
(globalThis as any).heartbeats=0;setInterval(()=>(globalThis as any).heartbeats++,50);
function Fixture(){const[product,setProduct]=useState(initial);return <AuthoritiesHighlights product={product} tabs={new Map()} host={beaverAuthoritiesHost} busy={false} ocr={{tracked:{},begin:async()=>{},stop:async()=>{}}} onSaved={setProduct}/>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
