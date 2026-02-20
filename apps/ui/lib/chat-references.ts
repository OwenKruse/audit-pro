export const RUNNER_REFERENCE_EVENT = 'cipherscope:runner:add-reference';

export type RunnerReferenceDetail = {
  referenceId: string;
};

const REFERENCE_ID_PATTERN = /@\[(.+?)\]/g;

export function buildReferenceToken(referenceId: string): string {
  return `@[${referenceId}]`;
}

export function extractReferenceIds(input: string): string[] {
  const ids = new Set<string>();
  for (const match of input.matchAll(REFERENCE_ID_PATTERN)) {
    const id = (match[1] ?? '').trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

export function dispatchRunnerReference(referenceId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<RunnerReferenceDetail>(RUNNER_REFERENCE_EVENT, {
      detail: { referenceId },
    }),
  );
}
