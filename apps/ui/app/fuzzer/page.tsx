import { AgentClient } from '@cipherscope/sdk';
import { FuzzerClient } from './FuzzerClient';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export default async function FuzzerPage() {
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  const messages = await client
    .listMessages({ limit: 250, offset: 0 })
    .then((r) => r.items)
    .catch(() => null);

  return (
    <div className="flex h-full flex-col">
      <FuzzerClient initialMessages={messages ?? []} agentReachable={messages != null} />
    </div>
  );
}
