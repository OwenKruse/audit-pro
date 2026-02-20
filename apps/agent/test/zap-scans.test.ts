import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('Bad address'));
      resolve(addr.port);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.sequential('zap scans', () => {
  it('starts a ZAP scan, tracks progress, and persists results', async () => {
    let spiderPollCount = 0;
    let passivePollCount = 0;
    let activePollCount = 0;

    const zap = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathName = url.pathname;

      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');

      if (pathName === '/JSON/core/view/version/') {
        res.end(JSON.stringify({ version: '2.15.0' }));
        return;
      }

      if (pathName === '/JSON/spider/action/scan/') {
        res.end(JSON.stringify({ scan: '1' }));
        return;
      }

      if (pathName === '/JSON/spider/view/status/') {
        spiderPollCount += 1;
        res.end(JSON.stringify({ status: spiderPollCount >= 2 ? '100' : '40' }));
        return;
      }

      if (pathName === '/JSON/pscan/view/recordsToScan/') {
        passivePollCount += 1;
        res.end(JSON.stringify({ recordsToScan: passivePollCount >= 2 ? '0' : '2' }));
        return;
      }

      if (pathName === '/JSON/ascan/action/scan/') {
        res.end(JSON.stringify({ scan: '3' }));
        return;
      }

      if (pathName === '/JSON/ascan/view/status/') {
        activePollCount += 1;
        res.end(JSON.stringify({ status: activePollCount >= 2 ? '100' : '35' }));
        return;
      }

      if (pathName === '/JSON/alert/view/alertsSummary/') {
        res.end(
          JSON.stringify({
            alertsSummary: {
              High: '1',
              Medium: '1',
              Low: '0',
              Informational: '0',
              Critical: '0',
              Unknown: '0',
            },
          }),
        );
        return;
      }

      if (pathName === '/JSON/alert/view/alerts/') {
        res.end(
          JSON.stringify({
            alerts: [
              {
                pluginId: '40018',
                alert: 'SQL Injection',
                risk: 'High',
                confidence: 'Medium',
                url: 'https://target.test/login',
              },
              {
                pluginId: '90020',
                alert: 'X-Content-Type-Options Header Missing',
                risk: 'Medium',
                confidence: 'Low',
                url: 'https://target.test',
              },
            ],
          }),
        );
        return;
      }

      if (
        pathName === '/JSON/spider/action/stop/' ||
        pathName === '/JSON/ascan/action/stop/' ||
        pathName === '/JSON/ajaxSpider/action/stop/'
      ) {
        res.end(JSON.stringify({ Result: 'OK' }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'not_found', message: pathName }));
    });

    const zapPort = await listen(zap);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-zap-'));
    const dbPath = path.join(tmpDir, 'agent.db');

    const prevZapUrl = process.env.ZAP_API_URL;
    process.env.ZAP_API_URL = `http://127.0.0.1:${zapPort}`;

    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/zap/scans/start',
        payload: {
          target: 'https://target.test',
          spider: true,
          ajaxSpider: false,
          activeScan: true,
          waitForPassiveScan: true,
          pollIntervalMs: 50,
          maxAlerts: 25,
          maxDurationMs: 120000,
        },
      });
      expect(startRes.statusCode).toBe(200);
      const startJson = startRes.json() as {
        ok: boolean;
        scan: { id: string; status: string };
      };
      expect(startJson.ok).toBe(true);
      expect(startJson.scan.status).toBe('queued');

      const scanId = startJson.scan.id;
      let terminal:
        | {
            id: string;
            status: string;
            summary: { alertsTotal: number; riskCounts: { high: number; medium: number } };
          }
        | null = null;

      for (let i = 0; i < 80; i += 1) {
        const res = await app.inject({ method: 'GET', url: `/zap/scans/${encodeURIComponent(scanId)}` });
        if (res.statusCode !== 200) {
          await sleep(25);
          continue;
        }
        const json = res.json() as {
          ok: boolean;
          scan: {
            id: string;
            status: string;
            summary: { alertsTotal: number; riskCounts: { high: number; medium: number } };
          };
        };
        if (json.ok && ['completed', 'failed', 'stopped'].includes(json.scan.status)) {
          terminal = json.scan;
          break;
        }
        await sleep(25);
      }

      expect(terminal).toBeTruthy();
      expect(terminal?.status).toBe('completed');
      expect(terminal?.summary.alertsTotal).toBeGreaterThanOrEqual(2);
      expect(terminal?.summary.riskCounts.high).toBeGreaterThanOrEqual(1);
      expect(terminal?.summary.riskCounts.medium).toBeGreaterThanOrEqual(1);

      const listRes = await app.inject({ method: 'GET', url: '/zap/scans?limit=10&offset=0' });
      expect(listRes.statusCode).toBe(200);
      const listJson = listRes.json() as { ok: boolean; items: Array<{ id: string; status: string }> };
      expect(listJson.ok).toBe(true);
      expect(listJson.items.some((item) => item.id === scanId && item.status === 'completed')).toBe(true);
    } finally {
      await close();
      zap.close();
      if (prevZapUrl === undefined) delete process.env.ZAP_API_URL;
      else process.env.ZAP_API_URL = prevZapUrl;
    }
  });

  it('stops an in-flight ZAP scan', async () => {
    let stopCalled = false;

    const zap = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathName = url.pathname;

      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');

      if (pathName === '/JSON/core/view/version/') {
        res.end(JSON.stringify({ version: '2.15.0' }));
        return;
      }

      if (pathName === '/JSON/ascan/action/scan/') {
        res.end(JSON.stringify({ scan: '88' }));
        return;
      }

      if (pathName === '/JSON/ascan/view/status/') {
        res.end(JSON.stringify({ status: stopCalled ? '100' : '10' }));
        return;
      }

      if (pathName === '/JSON/ascan/action/stop/') {
        stopCalled = true;
        res.end(JSON.stringify({ Result: 'OK' }));
        return;
      }

      if (
        pathName === '/JSON/spider/action/stop/' ||
        pathName === '/JSON/ajaxSpider/action/stop/' ||
        pathName === '/JSON/alert/view/alerts/' ||
        pathName === '/JSON/alert/view/alertsSummary/'
      ) {
        res.end(JSON.stringify({ alerts: [], alertsSummary: {} }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'not_found', message: pathName }));
    });

    const zapPort = await listen(zap);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-zap-stop-'));
    const dbPath = path.join(tmpDir, 'agent.db');

    const prevZapUrl = process.env.ZAP_API_URL;
    process.env.ZAP_API_URL = `http://127.0.0.1:${zapPort}`;

    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/zap/scans/start',
        payload: {
          target: 'https://target.test',
          spider: false,
          ajaxSpider: false,
          activeScan: true,
          waitForPassiveScan: false,
          pollIntervalMs: 50,
          maxDurationMs: 120000,
        },
      });

      const startJson = startRes.json() as { ok: boolean; scan: { id: string } };
      expect(startJson.ok).toBe(true);

      const stopRes = await app.inject({
        method: 'POST',
        url: `/zap/scans/${encodeURIComponent(startJson.scan.id)}/stop`,
      });
      expect(stopRes.statusCode).toBe(200);

      let finalStatus: string | null = null;
      for (let i = 0; i < 80; i += 1) {
        const current = await app.inject({
          method: 'GET',
          url: `/zap/scans/${encodeURIComponent(startJson.scan.id)}`,
        });
        if (current.statusCode !== 200) {
          await sleep(25);
          continue;
        }

        const json = current.json() as { ok: boolean; scan: { status: string } };
        if (json.ok && ['stopped', 'failed', 'completed'].includes(json.scan.status)) {
          finalStatus = json.scan.status;
          break;
        }
        await sleep(25);
      }

      expect(finalStatus).toBe('stopped');
    } finally {
      await close();
      zap.close();
      if (prevZapUrl === undefined) delete process.env.ZAP_API_URL;
      else process.env.ZAP_API_URL = prevZapUrl;
    }
  });
});
