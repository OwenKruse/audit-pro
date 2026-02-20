const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function POST(req: Request): Promise<Response> {
  try {
    const ct = req.headers.get('content-type') ?? '';
    let zipBytes: ArrayBuffer;

    if (ct.includes('multipart/form-data')) {
      const fd = await req.formData();
      const file = fd.get('file');
      if (!(file instanceof File)) {
        return Response.json(
          { ok: false, error: { code: 'bad_request', message: 'Missing file.' } },
          { status: 400, headers: { 'cache-control': 'no-store' } },
        );
      }
      zipBytes = await file.arrayBuffer();
    } else {
      zipBytes = await req.arrayBuffer();
    }

    const upstream = await fetch(`${agentHttpUrl.replace(/\/$/, '')}/projects/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: zipBytes,
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'internal_error',
          message: err instanceof Error ? err.message : 'Failed to import.',
        },
      },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
