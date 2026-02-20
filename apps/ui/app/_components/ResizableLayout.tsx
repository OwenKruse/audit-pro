'use client';

import { useState, useEffect, useRef, useCallback, Children, type ReactNode } from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';

interface ResizableLayoutProps {
  children: ReactNode;
}

const MIN_PANEL_WIDTH = 240;
const MAX_PANEL_WIDTH = 800;
const DEFAULT_LEFT_WIDTH = 360;
const DEFAULT_RIGHT_WIDTH = 420;
const XL_BREAKPOINT = 1280;

function useIsNarrow() {
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${XL_BREAKPOINT - 1}px)`);
    setIsNarrow(mq.matches);
    const handler = () => setIsNarrow(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isNarrow;
}

export function ResizableLayout({ children }: ResizableLayoutProps) {
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH);
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [leftSheetOpen, setLeftSheetOpen] = useState(false);
  const [rightSheetOpen, setRightSheetOpen] = useState(false);
  const isNarrow = useIsNarrow();
  const containerRef = useRef<HTMLDivElement>(null);
  
  const childrenArray = Children.toArray(children);

  // Load widths from localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedLeft = localStorage.getItem('resizable-left-width');
      const savedRight = localStorage.getItem('resizable-right-width');
      if (savedLeft) {
        const width = parseInt(savedLeft, 10);
        if (width >= MIN_PANEL_WIDTH && width <= MAX_PANEL_WIDTH) setLeftWidth(width);
      }
      if (savedRight) {
        const width = parseInt(savedRight, 10);
        if (width >= MIN_PANEL_WIDTH && width <= MAX_PANEL_WIDTH) setRightWidth(width);
      }
    }
  }, []);

  // Save widths to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('resizable-left-width', leftWidth.toString());
    }
  }, [leftWidth]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('resizable-right-width', rightWidth.toString());
    }
  }, [rightWidth]);

  const handleLeftMouseDown = useCallback(() => {
    setIsResizingLeft(true);
  }, []);

  const handleRightMouseDown = useCallback(() => {
    setIsResizingRight(true);
  }, []);

  useEffect(() => {
    if (!isResizingLeft && !isResizingRight) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      
      const containerRect = containerRef.current.getBoundingClientRect();
      const containerWidth = containerRect.width;
      const minCenterWidth = 400; // Minimum width for center content

      if (isResizingLeft) {
        const newWidth = e.clientX - containerRect.left;
        // Ensure center content has minimum width
        const maxLeftWidth = containerWidth - minCenterWidth - rightWidth - 2; // 2px for resize handles
        const constrainedWidth = Math.max(
          MIN_PANEL_WIDTH, 
          Math.min(Math.min(MAX_PANEL_WIDTH, maxLeftWidth), newWidth)
        );
        setLeftWidth(constrainedWidth);
      }

      if (isResizingRight) {
        const newWidth = containerRect.right - e.clientX;
        // Ensure center content has minimum width
        const maxRightWidth = containerWidth - minCenterWidth - leftWidth - 2; // 2px for resize handles
        const constrainedWidth = Math.max(
          MIN_PANEL_WIDTH, 
          Math.min(Math.min(MAX_PANEL_WIDTH, maxRightWidth), newWidth)
        );
        setRightWidth(constrainedWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizingLeft(false);
      setIsResizingRight(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingLeft, isResizingRight]);

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 overflow-hidden xl:max-h-screen"
    >
      {/* Left Panel */}
      <div
        className="hidden xl:flex xl:flex-shrink-0 xl:min-w-0"
        style={{ width: `${leftWidth}px`, minWidth: `${MIN_PANEL_WIDTH}px`, maxWidth: `${MAX_PANEL_WIDTH}px` }}
      >
        {childrenArray[0]}
      </div>

      {/* Left Resize Handle */}
      <div
        className="hidden xl:block group relative w-1 flex-shrink-0 cursor-col-resize flex items-center justify-center bg-transparent transition-colors hover:bg-[color:var(--cs-accent)] active:bg-[color:var(--cs-accent)]"
        onMouseDown={handleLeftMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize left panel"
      >
        <div className="absolute inset-y-0 -left-1 -right-1" />
        <div className="h-8 w-0.5 rounded-full bg-[color:var(--cs-border)] group-hover:bg-[color:var(--cs-accent)] transition-colors" />
      </div>

      {/* Center Content */}
      <div className="relative flex min-h-0 min-w-[400px] flex-1">
        {isNarrow && (
          <>
            <button
              type="button"
              onClick={() => setLeftSheetOpen(true)}
              className="absolute left-0 top-1/2 z-10 -translate-y-1/2 flex h-9 w-7 items-center justify-center rounded-r-md border border-l-0 border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] text-[color:var(--cs-muted)] shadow-sm transition-colors hover:bg-[color:var(--cs-hover)] hover:text-[color:var(--cs-fg)]"
              aria-label="Open left panel"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setRightSheetOpen(true)}
              className="absolute right-0 top-1/2 z-10 -translate-y-1/2 flex h-9 w-7 items-center justify-center rounded-l-md border border-r-0 border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] text-[color:var(--cs-muted)] shadow-sm transition-colors hover:bg-[color:var(--cs-hover)] hover:text-[color:var(--cs-fg)]"
              aria-label="Open right panel"
            >
              <PanelRight className="h-4 w-4" />
            </button>
          </>
        )}
        {childrenArray[1]}
      </div>

      {/* Right Resize Handle */}
      <div
        className="hidden xl:block group relative w-1 flex-shrink-0 cursor-col-resize flex items-center justify-center bg-transparent transition-colors hover:bg-[color:var(--cs-accent)] active:bg-[color:var(--cs-accent)]"
        onMouseDown={handleRightMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right panel"
      >
        <div className="absolute inset-y-0 -left-1 -right-1" />
        <div className="h-8 w-0.5 rounded-full bg-[color:var(--cs-border)] group-hover:bg-[color:var(--cs-accent)] transition-colors" />
      </div>

      {/* Right Panel */}
      <div
        className="hidden xl:flex xl:flex-shrink-0 xl:min-w-0"
        style={{ width: `${rightWidth}px`, minWidth: `${MIN_PANEL_WIDTH}px`, maxWidth: `${MAX_PANEL_WIDTH}px` }}
      >
        {childrenArray[2]}
      </div>

      {/* Narrow layout: left panel sheet */}
      <Sheet open={leftSheetOpen} onOpenChange={setLeftSheetOpen}>
        <SheetContent
          side="left"
          className="flex h-full w-[min(100vw-2rem,360px)] max-w-[360px] flex-col gap-0 border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-0"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {childrenArray[0]}
          </div>
        </SheetContent>
      </Sheet>

      {/* Narrow layout: right panel sheet */}
      <Sheet open={rightSheetOpen} onOpenChange={setRightSheetOpen}>
        <SheetContent
          side="right"
          className="flex h-full w-[min(100vw-2rem,420px)] max-w-[420px] flex-col gap-0 border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-0"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {childrenArray[2]}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
