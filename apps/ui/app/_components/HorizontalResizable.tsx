'use client';

import { useState, useEffect, useRef, Children, type ReactNode } from 'react';

interface HorizontalResizableProps {
  children: ReactNode;
  storageKey?: string;
  defaultRatio?: number; // 0-1, fraction for right pane (e.g. 0.33 = 1/3)
}

const MIN_PANE_WIDTH = 200;

export function HorizontalResizable({ children, storageKey = 'horizontal-resize-ratio', defaultRatio = 0.33 }: HorizontalResizableProps) {
  const [rightWidth, setRightWidth] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const childrenArray = Children.toArray(children);

  useEffect(() => {
    if (rightWidth === null && containerRef.current) {
      const containerRect = containerRef.current.getBoundingClientRect();
      const containerWidth = containerRect.width;
      const saved = storageKey && typeof window !== 'undefined' ? localStorage.getItem(storageKey) : null;
      const ratio = saved ? parseFloat(saved) : defaultRatio;
      const clampedRatio = Math.max(0.15, Math.min(0.85, ratio));
      setRightWidth(containerWidth * clampedRatio);
    }
  }, [rightWidth, storageKey, defaultRatio]);

  const handleMouseDown = () => {
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const containerWidth = containerRect.width;
      const newRightWidth = containerRect.right - e.clientX;
      const constrainedWidth = Math.max(
        MIN_PANE_WIDTH,
        Math.min(containerWidth - MIN_PANE_WIDTH, newRightWidth),
      );
      setRightWidth(constrainedWidth);
      if (storageKey && typeof window !== 'undefined') {
        const ratio = constrainedWidth / containerWidth;
        localStorage.setItem(storageKey, ratio.toString());
      }
    };

    const handleMouseUp = () => setIsResizing(false);

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
  }, [isResizing, storageKey]);

  const rightWidthStyle =
    rightWidth !== null ? { width: `${rightWidth}px`, minWidth: `${rightWidth}px` } : { flex: `0 0 ${defaultRatio * 100}%` };

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{childrenArray[0]}</div>

      <div
        className="group relative flex w-1 shrink-0 cursor-col-resize items-stretch justify-center bg-transparent transition-colors hover:bg-[color:var(--cs-accent)] active:bg-[color:var(--cs-accent)]"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
      >
        <div className="absolute inset-y-0 -left-1 -right-1" />
        <div className="h-8 w-0.5 shrink-0 self-center rounded-full bg-[color:var(--cs-border)] group-hover:bg-[color:var(--cs-accent)] transition-colors" />
      </div>

      <div className="flex min-h-0 shrink-0 flex-col overflow-hidden" style={rightWidthStyle}>
        {childrenArray[1]}
      </div>
    </div>
  );
}
