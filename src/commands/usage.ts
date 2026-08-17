import { collectUsage, formatUsageReport, type UsageProvider } from "../usage";

export async function usageCommand(opts: { json?: boolean; provider?: string } = {}): Promise<void> {
  const providers = opts.provider ? [opts.provider as UsageProvider] : undefined;
  if (providers && !["claude", "codex"].includes(providers[0]!)) {
    throw new Error(`unknown provider "${opts.provider}" (expected claude or codex)`);
  }
  const report = await collectUsage({ providers });
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatUsageReport(report, { color: process.stdout.isTTY ?? false }).join("\n"));
}
