import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Text } from "react-native";
import { Button, Card, FormField, Heading, Screen, colors } from "@/components/native";
import { authClient } from "@/lib/auth-client";

export default function SignupScreen() {
  const { invitationId } = useLocalSearchParams<{ invitationId?: string }>();
  const [name,setName]=useState(""); const [email,setEmail]=useState(""); const [password,setPassword]=useState(""); const [confirm,setConfirm]=useState(""); const [busy,setBusy]=useState(false); const [error,setError]=useState<string|null>(null);
  const submit=async()=>{ if(!name.trim()||!email.includes("@")) return setError("Enter your name and a valid email."); if(password.length<8) return setError("Use at least 8 characters for your password."); if(password!==confirm) return setError("Passwords do not match."); setBusy(true); setError(null); try { const result=await authClient.signUp.email({name:name.trim(),email:email.trim().toLowerCase(),password}); if(result.error) return setError(result.error.message??"Could not create your account."); router.replace(invitationId ? `/(auth)/accept-invitation/${invitationId}` : "/(app)"); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create your account."); } finally { setBusy(false); } };
  return <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==="ios"?"padding":undefined}><Screen><Heading title="Create your account" subtitle="Your personal workspace will be ready when you sign in."/><Card><FormField label="Name" value={name} onChangeText={setName} autoComplete="name"/><FormField label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address"/><FormField label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" hint="At least 8 characters"/><FormField label="Confirm password" value={confirm} onChangeText={setConfirm} secureTextEntry autoComplete="new-password" onSubmitEditing={submit}/>{error?<Text accessibilityRole="alert" style={{color:colors.red}}>{error}</Text>:null}<Button title={busy?"Creating account…":"Create account"} disabled={busy} onPress={submit}/></Card></Screen></KeyboardAvoidingView>;
}
