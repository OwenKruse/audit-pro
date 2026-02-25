import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export type BrowserWaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
export type BrowserWaitForState = 'attached' | 'detached' | 'visible' | 'hidden';

export type BrowserToolResult = {
  payload: Record<string, unknown>;
  summary: string;
};

type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: string;
  updatedAt: string;
};

type TruncatedText = {
  text: string;
  truncated: boolean;
  chars: number;
};

const DEFAULT_SESSION = 'default';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 80_000;
const MAX_SESSIONS = 6;
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'cipherscope-ai-screenshots');

const browserSessions = new Map<string, BrowserSession>();
const browserSessionCreation = new Map<string, Promise<BrowserSession>>();

function nowIso(): string {
  return new Date().toISOString();
}

function envIsFalse(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off';
}

function envIsTrue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeSessionName(value: string | undefined): string {
  const raw = value?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_SESSION;
}

function sanitizeFileFragment(value: string): string {
  const safe = value
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');
  return safe || 'capture';
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function truncateText(input: string, maxChars: number): TruncatedText {
  const chars = input.length;
  if (chars <= maxChars) {
    return {
      text: input,
      truncated: false,
      chars,
    };
  }
  return {
    text: input.slice(0, maxChars),
    truncated: true,
    chars,
  };
}

function normalizeScreenshotType(value: string | undefined): 'png' | 'jpeg' {
  if (value && value.toLowerCase() === 'jpeg') return 'jpeg';
  return 'png';
}

function resolveScreenshotPath(inputPath: string | undefined, session: string, type: 'png' | 'jpeg'): string {
  if (inputPath && inputPath.trim()) {
    const raw = inputPath.trim();
    if (path.isAbsolute(raw)) return raw;
    return path.resolve(process.cwd(), raw);
  }
  const stamp = nowIso().replaceAll(/[:.]/g, '-');
  const extension = type === 'jpeg' ? 'jpg' : 'png';
  return path.join(
    SCREENSHOT_DIR,
    `${sanitizeFileFragment(session)}-${stamp}-${randomUUID().slice(0, 8)}.${extension}`,
  );
}

function pageClosedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /target page, context or browser has been closed/i.test(err.message);
}

async function closeSession(name: string, session: BrowserSession): Promise<void> {
  browserSessions.delete(name);
  try {
    await session.context.close();
  } catch {
    // ignore
  }
  try {
    await session.browser.close();
  } catch {
    // ignore
  }
}

async function createSession(): Promise<BrowserSession> {
  const headless = !envIsFalse(process.env.AGENT_AI_BROWSER_HEADLESS);
  const ignoreHTTPSErrors = envIsTrue(process.env.AGENT_UPSTREAM_INSECURE);
  try {
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      ignoreHTTPSErrors,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    const createdAt = nowIso();
    return {
      browser,
      context,
      page,
      createdAt,
      updatedAt: createdAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/executable doesn't exist/i.test(message) || /please run the following command/i.test(message)) {
      throw new Error(
        `Playwright Chromium is not installed. Install it with "pnpm exec playwright install chromium". (${message})`,
      );
    }
    throw err;
  }
}

function touchSession(name: string): void {
  const existing = browserSessions.get(name);
  if (!existing) return;
  existing.updatedAt = nowIso();
}

async function pruneSessions(): Promise<void> {
  if (browserSessions.size <= MAX_SESSIONS) return;
  const entries = [...browserSessions.entries()].sort((a, b) => {
    return Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt);
  });
  const toClose = entries.slice(0, Math.max(0, entries.length - MAX_SESSIONS));
  for (const [name, session] of toClose) {
    await closeSession(name, session);
  }
}

async function getSession(name: string): Promise<BrowserSession> {
  const existing = browserSessions.get(name);
  if (existing && existing.browser.isConnected() && !existing.page.isClosed()) {
    touchSession(name);
    return existing;
  }
  if (existing) await closeSession(name, existing);

  const pending = browserSessionCreation.get(name);
  if (pending) return pending;

  const creating = (async () => {
    const created = await createSession();
    browserSessions.set(name, created);
    await pruneSessions();
    return created;
  })();
  browserSessionCreation.set(name, creating);
  try {
    return await creating;
  } finally {
    browserSessionCreation.delete(name);
  }
}

async function withPage<T>(sessionName: string, runner: (page: Page) => Promise<T>): Promise<T> {
  const execute = async (): Promise<T> => {
    const session = await getSession(sessionName);
    const result = await runner(session.page);
    touchSession(sessionName);
    return result;
  };

  try {
    return await execute();
  } catch (err) {
    if (!pageClosedError(err)) throw err;
    const stale = browserSessions.get(sessionName);
    if (stale) await closeSession(sessionName, stale);
    return await execute();
  }
}

async function pageMeta(page: Page): Promise<{ url: string; title: string | null }> {
  let title: string | null = null;
  try {
    title = await page.title();
  } catch {
    title = null;
  }
  return {
    url: page.url(),
    title,
  };
}

export async function gotoPage(input: {
  session?: string;
  url: string;
  timeoutMs?: number;
  waitUntil?: BrowserWaitUntil;
}): Promise<BrowserToolResult> {
  const session = normalizeSessionName(input.session);
  let requested: URL;
  try {
    requested = new URL(input.url);
  } catch (err) {
    throw new Error(`goto invalid url: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (requested.protocol !== 'http:' && requested.protocol !== 'https:') {
    throw new Error(`goto only supports http/https URLs. Received: ${requested.protocol}`);
  }

  const timeoutMs =
    input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : clampInt(input.timeoutMs, 100, 120_000);
  const waitUntil = input.waitUntil ?? 'domcontentloaded';

  const payload = await withPage(session, async (page) => {
    const response = await page.goto(requested.toString(), {
      timeout: timeoutMs,
      waitUntil,
    });
    const meta = await pageMeta(page);
    return {
      session,
      requestedUrl: requested.toString(),
      url: meta.url,
      title: meta.title,
      status: response?.status() ?? null,
      ok: response ? response.ok() : true,
      waitUntil,
    };
  });

  const statusText =
    typeof payload.status === 'number' ? ` (${payload.status})` : '';
  return {
    payload,
    summary: `Browser goto navigated session "${session}" to ${String(payload.url)}${statusText}.`,
  };
}

export async function clickPage(input: {
  session?: string;
  selector: string;
  timeoutMs?: number;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
  delayMs?: number;
}): Promise<BrowserToolResult> {
  const session = normalizeSessionName(input.session);
  const timeoutMs =
    input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : clampInt(input.timeoutMs, 100, 120_000);
  const clickCount = input.clickCount === undefined ? 1 : clampInt(input.clickCount, 1, 20);
  const delay = input.delayMs === undefined ? 0 : clampInt(input.delayMs, 0, 3000);
  const button = input.button ?? 'left';

  const payload = await withPage(session, async (page) => {
    await page.click(input.selector, {
      timeout: timeoutMs,
      clickCount,
      button,
      delay,
    });
    const meta = await pageMeta(page);
    return {
      session,
      selector: input.selector,
      url: meta.url,
      title: meta.title,
      button,
      clickCount,
    };
  });

  return {
    payload,
    summary: `Browser click executed on "${input.selector}" in session "${session}".`,
  };
}

export async function typeIntoPage(input: {
  session?: string;
  selector: string;
  text: string;
  clear?: boolean;
  delayMs?: number;
  timeoutMs?: number;
  pressEnter?: boolean;
}): Promise<BrowserToolResult> {
  const session = normalizeSessionName(input.session);
  const timeoutMs =
    input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : clampInt(input.timeoutMs, 100, 120_000);
  const clear = input.clear ?? true;
  const delay = input.delayMs === undefined ? 0 : clampInt(input.delayMs, 0, 500);
  const pressEnter = input.pressEnter ?? false;

  const payload = await withPage(session, async (page) => {
    const locator = page.locator(input.selector).first();
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    if (clear) await locator.fill('', { timeout: timeoutMs });
    if (delay > 0) await locator.type(input.text, { delay, timeout: timeoutMs });
    else await locator.type(input.text, { timeout: timeoutMs });
    if (pressEnter) await locator.press('Enter', { timeout: timeoutMs });
    const meta = await pageMeta(page);
    return {
      session,
      selector: input.selector,
      url: meta.url,
      title: meta.title,
      typedChars: input.text.length,
      cleared: clear,
      pressEnter,
    };
  });

  return {
    payload,
    summary: `Browser type entered text into "${input.selector}" in session "${session}".`,
  };
}

export async function waitForPage(input: {
  session?: string;
  selector: string;
  state?: BrowserWaitForState;
  timeoutMs?: number;
}): Promise<BrowserToolResult> {
  const session = normalizeSessionName(input.session);
  const state = input.state ?? 'visible';
  const timeoutMs =
    input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : clampInt(input.timeoutMs, 50, 120_000);

  const payload = await withPage(session, async (page) => {
    const startedAt = Date.now();
    const handle = await page.waitForSelector(input.selector, { timeout: timeoutMs, state });
    if (handle) {
      await handle.dispose();
    }
    const meta = await pageMeta(page);
    return {
      session,
      selector: input.selector,
      state,
      waitedMs: Date.now() - startedAt,
      url: meta.url,
      title: meta.title,
      satisfied: true,
    };
  });

  return {
    payload,
    summary: `Browser wait_for satisfied "${input.selector}" (${state}) in session "${session}".`,
  };
}

async function evaluateWithTimeout(page: Page, script: string, timeoutMs: number): Promise<unknown> {
  const evalPromise = page.evaluate(async ({ source }) => {
    const result = (0, eval)(source) as unknown;
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return await (result as Promise<unknown>);
    }
    return result;
  }, { source: script });

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`evaluate_js timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });

    return await Promise.race([evalPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function evaluatePageJs(input: {
  session?: string;
  script: string;
  timeoutMs?: number;
}): Promise<BrowserToolResult> {
  const session = normalizeSessionName(input.session);
  const timeoutMs =
    input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : clampInt(input.timeoutMs, 50, 120_000);

  const payload = await withPage(session, async (page) => {
    const startedAt = Date.now();
    const result = await evaluateWithTimeout(page, input.script, timeoutMs);
    const meta = await pageMeta(page);
    return {
      session,
      url: meta.url,
      title: meta.title,
      durationMs: Date.now() - startedAt,
      result,
    };
  });

  return {
    payload,
    summary: `Browser evaluate_js completed in session "${session}".`,
  };
}

export async function extractPageText(input: {
  session?: string;
  selector: string;
  all?: boolean;
  timeoutMs?: number;
  maxChars?: number;
  maxItems?: number;
  trim?: boolean;
}): Promise<BrowserToolResult> {
  const session = normalizeSessionName(input.session);
  const all = input.all ?? false;
  const trim = input.trim ?? true;
  const timeoutMs =
    input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : clampInt(input.timeoutMs, 100, 120_000);
  const maxChars =
    input.maxChars === undefined ? DEFAULT_MAX_CHARS : clampInt(input.maxChars, 100, 500_000);
  const maxItems = input.maxItems === undefined ? 200 : clampInt(input.maxItems, 1, 2000);

  const payload = await withPage(session, async (page) => {
    await page.waitForSelector(input.selector, { timeout: timeoutMs, state: 'attached' });
    const meta = await pageMeta(page);

    if (all) {
      const texts = await page.$$eval(
        input.selector,
        (nodes, trimText) =>
          nodes.map((node) => {
            const raw = node.textContent ?? '';
            return trimText ? raw.trim() : raw;
          }),
        trim,
      );

      const limited = texts.slice(0, maxItems);
      const combined = limited.join('\n');
      const clipped = truncateText(combined, maxChars);
      return {
        session,
        selector: input.selector,
        url: meta.url,
        title: meta.title,
        all: true,
        count: texts.length,
        returnedCount: limited.length,
        omittedCount: Math.max(0, texts.length - limited.length),
        text: clipped.text,
        textChars: clipped.chars,
        truncated: clipped.truncated,
      };
    }

    const single = await page.$eval(
      input.selector,
      (node, trimText) => {
        const raw = node.textContent ?? '';
        return trimText ? raw.trim() : raw;
      },
      trim,
    );
    const clipped = truncateText(single, maxChars);
    return {
      session,
      selector: input.selector,
      url: meta.url,
      title: meta.title,
      all: false,
      text: clipped.text,
      textChars: clipped.chars,
      truncated: clipped.truncated,
    };
  });

  return {
    payload,
    summary: `Browser extract_text captured text for "${input.selector}" in session "${session}".`,
  };
}

export async function extractPageDom(input: {
  session?: string;
  selector?: string;
  outerHtml?: boolean;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<BrowserToolResult> {
  const session = normalizeSessionName(input.session);
  const timeoutMs =
    input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : clampInt(input.timeoutMs, 100, 120_000);
  const maxChars =
    input.maxChars === undefined ? DEFAULT_MAX_CHARS : clampInt(input.maxChars, 100, 600_000);
  const outerHtml = input.outerHtml ?? true;

  const payload = await withPage(session, async (page) => {
    const meta = await pageMeta(page);
    const raw = (() => {
      if (!input.selector) return page.content();
      return page.waitForSelector(input.selector, { timeout: timeoutMs, state: 'attached' }).then(async () => {
        return await page.$eval(
          input.selector as string,
          (node, useOuter) => (useOuter ? (node as Element).outerHTML : (node as Element).innerHTML),
          outerHtml,
        );
      });
    })();
    const html = await raw;
    const clipped = truncateText(html, maxChars);
    return {
      session,
      selector: input.selector ?? null,
      url: meta.url,
      title: meta.title,
      html: clipped.text,
      htmlChars: clipped.chars,
      truncated: clipped.truncated,
      outerHtml,
    };
  });

  return {
    payload,
    summary: input.selector
      ? `Browser extract_dom captured DOM for "${input.selector}" in session "${session}".`
      : `Browser extract_dom captured full page DOM in session "${session}".`,
  };
}

export async function screenshotPage(input: {
  session?: string;
  selector?: string;
  fullPage?: boolean;
  path?: string;
  type?: 'png' | 'jpeg';
  quality?: number;
  timeoutMs?: number;
  omitBackground?: boolean;
}): Promise<BrowserToolResult> {
  const session = normalizeSessionName(input.session);
  const timeoutMs =
    input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : clampInt(input.timeoutMs, 100, 120_000);
  const type = normalizeScreenshotType(input.type);
  const quality = type === 'jpeg' ? clampInt(input.quality ?? 80, 1, 100) : undefined;
  const fullPage = input.fullPage ?? true;
  const omitBackground = input.omitBackground ?? false;
  const outputPath = resolveScreenshotPath(input.path, session, type);

  const payload = await withPage(session, async (page) => {
    let buffer: Buffer;
    if (input.selector) {
      const locator = page.locator(input.selector).first();
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      buffer = await locator.screenshot({
        type,
        timeout: timeoutMs,
        omitBackground,
        ...(quality !== undefined ? { quality } : {}),
      });
    } else {
      buffer = await page.screenshot({
        type,
        timeout: timeoutMs,
        fullPage,
        omitBackground,
        ...(quality !== undefined ? { quality } : {}),
      });
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, buffer);
    const meta = await pageMeta(page);
    return {
      session,
      selector: input.selector ?? null,
      url: meta.url,
      title: meta.title,
      path: outputPath,
      type,
      bytes: buffer.byteLength,
      fullPage: input.selector ? null : fullPage,
      quality: quality ?? null,
      omitBackground,
      createdAt: nowIso(),
    };
  });

  return {
    payload,
    summary: `Browser screenshot saved for session "${session}" (${String(payload.path)}).`,
  };
}

export async function closeBrowserAutomation(): Promise<void> {
  const sessions = [...browserSessions.entries()];
  for (const [name, session] of sessions) {
    await closeSession(name, session);
  }
}
