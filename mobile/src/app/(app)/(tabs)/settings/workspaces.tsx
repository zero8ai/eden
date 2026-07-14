import { mobileApi, type MobileMutationResult } from "@eden/api-contract";
import { router } from "expo-router";
import { useState } from "react";
import { Text } from "react-native";
import { Card, ErrorState, Heading, Loading, Row, Screen, colors } from "@/components/native";
import { postForm, useApiResource } from "@/hooks/use-api-resource";
type Data={workspaces:Array<{id:string;name:string;slug?:string}>;currentOrgId:string|null};
export default function WorkspacesScreen(){const{data,error,loading,refresh}=useApiResource<Data>(mobileApi.workspaces());const[busy,setBusy]=useState<string|null>(null);const[mutationError,setMutationError]=useState<string|null>(null);if(loading)return <Loading/>;if(error||!data)return <Screen><ErrorState message={error??"Could not load workspaces."} onRetry={refresh}/></Screen>;const choose=async(id:string)=>{setBusy(id);setMutationError(null);try{await postForm<MobileMutationResult>(mobileApi.workspaces(),{orgId:id,returnTo:"/dashboard"});router.replace("/(app)/(tabs)")}catch(e){setMutationError(e instanceof Error?e.message:"Could not switch workspace.")}finally{setBusy(null)}};return <Screen><Heading title="Choose a workspace" subtitle="Repository and organization data follows your active workspace."/>{mutationError?<ErrorState message={mutationError}/>:null}<Card>{data.workspaces.map(ws=><Row key={ws.id} title={ws.name} detail={ws.slug} meta={busy===ws.id?"Switching…":ws.id===data.currentOrgId?"Current":undefined} onPress={()=>choose(ws.id)}/>)}</Card></Screen>}
