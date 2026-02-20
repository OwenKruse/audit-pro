'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ZapScanRecord, ZapRiskLevel } from './SidebarZapScanner';
import {
  statusBadgeClass,
  formatStamp,
  isActiveStatus,
} from './SidebarZapScanner';

function riskBadgeClass(risk: ZapRiskLevel): string {
  switch (risk) {
    case 'critical':
      return 'bg-rose-500/20 text-rose-700 dark:text-rose-300 border-rose-500/40';
    case 'high':
      return 'bg-orange-500/20 text-orange-700 dark:text-orange-300 border-orange-500/40';
    case 'medium':
      return 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/40';
    case 'low':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30';
    case 'informational':
      return 'bg-muted text-muted-foreground border-border';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

function formatDuration(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const ms = end - start;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  if (min >= 1) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

type ScanSummaryModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scan: ZapScanRecord | null;
  onStopScan?: (scanId: string) => void;
  stoppingScanId?: string | null;
};

export function ScanSummaryModal({
  open,
  onOpenChange,
  scan,
  onStopScan,
  stoppingScanId = null,
}: ScanSummaryModalProps) {
  if (!scan) return null;

  const duration = formatDuration(scan.startedAt, scan.finishedAt);
  const running = isActiveStatus(scan.status);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col gap-0 w-full">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-base">
            {scan.id.slice(0, 8)}
            <Badge
              variant="outline"
              className={statusBadgeClass(scan.status)}
            >
              {scan.status}
            </Badge>
          </DialogTitle>
          <DialogDescription className="truncate" title={scan.target}>
            {scan.target}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-y-auto py-2 pr-1 -mr-1">
          {/* Meta */}
          <div className="space-y-1 text-sm">
            <div className="text-muted-foreground">
              Started: {formatStamp(scan.startedAt)}
            </div>
            {scan.finishedAt && (
              <div className="text-muted-foreground">
                Finished: {formatStamp(scan.finishedAt)}
                {duration != null && ` · Duration: ${duration}`}
              </div>
            )}
          </div>

          {/* Config */}
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Config
            </h4>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">{scan.config.spider ? 'Spider' : 'No spider'}</Badge>
              <Badge variant="secondary">{scan.config.ajaxSpider ? 'AJAX spider' : 'No AJAX'}</Badge>
              <Badge variant="secondary">{scan.config.activeScan ? 'Active scan' : 'Passive only'}</Badge>
              {scan.config.recurse && <Badge variant="outline">Recurse</Badge>}
              {scan.config.inScopeOnly && <Badge variant="outline">In scope only</Badge>}
              {scan.config.waitForPassiveScan && <Badge variant="outline">Wait for passive</Badge>}
              {scan.config.scanPolicyName && (
                <Badge variant="outline">Policy: {scan.config.scanPolicyName}</Badge>
              )}
              <Badge variant="outline">Source: {scan.config.source}</Badge>
            </div>
          </div>

          {/* State */}
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              State
            </h4>
            <div className="flex items-center gap-2">
              <span className="text-sm">{scan.state.stage}</span>
              <span className="text-muted-foreground text-sm">{scan.state.progress}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${scan.state.progress}%` }}
              />
            </div>
            {scan.state.detail && (
              <p className="text-xs text-muted-foreground">{scan.state.detail}</p>
            )}
            {scan.error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {scan.error}
              </div>
            )}
          </div>

          {/* Summary */}
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Alerts summary
            </h4>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{scan.summary.alertsTotal} total</Badge>
              {scan.summary.riskCounts.critical > 0 && (
                <Badge className={riskBadgeClass('critical')}>
                  {scan.summary.riskCounts.critical} critical
                </Badge>
              )}
              {scan.summary.riskCounts.high > 0 && (
                <Badge className={riskBadgeClass('high')}>
                  {scan.summary.riskCounts.high} high
                </Badge>
              )}
              {scan.summary.riskCounts.medium > 0 && (
                <Badge className={riskBadgeClass('medium')}>
                  {scan.summary.riskCounts.medium} medium
                </Badge>
              )}
              {scan.summary.riskCounts.low > 0 && (
                <Badge className={riskBadgeClass('low')}>
                  {scan.summary.riskCounts.low} low
                </Badge>
              )}
              {scan.summary.riskCounts.informational > 0 && (
                <Badge className={riskBadgeClass('informational')}>
                  {scan.summary.riskCounts.informational} info
                </Badge>
              )}
            </div>
          </div>

          {/* Alerts table */}
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Alerts ({scan.summary.alerts.length})
            </h4>
            {scan.summary.alerts.length > 0 ? (
              <div className="rounded-md border overflow-auto max-h-64">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px]">Risk</TableHead>
                      <TableHead>Alert</TableHead>
                      <TableHead className="max-w-[200px] truncate">URL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scan.summary.alerts.map((alert, index) => (
                      <TableRow key={`${alert.pluginId}-${index}`}>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={riskBadgeClass(alert.risk)}
                          >
                            {alert.risk}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-medium">{alert.alert}</TableCell>
                        <TableCell className="max-w-[200px] truncate text-muted-foreground" title={alert.url ?? undefined}>
                          {alert.url ?? '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No alerts recorded.</p>
            )}
          </div>
        </div>

        <DialogFooter className="border-t pt-4 mt-2">
          {running && onStopScan && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => onStopScan(scan.id)}
              disabled={stoppingScanId != null}
            >
              {stoppingScanId === scan.id ? 'Stopping…' : 'Stop scan'}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
