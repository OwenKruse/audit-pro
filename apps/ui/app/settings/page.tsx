import { CaseFilesCard } from './_components/CaseFilesCard';
import { AnvilForkSettingsCard } from './_components/AnvilForkSettingsCard';
import { FoundrySettingsCard } from './_components/FoundrySettingsCard';
import { FoundryDevToolsCard } from './_components/FoundryDevToolsCard';
import { ProxySettingsCard } from './_components/ProxySettingsCard';
import { AiSettingsCard } from './_components/AiSettingsCard';
import { ZapSettingsCard } from './_components/ZapSettingsCard';
import { SeedPhraseCard } from './_components/SeedPhraseCard';

export default function SettingsPage() {
  return (
    <div className="flex flex-col">
      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
        <h1 className="text-[13px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">Settings</h1>
      </div>

      <div className="flex flex-col gap-0 max-h-[90vh] overflow-y-auto">
        <CaseFilesCard />
        <AnvilForkSettingsCard />
        <FoundrySettingsCard />
        <FoundryDevToolsCard />
        <ProxySettingsCard />
        <ZapSettingsCard />
        <SeedPhraseCard />
        <AiSettingsCard />

        <div className="border-b border-[color:var(--cs-border)]">
          <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
            Local Agent Configuration
          </div>
          <div className="px-3 py-2 text-[11px] text-[color:var(--cs-muted)]">
            Agent port/host, DB path, log level, retention, redaction, and offline-only AI mode. TODO: settings persistence + agent restart integration.
          </div>
        </div>
      </div>
    </div>
  );
}
