import { redirect } from 'next/navigation';

export default async function RepeaterMessagePage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/repeater?open=${encodeURIComponent(id)}`);
}
