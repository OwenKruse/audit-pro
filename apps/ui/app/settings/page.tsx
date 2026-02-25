import { type ReactNode } from 'react';
import { CaseFilesCard } from './_components/CaseFilesCard';
import { AnvilForkSettingsCard } from './_components/AnvilForkSettingsCard';
import { FoundrySettingsCard } from './_components/FoundrySettingsCard';
import { FoundryDevToolsCard } from './_components/FoundryDevToolsCard';
import { FoundryAddressInspectorCard } from './_components/FoundryAddressInspectorCard';
import { ProxySettingsCard } from './_components/ProxySettingsCard';
import { AiSettingsCard } from './_components/AiSettingsCard';
import { ZapSettingsCard } from './_components/ZapSettingsCard';
import { SeedPhraseCard } from './_components/SeedPhraseCard';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function SettingsPage() {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
        <h1 className="text-[13px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">Settings</h1>
      </div>

      <Tabs defaultValue="foundry" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
          <TabsList
            variant="line"
            className="h-auto w-full flex-wrap justify-start gap-1 rounded-none bg-transparent p-0"
          >
            <TabsTrigger className="h-7 flex-none px-2 text-[11px]" value="foundry">Foundry</TabsTrigger>
            <TabsTrigger className="h-7 flex-none px-2 text-[11px]" value="network">Network</TabsTrigger>
            <TabsTrigger className="h-7 flex-none px-2 text-[11px]" value="workspace">Workspace</TabsTrigger>
            <TabsTrigger className="h-7 flex-none px-2 text-[11px]" value="ai">AI</TabsTrigger>
            <TabsTrigger className="h-7 flex-none px-2 text-[11px]" value="system">System</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="foundry" className="m-0 flex min-h-0 flex-1 flex-col overflow-y-auto">
          <SettingsSection
            title="Foundry Runtime"
            description="Configure chain/rpc runtime, wallet integration, and local fork lifecycle."
          >
            <AnvilForkSettingsCard />
            <FoundrySettingsCard />
          </SettingsSection>
          <SettingsSection
            title="Foundry Tooling"
            description="Advanced dev utilities for local Anvil and deep address-level inspection."
          >
            <FoundryAddressInspectorCard />
            <FoundryDevToolsCard />
          </SettingsSection>
        </TabsContent>

        <TabsContent value="network" className="m-0 flex min-h-0 flex-1 flex-col overflow-y-auto">
          <SettingsSection
            title="Proxy & Traffic"
            description="Configure local proxy behavior and interception defaults."
          >
            <ProxySettingsCard />
          </SettingsSection>
          <SettingsSection
            title="Scanner Integrations"
            description="Configure external active scanning integrations."
          >
            <ZapSettingsCard />
          </SettingsSection>
        </TabsContent>

        <TabsContent value="workspace" className="m-0 flex min-h-0 flex-1 flex-col overflow-y-auto">
          <SettingsSection
            title="Projects & Case Files"
            description="Manage case import/export and project-level data files."
          >
            <CaseFilesCard />
          </SettingsSection>
          <SettingsSection
            title="Seed & Wallet Data"
            description="Manage deterministic seed phrase and test wallet material."
          >
            <SeedPhraseCard />
          </SettingsSection>
        </TabsContent>

        <TabsContent value="ai" className="m-0 flex min-h-0 flex-1 flex-col overflow-y-auto">
          <SettingsSection
            title="AI Providers"
            description="Configure provider, model, and inference defaults for the agent."
          >
            <AiSettingsCard />
          </SettingsSection>
        </TabsContent>

        <TabsContent value="system" className="m-0 flex min-h-0 flex-1 flex-col overflow-y-auto">
          <SettingsSection
            title="Local Agent Configuration"
            description="Agent port/host, DB path, log level, retention, redaction, and offline-only AI mode."
          >
            <div className="border-b border-[color:var(--cs-border)] px-3 py-2 text-[11px] text-[color:var(--cs-muted)]">
              TODO: settings persistence + agent restart integration.
            </div>
          </SettingsSection>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SettingsSection(props: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="border-b border-[color:var(--cs-border)]">
      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        {props.title}
      </div>
      <div className="border-b border-[color:var(--cs-border)] px-3 py-2 text-[11px] text-[color:var(--cs-muted)]">
        {props.description}
      </div>
      <div className="flex flex-col">{props.children}</div>
    </section>
  );
}
