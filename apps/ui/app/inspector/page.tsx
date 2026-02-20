import { ContractsWorkbench } from './_components/ContractsWorkbench';

export default async function InspectorPage(props: {
  searchParams: Promise<{ open?: string }>;
}) {
  const searchParams = await props.searchParams;
  return (
    <div className="flex h-full flex-col">
      <ContractsWorkbench initialSelectedContractId={searchParams.open ?? null} />
    </div>
  );
}
