import { redirect } from 'next/navigation';

export default async function HistoryDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/history?open=${encodeURIComponent(id)}`);
}
