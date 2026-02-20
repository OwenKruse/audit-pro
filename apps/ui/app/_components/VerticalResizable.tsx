'use client';

import { useState, useEffect, useRef, useCallback, Children, type ReactNode } from 'react';

interface VerticalResizableProps {
  children: ReactNode;
  storageKey?: string;
  defaultRatio?: number; // 0-1, where 0.5 means 50/50 split
}

const MIN_SECTION_HEIGHT = 150; // Minimum height for each section in pixels

export function VerticalResizable({ children, storageKey = 'vertical-resize-ratio', defaultRatio = 0.5 }: VerticalResizableProps) {
  const [topHeight, setTopHeight] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const childrenArray = Children.toArray(children);

  // Load ratio from localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const ratio = parseFloat(saved);
        if (ratio >= 0.1 && ratio <= 0.9) {
          // We'll calculate height on first render
          setTopHeight(null); // Will be calculated based on ratio
        }
      }
    }
  }, [storageKey]);

  // Calculate initial height based on ratio
  useEffect(() => {
    if (topHeight === null && containerRef.current) {
      const containerHeight = containerRef.current.clientHeight;
      const saved = localStorage.getItem(storageKey);
      const ratio = saved ? parseFloat(saved) : defaultRatio;
      const calculatedHeight = containerHeight * ratio;
      setTopHeight(calculatedHeight);
    }
  }, [topHeight, storageKey, defaultRatio]);

  const handleMouseDown = useCallback(() => {
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      
      const containerRect = containerRef.current.getBoundingClientRect();
      const containerHeight = containerRect.height;
      const newTopHeight = e.clientY - containerRect.top;
      
      // Constrain to minimum heights
      const constrainedHeight = Math.max(
        MIN_SECTION_HEIGHT,
        Math.min(containerHeight - MIN_SECTION_HEIGHT, newTopHeight)
      );
      
      setTopHeight(constrainedHeight);
      
      // Save ratio to localStorage
      if (storageKey && typeof window !== 'undefined') {
        const ratio = constrainedHeight / containerHeight;
        localStorage.setItem(storageKey, ratio.toString());
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, storageKey]);

  // Use flexbox with calculated height if available, otherwise use ratio
  const topHeightStyle = topHeight !== null 
    ? { height: `${topHeight}px` }
    : { flex: `0 0 ${defaultRatio * 100}%` };

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
    >
      {/* Top Section */}
      <div
        className="flex min-h-0 flex-shrink-0 flex-col"
        style={topHeightStyle}
      >
        {childrenArray[0]}
      </div>

      {/* Resize Handle */}
      <div
        className="group relative flex h-1 cursor-row-resize items-center justify-center bg-transparent transition-colors hover:bg-[color:var(--cs-accent)] active:bg-[color:var(--cs-accent)]"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize sections"
      >
        <div className="absolute inset-x-0 -top-1 -bottom-1" />
        <div className="w-8 h-0.5 rounded-full bg-[color:var(--cs-border)] group-hover:bg-[color:var(--cs-accent)] transition-colors" />
      </div>

      {/* Bottom Section */}
      <div className="flex min-h-0 flex-1 flex-col">
        {childrenArray[1]}
      </div>
    </div>
  );
}
