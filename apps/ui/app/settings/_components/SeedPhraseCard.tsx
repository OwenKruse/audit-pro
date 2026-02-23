'use client';

import { useCallback, useState } from 'react';
import { generateMnemonic } from 'viem/accounts';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { Copy, RefreshCw } from 'lucide-react';

type WordCount = 12 | 24;

const ENTROPY_BITS: Record<WordCount, 128 | 256> = {
  12: 128,
  24: 256,
};

const btnClass =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)] disabled:opacity-50';

export function SeedPhraseCard() {
  const [wordCount, setWordCount] = useState<WordCount>(12);
  const [phrase, setPhrase] = useState<string>(() => generateMnemonic(wordlist, 128));
  const [copied, setCopied] = useState(false);

  const refresh = useCallback((count: WordCount) => {
    setPhrase(generateMnemonic(wordlist, ENTROPY_BITS[count]));
    setCopied(false);
  }, []);

  function onWordCountChange(next: WordCount) {
    setWordCount(next);
    refresh(next);
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(phrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  const words = phrase.split(' ');

  return (
    <div className="border-b border-[color:var(--cs-border)]">
      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        Seed Phrase Generator
      </div>
      <div className="space-y-3 px-3 py-2">
        <p className="text-[11px] text-[color:var(--cs-muted)]">
          Generate a random BIP-39 mnemonic seed phrase for testing. Never use generated phrases to
          secure real funds.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] text-[11px] font-medium">
            <button
              type="button"
              onClick={() => onWordCountChange(12)}
              className={[
                'h-7 rounded-l-md px-3 transition-colors',
                wordCount === 12
                  ? 'bg-[color:var(--cs-accent)] text-white'
                  : 'text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]',
              ].join(' ')}
            >
              12 words
            </button>
            <button
              type="button"
              onClick={() => onWordCountChange(24)}
              className={[
                'h-7 rounded-r-md px-3 transition-colors',
                wordCount === 24
                  ? 'bg-[color:var(--cs-accent)] text-white'
                  : 'text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]',
              ].join(' ')}
            >
              24 words
            </button>
          </div>

          <button type="button" onClick={() => refresh(wordCount)} className={btnClass}>
            <RefreshCw className="h-3.5 w-3.5" />
            Regenerate
          </button>

          <button type="button" onClick={() => void onCopy()} className={btnClass}>
            <Copy className="h-3.5 w-3.5" />
            {copied ? 'Copied!' : 'Copy Phrase'}
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
          {words.map((word, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1"
            >
              <span className="w-4 shrink-0 text-right font-mono text-[9px] text-[color:var(--cs-muted)]">
                {i + 1}
              </span>
              <span className="font-mono text-[11px] text-[color:var(--cs-fg)]">{word}</span>
            </div>
          ))}
        </div>

        <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1.5 font-mono text-[10px] text-[color:var(--cs-muted)] break-all">
          {phrase}
        </div>

        <p className="text-[10px] text-amber-600">
          Warning: for development and testing only. Do not use for real wallets or funds.
        </p>
      </div>
    </div>
  );
}
