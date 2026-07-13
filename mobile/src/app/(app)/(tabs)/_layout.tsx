import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { colors } from "@/components/native";

export default function TabsLayout(){return <Tabs screenOptions={{tabBarActiveTintColor:colors.blue,tabBarLabelStyle:{fontSize:11},tabBarStyle:{height:Platform.OS==="ios"?84:64,paddingTop:6},headerShadowVisible:false}}>
  <Tabs.Screen name="index" options={{title:"Repositories",tabBarIcon:({color})=><TabIcon color={color} icon="⌘"/>}}/>
  <Tabs.Screen name="marketplace" options={{title:"Marketplace",headerShown:false,tabBarIcon:({color})=><TabIcon color={color} icon="✦"/>}}/>
  <Tabs.Screen name="settings" options={{title:"Settings",headerShown:false,tabBarIcon:({color})=><TabIcon color={color} icon="⚙"/>}}/>
</Tabs>}
function TabIcon({color,icon}:{color:import("react-native").ColorValue;icon:string}){return <Text style={{color,fontSize:22}}>{icon}</Text>}
import { Text } from "react-native";
