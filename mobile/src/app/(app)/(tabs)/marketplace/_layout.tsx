import { Stack } from "expo-router";
export default function MarketplaceLayout(){return <Stack screenOptions={{headerBackTitle:"Marketplace",headerShadowVisible:false}}><Stack.Screen name="index" options={{title:"Marketplace"}}/><Stack.Screen name="[type]/[id]" options={{title:"Template"}}/><Stack.Screen name="[type]/[id]/install" options={{title:"Install"}}/></Stack>}
