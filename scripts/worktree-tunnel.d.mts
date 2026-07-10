export type PortEntry = {
  dev: number;
  splitter: number;
  instance: number;
  tunnelShortId?: string;
  tunnelHost?: string;
};
export type TunnelMetadata = {
  tunnelId: string;
  tunnelName: string;
  credentialsFile: string;
  domain: string;
};
export function generateTunnelShortId(): string;
export function sanitizeDnsLabel(value: string): string;
export function deriveTunnelHost(
  session: string,
  shortId: string,
  domain?: string,
): string;
export function enrichPortEntry(
  entry: PortEntry,
  session: string,
  domain?: string,
): PortEntry & Required<Pick<PortEntry, "tunnelShortId" | "tunnelHost">>;
export function isSafeHostname(host: string): boolean;
export function renderTunnelConfig(
  metadata: TunnelMetadata,
  registry: Record<string, PortEntry>,
): string;
export function parseQuickTunnelUrl(output: string): string;
export function cloudflaredEnvironment(
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
