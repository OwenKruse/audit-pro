import { HistoryWorkspace } from './_components/HistoryWorkspace';

export default async function HistoryPage(props: {
  searchParams: Promise<{ open?: string; search?: string; panel?: string }>;
}) {
  const searchParams = await props.searchParams;

  const panelParam = (searchParams.panel ?? '').toLowerCase();
  const initialPanel = panelParam === 'rpc' ? 'rpc' : 'http';

  return (
    <div className="flex h-full flex-col">
      <HistoryWorkspace
        initialPanel={initialPanel}
        httpInitialSelectedId={initialPanel === 'http' ? (searchParams.open ?? null) : null}
        httpInitialSearch={initialPanel === 'http' ? (searchParams.search ?? null) : null}
        rpcInitialSelectedId={initialPanel === 'rpc' ? (searchParams.open ?? null) : null}
        rpcInitialSearch={initialPanel === 'rpc' ? (searchParams.search ?? null) : null}
      />
    </div>
  );
}
